import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { LcmDb } from "./db"
import { LcmSummarize } from "./summarize"
import { Condense } from "./condense"
import { Summary } from "./summary"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"

/**
 * Read the LCM context threshold at call time, not module load time.
 * Flag.VOLTCODE_LCM_CONTEXT_THRESHOLD is a const evaluated at import time,
 * before the CLI handler sets process.env. This function reads the env var
 * directly so --context-threshold actually works.
 */
function getContextThresholdFlag(): number | undefined {
  const v = process.env.VOLTCODE_LCM_CONTEXT_THRESHOLD
  if (!v) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * LCM Context Management Module
 *
 * Implements the on_context_threshold_reached() handler that manages
 * context compression when the context window exceeds the threshold.
 *
 * Algorithm (from prompt.md pseudocode):
 * 1. Find existing summaries in context
 * 2. Find messages in context
 * 3. Summarize messages into a leaf summary
 * 4. Append to existing summaries
 * 5. If still over threshold, condense all summaries
 */
export namespace LcmContext {
  const log = Log.create({ service: "lcm.context" })
  const inFlightCompactions = new Map<number, Promise<ContextHandlerResult | null>>()

  // In-memory compaction state tracking (not persisted)
  interface CompactionState {
    sessionID: string
    conversationId: number
    startedAt: number
    blocking: boolean
  }
  const compactionStates = new Map<string, CompactionState>() // keyed by sessionID

  // Events for compaction state changes
  export const Event = {
    CompactionStarted: BusEvent.define(
      "lcm.compaction.started",
      z.object({
        sessionID: z.string(),
        conversationId: z.number(),
        blocking: z.boolean(),
      }),
    ),
    CompactionEnded: BusEvent.define(
      "lcm.compaction.ended",
      z.object({
        sessionID: z.string(),
        conversationId: z.number(),
      }),
    ),
  }

  /**
   * Get compaction state for a session (in-memory only)
   */
  export function getCompactionState(sessionID: string): { startedAt: number; blocking: boolean } | null {
    const state = compactionStates.get(sessionID)
    return state ? { startedAt: state.startedAt, blocking: state.blocking } : null
  }

  /**
   * Mark a session as compacting (in-memory only)
   */
  export function setCompactionState(sessionID: string, conversationId: number, blocking: boolean): void {
    const state: CompactionState = {
      sessionID,
      conversationId,
      startedAt: Date.now(),
      blocking,
    }
    compactionStates.set(sessionID, state)
    log.info("compaction state set", { sessionID, conversationId, blocking })
    Bus.publish(Event.CompactionStarted, { sessionID, conversationId, blocking })
  }

  /**
   * Clear compaction state for a session (in-memory only)
   */
  export function clearCompactionState(sessionID: string): void {
    const state = compactionStates.get(sessionID)
    if (state) {
      const durationMs = Date.now() - state.startedAt
      compactionStates.delete(sessionID)
      log.info("compaction state cleared", {
        sessionID,
        conversationId: state.conversationId,
        durationMs,
        durationSec: Math.round(durationMs / 1000),
      })
      Bus.publish(Event.CompactionEnded, { sessionID, conversationId: state.conversationId })
    } else {
      log.warn("clearCompactionState called but no state found", { sessionID })
    }
  }

  /**
   * Default context cutoff threshold (60% of context window)
   */
  export const DEFAULT_CTX_CUTOFF_THRESHOLD = 0.6

  /**
   * Target percentage of context to free up when summarizing (25%)
   * This determines the token budget for selecting messages to summarize.
   */
  export const TARGET_FREE_PERCENTAGE = 0.25

  /**
   * Minimum number of messages to summarize at once
   * (avoid summarizing too few messages which would be inefficient)
   */
  export const MIN_MESSAGES_TO_SUMMARIZE = 3

  /**
   * Critical threshold multiplier - when context is this far over threshold,
   * we lower the minimum messages requirement to ensure progress is made.
   * At 1.2 = 20% over threshold, we'll summarize even 1-2 messages.
   */
  export const CRITICAL_THRESHOLD_MULTIPLIER = 1.2

  /**
   * Maximum number of compaction rounds before giving up.
   * Each round attempts to reduce context size via three-level summarization escalation.
   */
  export const MAX_COMPACTION_ROUNDS = 10

  /**
   * Result of the context threshold check and handling
   */
  export interface ContextHandlerResult {
    /** Whether the context was over threshold and action was taken */
    actionTaken: boolean
    /** New token count after processing (if action was taken) */
    newTokenCount?: number
    /** Summary that was created (if any) */
    createdSummary?: Summary.Info
    /** Whether condensation was performed */
    condensed: boolean
    /** Token count before compaction started */
    beforeTokenCount?: number
    /** Model max tokens for the conversation */
    maxTokens?: number
    /** Cutoff threshold used */
    threshold?: number
    /** Number of messages summarized in the leaf summary */
    messagesSummarized?: number
    /** Which summarization level was used: 'normal' | 'aggressive' | 'fallback' */
    summarizationLevel?: string
    /** Which condensation level was used: 'normal' | 'aggressive' | 'fallback' */
    condensationLevel?: string
  }

  /**
   * Check if the current context exceeds the threshold.
   *
   * Accepts pre-computed budget values from TokenBudget:
   * - overhead: systemPromptTokens + toolTokens (always includes tool tokens)
   * - reserve: output token reserve
   * - contextWindow: model.limit.context
   * - softThresholdOverride: from --context-threshold flag
   *
   * @returns Whether the context is over soft/hard threshold and token counts
   */
  export async function isOverThreshold(input: {
    conversationId: number
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<{
    overHard: boolean
    overSoft: boolean
    currentTokens: number
    hardLimit: number
    softThreshold: number
  }> {
    const currentTokens = await LcmDb.getContextTokenCount(input.conversationId)
    const hardLimit = input.contextWindow - input.overhead - input.reserve
    const softRaw = (input.softThresholdOverride ?? Math.floor(input.contextWindow * 0.6)) - input.overhead
    const softThreshold = Math.max(0, Math.min(softRaw, hardLimit))

    log.debug("isOverThreshold", {
      conversationId: input.conversationId,
      currentTokens,
      softThreshold,
      hardLimit,
      contextWindow: input.contextWindow,
      overhead: input.overhead,
      reserve: input.reserve,
      softThresholdOverride: input.softThresholdOverride ?? "none",
      overSoft: currentTokens > softThreshold,
      overHard: currentTokens > hardLimit,
    })

    return {
      overHard: currentTokens > hardLimit,
      overSoft: currentTokens > softThreshold,
      currentTokens,
      hardLimit,
      softThreshold,
    }
  }

  /**
   * Get summaries currently in the context.
   *
   * @param conversationId - The LCM conversation ID
   * @returns List of summary info objects in context order
   */
  export async function getSummariesInContext(conversationId: number): Promise<Summary.Info[]> {
    const context = await LcmDb.getCurrentContext(conversationId)
    const summaries: Summary.Info[] = []

    for (const entry of context) {
      if (entry.item_type === "summary") {
        // Extract summary ID from the formatted content
        // Format: [Summary ID: sum_xxx]
        const match = entry.content.match(/\[Summary ID: (sum_[a-f0-9]{16})\]/)
        if (match) {
          const summaryId = match[1]
          const summary = await LcmDb.getSummaryById(summaryId)
          if (summary) {
            summaries.push({
              summaryId: summary.summary_id,
              content: summary.content,
              kind: summary.kind,
              tokenCount: summary.token_count,
              conversationId: conversationId.toString(),
              parents: summary.kind === "condensed" ? await LcmDb.getSummaryParentIds(summary.summary_id) : [],
              fileIds: summary.file_ids,
              createdAt: summary.created_at.getTime(),
            })
          }
        }
      }
    }

    return summaries
  }

  /**
   * Get messages currently in the context (not summaries).
   *
   * @param conversationId - The LCM conversation ID
   * @returns List of message entries with their positions
   */
  export async function getMessagesInContext(
    conversationId: number,
  ): Promise<{ position: number; messageId: number; role: LcmDb.MessageRole; content: string; tokenCount: number }[]> {
    const messages: {
      position: number
      messageId: number
      role: LcmDb.MessageRole
      content: string
      tokenCount: number
    }[] = []

    // Get the context items to find message IDs
    const conn = LcmDb.getConnection()
    const contextItems = await conn<{ position: number; message_id: number }[]>`
      SELECT position, message_id
      FROM context_items
      WHERE conversation_id = ${conversationId}
        AND item_type = 'message'::context_item_type
      ORDER BY position
    `

    for (const item of contextItems) {
      const msg = await LcmDb.getMessage(item.message_id)
      if (msg) {
        messages.push({
          position: item.position,
          messageId: msg.message_id,
          role: msg.role,
          content: msg.content,
          tokenCount: msg.token_count,
        })
      }
    }

    return messages
  }

  /**
   * Main handler called when context threshold is reached.
   *
   * Implements the algorithm from prompt.md:
   * 1. Find existing summaries in context
   * 2. Find messages in context
   * 3. Summarize messages into a leaf summary
   * 4. Replace messages with summary in context
   * 5. If still over threshold, condense all summaries
   *
   * @param input - The input parameters
   * @param input.conversationId - The LCM conversation ID (numeric)
   * @param input.sessionID - The VoltCode session ID (for LLM context)
   * @param input.user - The user message context for LLM calls
   * @param input.model - The provider model to use
   * @param input.abort - Optional abort signal
   * @returns Result indicating what actions were taken
   */
  export async function onContextThresholdReached(input: {
    conversationId: number
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort?: AbortSignal
    force?: boolean
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<ContextHandlerResult> {
    log.info("context threshold reached, starting compression", {
      conversationId: input.conversationId,
      force: input.force,
    })

    // Check if we're actually over threshold
    const thresholdCheck = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    const baseResult = {
      beforeTokenCount: thresholdCheck.currentTokens,
      maxTokens: input.contextWindow,
      threshold: thresholdCheck.softThreshold / input.contextWindow,
    }
    if (!thresholdCheck.overSoft && !input.force) {
      log.info("context not over threshold, skipping compression", {
        conversationId: input.conversationId,
        currentTokens: thresholdCheck.currentTokens,
        softThreshold: thresholdCheck.softThreshold,
      })
      return { actionTaken: false, condensed: false, ...baseResult }
    }

    // Step 1: Find existing summaries in context
    const existingSummaries = await getSummariesInContext(input.conversationId)

    // Step 2: Gather all messages currently in context (snapshot at job start)
    const messagesInContext = await getMessagesInContext(input.conversationId)
    log.info("found context items", {
      conversationId: input.conversationId,
      summaryCount: existingSummaries.length,
      messageCount: messagesInContext.length,
    })

    // If there are no messages to summarize, we can only try condensing summaries
    if (messagesInContext.length === 0) {
      if (existingSummaries.length >= 1) {
        log.info("no messages, attempting to condense existing summaries", {
          conversationId: input.conversationId,
          summaryCount: existingSummaries.length,
        })
        const condensationResult = await attemptCondensation(input, existingSummaries)
        return {
          ...condensationResult,
          ...baseResult,
          messagesSummarized: 0,
        }
      }

      log.info("no messages or summaries to compress", {
        conversationId: input.conversationId,
        summaryCount: existingSummaries.length,
      })
      return { actionTaken: false, condensed: false, ...baseResult, messagesSummarized: 0 }
    }

    // Step 3: Summarize messages into a leaf summary
    // Limit messages to fit within the model's context window for the summarization call.
    // Use 75% of the model's context to leave room for the system prompt and output.
    const conversation = await LcmDb.getConversation(input.conversationId)
    const modelMaxTokens = conversation?.model_ctx_max_tokens ?? 128000
    const maxSummarizationInputTokens = Math.floor(modelMaxTokens * 0.75)

    let selectedMessages = messagesInContext
    let tokenAccum = 0
    for (let i = 0; i < messagesInContext.length; i++) {
      tokenAccum += messagesInContext[i].tokenCount
      if (tokenAccum > maxSummarizationInputTokens) {
        const cutoff = Math.max(i, MIN_MESSAGES_TO_SUMMARIZE)
        selectedMessages = messagesInContext.slice(0, cutoff)
        log.info("limiting messages for summarization to fit model context", {
          conversationId: input.conversationId,
          totalMessages: messagesInContext.length,
          selectedMessages: selectedMessages.length,
          tokenBudget: maxSummarizationInputTokens,
          tokenAccum,
        })
        break
      }
    }

    // Convert LcmDb messages to MessageV2.WithParts format for summarization
    const messagesToSummarize = await convertToMessageV2(selectedMessages)

    // Extract numeric DB message IDs to pass to the summarizer for proper linking
    const dbMessageIds = selectedMessages.map((m) => m.messageId)

    // Step 3: Summarize messages with three-level escalation
    const inputTokens = selectedMessages.reduce((sum, m) => sum + m.tokenCount, 0)
    const summarizeParams = {
      messages: messagesToSummarize,
      conversationId: input.conversationId,
      sessionID: input.sessionID,
      user: input.user,
      dbMessageIds,
      model: input.model,
      abort: input.abort,
    }

    // Level 1: Normal summarization
    let leafSummary = await LcmSummarize.summarize(summarizeParams)
    let summarizationLevel = "normal"

    // Convergence check: summary must be strictly smaller than input
    if (leafSummary.tokenCount >= inputTokens) {
      log.info("normal summary not smaller than input, escalating to aggressive", {
        summaryTokens: leafSummary.tokenCount,
        inputTokens,
      })
      // Level 2: Aggressive
      leafSummary = await LcmSummarize.summarizeAggressive(summarizeParams)
      summarizationLevel = "aggressive"

      if (leafSummary.tokenCount >= inputTokens) {
        log.info("aggressive summary not smaller than input, escalating to fallback", {
          summaryTokens: leafSummary.tokenCount,
          inputTokens,
        })
        // Level 3: Fallback (deterministic, guaranteed smaller)
        leafSummary = await LcmSummarize.summarizeFallback({
          summaryText: leafSummary.content,
          messages: messagesToSummarize,
          conversationId: input.conversationId,
          dbMessageIds,
        })
        summarizationLevel = "fallback"
      }
    }

    log.info("created leaf summary", {
      summaryId: leafSummary.summaryId,
      tokenCount: leafSummary.tokenCount,
      messageCount: selectedMessages.length,
      summarizationLevel,
    })

    // Step 4: Replace the snapshot messages with the summary in context
    // Note: Message links are now stored by LcmSummarize.summarize() via dbMessageIds
    const positions = selectedMessages.map((m) => m.position)
    await LcmDb.replacePositionsWithSummary({
      conversationId: input.conversationId,
      positions,
      summaryId: leafSummary.summaryId,
    })

    log.info("replaced messages with summary in context", {
      conversationId: input.conversationId,
      replacedCount: positions.length,
      summaryId: leafSummary.summaryId,
    })

    // Step 5: Check if still over threshold
    const newThresholdCheck = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    if (!newThresholdCheck.overSoft) {
      log.info("context now under threshold after summarization", {
        conversationId: input.conversationId,
        newTokenCount: newThresholdCheck.currentTokens,
      })
      return {
        actionTaken: true,
        newTokenCount: newThresholdCheck.currentTokens,
        createdSummary: leafSummary,
        condensed: false,
        messagesSummarized: selectedMessages.length,
        summarizationLevel,
        ...baseResult,
      }
    }

    // Step 6: Still over threshold, condense all summaries (even a single one can be re-condensed)
    const allSummaries = await getSummariesInContext(input.conversationId)
    if (allSummaries.length >= 1) {
      log.info("still over threshold, condensing summaries", {
        conversationId: input.conversationId,
        summaryCount: allSummaries.length,
      })

      const condensationResult = await attemptCondensation(input, allSummaries)
      return {
        actionTaken: true,
        newTokenCount: condensationResult.newTokenCount,
        createdSummary: condensationResult.createdSummary,
        condensed: true,
        messagesSummarized: selectedMessages.length,
        summarizationLevel,
        condensationLevel: condensationResult.condensationLevel,
        ...baseResult,
      }
    }

    // No summaries to condense (shouldn't normally happen since we just created one)
    log.info("context still over threshold but no summaries to condense", {
      conversationId: input.conversationId,
      summaryCount: allSummaries.length,
    })

    return {
      actionTaken: true,
      newTokenCount: newThresholdCheck.currentTokens,
      createdSummary: leafSummary,
      condensed: false,
      messagesSummarized: messagesInContext.length,
      summarizationLevel,
      ...baseResult,
    }
  }

  /**
   * Attempt to condense summaries into one.
   *
   * When there are multiple summaries, they are merged into a single condensed summary.
   * When there is only a single summary, it is re-condensed to make it more compact.
   * This ensures we always make progress toward reducing context size.
   *
   * @param input - The base input parameters
   * @param summaries - The summaries to condense (1 or more)
   * @returns Result of the condensation attempt
   */
  async function attemptCondensation(
    input: {
      conversationId: number
      sessionID: string
      user: MessageV2.User
      model: Provider.Model
      abort?: AbortSignal
    },
    summaries: Summary.Info[],
  ): Promise<ContextHandlerResult> {
    if (summaries.length < 1) {
      log.debug("attemptCondensation: no summaries to condense")
      return { actionTaken: false, condensed: false }
    }

    const inputTokens = summaries.reduce((sum, s) => sum + s.tokenCount, 0)
    log.debug("attemptCondensation", {
      conversationId: input.conversationId,
      summaryCount: summaries.length,
      inputTokens,
      summaryIds: summaries.map((s) => s.summaryId),
    })
    const condenseParams = {
      summaries,
      conversationId: input.conversationId.toString(),
      dbConversationId: input.conversationId,
      model: input.model,
      abort: input.abort,
    }

    // Level 1: Normal condensation
    let condensedSummary = await Condense.condenseSummaries(condenseParams)
    let condensationLevel = "normal"

    // Convergence check: condensed must be strictly smaller than input
    if (condensedSummary.tokenCount >= inputTokens) {
      log.info("normal condensation not smaller, escalating to aggressive", {
        condensedTokens: condensedSummary.tokenCount,
        inputTokens,
      })
      // Level 2: Aggressive
      condensedSummary = await Condense.condenseSummariesAggressive(condenseParams)
      condensationLevel = "aggressive"

      if (condensedSummary.tokenCount >= inputTokens) {
        log.info("aggressive condensation not smaller, escalating to fallback", {
          condensedTokens: condensedSummary.tokenCount,
          inputTokens,
        })
        // Level 3: Fallback (deterministic, guaranteed smaller)
        condensedSummary = await Condense.condenseFallback(condenseParams)
        condensationLevel = "fallback"
      }
    }

    log.info("created condensed summary", {
      summaryId: condensedSummary.summaryId,
      tokenCount: condensedSummary.tokenCount,
      parentCount: summaries.length,
      condensationLevel,
    })

    // Find positions of all the summaries in context and replace with condensed
    const context = await LcmDb.getCurrentContext(input.conversationId)
    const summaryIds = new Set(summaries.map((s) => s.summaryId))
    const positions: number[] = []

    for (const entry of context) {
      if (entry.item_type === "summary") {
        const match = entry.content.match(/\[Summary ID: (sum_[a-f0-9]{16})\]/)
        if (match && summaryIds.has(match[1])) {
          positions.push(entry.position)
        }
      }
    }

    if (positions.length > 0) {
      // Use replacePositionsWithSummary to only remove the specific summary positions,
      // preserving any messages that may be between them (fixes bd-1vx)
      await LcmDb.replacePositionsWithSummary({
        conversationId: input.conversationId,
        positions,
        summaryId: condensedSummary.summaryId,
      })

      log.info("replaced summaries with condensed summary in context", {
        conversationId: input.conversationId,
        replacedCount: summaries.length,
        summaryId: condensedSummary.summaryId,
      })
    }

    const newTokenCount = await LcmDb.getContextTokenCount(input.conversationId)
    return {
      actionTaken: true,
      newTokenCount,
      createdSummary: condensedSummary,
      condensed: true,
      condensationLevel,
    }
  }

  /**
   * Convert LcmDb messages to MessageV2.WithParts format for the summarizer.
   *
   * This creates a minimal representation since the summarizer primarily
   * needs the text content and role information.
   *
   * Role mapping:
   * - "user" -> "user"
   * - "assistant" -> "assistant"
   * - "system" -> "user" (system prompts are user-side)
   * - "tool" -> "assistant" (tool results are part of assistant turns)
   */
  async function convertToMessageV2(
    messages: { position: number; messageId: number; role: LcmDb.MessageRole; content: string; tokenCount: number }[],
  ): Promise<MessageV2.WithParts[]> {
    return messages.map((msg) => {
      // Map LcmDb roles to MessageV2 roles (only "user" | "assistant" supported)
      const mappedRole: "user" | "assistant" = msg.role === "user" || msg.role === "system" ? "user" : "assistant"

      const baseInfo = {
        id: `lcm_msg_${msg.messageId}`,
        sessionID: "",
        role: mappedRole,
        time: { created: Date.now() },
      }

      // Create a text part with the message content
      const textPart: MessageV2.TextPart = {
        id: `lcm_part_${msg.messageId}`,
        sessionID: "",
        messageID: baseInfo.id,
        type: "text",
        text: msg.content,
        time: { start: Date.now(), end: Date.now() },
      }

      return {
        info: baseInfo as MessageV2.Info,
        parts: [textPart],
      }
    })
  }

  /**
   * Schedule an asynchronous compaction job for a conversation.
   *
   * Returns a promise for the compaction result if a new job was scheduled,
   * or null if a job is already running for this conversation.
   */
  /**
   * Check if a compaction job is currently in flight for a conversation.
   */
  export function isCompactionInFlight(conversationId: number): boolean {
    return inFlightCompactions.has(conversationId)
  }

  export function scheduleCompaction(input: {
    conversationId: number
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<ContextHandlerResult | null> | null {
    if (inFlightCompactions.has(input.conversationId)) {
      log.debug("scheduleCompaction: already in flight", { conversationId: input.conversationId })
      return null
    }

    log.debug("scheduleCompaction: launching async compaction", {
      conversationId: input.conversationId,
      sessionID: input.sessionID,
    })

    const job = (async () => {
      try {
        return await onContextThresholdReached({
          conversationId: input.conversationId,
          sessionID: input.sessionID,
          user: input.user,
          model: input.model,
          overhead: input.overhead,
          reserve: input.reserve,
          contextWindow: input.contextWindow,
          softThresholdOverride: input.softThresholdOverride,
        })
      } catch (error) {
        log.warn("async compaction failed", { conversationId: input.conversationId, error })
        return null
      }
    })()

    inFlightCompactions.set(input.conversationId, job)
    job.finally(() => {
      inFlightCompactions.delete(input.conversationId)
    })

    return job
  }

  /**
   * Compact context until it is under the given hard limit.
   *
   * Runs up to MAX_COMPACTION_ROUNDS of compaction. Each round calls
   * onContextThresholdReached() (which uses three-level escalation) and
   * rechecks context size. Stops when:
   * - Context is under the hard limit
   * - Compaction made no progress (no token reduction)
   * - MAX_COMPACTION_ROUNDS exhausted
   *
   * @param input - The compaction parameters
   * @returns Result with success status and diagnostics
   */
  export async function compactUntilUnderLimit(input: {
    conversationId: number
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort?: AbortSignal
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<{
    success: boolean
    rounds: number
    finalTokens: number
    hardLimit: number
  }> {
    log.debug("compactUntilUnderLimit entry", {
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
    })

    const initialCheck = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })

    if (initialCheck.currentTokens <= initialCheck.hardLimit) {
      log.debug("compactUntilUnderLimit: already under limit", {
        conversationId: input.conversationId,
        currentTokens: initialCheck.currentTokens,
        hardLimit: initialCheck.hardLimit,
      })
      return {
        success: true,
        rounds: 0,
        finalTokens: initialCheck.currentTokens,
        hardLimit: initialCheck.hardLimit,
      }
    }

    log.info("starting hard-limit compaction loop", {
      sessionID: input.sessionID,
      conversationId: input.conversationId,
      currentTokens: initialCheck.currentTokens,
      hardLimit: initialCheck.hardLimit,
      overhead: input.overhead,
      reserve: input.reserve,
    })

    let lastTokenCount = initialCheck.currentTokens
    for (let round = 1; round <= MAX_COMPACTION_ROUNDS; round++) {
      log.debug("compactUntilUnderLimit: starting round", {
        conversationId: input.conversationId,
        round,
        lastTokenCount,
        hardLimit: initialCheck.hardLimit,
      })
      const result = await onContextThresholdReached({
        conversationId: input.conversationId,
        sessionID: input.sessionID,
        user: input.user,
        model: input.model,
        abort: input.abort,
        force: true,
        overhead: input.overhead,
        reserve: input.reserve,
        contextWindow: input.contextWindow,
        softThresholdOverride: input.softThresholdOverride,
      })

      const recheck = await isOverThreshold({
        conversationId: input.conversationId,
        overhead: input.overhead,
        reserve: input.reserve,
        contextWindow: input.contextWindow,
        softThresholdOverride: input.softThresholdOverride,
      })

      log.info("hard-limit compaction round completed", {
        sessionID: input.sessionID,
        round,
        beforeTokens: lastTokenCount,
        afterTokens: recheck.currentTokens,
        hardLimit: recheck.hardLimit,
        actionTaken: result.actionTaken,
        summarizationLevel: result.summarizationLevel,
        condensationLevel: result.condensationLevel,
      })

      if (recheck.currentTokens <= recheck.hardLimit) {
        return {
          success: true,
          rounds: round,
          finalTokens: recheck.currentTokens,
          hardLimit: recheck.hardLimit,
        }
      }

      if (!result.actionTaken || recheck.currentTokens >= lastTokenCount) {
        log.error("compaction made no progress, cannot reduce context further", {
          sessionID: input.sessionID,
          conversationId: input.conversationId,
          currentTokens: recheck.currentTokens,
          hardLimit: recheck.hardLimit,
          round,
        })
        return {
          success: false,
          rounds: round,
          finalTokens: recheck.currentTokens,
          hardLimit: recheck.hardLimit,
        }
      }

      lastTokenCount = recheck.currentTokens
    }

    // Exhausted all rounds
    const finalCheck = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    log.error("context exceeds hard limit after max compaction rounds", {
      sessionID: input.sessionID,
      conversationId: input.conversationId,
      currentTokens: finalCheck.currentTokens,
      hardLimit: finalCheck.hardLimit,
      maxRounds: MAX_COMPACTION_ROUNDS,
    })

    return {
      success: false,
      rounds: MAX_COMPACTION_ROUNDS,
      finalTokens: finalCheck.currentTokens,
      hardLimit: finalCheck.hardLimit,
    }
  }

  /**
   * Check and handle context threshold for a conversation.
   *
   * This is a convenience function that combines isOverThreshold check
   * with onContextThresholdReached handler.
   *
   * @param input - The input parameters
   * @returns Result indicating what actions were taken (or null if under threshold)
   */
  export async function checkAndHandle(input: {
    conversationId: number
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort?: AbortSignal
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<ContextHandlerResult | null> {
    const check = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    if (!check.overSoft) {
      return null
    }

    return await onContextThresholdReached(input)
  }
}
