import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Log } from "../util/log"
import { Session } from "../session"

const log = Log.create({ service: "tool.read" })

/**
 * Coordinator for parallel Read calls within a session.
 *
 * When multiple Read tools execute in parallel, each independently checks if its file
 * would exceed the context threshold. Without coordination, all may pass individually
 * but their combined output overflows context.
 *
 * This coordinator tracks cumulative reserved tokens across concurrent Read calls,
 * allowing later calls to redirect to LCM when the combined total would be too large.
 */
export namespace ReadCoordinator {
  interface SessionState {
    reservedTokens: number
    cleanupTimer?: ReturnType<typeof setTimeout>
  }

  const sessions = new Map<string, SessionState>()

  // Threshold for combined parallel read output (~100k tokens = 400KB)
  // This is lower than model context to leave room for other content
  const PARALLEL_READ_TOKEN_LIMIT = 100_000

  function getOrCreate(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { reservedTokens: 0 }
      sessions.set(sessionID, state)
    }
    // Reset cleanup timer on activity
    if (state.cleanupTimer) clearTimeout(state.cleanupTimer)
    state.cleanupTimer = setTimeout(() => cleanup(sessionID), 60_000)
    return state
  }

  function cleanup(sessionID: string) {
    const state = sessions.get(sessionID)
    if (state?.cleanupTimer) clearTimeout(state.cleanupTimer)
    sessions.delete(sessionID)
  }

  /**
   * Reserve token space for a file read.
   * Returns true if the reservation would exceed the limit (should use LCM instead).
   */
  export function reserveTokens(
    sessionID: string,
    estimatedTokens: number,
  ): { shouldUseLcm: boolean; reserved: number } {
    const state = getOrCreate(sessionID)
    const projectedTotal = state.reservedTokens + estimatedTokens

    if (projectedTotal > PARALLEL_READ_TOKEN_LIMIT) {
      log.info("parallel read would exceed token limit, redirecting to LCM", {
        sessionID,
        estimatedTokens,
        currentReserved: state.reservedTokens,
        projectedTotal,
        limit: PARALLEL_READ_TOKEN_LIMIT,
      })
      return { shouldUseLcm: true, reserved: 0 }
    }

    state.reservedTokens += estimatedTokens
    log.debug("reserved tokens for parallel read", {
      sessionID,
      estimatedTokens,
      totalReserved: state.reservedTokens,
    })
    return { shouldUseLcm: false, reserved: estimatedTokens }
  }

  /**
   * Release reserved tokens (call when read completes or is redirected to LCM).
   */
  export function releaseTokens(sessionID: string, tokens: number) {
    const state = sessions.get(sessionID)
    if (state) {
      state.reservedTokens = Math.max(0, state.reservedTokens - tokens)
      log.debug("released tokens", {
        sessionID,
        released: tokens,
        remaining: state.reservedTokens,
      })
    }
  }

  /**
   * Reset session state (call at end of model turn).
   */
  export function reset(sessionID: string) {
    cleanup(sessionID)
  }
}

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
// Cap output to ~50K tokens worth of content to prevent context overflow
// ~50k tokens at ~4 bytes/token = 200KB (conservative for mixed content)
const MAX_OUTPUT_BYTES = 200 * 1024 // 200KB (~50k tokens max)
// Files larger than this will be stored in LCM if available
// ~2.5k tokens at ~3 bytes/token = 7.5KB (conservative estimate for code/text)
const LCM_FILE_SIZE_THRESHOLD = 7.5 * 1024 // 7.5KB (~2.5k tokens)

interface ReadLcmMetadata {
  type: "file"
  fileId: string
  filePath: string
  mimeType: string
  sizeBytes: number
  tokenCount: number
  explorerUsed: string
  source: "read"
}

interface ReadMetadata {
  preview: string
  truncated: boolean
  lcm?: ReadLcmMetadata
}

const parameters = z.object({
  filePath: z.string().describe("The path to the file to read"),
  offset: z.coerce.number().min(0).describe("The line number to start reading from (0-based)").optional(),
  limit: z.coerce.number().min(1).describe("The number of lines to read (defaults to 2000)").optional(),
})

export const ReadTool = Tool.define<typeof parameters, ReadMetadata>("read", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      // Use session directory for relative paths, falling back to process.cwd()
      const session = await Session.get(ctx.sessionID)
      const baseDir = session.directory || process.cwd()
      filepath = path.join(baseDir, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      try {
        const dirEntries = fs.readdirSync(dir)
        const suggestions = dirEntries
          .filter(
            (entry) =>
              entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
          )
          .map((entry) => path.join(dir, entry))
          .slice(0, 3)

        if (suggestions.length > 0) {
          throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
        }
      } catch (e: any) {
        if (e?.message?.startsWith("File not found:")) throw e
      }

      throw new Error(`File not found: ${filepath}`)
    }

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
        },
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = await isBinaryFile(filepath, file)
    if (isBinary) {
      const stat = await file.stat()
      const mime = file.type || "application/octet-stream"
      const ext = path.extname(filepath).toLowerCase()
      const sizeKB = Math.round(stat.size / 1024)
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(2)

      const outputLines = [
        `**Binary file detected - cannot display contents as text.**`,
        ``,
        `**Path:** ${filepath}`,
        `**Size:** ${stat.size} bytes (${sizeKB >= 1024 ? sizeMB + " MB" : sizeKB + " KB"})`,
        `**MIME Type:** ${mime}`,
        `**Extension:** ${ext || "(none)"}`,
        `**Modified:** ${stat.mtime?.toISOString() || "unknown"}`,
        ``,
        `This is a binary file (e.g., executable, archive, compiled object). `,
        `Use appropriate tools to inspect binary files:`,
        `- \`file ${filepath}\` - identify file type`,
        `- \`xxd ${filepath} | head\` - hex dump`,
        `- \`strings ${filepath} | head\` - extract printable strings`,
      ]

      return {
        title,
        output: outputLines.join("\n"),
        metadata: {
          preview: `Binary file: ${path.basename(filepath)} (${sizeKB >= 1024 ? sizeMB + " MB" : sizeKB + " KB"})`,
          truncated: false,
        },
      }
    }

    // If a limit is specified, skip large file handling and just do the direct read.
    // Only check file size for LCM when reading the entire file (no limit specified).
    const hasExplicitLimit = params.limit !== undefined
    const stat = await file.stat()
    const isLargeFile = !hasExplicitLimit && stat.size > LCM_FILE_SIZE_THRESHOLD

    // Estimate tokens for this file (~4 bytes per token for code/text)
    const estimatedTokens = Math.ceil(stat.size / 4)

    // Check if reading this file would push context over the LCM threshold
    const wouldExceedThreshold = !hasExplicitLimit && (await checkWouldExceedContextThreshold(ctx.sessionID, stat.size))

    // Check if combined parallel reads would exceed the limit
    // This coordinates with other concurrent Read calls in the same session
    const parallelCheck = !hasExplicitLimit ? ReadCoordinator.reserveTokens(ctx.sessionID, estimatedTokens) : null
    const wouldExceedParallelLimit = parallelCheck?.shouldUseLcm ?? false

    // Handle large files, files that would exceed context threshold, or parallel limit: try LCM first
    if (isLargeFile || wouldExceedThreshold || wouldExceedParallelLimit) {
      // Release any reserved tokens since we're using LCM instead of direct read
      if (parallelCheck?.reserved) {
        ReadCoordinator.releaseTokens(ctx.sessionID, parallelCheck.reserved)
      }

      const reason = isLargeFile
        ? "large_file"
        : wouldExceedParallelLimit
          ? "parallel_limit_exceeded"
          : "would_exceed_threshold"

      log.info("storing file in LCM", {
        filepath,
        size: stat.size,
        estimatedTokens,
        reason,
      })
      try {
        const lcmResult = await storeLargeFileInLcm(filepath, file.type || "application/octet-stream", ctx)
        const metadata = {
          preview: `Large file stored in LCM (file_id: ${lcmResult.fileId}, ~${lcmResult.tokenCount} tokens)`,
          truncated: false,
          lcm: lcmResult.lcm,
        }
        log.info("read tool returning LCM result", {
          filepath,
          hasLcm: !!metadata.lcm,
          lcmFileId: metadata.lcm?.fileId,
        })
        return {
          title,
          output: lcmResult.output,
          metadata,
        }
      } catch (e) {
        // LCM storage failed - fall back to streaming read gracefully
        log.error("LCM storage failed, falling back to streaming read", { filepath, error: e })
      }

      // Use streaming read for large files (either LCM unavailable or LCM failed)
      log.info("reading large file with streaming", { filepath, size: stat.size })
      return await streamReadLargeFile(filepath, title, params.offset, params.limit)
    }

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const lines = await file.text().then((text) => text.split("\n"))

    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false
    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i]
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_OUTPUT_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(line)
      bytes += size
    }

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = lines.length
    const lastReadLine = offset + raw.length
    const hasMoreLines = totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ~${Math.round(MAX_OUTPUT_BYTES / 1024)}KB to prevent context overflow. Use 'offset' parameter to read beyond line ${lastReadLine}, or use Task sub-agent to analyze large files.)`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
      },
    }
  },
})

/**
 * Stream-read a large file without loading it entirely into memory.
 * Reads line by line up to the limit.
 */
async function streamReadLargeFile(
  filepath: string,
  title: string,
  offsetParam?: number,
  limitParam?: number,
): Promise<{ title: string; output: string; metadata: { preview: string; truncated: boolean } }> {
  const limit = limitParam ?? DEFAULT_READ_LIMIT
  const offset = offsetParam || 0

  const file = Bun.file(filepath)
  const stream = file.stream()
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  const lines: string[] = []
  let lineBuffer = ""
  let currentLine = 0
  let bytes = 0
  let truncatedByBytes = false
  let reachedEnd = false

  try {
    while (lines.length < limit) {
      const { done, value } = await reader.read()
      if (done) {
        // Handle any remaining content in the buffer
        if (lineBuffer.length > 0 && currentLine >= offset) {
          const line =
            lineBuffer.length > MAX_LINE_LENGTH ? lineBuffer.substring(0, MAX_LINE_LENGTH) + "..." : lineBuffer
          const size = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0)
          if (bytes + size <= MAX_OUTPUT_BYTES) {
            lines.push(line)
            bytes += size
          } else {
            truncatedByBytes = true
          }
        }
        reachedEnd = true
        break
      }

      const chunk = decoder.decode(value, { stream: true })
      const parts = (lineBuffer + chunk).split("\n")
      lineBuffer = parts.pop() || ""

      for (const rawLine of parts) {
        if (currentLine >= offset) {
          const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.substring(0, MAX_LINE_LENGTH) + "..." : rawLine
          const size = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0)
          if (bytes + size > MAX_OUTPUT_BYTES) {
            truncatedByBytes = true
            break
          }
          lines.push(line)
          bytes += size
          if (lines.length >= limit) break
        }
        currentLine++
      }

      if (truncatedByBytes || lines.length >= limit) break
    }
  } finally {
    reader.releaseLock()
  }

  const content = lines.map((line, index) => {
    return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
  })
  const preview = lines.slice(0, 20).join("\n")

  let output = "<file>\n"
  output += content.join("\n")

  const lastReadLine = offset + lines.length
  const truncated = !reachedEnd || truncatedByBytes

  if (truncatedByBytes) {
    output += `\n\n(Output truncated at ~${Math.round(MAX_OUTPUT_BYTES / 1024)}KB to prevent context overflow. Use 'offset' parameter to read beyond line ${lastReadLine}, or use Task sub-agent to analyze large files.)`
  } else if (!reachedEnd) {
    output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
  } else {
    output += `\n\n(End of file - read ${lines.length} lines)`
  }
  output += "\n</file>"

  return {
    title,
    output,
    metadata: {
      preview,
      truncated,
    },
  }
}

interface LcmStorageResult {
  fileId: string
  tokenCount: number
  output: string
  lcm: ReadLcmMetadata
}

async function storeLargeFileInLcm(filepath: string, mimeType: string, ctx: Tool.Context): Promise<LcmStorageResult> {
  const startTime = Date.now()

  // Dynamic imports to avoid loading LCM code when not needed
  const { LcmDb } = await import("../session/lcm/db")
  const { ExploreDispatcher } = await import("../session/lcm/explore/dispatcher")

  // Get or create conversation for this session
  const conversationId = await getOrCreateLcmConversation(ctx.sessionID, LcmDb)
  if (!conversationId) {
    throw new Error("Failed to create LCM conversation for file storage")
  }

  // Store the file path reference in LCM database (content is read from disk on demand)
  const { fileId, tokenCount } = await LcmDb.insertLargeFileFromPath({
    conversationId,
    filePath: filepath,
    mimeType,
  })

  // Get the model from context for exploration
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = ctx.extra?.model as any
  if (!model) {
    throw new Error("Model not available in context for file exploration")
  }

  // Run exploration to generate a summary
  let summary = ""
  let explorerUsed = "none"
  try {
    const explorationResult = await ExploreDispatcher.explore({
      filePath: filepath,
      mimeType,
      model,
    })
    summary = explorationResult.summary
    explorerUsed = explorationResult.explorerUsed
  } catch (e) {
    log.warn("exploration failed, storing file without summary", { filepath, error: e })
    summary = `File stored but exploration failed. Use Task sub-agent with file_id "${fileId}" to interact with the content.`
  }

  const stat = await Bun.file(filepath).stat()
  const durationMs = Date.now() - startTime

  const outputLines = [
    `**Large file automatically stored in LCM for efficient interaction.**`,
    ``,
    `**File ID:** ${fileId}`,
    `**Path:** ${filepath}`,
    `**Size:** ${stat.size} bytes (~${tokenCount} tokens)`,
    `**Storage:** Path reference (content read from disk on demand)`,
    `**Explorer Used:** ${explorerUsed}`,
    ``,
    `## Summary`,
    summary,
    ``,
    `Use \`Task sub-agent\` with file_id "${fileId}" to ask questions about this file.`,
  ]

  return {
    fileId,
    tokenCount: Number(tokenCount),
    output: outputLines.join("\n"),
    lcm: {
      type: "file",
      fileId,
      filePath: filepath,
      mimeType,
      sizeBytes: stat.size,
      tokenCount: Number(tokenCount),
      explorerUsed,
      source: "read",
    },
  }
}

async function getOrCreateLcmConversation(
  sessionID: string,
  LcmDb: typeof import("../session/lcm/db").LcmDb,
): Promise<number | null> {
  const titlePrefix = `[VoltCode Session: ${sessionID}]`

  try {
    const conn = LcmDb.getConnection()
    const existing = await conn<{ conversation_id: number }[]>`
      SELECT conversation_id
      FROM conversations
      WHERE title LIKE ${titlePrefix + "%"}
      LIMIT 1
    `

    if (existing.length > 0) {
      return existing[0].conversation_id
    }

    // Check if this session has a parent, and if so, get the parent's conversation ID
    let parentConversationId: number | undefined
    try {
      const session = await Session.get(sessionID)
      if (session.parentID) {
        // Recursively get the parent's conversation ID
        parentConversationId = (await getOrCreateLcmConversation(session.parentID, LcmDb)) ?? undefined
      }
    } catch {
      // Session lookup failed, proceed without parent linkage
    }

    // Create a new conversation linked to parent
    const conversationId = await LcmDb.createConversation({
      title: titlePrefix,
      modelName: "unknown",
      modelCtxMaxTokens: 128000,
      parentConversationId,
    })

    log.info("created LCM conversation for session", { sessionID, conversationId, parentConversationId })
    return conversationId
  } catch (e) {
    log.error("failed to get or create LCM conversation", { sessionID, error: e })
    return null
  }
}

/**
 * Check if reading a file of the given size would push context over the LCM threshold.
 *
 * This prevents reading files directly into context when doing so would immediately
 * trigger compaction. Instead, we proactively store such files in LCM.
 *
 * @param sessionID - The current session ID
 * @param fileSize - Size of the file in bytes
 * @returns true if reading this file would exceed the context threshold
 */
async function checkWouldExceedContextThreshold(sessionID: string, fileSize: number): Promise<boolean> {
  try {
    const { TokenBudget } = await import("../session/token-budget")
    const { LcmDb } = await import("../session/lcm/db")
    const { LcmContext } = await import("../session/lcm/context")

    // Get the pre-computed budget (set by buildLcmModelMessages each turn)
    let budget: ReturnType<typeof TokenBudget.getSessionBudget>
    try {
      budget = TokenBudget.getSessionBudget(sessionID)
    } catch {
      // No budget yet (e.g. first turn before buildLcmModelMessages runs)
      return false
    }

    // Find existing conversation for this session
    const titlePrefix = `[VoltCode Session: ${sessionID}]`
    const conn = LcmDb.getConnection()
    const existing = await conn<{ conversation_id: number }[]>`
      SELECT conversation_id
      FROM conversations
      WHERE title LIKE ${titlePrefix + "%"}
      LIMIT 1
    `

    if (existing.length === 0) {
      return false
    }

    const conversationId = existing[0].conversation_id
    const thresholdInfo = await LcmContext.isOverThreshold({
      conversationId,
      overhead: budget.overhead,
      reserve: budget.reserve,
      contextWindow: budget.contextWindow,
    })

    // Estimate tokens for this file (~4 bytes per token for code/text)
    const estimatedFileTokens = Math.ceil(fileSize / 4)

    // Check if adding this file would push us over the soft threshold
    const projectedTokens = thresholdInfo.currentTokens + estimatedFileTokens
    const wouldExceed = projectedTokens > thresholdInfo.softThreshold

    if (wouldExceed) {
      log.info("file would exceed context threshold, will use LCM", {
        sessionID,
        fileSize,
        estimatedFileTokens,
        currentTokens: thresholdInfo.currentTokens,
        projectedTokens,
        softThreshold: thresholdInfo.softThreshold,
        hardLimit: thresholdInfo.hardLimit,
      })
    }

    return wouldExceed
  } catch (e) {
    log.warn("failed to check context threshold", { sessionID, error: e })
    return false
  }
}

async function isBinaryFile(filepath: string, file: Bun.BunFile): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const stat = await file.stat()
  const fileSize = stat.size
  if (fileSize === 0) return false

  // Only read the first 4096 bytes for binary detection (not the entire file!)
  const bufferSize = Math.min(4096, fileSize)
  const slicedFile = file.slice(0, bufferSize)
  const buffer = await slicedFile.arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer)

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
