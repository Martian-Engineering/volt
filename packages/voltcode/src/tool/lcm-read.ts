import z from "zod"
import { Tool } from "./tool"
import { LcmDb } from "../session/lcm/db"
import type { LcmToolMetadata } from "../session/lcm/types"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Log } from "../util/log"
import DESCRIPTION from "./lcm-read.txt"

const log = Log.create({ service: "tool.lcm_read" })

/** Default byte cap — ~25k tokens at ~4 chars/token. */
const DEFAULT_MAX_BYTES = 100_000

const parameters = z.object({
  file_id: z.string().describe("The LCM file ID to read (file_xxx format)"),
  max_bytes: z
    .number()
    .min(1)
    .optional()
    .describe("Optional byte limit for very large payloads (default: 100000)"),
})

interface LcmReadMetadata {
  fileId: string
  found: boolean
  truncated: boolean
  totalSize: number
  lcm?: LcmToolMetadata
}

export const LcmReadTool = Tool.define<typeof parameters, LcmReadMetadata>("lcm_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    // Sub-agent gate — same pattern as lcm_expand.
    const session = await Session.get(ctx.sessionID)
    if (!session.parentID) {
      return {
        title: `Read LCM file: ${params.file_id}`,
        metadata: {
          fileId: params.file_id,
          found: false,
          truncated: false,
          totalSize: 0,
        },
        output: `ERROR: Only sub-agents can read full LCM file content.

The lcm_read tool can only be called by sub-agents spawned via the Task tool.
This restriction protects the main context from uncontrolled expansion.

To retrieve the content of "${params.file_id}", spawn an explore sub-agent:
  Task(subagent_type="explore", prompt="Use lcm_read on ${params.file_id} to find <your question>")

The explore sub-agent will call lcm_read and return a focused answer.`,
      }
    }

    const fileId = params.file_id.trim()

    if (!fileId.startsWith("file_")) {
      return {
        title: `LCM read: ${fileId}`,
        metadata: {
          fileId,
          found: false,
          truncated: false,
          totalSize: 0,
        },
        output: `Invalid ID format: "${fileId}". lcm_read accepts file IDs (file_xxx). For summary IDs (sum_xxx), use lcm_expand instead.`,
      }
    }

    // Scope lookup to this conversation's ancestry chain.
    const conversationId = await SessionPrompt.getLcmConversationId(ctx.sessionID)

    const maxBytes = params.max_bytes ?? DEFAULT_MAX_BYTES

    log.info("reading LCM file content", { fileId, maxBytes, sessionId: ctx.sessionID })

    const result = await LcmDb.getLargeFileContent(fileId, maxBytes, conversationId ?? undefined)

    if (!result) {
      // Distinguish "ID not found" from "file on disk missing".
      const exists = await LcmDb.largeFileExists(fileId, conversationId ?? undefined)
      if (exists) {
        return {
          title: `LCM read: ${fileId}`,
          metadata: {
            fileId,
            found: true,
            truncated: false,
            totalSize: 0,
          },
          output: `File record exists but content could not be read — the backing file may have been moved or deleted.\n\nUse lcm_describe with "${fileId}" for metadata and exploration summary.`,
        }
      }

      return {
        title: `LCM read: ${fileId}`,
        metadata: {
          fileId,
          found: false,
          truncated: false,
          totalSize: 0,
        },
        output: `File not found: ${fileId}\n\nThis file ID does not exist in the current conversation or its ancestors.`,
      }
    }

    log.info("read LCM file content", {
      fileId,
      totalSize: result.totalSize,
      truncated: result.truncated,
    })

    const lines: string[] = []
    lines.push(`## LCM File Content: ${fileId}`)
    lines.push("")

    if (result.truncated) {
      lines.push(
        `**Note:** Content truncated to ${maxBytes.toLocaleString()} bytes (full size: ${result.totalSize.toLocaleString()} bytes). Call again with a larger max_bytes to see more.`,
      )
      lines.push("")
    }

    lines.push(result.content)

    return {
      title: `Read LCM: ${fileId} (${result.totalSize.toLocaleString()} bytes)`,
      metadata: {
        fileId,
        found: true,
        truncated: result.truncated,
        totalSize: result.totalSize,
        // Signal to the processor that this is already LCM content — do not re-store.
        lcm: { storedInLcm: true, fileId },
      },
      output: lines.join("\n"),
    }
  },
})
