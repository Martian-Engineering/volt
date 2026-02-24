import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import {
  type Tool as AITool,
  tool,
  jsonSchema,
  asSchema,
  type ToolCallOptions,
  type ModelMessage,
  type UIMessage,
  type UserContent,
  convertToModelMessages,
} from "ai"

import type { JSONSchema7 } from "@ai-sdk/provider"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { withTimeout } from "../util/timeout"
import { clone } from "remeda"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $, fileURLToPath } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { LargeFileThreshold } from "./lcm/large-file-threshold"
import { ExploreDispatcher } from "./lcm/explore/dispatcher"
import { LcmDb } from "./lcm/db"
import { LcmContext } from "./lcm/context"
import { LcmContextSnapshot } from "./lcm/context-snapshot"
import { LcmRetrieval } from "./lcm/retrieval"
import {
  LCM_PRE_RESPONSE_HOOK_MAX_DISTANCE,
  LCM_PRE_RESPONSE_HOOK_MIN_SCORE,
  LCM_PRE_RESPONSE_HOOK_TOP_K,
} from "./lcm/config"
import { LargeFile } from "./lcm/large-file"
import { Token } from "@/util/token"
import { TokenBudget } from "./token-budget"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })
  export const OUTPUT_TOKEN_MAX = Flag.VOLTCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // Timeout for queued loop callers - if a loop is running and takes longer than this,
  // queued callers will timeout rather than wait forever

  // Timeout for tool execution - 30 minutes for long-running tools
  const TOOL_EXECUTE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

  const lcmSyncState = new Map<string, string>()

  async function writeLcmContextSnapshotBestEffort(input: {
    conversationId: number
    sessionID: string
    reason: string
    triggerMessageId?: number
  }) {
    try {
      await LcmContextSnapshot.write(input)
    } catch (error) {
      log.warn("failed to write lcm context snapshot", {
        sessionID: input.sessionID,
        conversationId: input.conversationId,
        reason: input.reason,
        triggerMessageId: input.triggerMessageId,
        error,
      })
    }
  }

  const state = Instance.state(
    () => {
      const data: Record<
        string,
        {
          abort: AbortController
          callbacks: {
            resolve(input: MessageV2.WithParts): void
            reject(): void
          }[]
        }
      > = {}
      return data
    },
    async (current) => {
      for (const item of Object.values(current)) {
        item.abort.abort()
      }
    },
  )

  export function assertNotBusy(sessionID: string) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  /**
   * Get or create an LCM conversation ID for a VoltCode session.
   * This creates a new LCM conversation if one doesn't exist.
   * The conversation is created on-demand when the first large file is encountered.
   *
   * If the session has a parent, the new conversation will be linked to the parent's
   * conversation, allowing the child to access files and summaries from ancestors.
   */
  export async function getOrCreateLcmConversation(sessionID: string, model: Provider.Model): Promise<number | null> {
    // Use a deterministic approach: hash the session ID to get a consistent lookup key
    // We store the session ID in the conversation title for later lookup
    const titlePrefix = `[VoltCode Session: ${sessionID}]`

    // Check if conversation already exists by querying with title
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
        // Recursively get the parent's conversation ID (which will create it if needed)
        parentConversationId = (await getOrCreateLcmConversation(session.parentID, model)) ?? undefined
      }
    } catch {
      // Session lookup failed, proceed without parent linkage
    }

    // Create a new conversation for this session
    const conversationId = await LcmDb.createConversation({
      title: titlePrefix,
      modelName: model.id,
      modelCtxMaxTokens: model.limit.context,
      parentConversationId,
    })

    log.info("created LCM conversation for session", { sessionID, conversationId, parentConversationId })
    return conversationId
  }

  /**
   * Look up the LCM conversation ID for a session (if one exists).
   * Returns null if no conversation has been created for this session yet.
   *
   * This is useful for tools that need to do scoped lookups of files/summaries
   * that may exist in ancestor conversations.
   */
  export async function getLcmConversationId(sessionID: string): Promise<number | null> {
    const titlePrefix = `[VoltCode Session: ${sessionID}]`

    try {
      const conn = LcmDb.getConnection()
      const existing = await conn<{ conversation_id: number }[]>`
        SELECT conversation_id
        FROM conversations
        WHERE title LIKE ${titlePrefix + "%"}
        LIMIT 1
      `
      return existing[0]?.conversation_id ?? null
    } catch (e) {
      log.error("failed to look up LCM conversation", { sessionID, error: e })
      return null
    }
  }

  /**
   * Handle a large file by storing it in LCM database and returning a marker.
   * If LCM is not available, returns null and the file should be handled normally.
   *
   * IMPORTANT: This function avoids loading giant files into JS memory by:
   * 1. Using insertLargeFileFromPath which stores only the file path (not content)
   * 2. Passing just the filePath to the explorer (not content)
   * Content is read from disk on demand when needed.
   */
  async function handleLargeFile(input: {
    sessionID: string
    filepath: string
    fileSize: number
    mimeType: string
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<{
    fileId: string
    summary: string
    explorerUsed: string
    tokenCount: bigint
  } | null> {
    const conversationId = await getOrCreateLcmConversation(input.sessionID, input.model)
    if (conversationId === null) {
      return null
    }

    try {
      // Store the file path reference in LCM database (content is read from disk on demand)
      const { fileId, tokenCount } = await LcmDb.insertLargeFileFromPath({
        conversationId,
        filePath: input.filepath,
        mimeType: input.mimeType,
      })

      // Run exploration to generate a summary
      // Pass just the filePath - the dispatcher will load content as needed
      const explorationResult = await ExploreDispatcher.explore({
        filePath: input.filepath,
        mimeType: input.mimeType,
        model: input.model,
        abort: input.abort,
      })

      // Store the exploration results in the database for later retrieval
      await LcmDb.updateLargeFileExploration({
        fileId,
        explorationSummary: explorationResult.summary,
        explorerUsed: explorationResult.explorerUsed,
      })

      log.info("explored large file", {
        fileId,
        filepath: input.filepath,
        explorerUsed: explorationResult.explorerUsed,
        tokenCount: tokenCount.toString(),
      })

      return {
        fileId,
        summary: explorationResult.summary,
        explorerUsed: explorationResult.explorerUsed,
        tokenCount,
      }
    } catch (e) {
      log.error("failed to handle large file", { filepath: input.filepath, error: e })
      return null
    }
  }

  /**
   * Format a session message (with parts) into LCM-compatible structure.
   * Produces a content string and structured parts array for database storage.
   *
   * @internal Exported for testing
   */
  export function formatMessageForLcm(msg: MessageV2.WithParts): {
    role: LcmDb.MessageRole
    content: string
    tokenCount: number
    parts: LcmDb.MessagePartInput[]
  } {
    const contentParts: string[] = []
    const structuredParts: LcmDb.MessagePartInput[] = []

    for (let ordinal = 0; ordinal < msg.parts.length; ordinal++) {
      const part = msg.parts[ordinal]
      const base = { partId: part.id, sessionId: part.sessionID, ordinal }

      switch (part.type) {
        case "text":
          structuredParts.push({
            ...base,
            partType: "text",
            textContent: part.text,
            isIgnored: part.ignored ?? null,
            isSynthetic: part.synthetic ?? null,
            metadata: part.metadata ?? null,
          })
          if (!part.ignored) {
            contentParts.push(part.text)
          }
          break
        case "reasoning":
          structuredParts.push({
            ...base,
            partType: "reasoning",
            textContent: part.text,
            metadata: part.metadata ?? null,
          })
          if (part.text) {
            contentParts.push(`<reasoning>\n${part.text}\n</reasoning>`)
          }
          break
        case "tool": {
          const toolPart: LcmDb.MessagePartInput = {
            ...base,
            partType: "tool",
            toolCallId: part.callID,
            toolName: part.tool,
            toolStatus: part.state.status,
            toolInput: part.state.input,
            metadata: part.metadata ?? null,
          }
          if (part.state.status === "completed") {
            const rawOutput = part.state.output
            const output =
              typeof rawOutput === "string" ? rawOutput : rawOutput == null ? "" : JSON.stringify(rawOutput)
            toolPart.toolOutput = output
            toolPart.toolTitle = part.state.title
            if (part.state.metadata) {
              toolPart.metadata = toolPart.metadata
                ? { ...toolPart.metadata, ...part.state.metadata }
                : part.state.metadata
            }
            contentParts.push(
              `<tool name="${part.tool}">\nInput: ${JSON.stringify(part.state.input)}\nOutput: ${output}\n</tool>`,
            )
          } else if (part.state.status === "error") {
            toolPart.toolError = part.state.error
            if (part.state.metadata) {
              toolPart.metadata = toolPart.metadata
                ? { ...toolPart.metadata, ...part.state.metadata }
                : part.state.metadata
            }
            contentParts.push(
              `<tool name="${part.tool}">\nInput: ${JSON.stringify(part.state.input)}\nError: ${part.state.error}\n</tool>`,
            )
          }
          structuredParts.push(toolPart)
          break
        }
        case "patch":
          structuredParts.push({
            ...base,
            partType: "patch",
            patchHash: part.hash,
            patchFiles: part.files,
          })
          // patch: structured only, not added to content string
          break
        case "file":
          structuredParts.push({
            ...base,
            partType: "file",
            fileMime: part.mime,
            fileName: part.filename ?? null,
            fileUrl: part.url,
          })
          // file: structured only, not added to content string
          break
        case "subtask":
          structuredParts.push({
            ...base,
            partType: "subtask",
            subtaskPrompt: part.prompt,
            subtaskDesc: part.description,
            subtaskAgent: part.agent,
          })
          // subtask: structured only, not added to content string
          break
        case "compaction":
          structuredParts.push({
            ...base,
            partType: "compaction",
            compactionAuto: part.auto,
          })
          // compaction: structured only, not added to content string
          break
        case "step-start":
          structuredParts.push({
            ...base,
            partType: "step_start",
            snapshotHash: part.snapshot ?? null,
          })
          break
        case "step-finish":
          structuredParts.push({
            ...base,
            partType: "step_finish",
            stepReason: part.reason,
            snapshotHash: part.snapshot ?? null,
            stepCost: part.cost,
            stepTokensIn: part.tokens.input,
            stepTokensOut: part.tokens.output,
          })
          break
        case "snapshot":
          structuredParts.push({
            ...base,
            partType: "snapshot",
            snapshotHash: part.snapshot,
          })
          break
        case "agent":
          structuredParts.push({
            ...base,
            partType: "agent",
            subtaskAgent: part.name,
            metadata: part.source ? { source: part.source } : null,
          })
          break
        case "retry":
          structuredParts.push({
            ...base,
            partType: "retry",
            metadata: {
              attempt: part.attempt,
              error: part.error,
              time: part.time,
            },
          })
          break
        default:
          break
      }
    }

    const content = contentParts.join("\n\n")
    const role: LcmDb.MessageRole = msg.info.role === "user" ? "user" : "assistant"
    return {
      role,
      content,
      tokenCount: Token.estimate(content),
      parts: structuredParts,
    }
  }

  function buildLcmEventPart(input: {
    sessionID: string
    messageID: string
    text: string
    metadata: Record<string, any>
  }): MessageV2.TextPart {
    return {
      id: Identifier.ascending("part"),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "text",
      text: input.text,
      synthetic: true,
      ignored: true,
      metadata: {
        lcm: input.metadata,
      },
    }
  }

  async function syncSessionMessagesToLcm(
    conversationId: number,
    sessionID: string,
    sessionMessages?: MessageV2.WithParts[],
  ) {
    const lastSyncedId = lcmSyncState.get(sessionID)
    if (lastSyncedId) {
      if (sessionMessages) {
        const lastIndex = sessionMessages.findIndex((msg) => msg.info.id === lastSyncedId)
        if (lastIndex >= 0) {
          const newMessages = sessionMessages.slice(lastIndex + 1)
          log.debug("syncSessionMessagesToLcm: incremental sync", {
            conversationId,
            newMessageCount: newMessages.length,
            totalSessionMessages: sessionMessages.length,
            newTokens: newMessages.reduce((sum, m) => {
              const f = formatMessageForLcm(m)
              return sum + f.tokenCount
            }, 0),
          })
          for (const msg of newMessages) {
            const formatted = formatMessageForLcm(msg)
            const messageId = await LcmDb.appendMessage({
              conversationId,
              role: formatted.role,
              content: formatted.content,
              tokenCount: formatted.tokenCount,
            })
            await LcmDb.insertMessageParts(messageId, formatted.parts)
            await writeLcmContextSnapshotBestEffort({
              conversationId,
              sessionID,
              reason: "leaf_appended",
              triggerMessageId: messageId,
            })
          }
          const lastMsg = sessionMessages.at(-1)
          if (lastMsg) {
            lcmSyncState.set(sessionID, lastMsg.info.id)
          }
          return
        }
      } else {
        const newMessages: MessageV2.WithParts[] = []
        let found = false
        for await (const msg of MessageV2.stream(sessionID)) {
          if (msg.info.id === lastSyncedId) {
            found = true
            break
          }
          newMessages.push(msg)
        }

        if (found) {
          newMessages.reverse()
          for (const msg of newMessages) {
            const formatted = formatMessageForLcm(msg)
            const messageId = await LcmDb.appendMessage({
              conversationId,
              role: formatted.role,
              content: formatted.content,
              tokenCount: formatted.tokenCount,
            })
            await LcmDb.insertMessageParts(messageId, formatted.parts)
            await writeLcmContextSnapshotBestEffort({
              conversationId,
              sessionID,
              reason: "leaf_appended",
              triggerMessageId: messageId,
            })
          }
          if (newMessages.length > 0) {
            lcmSyncState.set(sessionID, newMessages[newMessages.length - 1].info.id)
          }
          return
        }
      }
    }

    const existingCount = await LcmDb.getMessageCount(conversationId)
    const allMessages = sessionMessages ?? (await Session.messages({ sessionID }))

    if (existingCount > allMessages.length) {
      log.warn("LCM message count exceeds session message count", { sessionID, conversationId, existingCount })
      return
    }
    const newMessages = allMessages.slice(existingCount)

    for (const msg of newMessages) {
      const formatted = formatMessageForLcm(msg)
      const messageId = await LcmDb.appendMessage({
        conversationId,
        role: formatted.role,
        content: formatted.content,
        tokenCount: formatted.tokenCount,
      })
      await LcmDb.insertMessageParts(messageId, formatted.parts)
      await writeLcmContextSnapshotBestEffort({
        conversationId,
        sessionID,
        reason: "leaf_appended",
        triggerMessageId: messageId,
      })
    }
    const lastMsg = allMessages.at(-1)
    if (lastMsg) {
      lcmSyncState.set(sessionID, lastMsg.info.id)
    }
  }

  function mapLcmRoleToModel(role: string): "user" | "assistant" {
    if (role === "user" || role === "system") return "user"
    return "assistant"
  }

  /**
   * Parse <tool> XML tags from LCM content and extract tool call information.
   * Format: <tool name="toolName">\nInput: {...}\nOutput: ...\n</tool>
   * or: <tool name="toolName">\nInput: {...}\nError: ...\n</tool>
   *
   * Uses manual parsing to handle edge cases where:
   * - Tool input contains literal "Output:" or "Error:" text
   * - Tool output contains literal "</tool>" text
   *
   * @internal Exported for testing
   */
  export function parseToolTagsFromLcm(content: string): {
    name: string
    input: unknown
    output: string
    isError: boolean
  }[] {
    const tools: { name: string; input: unknown; output: string; isError: boolean }[] = []

    log.debug("lcm tool parsing", { content: content.slice(0, 200) })

    // Find all <tool name="..."> opening tags
    const openTagPattern = /<tool name="([^"]+)">/g
    let openMatch
    while ((openMatch = openTagPattern.exec(content)) !== null) {
      const name = openMatch[1]
      const openTagEnd = openMatch.index + openMatch[0].length

      // Find the matching </tool> closing tag by searching BACKWARDS from the end.
      // This handles cases where </tool> appears inside the tool output - we want the LAST one.
      // We find the next opening tag to limit our search range (or use end of content).
      const nextOpenMatch = content.slice(openTagEnd).match(/<tool name="[^"]+">\s*Input:/)
      const searchEndPos =
        nextOpenMatch && nextOpenMatch.index !== undefined ? openTagEnd + nextOpenMatch.index : content.length

      // Find the LAST </tool> in the valid range
      let closeTagStart = -1
      let searchPos = searchEndPos

      while (searchPos > openTagEnd) {
        const lastCloseInRange = content.lastIndexOf("</tool>", searchPos - 1)
        if (lastCloseInRange === -1 || lastCloseInRange < openTagEnd) break

        // Check if content between opening and this closing tag forms a valid structure
        const candidateContent = content.slice(openTagEnd, lastCloseInRange)
        const hasInput = /^\s*Input:\s*/.test(candidateContent)
        const hasResultMarker = /\n(Output|Error):/s.test(candidateContent)

        if (hasInput && hasResultMarker) {
          closeTagStart = lastCloseInRange
          break
        }

        searchPos = lastCloseInRange // Try finding an earlier </tool>
      }

      if (closeTagStart === -1) continue // No matching closing tag found

      // Extract content between <tool name="..."> and </tool>
      const innerContent = content.slice(openTagEnd, closeTagStart)

      // Find "Input:" at the beginning (allowing leading whitespace)
      const inputMatch = innerContent.match(/^\s*Input:\s*/)
      if (!inputMatch) continue

      const afterInput = innerContent.slice(inputMatch[0].length)

      // Find the LAST occurrence of "\nOutput:" or "\nError:" to handle edge cases
      // where the input itself contains these strings
      const lastOutputIndex = afterInput.lastIndexOf("\nOutput:")
      const lastErrorIndex = afterInput.lastIndexOf("\nError:")

      let resultType: "Output" | "Error"
      let splitIndex: number

      if (lastOutputIndex === -1 && lastErrorIndex === -1) continue // No result marker found

      if (lastOutputIndex === -1) {
        resultType = "Error"
        splitIndex = lastErrorIndex
      } else if (lastErrorIndex === -1) {
        resultType = "Output"
        splitIndex = lastOutputIndex
      } else {
        // Both exist, use the later one
        if (lastOutputIndex > lastErrorIndex) {
          resultType = "Output"
          splitIndex = lastOutputIndex
        } else {
          resultType = "Error"
          splitIndex = lastErrorIndex
        }
      }

      const inputStr = afterInput.slice(0, splitIndex)
      const markerLength = resultType === "Output" ? "\nOutput:".length : "\nError:".length
      const resultStr = afterInput.slice(splitIndex + markerLength)

      let input: unknown
      try {
        const parsed = JSON.parse(inputStr.trim())
        // Anthropic API requires input to be a dictionary/object
        input = typeof parsed === "object" && parsed !== null ? parsed : { value: parsed }
      } catch {
        input = { value: inputStr.trim() }
      }

      tools.push({
        name,
        input,
        output: resultStr.trim(),
        isError: resultType === "Error",
      })
    }

    log.debug("lcm tools found", { count: tools.length })
    if (tools.length === 0 && content.includes("<tool")) {
      log.warn("lcm tool tag present but parser failed to match", { content: content.slice(0, 500) })
    }

    return tools
  }

  /**
   * Strip all <tool name="...">...</tool> tags from content.
   * Uses the same robust parsing as parseToolTagsFromLcm to handle nested content.
   *
   * @internal Exported for testing
   */
  export function stripToolTagsFromLcm(content: string): string {
    const ranges: { start: number; end: number }[] = []

    // Find all <tool name="..."> opening tags
    const openTagPattern = /<tool name="[^"]+">[\s]*/g
    let openMatch
    while ((openMatch = openTagPattern.exec(content)) !== null) {
      const openTagStart = openMatch.index
      const openTagEnd = openMatch.index + openMatch[0].length

      // Find the matching </tool> closing tag by searching BACKWARDS from the end.
      // This handles cases where </tool> appears inside the tool output.
      const nextOpenMatch = content.slice(openTagEnd).match(/<tool name="[^"]+">\s*Input:/)
      const searchEndPos =
        nextOpenMatch && nextOpenMatch.index !== undefined ? openTagEnd + nextOpenMatch.index : content.length

      // Find the LAST </tool> in the valid range
      let closeTagEnd = -1
      let searchPos = searchEndPos

      while (searchPos > openTagEnd) {
        const lastCloseInRange = content.lastIndexOf("</tool>", searchPos - 1)
        if (lastCloseInRange === -1 || lastCloseInRange < openTagEnd) break

        // Check if content between opening and this closing tag forms a valid structure
        const candidateContent = content.slice(openTagEnd, lastCloseInRange)
        const hasInput = /^\s*Input:\s*/.test(candidateContent)
        const hasResultMarker = /\n(Output|Error):/s.test(candidateContent)

        if (hasInput && hasResultMarker) {
          closeTagEnd = lastCloseInRange + "</tool>".length
          // Also consume trailing whitespace
          while (closeTagEnd < content.length && /\s/.test(content[closeTagEnd])) {
            closeTagEnd++
          }
          break
        }

        searchPos = lastCloseInRange // Try finding an earlier </tool>
      }

      if (closeTagEnd !== -1) {
        ranges.push({ start: openTagStart, end: closeTagEnd })
      }
    }

    // Remove ranges from end to start to preserve indices
    let result = content
    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i]
      result = result.slice(0, range.start) + result.slice(range.end)
    }

    return result.trim()
  }

  /**
   * Strip LCM-only markers that aren't tool tags but shouldn't appear in text parts.
   * These are formatting artifacts from formatMessageForLcm() and summarize().
   */
  export function stripLcmMarkers(content: string): string {
    return content
      .replace(/\[Patch:[^\]]*\]/g, "")
      .replace(/<file\s+path="[^"]*"\s+mime="[^"]*"\s*\/>/g, "")
      .replace(/<compaction\s*\/>/g, "")
      .replace(/<subtask\s+agent="[^"]*">[\s\S]*?<\/subtask>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  const SUMMARY_ID_IN_CONTEXT_RE = /\[Summary ID: (sum_[a-f0-9]{16})\]/g

  /**
   * Build a retrieval query string from the latest user message text parts.
   */
  export function buildPreResponseRetrievalQuery(message: MessageV2.WithParts | undefined): string {
    if (!message || message.info.role !== "user") return ""

    const chunks: string[] = []
    for (const part of message.parts) {
      if (part.type === "text" && !part.ignored && !part.synthetic) {
        const text = part.text.trim()
        if (text) chunks.push(text)
      }
      if (part.type === "subtask") {
        const prompt = part.prompt.trim()
        if (prompt) chunks.push(prompt)
      }
    }
    return chunks.join("\n").trim()
  }

  /**
   * Extract active summary IDs already present in the in-context summary lane.
   */
  export function collectActiveSummaryIdsFromContext(
    context: Array<{ item_type: string; content: string }>,
  ): Set<string> {
    const ids = new Set<string>()
    for (const item of context) {
      if (item.item_type !== "summary") continue
      for (const match of item.content.matchAll(SUMMARY_ID_IN_CONTEXT_RE)) {
        if (match[1]) {
          ids.add(match[1])
        }
      }
    }
    return ids
  }

  /**
   * Format retrieval hits into ultra-short pre-response memory cue lines.
   */
  export function formatPreResponseMemoryCueBlock(input: {
    hits: LcmRetrieval.QueryHit[]
    activeSummaryIds: Iterable<string>
    topK?: number
  }): string | null {
    const topK = Math.max(1, Math.floor(input.topK ?? LCM_PRE_RESPONSE_HOOK_TOP_K))
    const active = new Set(input.activeSummaryIds)
    const cues = input.hits.filter((hit) => !active.has(hit.summaryId)).slice(0, topK)
    if (cues.length === 0) return null

    const lines = ["<memory-cues>"]
    for (const [index, cue] of cues.entries()) {
      const pointerIds = cue.pointerSummaryIds.length > 0 ? cue.pointerSummaryIds.join(",") : "-"
      const lineageIds = cue.lineageSummaryIds.length > 0 ? cue.lineageSummaryIds.join(",") : "-"
      const archived = cue.summaryType === "archive_stub" ? "yes" : "no"
      lines.push(
        `[cue ${index + 1}] summaryId=${cue.summaryId} summaryType=${cue.summaryType} archived=${archived} score=${cue.score.toFixed(3)} distance=${cue.distance.toFixed(3)} pointerIds=${pointerIds} lineageIds=${lineageIds} cue=${JSON.stringify(cue.cueText)}`,
      )
    }
    lines.push("</memory-cues>")
    return lines.join("\n")
  }

  /**
   * Insert the cue block before the latest user message so the current query remains last.
   */
  export function injectPreResponseMemoryCueBlock(messages: ModelMessage[], cueBlock: string | null): ModelMessage[] {
    if (!cueBlock) return messages
    const lastUserIndex = [...messages].reverse().findIndex((message) => message.role === "user")
    if (lastUserIndex === -1) {
      return [...messages, { role: "user", content: cueBlock }]
    }
    const insertAt = messages.length - 1 - lastUserIndex
    return [...messages.slice(0, insertAt), { role: "user", content: cueBlock }, ...messages.slice(insertAt)]
  }

  async function buildLcmModelMessages(input: {
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort?: AbortSignal
    sessionMessages: MessageV2.WithParts[]
    assistantMessageID?: string
    toolTokenEstimate?: number
  }) {
    const conversationId = await getOrCreateLcmConversation(input.sessionID, input.model)
    if (conversationId === null) {
      throw new Error("failed to get or create LCM conversation for session " + input.sessionID)
    }

    try {
      const syncStart = performance.now()
      await syncSessionMessagesToLcm(conversationId, input.sessionID, input.sessionMessages)
      log.trace("buildLcm.timing.syncToLcm", {
        sessionID: input.sessionID,
        ms: Math.round(performance.now() - syncStart),
      })

      // Two-tier threshold: measure system prompt overhead
      const measureStart = performance.now()
      const systemPromptTokens = await SystemPrompt.measureSystemPromptTokens()
      log.trace("buildLcm.timing.measureSystemTokens", {
        sessionID: input.sessionID,
        ms: Math.round(performance.now() - measureStart),
      })
      const toolTokens = input.toolTokenEstimate ?? 0
      const budget = TokenBudget.computeBudget({
        model: input.model,
        systemPromptTokens,
        toolTokens,
        softThresholdOverride: Number(process.env.VOLTCODE_LCM_CONTEXT_THRESHOLD) || undefined,
      })
      TokenBudget.storeSessionBudget(input.sessionID, budget)
      const overhead = budget.overhead
      const reserve = budget.reserve
      const contextWindow = input.model.limit.context
      const softThresholdOverride = Number(process.env.VOLTCODE_LCM_CONTEXT_THRESHOLD) || undefined
      const thresholdCheck = await LcmContext.isOverThreshold({
        conversationId,
        overhead,
        reserve,
        contextWindow,
        softThresholdOverride,
      })
      const compactionInFlight = LcmContext.isCompactionInFlight(conversationId)

      log.info("building LCM context", {
        sessionID: input.sessionID,
        conversationId,
        currentTokens: thresholdCheck.currentTokens,
        softThreshold: thresholdCheck.softThreshold,
        hardLimit: thresholdCheck.hardLimit,
        overSoft: thresholdCheck.overSoft,
        overHard: thresholdCheck.overHard,
        compactionInFlight,
        systemPromptTokens,
        toolTokens,
        overhead,
        reserve,
      })

      // Publish LCM metrics so the TUI footer can display them.
      // Show input tokens (LCM + overhead) vs the raw --context-threshold flag value
      // so the user sees numbers that match what they specified on the command line.
      const flagThreshold = softThresholdOverride ?? 0
      await Session.update(input.sessionID, (draft) => {
        draft.lcm = {
          inputTokens: thresholdCheck.currentTokens + overhead,
          threshold: flagThreshold,
        }
      })

      if (thresholdCheck.overHard) {
        // Tier 2 (hard limit): MUST compact before proceeding
        log.info("context exceeds hard limit, blocking on compaction", {
          sessionID: input.sessionID,
          conversationId,
          currentTokens: thresholdCheck.currentTokens,
          hardLimit: thresholdCheck.hardLimit,
          systemPromptTokens,
          overhead,
          reserve,
        })

        LcmContext.setCompactionState(input.sessionID, conversationId, true)

        try {
          const compactResult = await LcmContext.compactUntilUnderLimit({
            conversationId,
            sessionID: input.sessionID,
            user: input.user,
            model: input.model,
            abort: input.abort,
            overhead,
            reserve,
            contextWindow,
            softThresholdOverride,
          })

          log.debug("hard-limit compaction returned", {
            sessionID: input.sessionID,
            conversationId,
            success: compactResult.success,
            rounds: compactResult.rounds,
            finalTokens: compactResult.finalTokens,
            hardLimit: compactResult.hardLimit,
          })
          if (!compactResult.success) {
            log.error("hard-limit compaction failed, proceeding anyway", {
              sessionID: input.sessionID,
              conversationId,
              finalTokens: compactResult.finalTokens,
              hardLimit: compactResult.hardLimit,
              rounds: compactResult.rounds,
            })
          }

          await writeLcmContextSnapshotBestEffort({
            conversationId,
            sessionID: input.sessionID,
            reason: "compaction_hard_limit",
          })
        } finally {
          LcmContext.clearCompactionState(input.sessionID)
        }
      } else if (thresholdCheck.overSoft) {
        // Tier 1 (soft threshold): schedule async compaction, proceed immediately
        const job = LcmContext.scheduleCompaction({
          conversationId,
          sessionID: input.sessionID,
          user: input.user,
          model: input.model,
          overhead,
          reserve,
          contextWindow,
          softThresholdOverride,
        })

        if (job) {
          LcmContext.setCompactionState(input.sessionID, conversationId, false)

          const clearCompacting = () => LcmContext.clearCompactionState(input.sessionID)

          if (input.assistantMessageID) {
            // Non-critical: fire and forget, but publish event when done
            const assistantMessageID = input.assistantMessageID
            void job
              .then(async (result) => {
                if (!result?.actionTaken || !result.createdSummary) {
                  log.info("async compaction completed with no action", {
                    sessionID: input.sessionID,
                    conversationId,
                    actionTaken: result?.actionTaken,
                  })
                  return
                }

                const afterTokens = result.newTokenCount ?? (await LcmDb.getContextTokenCount(conversationId))
                const beforeTokens = result.beforeTokenCount ?? afterTokens
                const maxTokens = result.maxTokens ?? budget.hardLimit
                const threshold = result.threshold ?? budget.softThreshold
                const reductionTokens = Math.max(0, beforeTokens - afterTokens)
                const beforePercent = maxTokens > 0 ? (beforeTokens / maxTokens) * 100 : 0
                const afterPercent = maxTokens > 0 ? (afterTokens / maxTokens) * 100 : 0
                const reductionPercent = maxTokens > 0 ? (reductionTokens / maxTokens) * 100 : 0
                const summaryId = result.createdSummary.summaryId
                const summaryKind = result.createdSummary.kind
                const summaryTokenCount = result.createdSummary.tokenCount
                const summaryText = result.createdSummary.content
                const messagesSummarized =
                  result.messagesSummarized ??
                  (summaryKind === "sprig" ? (await LcmDb.getSummaryMessageIds(summaryId)).length : 0)
                const totalSummaries = (await LcmContext.getSummariesInContext(conversationId)).length

                log.info("async compaction completed", {
                  sessionID: input.sessionID,
                  conversationId,
                  summaryId,
                  summaryKind,
                  summaryTokenCount,
                  messagesSummarized,
                  beforeTokens,
                  afterTokens,
                  reductionTokens,
                })

                const event = buildLcmEventPart({
                  sessionID: input.sessionID,
                  messageID: assistantMessageID,
                  text: `LCM summary created: ${summaryId}`,
                  metadata: {
                    type: "summary",
                    summaryId,
                    summaryKind,
                    summaryTokenCount,
                    summaryText,
                    messagesSummarized,
                    condensed: result.condensed,
                    bindleParentSummaryCount: summaryKind === "bindle" ? result.createdSummary.parents.length : 0,
                    totalSummaries,
                    thresholdConstant: LcmContext.DEFAULT_CTX_CUTOFF_THRESHOLD,
                    threshold,
                    maxTokens,
                    beforeTokens,
                    afterTokens,
                    beforePercent,
                    afterPercent,
                    reductionTokens,
                    reductionPercent,
                  },
                })

                await Session.updatePart(event)

                // Update session.lcm so TUI displays the new context size immediately
                await Session.update(input.sessionID, (draft) => {
                  draft.lcm = {
                    inputTokens: afterTokens + overhead,
                    threshold: flagThreshold,
                  }
                })

                await writeLcmContextSnapshotBestEffort({
                  conversationId,
                  sessionID: input.sessionID,
                  reason: "compaction_async_complete",
                })
              })
              .catch((error: unknown) => {
                log.warn("failed to publish async LCM summary event", {
                  sessionID: input.sessionID,
                  conversationId,
                  error,
                })
              })
              .finally(clearCompacting)
          } else {
            void job.finally(clearCompacting)
          }
        }
      }

      const contextStart = performance.now()
      const context = await LcmDb.getCurrentContext(conversationId)
      log.trace("buildLcm.timing.getCurrentContext", {
        sessionID: input.sessionID,
        ms: Math.round(performance.now() - contextStart),
      })

      log.debug("LCM context fetched", {
        conversationId,
        entryCount: context.length,
        byType: {
          message: context.filter((e) => e.item_type === "message").length,
          summary: context.filter((e) => e.item_type === "summary").length,
        },
        totalTokens: context.reduce((s, e) => s + e.token_count, 0),
      })

      // Pre-fetch structured parts for message entries
      const messageIds = context
        .filter((e) => e.item_type === "message" && e.message_id !== null)
        .map((e) => e.message_id!)
      const partsMap =
        messageIds.length > 0
          ? await LcmDb.getMessagePartsForMessages(messageIds)
          : new Map<number, LcmDb.MessagePart[]>()
      const activeSummaryIds = collectActiveSummaryIdsFromContext(context)
      const currentUserMessage = input.sessionMessages.find((message) => message.info.id === input.user.id)
      const retrievalQuery = buildPreResponseRetrievalQuery(currentUserMessage)

      let preResponseCueBlock: string | null = null
      if (retrievalQuery) {
        try {
          const retrieval = await LcmRetrieval.queryOffContextBindles({
            conversationId,
            query: retrievalQuery,
            topK: LCM_PRE_RESPONSE_HOOK_TOP_K,
            minScore: LCM_PRE_RESPONSE_HOOK_MIN_SCORE,
            maxDistance: LCM_PRE_RESPONSE_HOOK_MAX_DISTANCE,
          })
          preResponseCueBlock = formatPreResponseMemoryCueBlock({
            hits: retrieval.hits,
            activeSummaryIds,
            topK: LCM_PRE_RESPONSE_HOOK_TOP_K,
          })
          if (preResponseCueBlock) {
            log.debug("prepared pre-response memory cues", {
              sessionID: input.sessionID,
              conversationId,
              cueCount: retrieval.hits.filter((hit) => !activeSummaryIds.has(hit.summaryId)).length,
            })
          }
        } catch (error) {
          log.warn("failed pre-response off-context retrieval", {
            sessionID: input.sessionID,
            conversationId,
            error,
          })
        }
      }

      // Determine interleaved capability - check model config first, then auto-detect from model ID
      // Models like DeepSeek use reasoning_content field even if not explicitly configured
      const interleavedCap = input.model.capabilities.interleaved
      const modelId = input.model.id.toLowerCase()
      const autoDetectedInterleaved = modelId.includes("deepseek")
      const isInterleavedModel = (typeof interleavedCap === "object" && interleavedCap.field) || autoDetectedInterleaved
      const interleavedField =
        typeof interleavedCap === "object" && interleavedCap.field
          ? interleavedCap.field
          : autoDetectedInterleaved
            ? "reasoning_content"
            : undefined

      // For interleaved models (like DeepSeek), we need to:
      // 1. Parse tool XML and create proper UIMessage format with tool parts
      // 2. Convert to ModelMessage using convertToModelMessages
      // 3. Apply reasoning_content via providerOptions
      if (isInterleavedModel && interleavedField) {
        const uiMessages: UIMessage[] = []
        const reasoningByMessageId: Map<string, string> = new Map()

        for (let i = 0; i < context.length; i++) {
          const entry = context[i]
          const role = mapLcmRoleToModel(entry.role)
          const msgId = `lcm_msg_${i}`

          if (role === "user") {
            const userParts: UIMessage["parts"] = [{ type: "text", text: entry.content }]
            const dbParts = entry.message_id !== null ? partsMap.get(entry.message_id) : undefined
            if (dbParts) {
              for (const dbPart of dbParts) {
                if (dbPart.part_type === "file" && dbPart.file_url && dbPart.file_mime) {
                  userParts.push({
                    type: "file",
                    url: dbPart.file_url,
                    mediaType: dbPart.file_mime,
                    filename: dbPart.file_name ?? undefined,
                  } as any)
                }
              }
            }
            uiMessages.push({
              id: msgId,
              role: "user",
              parts: userParts,
            })
          } else if (role === "assistant") {
            // Check for structured parts
            const dbParts = entry.message_id !== null ? partsMap.get(entry.message_id) : undefined

            if (dbParts && dbParts.length > 0) {
              // Reconstruct from structured parts
              const parts: UIMessage["parts"] = []
              let reasoningContent = ""
              let toolIndex = 0

              for (const dbPart of dbParts) {
                switch (dbPart.part_type) {
                  case "text":
                    if (!dbPart.is_ignored && dbPart.text_content) {
                      parts.push({ type: "text", text: dbPart.text_content })
                    }
                    break
                  case "reasoning":
                    if (dbPart.text_content) {
                      reasoningContent += (reasoningContent ? "\n\n" : "") + dbPart.text_content
                    }
                    break
                  case "tool":
                    if (dbPart.tool_name && (dbPart.tool_status === "completed" || dbPart.tool_status === "error")) {
                      const isError = dbPart.tool_status === "error"
                      parts.push({
                        type: `tool-${dbPart.tool_name}` as `tool-${string}`,
                        state: isError ? "output-error" : "output-available",
                        toolCallId: dbPart.tool_call_id || `lcm_${i}_${toolIndex}`,
                        input: dbPart.tool_input,
                        ...(isError ? { errorText: dbPart.tool_error || "" } : { output: dbPart.tool_output || "" }),
                      } as any)
                      toolIndex++
                    }
                    break
                  // Skip metadata-only part types: patch, file, subtask, compaction, snapshot, step_start, step_finish
                  default:
                    break
                }
              }

              // Skip empty assistant messages - APIs reject them
              if (parts.length > 0) {
                uiMessages.push({
                  id: msgId,
                  role: "assistant",
                  parts,
                })

                if (reasoningContent) {
                  reasoningByMessageId.set(msgId, reasoningContent)
                }
              }
            } else {
              // Fallback: regex parsing for old messages without structured parts
              const reasoningMatch = entry.content.match(/<reasoning>([\s\S]*?)<\/reasoning>/)
              const reasoningContent = reasoningMatch ? reasoningMatch[1].trim() : ""
              let contentWithoutReasoning = entry.content.replace(/<reasoning>[\s\S]*?<\/reasoning>\s*/g, "").trim()

              // Parse tool tags
              const tools = parseToolTagsFromLcm(contentWithoutReasoning)
              const contentWithoutTools = stripLcmMarkers(stripToolTagsFromLcm(contentWithoutReasoning))

              const parts: UIMessage["parts"] = []

              // Add text content if any
              if (contentWithoutTools) {
                parts.push({ type: "text", text: contentWithoutTools })
              }

              // Add tool parts (UIMessage format)
              for (let j = 0; j < tools.length; j++) {
                const tool = tools[j]
                parts.push({
                  type: `tool-${tool.name}` as `tool-${string}`,
                  state: tool.isError ? "output-error" : "output-available",
                  toolCallId: `lcm_${i}_${j}`,
                  input: tool.input,
                  ...(tool.isError ? { errorText: tool.output } : { output: tool.output }),
                } as any)
              }

              // Skip empty assistant messages - APIs reject them
              if (parts.length > 0) {
                uiMessages.push({
                  id: msgId,
                  role: "assistant",
                  parts,
                })

                // Store reasoning for later
                if (reasoningContent) {
                  reasoningByMessageId.set(msgId, reasoningContent)
                }
              }
            }
          }
        }

        // Convert UIMessages to ModelMessages
        const modelMessages = await convertToModelMessages(uiMessages)

        // Debug: Log UIMessages and ModelMessages for LCM tool verification
        log.debug("lcm uiMessages before conversion", {
          count: uiMessages.length,
          uiMessages: uiMessages.map((m) => ({
            id: m.id,
            role: m.role,
            partsCount: m.parts.length,
            parts: m.parts.map((p) => ({
              type: p.type,
              ...(p.type.startsWith("tool-")
                ? {
                    state: (p as any).state,
                    toolCallId: (p as any).toolCallId,
                    hasInput: (p as any).input !== undefined,
                    hasOutput: (p as any).output !== undefined,
                    hasErrorText: (p as any).errorText !== undefined,
                  }
                : {}),
            })),
          })),
        })
        log.debug("lcm modelMessages after conversion", {
          count: modelMessages.length,
          modelMessages: modelMessages.map((m) => ({
            role: m.role,
            contentType: Array.isArray(m.content)
              ? m.content.map((c: any) => c.type)
              : typeof m.content === "string"
                ? "string"
                : "unknown",
            content: Array.isArray(m.content)
              ? m.content.map((c: any) => ({
                  type: c.type,
                  ...(c.type === "tool-call" ? { toolCallId: c.toolCallId, toolName: c.toolName } : {}),
                  ...(c.type === "tool-result" ? { toolCallId: c.toolCallId, toolName: c.toolName } : {}),
                }))
              : typeof m.content === "string"
                ? m.content.slice(0, 100)
                : "unknown",
          })),
        })

        // Apply reasoning_content to assistant messages
        const messages: ModelMessage[] = modelMessages.map((msg, idx) => {
          if (msg.role === "assistant") {
            // Find the original UIMessage to get reasoning
            const uiMsg = uiMessages.find((u) => u.role === "assistant" && uiMessages.indexOf(u) <= idx)
            const reasoning = uiMsg ? reasoningByMessageId.get(uiMsg.id) : ""
            return {
              ...msg,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  [interleavedField]: reasoning || "",
                },
              },
            }
          }
          return msg
        })

        const messagesWithCues = injectPreResponseMemoryCueBlock(messages, preResponseCueBlock)
        log.debug("buildLcmModelMessages: interleaved result", {
          conversationId,
          messageCount: messagesWithCues.length,
          roles: messagesWithCues.map((m) => m.role),
        })
        return messagesWithCues
      }

      // Non-interleaved models: parse tool XML from LCM content into structured messages
      const skippedEmpty: number[] = []
      const messages: ModelMessage[] = context.flatMap((entry, idx): ModelMessage[] => {
        // Skip entries with empty content - APIs reject empty messages
        if (!entry.content.trim()) {
          skippedEmpty.push(idx)
          return []
        }
        const role = mapLcmRoleToModel(entry.role)
        if (role === "user" && entry.message_id !== null) {
          const dbParts = partsMap.get(entry.message_id)
          const fileParts = dbParts?.filter((p) => p.part_type === "file" && p.file_url && p.file_mime)
          if (fileParts && fileParts.length > 0) {
            const content: UserContent = [
              { type: "text", text: entry.content },
              ...fileParts.map((p) => ({
                type: "image" as const,
                image: new URL(p.file_url!),
                mediaType: p.file_mime!,
              })),
            ]
            return [{ role, content }]
          }
        }

        // For assistant messages, parse tool XML into structured tool-call/tool-result messages
        if (role === "assistant") {
          const tools = parseToolTagsFromLcm(entry.content)
          if (tools.length > 0) {
            const textContent = stripLcmMarkers(stripToolTagsFromLcm(entry.content))
            const assistantParts: any[] = []
            if (textContent) {
              assistantParts.push({ type: "text", text: textContent })
            }
            for (let j = 0; j < tools.length; j++) {
              assistantParts.push({
                type: "tool-call",
                toolCallId: `lcm_${idx}_${j}`,
                toolName: tools[j].name,
                input: tools[j].input,
              })
            }
            const result: ModelMessage[] = [{ role: "assistant", content: assistantParts }]
            result.push({
              role: "tool",
              content: tools.map((tool, j) => ({
                type: "tool-result" as const,
                toolCallId: `lcm_${idx}_${j}`,
                toolName: tool.name,
                output: { type: "text" as const, value: tool.output },
              })) as any,
            })
            return result
          }
        }

        return [{ role, content: entry.content }]
      })

      const messagesWithCues = injectPreResponseMemoryCueBlock(messages, preResponseCueBlock)
      log.debug("buildLcmModelMessages: non-interleaved result", {
        conversationId,
        messageCount: messagesWithCues.length,
        skippedEmpty: skippedEmpty.length,
        roles: messagesWithCues.map((m) => m.role),
        contentLengths: messagesWithCues.map((m) =>
          typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length,
        ),
      })
      return messagesWithCues
    } catch (e) {
      log.error("failed to build LCM context", {
        sessionID: input.sessionID,
        error: e,
      })
      throw e
    }
  }

  /**
   * Format a large file result as context text for the model.
   */
  function formatLargeFileContext(result: {
    fileId: string
    filepath: string
    summary: string
    explorerUsed: string
    tokenCount: bigint
  }): string {
    const lines: string[] = []
    lines.push(`[Large File Stored: ${result.fileId}]`)
    lines.push(`[Path: ${result.filepath}]`)
    lines.push(`[Explorer: ${result.explorerUsed}]`)
    lines.push(`[Token Count: ${result.tokenCount}]`)
    lines.push("")
    lines.push("## File Summary")
    lines.push(result.summary)
    lines.push("")
    lines.push(
      "**Note:** The file content is stored as a path reference and read from disk on demand. Spawn a Task sub-agent with the file path to analyze or ask questions about the content.",
    )
    return lines.join("\n")
  }

  /**
   * Handle large user text content by storing it in LCM database.
   * Returns the replacement text with summary, or null if LCM is not available.
   *
   * This is used when users paste very large text content (like log files or
   * large code blocks) directly into their prompt.
   */
  async function handleLargeUserText(input: {
    sessionID: string
    text: string
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<{
    fileId: string
    summary: string
    explorerUsed: string
    tokenCount: number
  } | null> {
    const conversationId = await getOrCreateLcmConversation(input.sessionID, input.model)
    if (conversationId === null) {
      return null
    }

    try {
      // Store the text content in LCM database
      const { fileId, tokenCount } = await LcmDb.insertLargeTextContent({
        conversationId,
        content: input.text,
        mimeType: "text/plain",
        label: `user_prompt_${input.sessionID}_${Date.now()}`,
      })

      // Run exploration to generate a summary
      // Use TextExplorer via the dispatcher with in-memory content
      const explorationResult = await ExploreDispatcher.explore({
        content: input.text,
        mimeType: "text/plain",
        model: input.model,
        abort: input.abort,
      })

      log.info("explored large user text", {
        fileId,
        explorerUsed: explorationResult.explorerUsed,
        tokenCount,
        contentLength: input.text.length,
      })

      return {
        fileId,
        summary: explorationResult.summary,
        explorerUsed: explorationResult.explorerUsed,
        tokenCount,
      }
    } catch (e) {
      log.error("failed to handle large user text", { error: e })
      return null
    }
  }

  /**
   * Format a large user text result as context for the model.
   */
  function formatLargeUserTextContext(result: {
    fileId: string
    summary: string
    explorerUsed: string
    tokenCount: number
    originalLength: number
  }): string {
    const lines: string[] = []
    lines.push(`[Large User Text Stored: ${result.fileId}]`)
    lines.push(`[Original Size: ${result.originalLength} characters (~${result.tokenCount} tokens)]`)
    lines.push(`[Explorer: ${result.explorerUsed}]`)
    lines.push("")
    lines.push("## Content Summary")
    lines.push(result.summary)
    lines.push("")
    lines.push(
      "**Note:** The full user text content is stored in the LCM database. Spawn a Task sub-agent to analyze or ask questions about the content.",
    )
    return lines.join("\n")
  }

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.update(session.id, (draft) => {
        draft.permission = permissions
      })
    }

    if (input.noReply === true) {
      return message
    }

    return loop(input.sessionID)
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const matches = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    const names = matches
      .map((match) => match[1])
      .filter((name) => {
        if (seen.has(name)) return false
        seen.add(name)
        return true
      })
    const resolved = await Promise.all(
      names.map(async (name) => {
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (!agent) return undefined
          return {
            type: "agent",
            name: agent.name,
          } satisfies PromptInput["parts"][number]
        }

        if (stats.isDirectory()) {
          return {
            type: "file",
            url: `file://${filepath}`,
            filename: name,
            mime: "application/x-directory",
          } satisfies PromptInput["parts"][number]
        }

        return {
          type: "file",
          url: `file://${filepath}`,
          filename: name,
          mime: "text/plain",
        } satisfies PromptInput["parts"][number]
      }),
    )
    for (const item of resolved) {
      if (!item) continue
      parts.push(item)
    }
    return parts
  }

  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) return
    match.abort.abort()
    delete s[sessionID]
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }

  export const loop = fn(Identifier.schema("session"), async (sessionID) => {
    const abort = start(sessionID)
    if (!abort) {
      // Another loop is already running - queue up and wait with timeout
      const queuedPromise = new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = state()[sessionID]?.callbacks
        if (!callbacks) {
          reject(new Error("Session loop state disappeared while queuing"))
          return
        }
        callbacks.push({ resolve, reject })
      })
      return queuedPromise
    }

    using _ = defer(() => cancel(sessionID))

    let step = 0
    const session = await Session.get(sessionID)
    while (true) {
      const loopStart = performance.now()
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      log.trace("loop.timing.loadMessages", { sessionID, step, ms: Math.round(performance.now() - loopStart) })

      // On first iteration (session resume), sanitize orphaned tool calls from crashes.
      // Tool parts left in "running" or "pending" status have no matching result and will
      // confuse the model. Mark them as errors so the model sees clean history.
      if (step === 0) {
        const completedCallIDs = new Set<string>()
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            if (part.state.status === "completed" || part.state.status === "error") {
              completedCallIDs.add(part.callID)
            }
          }
        }
        for (const msg of msgs) {
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            if (part.state.status !== "running" && part.state.status !== "pending") continue
            if (completedCallIDs.has(part.callID)) continue
            log.info("sanitizing orphaned tool call from crash", {
              sessionID,
              messageID: msg.info.id,
              partID: part.id,
              tool: part.tool,
              callID: part.callID,
              previousStatus: part.state.status,
            })
            const now = Date.now()
            const updatedPart: MessageV2.ToolPart = {
              ...part,
              state: {
                status: "error",
                input: part.state.input,
                error: "This tool call was interrupted by a previous session crash. The session has been resumed.",
                time: {
                  start: part.state.status === "running" ? part.state.time.start : now,
                  end: now,
                },
              },
            }
            await Session.updatePart(updatedPart)
            // Update the in-memory part so downstream code sees the fix
            const idx = msg.parts.indexOf(part)
            if (idx !== -1) msg.parts[idx] = updatedPart
          }
        }
      }

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      if (
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id
      ) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          async metadata(input) {
            await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          const attachments = result.attachments?.map((attachment) => ({
            ...attachment,
            id: Identifier.ascending("part"),
            messageID: assistantMessage.id,
            sessionID: assistantMessage.sessionID,
          }))
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        // Add synthetic user message to prevent certain reasoning models from erroring
        // If we create assistant messages w/ out user ones following mid loop thinking signatures
        // will be missing and it can cause errors for models like gemini for example
        const summaryUserMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        await Session.updateMessage(summaryUserMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: summaryUserMsg.id,
          sessionID,
          type: "text",
          text: "Summarize the task tool output above and continue with your task.",
          synthetic: true,
        } satisfies MessageV2.TextPart)

        continue
      }

      // pending compaction — LCM handles this, just remove stale compaction parts
      if (task?.type === "compaction") {
        await Session.removePart({
          sessionID: task.sessionID,
          messageID: task.messageID,
          partID: task.id,
        })
        log.info("removed stale compaction task", { sessionID })
        continue
      }

      // normal processing
      const stepStart = performance.now()
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const isLastStep = step >= maxSteps
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })
      log.trace("loop.timing.agentAndReminders", { sessionID, step, ms: Math.round(performance.now() - stepStart) })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const resolveToolsStart = performance.now()
      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
      })
      log.trace("loop.timing.resolveTools", { sessionID, step, ms: Math.round(performance.now() - resolveToolsStart) })

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      const sessionMessages = clone(msgs)

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of sessionMessages) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })

      const toolTokenEstimate = Object.values(tools).reduce((sum, t) => {
        const desc = (t as any).description ?? ""
        const params = (t as any).parameters ? JSON.stringify((t as any).parameters) : ""
        return sum + Token.estimate(desc + params)
      }, 0)

      const lcmStart = performance.now()
      const lcmMessages = await buildLcmModelMessages({
        sessionID,
        user: lastUser,
        model,
        abort,
        sessionMessages: sessionMessages,
        assistantMessageID: processor.message.id,
        toolTokenEstimate,
      })
      log.trace("loop.timing.buildLcmModelMessages", { sessionID, step, ms: Math.round(performance.now() - lcmStart) })

      // Models like Claude Opus don't support assistant message prefill
      // (the last message must be a user message). For these models, inject
      // the max-steps instruction as a system message instead, and strip any
      // trailing assistant messages from the conversation history.
      const supportsPrefill = !model.api.id.toLowerCase().includes("opus")

      // Strip trailing assistant messages for models that don't support prefill.
      // On multi-step iterations the LCM context can end with the previous
      // assistant response, which the Anthropic API rejects for Opus models.
      const finalMessages = !supportsPrefill
        ? (() => {
            let end = lcmMessages.length
            while (end > 0 && lcmMessages[end - 1].role === "assistant") end--
            return end < lcmMessages.length ? lcmMessages.slice(0, end) : lcmMessages
          })()
        : lcmMessages

      const systemStart = performance.now()
      const systemSections = [
        ...(await SystemPrompt.buildSections(
          model,
          await (async () => {
            const provider = await Provider.getProvider(model.providerID)
            const apiKey = provider?.key ?? (provider?.options?.apiKey as string | undefined)
            if (!apiKey || !model.api.url) return undefined
            return { url: model.api.url, model: model.api.id, apiKey }
          })(),
        )),
        ...(isLastStep && !supportsPrefill ? [MAX_STEPS] : []),
      ]
      log.trace("loop.timing.buildSystemPrompt", { sessionID, step, ms: Math.round(performance.now() - systemStart) })

      const processStart = performance.now()
      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system: systemSections,
        messages: [
          ...finalMessages,
          ...(isLastStep && supportsPrefill
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        model,
      })
      log.trace("loop.timing.processorProcess", { sessionID, step, ms: Math.round(performance.now() - processStart) })
      log.trace("loop.timing.totalStep", { sessionID, step, ms: Math.round(performance.now() - loopStart) })
      if (result === "stop") break
      if (result === "reasoning-only") {
        const nudgeMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          time: {
            created: Date.now(),
          },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        await Session.updateMessage(nudgeMsg)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: nudgeMsg.id,
          sessionID,
          type: "text",
          text: "Continue - your previous response contained only internal reasoning. Please provide a visible text response or use a tool to proceed.",
          synthetic: true,
        } satisfies MessageV2.TextPart)
      }
      continue
    }
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = state()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    for (const item of await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
    )) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          const result = await withTimeout(item.execute(args, ctx), TOOL_EXECUTE_TIMEOUT_MS).catch((e) => {
            if (e instanceof Error && e.message.includes("timed out")) {
              log.error("tool execution timed out", { tool: item.id, timeoutMs: TOOL_EXECUTE_TIMEOUT_MS })
              return {
                title: item.id,
                output: `Tool execution timed out after ${TOOL_EXECUTE_TIMEOUT_MS / 1000} seconds. The operation may still be running in the background.`,
                metadata: {},
              }
            }
            throw e
          })
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            result,
          )
          return result
        },
        toModelOutput(result) {
          return {
            type: "text",
            value: result.output,
          }
        },
      })
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      const transformed = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema as JSONSchema7)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const result = await execute(args, opts)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID">[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        return {
          title: "",
          metadata: result.metadata ?? {},
          output: textParts.join("\n\n"),
          attachments,
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      item.toModelOutput = (result) => {
        return {
          type: "text",
          value: result.output,
        }
      }
      tools[key] = item
    }

    return tools
  }

  async function createUserMessage(input: PromptInput) {
    const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))

    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const variant =
      input.variant ??
      (agent.variant &&
      agent.model &&
      model.providerID === agent.model.providerID &&
      model.modelID === agent.model.modelID
        ? agent.variant
        : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
      variant,
    }

    const parts = await Promise.all(
      input.parts.map(async (part) => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: MessageV2.Part[] = [
              {
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                id: part.id ?? Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                id: Identifier.ascending("part"),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              // Handle images with data: URLs - save to session directory
              if (part.mime?.startsWith("image/")) {
                const session = await Session.get(input.sessionID)
                if (session.directory) {
                  try {
                    // Extract base64 data from data URL
                    const match = part.url.match(/^data:image\/[^;]+;base64,(.*)$/)
                    if (match) {
                      const base64Data = match[1]
                      const ext =
                        part.mime === "image/png"
                          ? ".png"
                          : part.mime === "image/jpeg"
                            ? ".jpg"
                            : part.mime === "image/gif"
                              ? ".gif"
                              : part.mime === "image/webp"
                                ? ".webp"
                                : ".png"
                      const filename = part.filename || `image_${Date.now()}${ext}`
                      const filepath = path.join(session.directory, filename)

                      // Decode and save the image
                      const buffer = Buffer.from(base64Data, "base64")
                      await Bun.write(filepath, buffer)

                      // Return file part with file:// URL
                      return [
                        {
                          ...part,
                          id: part.id ?? Identifier.ascending("part"),
                          messageID: info.id,
                          sessionID: input.sessionID,
                          filename,
                          url: `file://${filepath}`,
                        },
                      ]
                    }
                  } catch (e) {
                    log.error("failed to save image to session directory", { error: e, sessionID: input.sessionID })
                  }
                }
                // Fallback: return original part if save fails
                return [
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const stat = await Bun.file(filepath)
                .stat()
                .catch(() => undefined)

              if (stat?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain" && stat) {
                // Check if file is large (exceeds threshold for context inclusion)
                const isLarge = stat.size > LargeFileThreshold.DEFAULT_BYTE_THRESHOLD
                const hasRange = url.searchParams.get("start") != null

                // If file is large and no specific range is requested, try LCM exploration
                if (isLarge && !hasRange) {
                  const model = await Provider.getModel(info.model.providerID, info.model.modelID)

                  // NOTE: We do NOT load the file content here to avoid memory issues with giant files
                  // The handleLargeFile function and dispatcher handle memory limits internally
                  const largeFileResult = await handleLargeFile({
                    sessionID: input.sessionID,
                    filepath,
                    fileSize: stat.size,
                    mimeType: part.mime,
                    model,
                    abort: new AbortController().signal,
                  })

                  // If LCM handling succeeded, return the summary instead of full content
                  if (largeFileResult) {
                    const contextText = formatLargeFileContext({
                      ...largeFileResult,
                      filepath,
                    })
                    const lcmEvent = buildLcmEventPart({
                      sessionID: input.sessionID,
                      messageID: info.id,
                      text: `LCM stored file: ${largeFileResult.fileId}`,
                      metadata: {
                        type: "file",
                        fileId: largeFileResult.fileId,
                        filePath: filepath,
                        mimeType: part.mime,
                        sizeBytes: stat.size,
                        tokenCount: Number(largeFileResult.tokenCount),
                        explorerUsed: largeFileResult.explorerUsed,
                        source: "prompt-file",
                      },
                    })

                    return [
                      lcmEvent,
                      {
                        id: Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: `[Large file detected: ${filepath} (${stat.size} bytes, ~${largeFileResult.tokenCount} tokens)]`,
                      },
                      {
                        id: Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: contextText,
                      },
                      {
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      },
                    ]
                  }

                  // LCM not available, log warning and fall through to normal handling
                  log.warn("large file detected but LCM not available, using normal read", {
                    filepath,
                    size: stat.size,
                  })
                }

                // Normal file handling (small files or LCM unavailable)
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start - 1, 0)
                  if (end) {
                    limit = end - offset
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: MessageV2.Part[] = [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          id: Identifier.ascending("part"),
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        id: part.id ?? Identifier.ascending("part"),
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { path: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ListTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the list tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    id: Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    id: part.id ?? Identifier.ascending("part"),
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              const file = Bun.file(filepath)
              FileTime.read(input.sessionID, filepath)

              // For images, store in LCM and generate exploration summary
              if (part.mime?.startsWith("image/")) {
                const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                const imageResult = await handleLargeFile({
                  sessionID: input.sessionID,
                  filepath,
                  fileSize: file.size,
                  mimeType: part.mime,
                  model,
                  abort: new AbortController().signal,
                })

                if (imageResult) {
                  const contextText = formatLargeFileContext({
                    ...imageResult,
                    filepath,
                  })
                  const lcmEvent = buildLcmEventPart({
                    sessionID: input.sessionID,
                    messageID: info.id,
                    text: `LCM stored image: ${imageResult.fileId}`,
                    metadata: {
                      type: "image",
                      fileId: imageResult.fileId,
                      filePath: filepath,
                      mimeType: part.mime,
                      tokenCount: Number(imageResult.tokenCount),
                      explorerUsed: imageResult.explorerUsed,
                      source: "user-image",
                    },
                  })

                  return [
                    lcmEvent,
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Image stored: ${filepath} (${file.size} bytes, ~${imageResult.tokenCount} tokens)]`,
                    },
                    {
                      id: Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: contextText,
                    },
                    {
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "file",
                      url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                      mime: part.mime,
                      filename: part.filename!,
                      source: part.source,
                    },
                  ]
                }
              }

              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              id: Identifier.ascending("part"),
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        // Check if text part is large enough to store in LCM
        if (part.type === "text" && part.text) {
          const textLength = part.text.length
          const isLargeText = textLength > LargeFileThreshold.DEFAULT_BYTE_THRESHOLD

          if (isLargeText) {
            const model = await Provider.getModel(info.model.providerID, info.model.modelID)

            const largeTextResult = await handleLargeUserText({
              sessionID: input.sessionID,
              text: part.text,
              model,
              abort: new AbortController().signal,
            })

            // If LCM handling succeeded, return the summary instead of full content
            if (largeTextResult) {
              const contextText = formatLargeUserTextContext({
                ...largeTextResult,
                originalLength: textLength,
              })
              const lcmEvent = buildLcmEventPart({
                sessionID: input.sessionID,
                messageID: info.id,
                text: `LCM stored user text: ${largeTextResult.fileId}`,
                metadata: {
                  type: "file",
                  fileId: largeTextResult.fileId,
                  mimeType: "text/plain",
                  tokenCount: largeTextResult.tokenCount,
                  explorerUsed: largeTextResult.explorerUsed,
                  originalLength: textLength,
                  source: "user-text",
                },
              })

              log.info("stored large user text in LCM", {
                fileId: largeTextResult.fileId,
                originalLength: textLength,
                tokenCount: largeTextResult.tokenCount,
              })

              return [
                lcmEvent,
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `[Large user text detected: ${textLength} characters (~${largeTextResult.tokenCount} tokens)]`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: contextText,
                },
              ]
            }

            // LCM not available, log warning and fall through to normal handling
            log.warn("large user text detected but LCM not available, including full text", {
              textLength,
            })
          }
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    )
      .then((x) => x.flat())
      .then((drafts) =>
        drafts.map(
          (part) =>
            ({
              ...part,
              id: Identifier.ascending("part"),
              messageID: info.id,
              sessionID: input.sessionID,
            }) as MessageV2.Part,
        ),
      )

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // Original logic when experimental plan mode is disabled
    if (!Flag.VOLTCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
        })
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "build") {
        userMessage.parts.push({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
        })
      }
      return input.messages
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to build mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Bun.file(plan).exists()
      if (exists) {
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Bun.file(plan).exists()
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: Identifier.schema("session"),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }
    using _ = defer(() => cancel(input.sessionID))

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: Identifier.ascending("part"),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: Identifier.ascending("part"),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)

    if (input.command === "remember") {
      if (!input.arguments.trim()) {
        throw new Error("Please provide text to remember: /remember <text>")
      }
      const { Volt01 } = await import("@/volt01/backend")
      if (!(await Volt01.isConfigured())) {
        throw new Error("Volt01 backend not configured. Add provider.br.options.baseURL to voltcode.json")
      }
      await Volt01.sendRemember({
        repo_id: Instance.project.id,
        session_id: input.sessionID,
        text: input.arguments.trim(),
        scope: "repo",
      })
      return await prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: await lastModel(input.sessionID),
        agent: await Agent.defaultAgent(),
        parts: [
          {
            type: "text",
            text: `Remembered: ${input.arguments.trim()}`,
            synthetic: true,
          },
        ],
      })
    }

    const command = await Command.get(input.command)
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model: await iife(async () => {
        if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
        return (
          (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
        )
      }),
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : await MessageV2.toModelMessage(contextMessages)),
      ],
    })
    const text = await Promise.resolve(result.text).catch((err: unknown) =>
      log.error("failed to generate title", { error: err }),
    )
    if (text)
      return Session.update(input.session.id, (draft) => {
        const cleaned = text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!cleaned) return

        const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
        draft.title = title
      })
  }
}
