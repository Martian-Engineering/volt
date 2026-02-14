import { generateText } from "ai"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { Summary } from "./summary"
import { LcmDb } from "./db"
import SUMMARIZE_PROMPT from "./prompts/summarize.txt"

// Try to import the aggressive prompt; use fallback if the file doesn't exist yet
let SUMMARIZE_AGGRESSIVE_PROMPT: string
try {
  SUMMARIZE_AGGRESSIVE_PROMPT =
    require("./prompts/summarize-aggressive.txt").default ?? require("./prompts/summarize-aggressive.txt")
} catch {
  SUMMARIZE_AGGRESSIVE_PROMPT = [
    "You are a context management assistant. Summarize the provided messages with MAXIMUM brevity.",
    "Keep ONLY: decisions made, artifacts created/modified (with file paths), key conclusions, and all LCM file IDs (file_xxx) and summary IDs (sum_xxx).",
    "Drop: timestamps, intermediate steps, tool input/output details, debugging iterations, verbose explanations.",
    "Target the absolute minimum token count while preserving critical information for conversation continuity.",
  ].join("\n")
}

/**
 * LCM Summarize Module
 *
 * Provides the summarize function for creating leaf summaries of conversation
 * messages as part of the Lossless Context Management system.
 */
export namespace LcmSummarize {
  const log = Log.create({ service: "lcm.summarize" })

  /**
   * Summarize a list of messages into a leaf summary.
   *
   * This function:
   * 1. Reads the summarize prompt from prompts/summarize.md
   * 2. Calls the LLM (using the same model as the main conversation)
   * 3. Creates a Summary object with a deterministic ID
   * 4. Stores the summary using LCMDB.insertLeafSummary()
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

    // Extract file IDs from the input messages and append structured block
    const fileIds = extractFileIds(formattedMessages)
    const finalContent =
      fileIds.length > 0 ? summaryContent + `\n[LCM File IDs: ${fileIds.join(", ")}]` : summaryContent

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

    // Create the leaf summary info object
    const summaryInfo = Summary.createLeaf(
      {
        content: finalContent,
        tokenCount,
        conversationId: input.conversationId.toString(),
        messageIds,
        fileIds,
      },
      timestamp,
    )

    // Store the summary in the database with linked message IDs
    // Use dbMessageIds if provided (numeric DB IDs), otherwise leave empty
    // The caller in context.ts provides the actual DB message IDs
    await LcmDb.insertLeafSummary({
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
      content: summaryInfo.content,
      tokenCount: summaryInfo.tokenCount,
      messageIds: input.dbMessageIds ?? [],
      fileIds,
    })

    log.info("summary stored", {
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
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

  // ---------------------------------------------------------------------------
  // bd-38z: summarizeAggressive
  // ---------------------------------------------------------------------------

  /**
   * Summarize a list of messages into a leaf summary using an aggressive prompt.
   *
   * Works identically to `summarize()` but uses a maximally terse prompt that
   * instructs the LLM to minimize output length while preserving only critical
   * information: decisions, artifacts, conclusions, and all LCM file/summary IDs.
   *
   * @param input - Same parameters as `summarize()`
   * @returns The created Summary.WithMessages object
   */
  export async function summarizeAggressive(input: {
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
    log.info("summarizing messages (aggressive)", {
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

    // Call the LLM with the aggressive prompt
    const result = await generateText({
      model: language,
      abortSignal: input.abort,
      messages: [
        {
          role: "system",
          content: SUMMARIZE_AGGRESSIVE_PROMPT,
        },
        {
          role: "user",
          content: `<messages>\n${formattedMessages}\n</messages>`,
        },
      ],
    })

    const summaryContent = result.text.trim()

    // Extract file IDs from the input messages and append structured block
    const fileIds = extractFileIds(formattedMessages)
    const finalContent =
      fileIds.length > 0 ? summaryContent + `\n[LCM File IDs: ${fileIds.join(", ")}]` : summaryContent

    log.info("aggressive summary generated", {
      conversationId: input.conversationId,
      contentLength: finalContent.length,
      fileIdCount: fileIds.length,
    })

    // Calculate token count for the summary
    const tokenCount = Token.estimate(finalContent)

    // Extract message IDs from the input messages
    const messageIds = input.messages.map((m) => m.info.id)

    // Create the timestamp for deterministic ID generation
    const timestamp = Date.now()

    // Create the leaf summary info object
    const summaryInfo = Summary.createLeaf(
      {
        content: finalContent,
        tokenCount,
        conversationId: input.conversationId.toString(),
        messageIds,
        fileIds,
      },
      timestamp,
    )

    // Store the summary in the database with linked message IDs
    await LcmDb.insertLeafSummary({
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
      content: summaryInfo.content,
      tokenCount: summaryInfo.tokenCount,
      messageIds: input.dbMessageIds ?? [],
      fileIds,
    })

    log.info("aggressive summary stored", {
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
    })

    // Return the summary with linked message IDs
    return {
      ...summaryInfo,
      messageIds,
    } satisfies Summary.WithMessages
  }

  // ---------------------------------------------------------------------------
  // bd-9jw: summarizeFallback
  // ---------------------------------------------------------------------------

  /** Maximum tokens for fallback truncation */
  const FALLBACK_MAX_TOKENS = 512

  /**
   * Create a deterministic fallback summary by truncating text and preserving file IDs.
   *
   * This function does NOT call the LLM. It:
   * 1. Truncates the summary text to FALLBACK_MAX_TOKENS worth of characters (~4 chars/token)
   * 2. Extracts all file IDs from the original messages
   * 3. Appends a structured ID block and truncation notice
   * 4. Returns a Summary.WithMessages compatible object
   *
   * Used as a last resort when both normal and aggressive summarization fail to
   * produce output smaller than the input, guaranteeing convergence.
   *
   * @param input.summaryText - The summary text to truncate (from aggressive or normal summarization)
   * @param input.messages - The original messages (used to extract file IDs)
   * @param input.conversationId - The LCM conversation ID (numeric)
   * @param input.dbMessageIds - Numeric DB message IDs to link in summary_messages table
   * @returns The created Summary.WithMessages object
   */
  export async function summarizeFallback(input: {
    summaryText: string
    messages: MessageV2.WithParts[]
    conversationId: number
    dbMessageIds?: number[]
  }): Promise<Summary.WithMessages> {
    const originalTokens = Token.estimate(input.summaryText)
    const maxChars = FALLBACK_MAX_TOKENS * 4

    // Truncate the summary text
    const truncated = input.summaryText.length > maxChars ? input.summaryText.slice(0, maxChars) : input.summaryText

    // Extract file IDs from all original message content
    const allContent = input.messages.map((m) => formatMessagesForSummary([m])).join("\n")
    const fileIds = extractFileIds(allContent)

    // Build the structured block
    const blocks: string[] = [truncated]
    if (fileIds.length > 0) {
      blocks.push(`[LCM File IDs: ${fileIds.join(", ")}]`)
    }
    blocks.push(`[Truncated from ${originalTokens} tokens to ${FALLBACK_MAX_TOKENS} tokens]`)

    const finalContent = blocks.join("\n")
    const tokenCount = Token.estimate(finalContent)

    // Extract message IDs from the input messages
    const messageIds = input.messages.map((m) => m.info.id)

    // Create the timestamp for deterministic ID generation
    const timestamp = Date.now()

    // Create the leaf summary info object
    const summaryInfo = Summary.createLeaf(
      {
        content: finalContent,
        tokenCount,
        conversationId: input.conversationId.toString(),
        messageIds,
      },
      timestamp,
    )

    // Store the summary in the database with linked message IDs
    await LcmDb.insertLeafSummary({
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
      content: summaryInfo.content,
      tokenCount: summaryInfo.tokenCount,
      messageIds: input.dbMessageIds ?? [],
    })

    log.info("fallback summary stored", {
      summaryId: summaryInfo.summaryId,
      conversationId: input.conversationId,
      originalTokens,
      fallbackTokens: tokenCount,
      fileIdCount: fileIds.length,
    })

    // Return the summary with linked message IDs
    return {
      ...summaryInfo,
      messageIds,
    } satisfies Summary.WithMessages
  }
}

// Re-export individual functions for direct named imports
export const extractFileIds = LcmSummarize.extractFileIds
export const summarizeAggressive = LcmSummarize.summarizeAggressive
export const summarizeFallback = LcmSummarize.summarizeFallback
