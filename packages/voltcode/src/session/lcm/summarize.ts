import { generateText } from "ai"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { Summary } from "./summary"
import { LcmDb } from "./db"
import { getLcmPolicyConfig } from "./config"
import SUMMARIZE_PROMPT from "./prompts/summarize.txt"

/**
 * LCM Summarize Module
 *
 * Provides the summarize function for creating sprig summaries of conversation
 * messages as part of the Lossless Context Management system.
 */
export namespace LcmSummarize {
  const log = Log.create({ service: "lcm.summarize" })
  const LCM_MESSAGE_ID_PATTERN = /^lcm_msg_(\d+)$/

  function resolveDbMessageIds(messages: MessageV2.WithParts[], dbMessageIds?: number[]): number[] {
    if (dbMessageIds && dbMessageIds.length > 0) return dbMessageIds
    const parsed: number[] = []
    for (const message of messages) {
      const match = message.info.id.match(LCM_MESSAGE_ID_PATTERN)
      if (!match) return []
      parsed.push(Number.parseInt(match[1], 10))
    }
    return parsed
  }

  /**
   * Summarize a list of messages into a sprig summary.
   *
   * This function:
   * 1. Reads the summarize prompt from prompts/summarize.md
   * 2. Calls the LLM (using the same model as the main conversation)
   * 3. Creates a Summary object with a deterministic ID
   * 4. Stores the summary using LCMDB.insertSprigSummary()
   * 5. Returns the Summary object
   *
   * @param input - The summarization input
   * @param input.messages - The messages to summarize
   * @param input.conversationId - The LCM conversation ID (numeric)
   * @param input.sessionID - The VoltCode session ID (for LLM context)
   * @param input.user - The user message context for LLM call
   * @returns The created Summary.WithMessages object
   */
  export async function summarize(input: {
    messages: MessageV2.WithParts[]
    conversationId: number
    sessionID: string
    user: MessageV2.User
    /** Numeric DB message IDs to link in summary_messages table */
    dbMessageIds?: number[]
    /** Model to use for summarization (if not provided, uses compaction agent or user model) */
    model?: Provider.Model
    /** Abort signal for cancellation */
    abort?: AbortSignal
  }): Promise<Summary.WithMessages> {
    const inputTokens = input.messages.reduce(
      (sum, m) => sum + m.parts.reduce((ps, p) => ps + (p.type === "text" ? Token.estimate(p.text) : 0), 0),
      0,
    )
    log.info("summarizing messages", {
      conversationId: input.conversationId,
      messageCount: input.messages.length,
      inputTokens,
    })

    // Format messages for the LLM
    const formattedMessages = formatMessagesForSummary(input.messages)

    // Get the model - use provided model, or fall back to user model
    const model = input.model
      ? input.model
      : await Provider.getModel(input.user.model.providerID, input.user.model.modelID)

    const language = await Provider.getLanguage(model)

    // Call the LLM to generate the summary (use generateText directly to avoid
    // streaming/reasoning middleware issues with thinking models)
    const result = await generateText({
      model: language,
      abortSignal: input.abort,
      maxOutputTokens: getLcmPolicyConfig().runtime.summaryMaxOutputTokens,
      messages: [
        {
          role: "system",
          content: SUMMARIZE_PROMPT,
        },
        {
          role: "user",
          content: `<messages>\n${formattedMessages}\n</messages>`,
        },
      ],
    })

    const summaryContent = result.text.trim()

    // Extract file IDs from input messages for structured DB metadata only.
    // We do not append programmatic metadata to summary text.
    const fileIds = extractFileIds(formattedMessages)
    const finalContent = summaryContent

    log.info("summary generated", {
      conversationId: input.conversationId,
      contentLength: finalContent.length,
      outputTokens: Token.estimate(finalContent),
      inputTokens,
      fileIdCount: fileIds.length,
    })

    // Calculate token count for the summary
    const tokenCount = Token.estimate(finalContent)

    // Extract message IDs from the input messages
    const messageIds = input.messages.map((m) => m.info.id)

    // Create the timestamp for deterministic ID generation
    const timestamp = Date.now()

    // Generate deterministic summary ID
    const summaryId = Summary.generateId(finalContent, timestamp)

    // Create the sprig summary info object
    const summaryInfo = Summary.createSprig(
      {
        content: finalContent,
        tokenCount,
        conversationId: input.conversationId.toString(),
        messageIds,
        fileIds,
      },
      timestamp,
    )

    const linkedDbMessageIds = resolveDbMessageIds(input.messages, input.dbMessageIds)

    // Store the summary in the database with linked message IDs.
    // If numeric IDs were not provided, recover them from lcm_msg_<id> placeholders.
    await LcmDb.insertSprigSummary({
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
      content: summaryInfo.content,
      tokenCount: summaryInfo.tokenCount,
      messageIds: linkedDbMessageIds,
      fileIds,
    })

    log.info("summary stored", {
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
      linkedMessageCount: linkedDbMessageIds.length,
    })

    // Return the summary with linked message IDs
    return {
      ...summaryInfo,
      messageIds,
    } satisfies Summary.WithMessages
  }

  /**
   * Format messages for the summarization prompt.
   *
   * Creates a readable representation of the messages that the LLM
   * can understand and summarize effectively.
   *
   * @internal Exported for testing
   */
  export function formatMessagesForSummary(messages: MessageV2.WithParts[]): string {
    const parts: string[] = []

    for (const msg of messages) {
      const role = msg.info.role
      const id = msg.info.id

      parts.push(`[Message ${id}] (${role})`)

      for (const part of msg.parts) {
        switch (part.type) {
          case "text":
            if (!part.ignored) {
              parts.push(part.text)
            }
            break
          case "tool":
            if (part.state.status === "completed") {
              parts.push(`[Tool: ${part.tool}]`)
              parts.push(`Input: ${JSON.stringify(part.state.input)}`)
              // Truncate long outputs - handle non-string output types safely
              const rawOutput = part.state.output
              const output =
                typeof rawOutput === "string" ? rawOutput : rawOutput == null ? "" : JSON.stringify(rawOutput)
              const truncatedOutput = output.length > 1000 ? output.slice(0, 1000) + "..." : output
              parts.push(`Output: ${truncatedOutput}`)
            } else if (part.state.status === "error") {
              parts.push(`[Tool: ${part.tool}] Error: ${part.state.error}`)
            }
            break
          case "reasoning":
            parts.push(`[Reasoning] ${part.text}`)
            break
          case "file":
          case "patch":
            break
          default:
            // Skip other part types (step-start, step-finish, etc.)
            break
        }
      }

      parts.push("") // Empty line between messages
    }

    return parts.join("\n")
  }

  // ---------------------------------------------------------------------------
  // bd-3fa: extractFileIds
  // ---------------------------------------------------------------------------

  /**
   * File ID pattern: "file_" followed by 16 hex characters.
   * Matches IDs in these contexts:
   *   [Large File Stored: file_xxx]
   *   [Large User Text Stored: file_xxx]
   *   LCM File ID: file_xxx
   *   file_id "file_xxx"
   */
  const FILE_ID_PATTERN =
    /\[Large File Stored:\s*(file_[0-9a-f]{16})\]|\[Large User Text Stored:\s*(file_[0-9a-f]{16})\]|LCM File ID:\s*(file_[0-9a-f]{16})|file_id\s+"(file_[0-9a-f]{16})"/g

  /**
   * Extract all file IDs from a text string.
   *
   * Scans for file ID patterns used throughout LCM:
   * - [Large File Stored: file_xxx]
   * - [Large User Text Stored: file_xxx]
   * - LCM File ID: file_xxx
   * - file_id "file_xxx"
   *
   * @param content - The text to scan for file IDs
   * @returns Deduplicated, sorted array of file IDs
   */
  export function extractFileIds(content: string): string[] {
    const ids = new Set<string>()
    const regex = new RegExp(FILE_ID_PATTERN.source, FILE_ID_PATTERN.flags)
    for (const match of content.matchAll(regex)) {
      // Each capture group corresponds to one pattern variant; exactly one will be defined
      const id = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (id) ids.add(id)
    }
    return [...ids].sort()
  }
}

// Re-export individual functions for direct named imports
export const extractFileIds = LcmSummarize.extractFileIds
