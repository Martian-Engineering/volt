import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { LcmDb } from "./db"
import { LcmSummarize } from "./summarize"
import { Condense } from "./condense"
import { Summary } from "./summary"
import { LcmGhostCue } from "./ghost-cue"
import { getLcmPolicyConfig } from "./config"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { TokenBudget } from "@/session/token-budget"
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
 * 3. Summarize messages into a sprig summary
 * 4. Append to existing summaries
 * 5. If still over threshold, condense all summaries
 */
export namespace LcmContext {
  const log = Log.create({ service: "lcm.context" })
  type LaneCompactionState = Record<TokenBudget.LaneName, boolean>
  const laneCompactionStateByConversation = new Map<number, LaneCompactionState>()

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
    GhostCueSkipped: BusEvent.define(
      "lcm.ghost-cue.skipped",
      z.object({
        conversationId: z.number(),
        mode: z.enum(["dolt", "upward"]),
        reason: z.string(),
        evictedBindleIds: z.array(z.string()),
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
  export const DEFAULT_CTX_CUTOFF_THRESHOLD = getLcmPolicyConfig().runtime.defaultCtxCutoffThreshold

  /**
   * Target percentage of context to free up when summarizing (25%)
   * This determines the token budget for selecting messages to summarize.
   */
  export const TARGET_FREE_PERCENTAGE = getLcmPolicyConfig().runtime.targetFreePercentage

  /**
   * Minimum number of messages to summarize at once
   * (avoid summarizing too few messages which would be inefficient)
   */
  export const MIN_MESSAGES_TO_SUMMARIZE = getLcmPolicyConfig().runtime.minMessagesToSummarize

  /**
   * Minimum leaves required to form a sprig summary.
   * Prevents one-leaf sprigs in high-pressure edge cases.
   */
  export const MIN_LEAVES_PER_SPRIG = getLcmPolicyConfig().strategies.dolt.leaves.minFanout

  /**
   * Fresh-tail protection is preferred at lanePolicy.leaves.freshTailFloor.
   * Under sustained pressure we may relax down to this minimum.
   */
  export const MIN_PROTECTED_TAIL_LEAVES = getLcmPolicyConfig().runtime.minProtectedTailLeaves

  /**
   * Critical threshold multiplier - when context is this far over threshold,
   * we lower the minimum messages requirement to ensure progress is made.
   * At 1.2 = 20% over threshold, we'll summarize even 1-2 messages.
   */
  export const CRITICAL_THRESHOLD_MULTIPLIER = getLcmPolicyConfig().runtime.criticalThresholdMultiplier

  /**
   * Maximum number of compaction rounds before giving up.
   * Each round attempts to reduce context size via lane-aware compaction.
   */
  export const MAX_COMPACTION_ROUNDS = getLcmPolicyConfig().runtime.maxCompactionRounds
  export const DEFAULT_UPWARD_LEAF_CHUNK_TOKENS = 20_000

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
    /** Number of messages summarized in the sprig summary */
    messagesSummarized?: number
    /** Active bindles evicted from context due to overflow */
    evictedBindleIds?: string[]
    /** Archive stubs generated for evicted bindles */
    archiveStubIds?: string[]
    /** Why manual compaction could not take action on specific stages */
    noOpReasons?: string[]
  }

  export interface TurnMessageInContext {
    position: number
    messageId: number
    role: LcmDb.MessageRole
    content: string
    tokenCount: number
  }

  interface ActiveSummaryForCompaction extends Summary.Info {
    position: number
    condensationOrder: number
    summaryType: Summary.Type
  }

  function normalizeLaneCompactionState(
    state?: Partial<Record<TokenBudget.LaneName, boolean>> | null,
  ): LaneCompactionState {
    return {
      leaves: Boolean(state?.leaves),
      sprigs: Boolean(state?.sprigs),
      bindles: Boolean(state?.bindles),
    }
  }

  function persistLaneCompactionState(conversationId: number, nextState: LaneCompactionState): void {
    if (!nextState.leaves && !nextState.sprigs && !nextState.bindles) {
      laneCompactionStateByConversation.delete(conversationId)
      return
    }
    laneCompactionStateByConversation.set(conversationId, nextState)
  }

  /**
   * Test-only helper for clearing lane hysteresis latch state.
   */
  export function clearLaneCompactionStateForTesting(conversationId?: number): void {
    if (conversationId == null) {
      laneCompactionStateByConversation.clear()
      return
    }
    laneCompactionStateByConversation.delete(conversationId)
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
    laneTokens?: Partial<TokenBudget.LaneTokenCounts>
    currentlyCompacting?: Partial<Record<TokenBudget.LaneName, boolean>>
  }): Promise<{
    overHard: boolean
    overSoft: boolean
    currentTokens: number
    hardLimit: number
    softThreshold: number
    lanePolicy: TokenBudget.DoltLanePolicy
    laneTokens: TokenBudget.LaneTokenCounts
    laneDecisions: TokenBudget.DoltLaneDecisions
  }> {
    const currentTokens = await LcmDb.getContextTokenCount(input.conversationId)
    const measuredLaneTokens = await LcmDb.getContextLaneTokenCounts(input.conversationId)
    const hardLimit = input.contextWindow - input.overhead - input.reserve
    const softRaw =
      (input.softThresholdOverride ??
        Math.floor(input.contextWindow * getLcmPolicyConfig().runtime.defaultCtxCutoffThreshold)) -
      input.overhead
    const softThreshold = Math.max(0, Math.min(softRaw, hardLimit))
    const lanePolicy = TokenBudget.computeLanePolicy({ hardLimit })
    const laneTokens: TokenBudget.LaneTokenCounts = {
      leaves: Math.max(0, Math.floor(input.laneTokens?.leaves ?? measuredLaneTokens.leaves)),
      sprigs: Math.max(0, Math.floor(input.laneTokens?.sprigs ?? measuredLaneTokens.sprigs)),
      bindles: Math.max(0, Math.floor(input.laneTokens?.bindles ?? measuredLaneTokens.bindles)),
      total: Math.max(0, Math.floor(input.laneTokens?.total ?? currentTokens)),
    }
    const currentlyCompacting = normalizeLaneCompactionState(
      input.currentlyCompacting ?? laneCompactionStateByConversation.get(input.conversationId),
    )
    const laneDecisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens,
      policy: lanePolicy,
      hardLimit,
      currentlyCompacting,
    })
    persistLaneCompactionState(input.conversationId, laneDecisions.nextCompacting)

    log.debug("isOverThreshold", {
      conversationId: input.conversationId,
      currentTokens,
      softThreshold,
      hardLimit,
      laneTokens,
      laneDecisions,
      currentlyCompacting,
      contextWindow: input.contextWindow,
      overhead: input.overhead,
      reserve: input.reserve,
      softThresholdOverride: input.softThresholdOverride ?? "none",
      overSoft: laneDecisions.compactAny,
      overHard: currentTokens > hardLimit,
    })

    return {
      overHard: currentTokens > hardLimit,
      overSoft: laneDecisions.compactAny,
      currentTokens,
      hardLimit,
      softThreshold,
      lanePolicy,
      laneTokens,
      laneDecisions,
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
              condensationOrder: summary.condensation_order,
              summaryType: summary.summary_type,
              tokenCount: summary.token_count,
              conversationId: conversationId.toString(),
              parents: summary.kind === "bindle" ? await LcmDb.getSummaryParentIds(summary.summary_id) : [],
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
  ): Promise<TurnMessageInContext[]> {
    const messages: TurnMessageInContext[] = []

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
   * Resolve the upward leaf-trigger chunk token threshold.
   */
  export function resolveUpwardLeafChunkTokens(): number {
    return DEFAULT_UPWARD_LEAF_CHUNK_TOKENS
  }

  /**
   * Sum raw message tokens before the fresh-tail boundary.
   *
   * The fresh-tail boundary is based on the last `freshTailCount` raw messages
   * in the active context.
   */
  export async function countRawTokensOutsideFreshTail(input: {
    conversationId: number
    freshTailCount: number
  }): Promise<number> {
    const freshTailCount = Math.max(0, Math.floor(input.freshTailCount))
    const messages = await getMessagesInContext(input.conversationId)
    const freshTailStart = Math.max(0, messages.length - freshTailCount)

    return messages
      .slice(0, freshTailStart)
      .reduce((sum, message) => sum + Math.max(0, Math.floor(message.tokenCount)), 0)
  }

  /**
   * Select the oldest leaf window for L0->L1 compaction while protecting a fresh tail.
   *
   * The selected window is a prefix of message leaves and never includes messages from the
   * protected tail region. If no eligible window can be formed at the preferred tail size,
   * the tail can relax down to a configured minimum. Selection enforces a minimum leaf count
   * so we never create one-leaf sprigs.
   */
  export function selectLeavesForSprigCompaction(input: {
    messages: TurnMessageInContext[]
    tokenBudget: number
    protectedTailCount: number
    minimumProtectedTailCount?: number
    minimumSelectionCount?: number
  }): {
    selectedMessages: TurnMessageInContext[]
    protectedTailMessages: TurnMessageInContext[]
    effectiveProtectedTailCount: number
  } {
    const tokenBudget = Math.max(1, Math.floor(input.tokenBudget))
    const preferredProtectedTailCount = Math.max(0, Math.floor(input.protectedTailCount))
    const policyConfig = getLcmPolicyConfig()
    const runtimePolicy = policyConfig.runtime
    const activeModePolicy = policyConfig.strategies[policyConfig.mode]
    const minimumProtectedTailCount = Math.max(
      0,
      Math.min(
        preferredProtectedTailCount,
        Math.floor(input.minimumProtectedTailCount ?? runtimePolicy.minProtectedTailLeaves),
      ),
    )
    const minimumSelectionCount = Math.max(
      1,
      Math.floor(input.minimumSelectionCount ?? activeModePolicy.leaves.minFanout),
    )

    function computeSelection(protectedTailCount: number): {
      selectedMessages: TurnMessageInContext[]
      protectedTailMessages: TurnMessageInContext[]
    } {
      const protectedStart = Math.max(0, input.messages.length - protectedTailCount)
      const eligible = input.messages.slice(0, protectedStart)
      const protectedTailMessages = input.messages.slice(protectedStart)

      if (eligible.length < minimumSelectionCount) {
        return { selectedMessages: [], protectedTailMessages }
      }

      const selectedMessages: TurnMessageInContext[] = []
      let tokens = 0
      for (const message of eligible) {
        const nextTokens = tokens + Math.max(0, message.tokenCount)
        if (selectedMessages.length >= minimumSelectionCount && nextTokens > tokenBudget) break
        selectedMessages.push(message)
        tokens = nextTokens
        if (tokens >= tokenBudget && selectedMessages.length >= minimumSelectionCount) break
      }

      if (selectedMessages.length < minimumSelectionCount) {
        return { selectedMessages: [], protectedTailMessages }
      }

      return { selectedMessages, protectedTailMessages }
    }

    const preferredSelection = computeSelection(preferredProtectedTailCount)
    if (preferredSelection.selectedMessages.length > 0) {
      return {
        ...preferredSelection,
        effectiveProtectedTailCount: preferredProtectedTailCount,
      }
    }

    for (
      let protectedTailCount = preferredProtectedTailCount - 1;
      protectedTailCount >= minimumProtectedTailCount;
      protectedTailCount--
    ) {
      const relaxedSelection = computeSelection(protectedTailCount)
      if (relaxedSelection.selectedMessages.length > 0) {
        return {
          ...relaxedSelection,
          effectiveProtectedTailCount: protectedTailCount,
        }
      }
    }

    return {
      selectedMessages: [],
      protectedTailMessages: input.messages.slice(Math.max(0, input.messages.length - preferredProtectedTailCount)),
      effectiveProtectedTailCount: preferredProtectedTailCount,
    }
  }

  async function evictOverflowBindles(input: {
    conversationId: number
    lanePolicy: TokenBudget.DoltLanePolicy
    laneTokens: TokenBudget.LaneTokenCounts
    laneDecisions: TokenBudget.DoltLaneDecisions
    model: Provider.Model
    abort?: AbortSignal
    maxEvictions?: number
    evictWhenOverTarget?: boolean
  }): Promise<{ evictedBindleIds: string[]; archiveStubIds: string[]; newTokenCount: number }> {
    const shouldCompactBindles = input.evictWhenOverTarget
      ? input.laneTokens.bindles > input.lanePolicy.bindles.target
      : input.laneDecisions.bindles.shouldCompact
    if (!shouldCompactBindles) {
      return { evictedBindleIds: [], archiveStubIds: [], newTokenCount: input.laneTokens.total }
    }

    const activeBindles = await LcmDb.getActiveBindlesInContext(input.conversationId)
    if (activeBindles.length === 0) {
      return { evictedBindleIds: [], archiveStubIds: [], newTokenCount: input.laneTokens.total }
    }

    const evictedBindles: LcmDb.ActiveContextBindle[] = []
    let projectedBindleTokens = input.laneTokens.bindles
    const maxEvictions = input.maxEvictions ? Math.max(1, Math.floor(input.maxEvictions)) : Number.POSITIVE_INFINITY
    for (const bindle of activeBindles) {
      if (evictedBindles.length >= maxEvictions) break
      if (projectedBindleTokens <= input.lanePolicy.bindles.target) break
      evictedBindles.push(bindle)
      projectedBindleTokens = Math.max(0, projectedBindleTokens - bindle.token_count)
    }

    if (evictedBindles.length === 0) {
      return { evictedBindleIds: [], archiveStubIds: [], newTokenCount: input.laneTokens.total }
    }

    const evictedBindleIds = evictedBindles.map((bindle) => bindle.summary_id)
    await LcmDb.removeContextPositions({
      conversationId: input.conversationId,
      positions: evictedBindles.map((bindle) => bindle.position),
    })
    await LcmDb.setSummariesOffContext(evictedBindleIds, true)

    const policyConfig = getLcmPolicyConfig()
    const activeMode = policyConfig.mode
    const ghostCueArchiveEnabled =
      activeMode === "dolt" && policyConfig.strategies[activeMode].ghostCueArchiveEnabled
    if (!ghostCueArchiveEnabled) {
      const newTokenCount = await LcmDb.getContextTokenCount(input.conversationId)
      log.info("skipping ghost cue archive generation for evicted bindles", {
        conversationId: input.conversationId,
        mode: activeMode,
        evictedBindleIds,
      })
      void Bus.publish(Event.GhostCueSkipped, {
        conversationId: input.conversationId,
        mode: activeMode,
        reason: "mode_policy_disabled",
        evictedBindleIds,
      }).catch((error) => {
        log.debug("failed to publish ghost cue skipped event", {
          conversationId: input.conversationId,
          mode: activeMode,
          error,
        })
      })
      return { evictedBindleIds, archiveStubIds: [], newTokenCount }
    }

    const archiveStubIds: string[] = []
    for (const [index, bindle] of evictedBindles.entries()) {
      const ghostCueContent = await LcmGhostCue.generateWithFallback({
        bindleId: bindle.summary_id,
        bindleContent: bindle.content,
        model: input.model,
        abort: input.abort,
      })
      const archiveStub = Summary.createArchiveStub(
        {
          archivedSummaryId: bindle.summary_id,
          ghostCueContent,
          conversationId: input.conversationId.toString(),
        },
        Date.now() + index,
      )

      await LcmDb.insertBindleSummary({
        summaryId: archiveStub.summaryId,
        conversationId: input.conversationId,
        content: archiveStub.content,
        tokenCount: archiveStub.tokenCount,
        parentSummaryIds: [],
      })
      await LcmDb.markSummaryAsArchiveStub(archiveStub.summaryId)
      await LcmDb.upsertSummaryLineagePointers({
        summaryId: archiveStub.summaryId,
        pointers: [{ pointsToSummaryId: bindle.summary_id, pointerKind: "archive_stub" }],
      })

      archiveStubIds.push(archiveStub.summaryId)
    }

    const newTokenCount = await LcmDb.getContextTokenCount(input.conversationId)
    log.info("evicted overflow bindles to archive", {
      conversationId: input.conversationId,
      evictedBindleIds,
      archiveStubIds,
      bindlesBefore: input.laneTokens.bindles,
      bindlesAfter: projectedBindleTokens,
      bindleTarget: input.lanePolicy.bindles.target,
      newTokenCount,
    })
    return { evictedBindleIds, archiveStubIds, newTokenCount }
  }

  /**
   * Main handler called when context threshold is reached.
   *
   * Implements the algorithm from prompt.md:
   * 1. Find existing summaries in context
   * 2. Find messages in context
   * 3. Summarize messages into a sprig summary
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
    let thresholdCheck = await isOverThreshold({
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

    const evictedBindleIds: string[] = []
    const archiveStubIds: string[] = []
    const bindleEvictionResult = await evictOverflowBindles({
      conversationId: input.conversationId,
      lanePolicy: thresholdCheck.lanePolicy,
      laneTokens: thresholdCheck.laneTokens,
      laneDecisions: thresholdCheck.laneDecisions,
      model: input.model,
      abort: input.abort,
    })
    if (bindleEvictionResult.evictedBindleIds.length > 0) {
      evictedBindleIds.push(...bindleEvictionResult.evictedBindleIds)
      archiveStubIds.push(...bindleEvictionResult.archiveStubIds)

      thresholdCheck = await isOverThreshold({
        conversationId: input.conversationId,
        overhead: input.overhead,
        reserve: input.reserve,
        contextWindow: input.contextWindow,
        softThresholdOverride: input.softThresholdOverride,
      })
      if (!thresholdCheck.overSoft && !input.force) {
        return {
          actionTaken: true,
          condensed: false,
          newTokenCount: bindleEvictionResult.newTokenCount,
          evictedBindleIds,
          archiveStubIds,
          ...baseResult,
        }
      }
    }

    const sprigsOverTarget = thresholdCheck.laneTokens.sprigs > thresholdCheck.lanePolicy.sprigs.target
    if (
      !thresholdCheck.laneDecisions.leaves.shouldCompact &&
      !thresholdCheck.laneDecisions.sprigs.shouldCompact &&
      !sprigsOverTarget &&
      !input.force
    ) {
      return {
        actionTaken: evictedBindleIds.length > 0,
        condensed: false,
        newTokenCount: thresholdCheck.currentTokens,
        messagesSummarized: 0,
        evictedBindleIds,
        archiveStubIds,
        ...baseResult,
      }
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

    const activeSprigSummaries = existingSummaries.filter((summary) => summary.kind === "sprig")
    if (sprigsOverTarget && activeSprigSummaries.length > 0) {
      log.info("sprig lane over target, compacting all active sprigs into bindle lane", {
        conversationId: input.conversationId,
        sprigSummaryCount: activeSprigSummaries.length,
        sprigTokens: thresholdCheck.laneTokens.sprigs,
        sprigSoft: thresholdCheck.lanePolicy.sprigs.soft,
        sprigDelta: thresholdCheck.lanePolicy.sprigs.delta,
        sprigTarget: thresholdCheck.lanePolicy.sprigs.target,
        sprigShouldCompactByBand: thresholdCheck.laneDecisions.sprigs.shouldCompact,
      })
      const condensationResult = await attemptCondensation(input, existingSummaries)
      return {
        ...condensationResult,
        actionTaken: condensationResult.actionTaken || evictedBindleIds.length > 0,
        ...baseResult,
        messagesSummarized: 0,
        evictedBindleIds,
        archiveStubIds,
      }
    }

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
          actionTaken: condensationResult.actionTaken || evictedBindleIds.length > 0,
          ...baseResult,
          messagesSummarized: 0,
          evictedBindleIds,
          archiveStubIds,
        }
      }

      log.info("no messages or summaries to compress", {
        conversationId: input.conversationId,
        summaryCount: existingSummaries.length,
      })
      return {
        actionTaken: evictedBindleIds.length > 0,
        condensed: false,
        ...baseResult,
        messagesSummarized: 0,
        evictedBindleIds,
        archiveStubIds,
      }
    }

    // Step 3: Summarize messages into a sprig summary
    // Limit messages to fit within the model's context window for the summarization call.
    // Use 75% of the model's context to leave room for the system prompt and output.
    const conversation = await LcmDb.getConversation(input.conversationId)
    const modelMaxTokens = conversation?.model_ctx_max_tokens ?? 128000
    const maxSummarizationInputTokens = Math.floor(modelMaxTokens * 0.75)

    const protectedTailCount = thresholdCheck.lanePolicy.leaves.freshTailFloor
    const leavesOverTarget = Math.max(1, thresholdCheck.laneTokens.leaves - thresholdCheck.lanePolicy.leaves.target)
    const eligibleLeafCount = Math.max(0, messagesInContext.length - protectedTailCount)
    const eligibleLeafTokens = messagesInContext
      .slice(0, eligibleLeafCount)
      .reduce((sum, message) => sum + Math.max(0, message.tokenCount), 0)
    const selectionTokenBudget = Math.min(Math.max(1, eligibleLeafTokens), maxSummarizationInputTokens)
    const { selectedMessages, protectedTailMessages, effectiveProtectedTailCount } = selectLeavesForSprigCompaction({
      messages: messagesInContext,
      tokenBudget: selectionTokenBudget,
      protectedTailCount,
      minimumProtectedTailCount: protectedTailCount,
      minimumSelectionCount: thresholdCheck.lanePolicy.leaves.minFanout,
    })

    if (selectedMessages.length === 0) {
      log.info("no eligible leaves for sprig compaction after fresh-tail protection and minimum sprig size", {
        conversationId: input.conversationId,
        totalMessages: messagesInContext.length,
        preferredProtectedTailCount: protectedTailCount,
        effectiveProtectedTailCount,
        minimumProtectedTailCount: getLcmPolicyConfig().runtime.minProtectedTailLeaves,
        minimumSelectionCount: thresholdCheck.lanePolicy.leaves.minFanout,
      })
      return {
        actionTaken: evictedBindleIds.length > 0,
        condensed: false,
        ...baseResult,
        messagesSummarized: 0,
        evictedBindleIds,
        archiveStubIds,
      }
    }

    log.info("selected leaf window for sprig compaction", {
      conversationId: input.conversationId,
      totalMessages: messagesInContext.length,
      selectedMessages: selectedMessages.length,
      selectedTokens: selectedMessages.reduce((sum, m) => sum + m.tokenCount, 0),
      tokenBudget: selectionTokenBudget,
      leavesOverTarget,
      preferredProtectedTailCount: protectedTailCount,
      effectiveProtectedTailCount,
      protectedTailMessages: protectedTailMessages.length,
      protectedTailPositions: protectedTailMessages.map((m) => m.position),
    })

    // Convert LcmDb messages to MessageV2.WithParts format for summarization
    const messagesToSummarize = await convertToMessageV2(selectedMessages)

    // Extract numeric DB message IDs to pass to the summarizer for proper linking
    const dbMessageIds = selectedMessages.map((m) => m.messageId)

    // Step 3: Summarize messages into a sprig summary.
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

    const sprigSummary = await LcmSummarize.summarize(summarizeParams)

    // Convergence check: summary should be strictly smaller than input.
    if (sprigSummary.tokenCount >= inputTokens) {
      log.warn("summary not smaller than input; skipping sprig compaction round", {
        summaryTokens: sprigSummary.tokenCount,
        inputTokens,
        conversationId: input.conversationId,
      })
      return {
        actionTaken: evictedBindleIds.length > 0,
        condensed: false,
        ...baseResult,
        messagesSummarized: 0,
        evictedBindleIds,
        archiveStubIds,
      }
    }

    log.info("created sprig summary", {
      summaryId: sprigSummary.summaryId,
      tokenCount: sprigSummary.tokenCount,
      messageCount: selectedMessages.length,
    })

    // Step 4: Replace the snapshot messages with the summary in context
    // Note: Message links are now stored by LcmSummarize.summarize() via dbMessageIds
    const positions = selectedMessages.map((m) => m.position)
    await LcmDb.replacePositionsWithSummary({
      conversationId: input.conversationId,
      positions,
      summaryId: sprigSummary.summaryId,
    })

    log.info("replaced messages with summary in context", {
      conversationId: input.conversationId,
      replacedCount: positions.length,
      summaryId: sprigSummary.summaryId,
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
        createdSummary: sprigSummary,
        condensed: false,
        messagesSummarized: selectedMessages.length,
        evictedBindleIds,
        archiveStubIds,
        ...baseResult,
      }
    }

    // Step 6: Still over threshold, condense eligible sprig summaries into a bindle
    const allSummaries = await getSummariesInContext(input.conversationId)
    if (allSummaries.length >= 1) {
      log.info("still over threshold, condensing summaries", {
        conversationId: input.conversationId,
        summaryCount: allSummaries.length,
      })

      const condensationResult = await attemptCondensation(input, allSummaries)
      return {
        actionTaken: true,
        newTokenCount: condensationResult.newTokenCount ?? newThresholdCheck.currentTokens,
        createdSummary: condensationResult.createdSummary ?? sprigSummary,
        condensed: condensationResult.condensed,
        messagesSummarized: selectedMessages.length,
        evictedBindleIds,
        archiveStubIds,
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
      createdSummary: sprigSummary,
      condensed: false,
      messagesSummarized: messagesInContext.length,
      evictedBindleIds,
      archiveStubIds,
      ...baseResult,
    }
  }

  /**
   * Manual short-bindling flow used by `/compact`.
   *
   * Steps:
   * 1. If leaves exceed the protected live tail, summarize all oldest leaves
   *    into one sprig (preserving the last N leaves in context).
   * 2. Condense all active sprigs into one bindle (ignores sprig lane pressure).
   * 3. If bindle lane is above target, evict exactly one oldest bindle and
   *    in Dolt mode generate/archive its ghost cue pointer.
   */
  export async function compactShortBindle(input: {
    conversationId: number
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort?: AbortSignal
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<ContextHandlerResult> {
    const initialThreshold = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    const baseResult = {
      beforeTokenCount: initialThreshold.currentTokens,
      maxTokens: input.contextWindow,
      threshold: initialThreshold.softThreshold / input.contextWindow,
    }

    let actionTaken = false
    let condensed = false
    let messagesSummarized = 0
    let createdSummary: Summary.Info | undefined
    const evictedBindleIds: string[] = []
    const archiveStubIds: string[] = []
    const noOpReasons: string[] = []

    const protectedTailCount = Math.max(1, Math.floor(initialThreshold.lanePolicy.leaves.freshTailFloor))
    const messagesInContext = await getMessagesInContext(input.conversationId)
    const eligibleLeafCount = Math.max(0, messagesInContext.length - protectedTailCount)
    if (eligibleLeafCount >= initialThreshold.lanePolicy.leaves.minFanout) {
      const selectedMessages = messagesInContext.slice(0, eligibleLeafCount)
      const inputTokens = selectedMessages.reduce((sum, m) => sum + m.tokenCount, 0)
      const messagesToSummarize = await convertToMessageV2(selectedMessages)
      const dbMessageIds = selectedMessages.map((m) => m.messageId)
      const sprigSummary = await LcmSummarize.summarize({
        messages: messagesToSummarize,
        conversationId: input.conversationId,
        sessionID: input.sessionID,
        user: input.user,
        dbMessageIds,
        model: input.model,
        abort: input.abort,
      })

      if (sprigSummary.tokenCount < inputTokens) {
        await LcmDb.replacePositionsWithSummary({
          conversationId: input.conversationId,
          positions: selectedMessages.map((m) => m.position),
          summaryId: sprigSummary.summaryId,
        })
        actionTaken = true
        messagesSummarized = selectedMessages.length
        createdSummary = sprigSummary
      } else {
        log.warn("short-bindle leaf summarization was not smaller than input; skipping leaf replacement", {
          conversationId: input.conversationId,
          inputTokens,
          summaryTokens: sprigSummary.tokenCount,
        })
        noOpReasons.push("leaf_summary_not_smaller_than_input")
      }
    } else {
      log.info("short-bindle leaf step skipped: not enough leaves beyond protected tail", {
        conversationId: input.conversationId,
        totalLeaves: messagesInContext.length,
        protectedTailCount,
        eligibleLeafCount,
        minimumLeavesPerSprig: initialThreshold.lanePolicy.leaves.minFanout,
      })
      noOpReasons.push("eligible_leaves_below_min")
    }

    const summariesAfterLeafStep = await getSummariesInContext(input.conversationId)
    const sprigCount = summariesAfterLeafStep.filter((summary) => summary.kind === "sprig").length
    if (sprigCount > 0) {
      const condensationResult = await attemptCondensation(input, summariesAfterLeafStep)
      if (condensationResult.actionTaken) {
        actionTaken = true
        condensed = condensationResult.condensed
        if (condensationResult.createdSummary) {
          createdSummary = condensationResult.createdSummary
        }
      }
    } else {
      noOpReasons.push("no_sprigs_to_bindle")
    }

    const postCondenseThreshold = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    const bindleEvictionResult = await evictOverflowBindles({
      conversationId: input.conversationId,
      lanePolicy: postCondenseThreshold.lanePolicy,
      laneTokens: postCondenseThreshold.laneTokens,
      laneDecisions: postCondenseThreshold.laneDecisions,
      model: input.model,
      abort: input.abort,
      maxEvictions: 1,
      evictWhenOverTarget: true,
    })
    if (bindleEvictionResult.evictedBindleIds.length > 0) {
      actionTaken = true
      evictedBindleIds.push(...bindleEvictionResult.evictedBindleIds)
      archiveStubIds.push(...bindleEvictionResult.archiveStubIds)
    } else if (postCondenseThreshold.laneTokens.bindles > postCondenseThreshold.lanePolicy.bindles.target) {
      noOpReasons.push("bindles_over_target_but_no_evictable_bindle")
    } else {
      noOpReasons.push("bindles_within_target")
    }

    const finalTokens =
      bindleEvictionResult.evictedBindleIds.length > 0
        ? bindleEvictionResult.newTokenCount
        : await LcmDb.getContextTokenCount(input.conversationId)

    return {
      actionTaken,
      condensed,
      createdSummary,
      messagesSummarized,
      evictedBindleIds,
      archiveStubIds,
      newTokenCount: finalTokens,
      noOpReasons: noOpReasons.length > 0 ? [...new Set(noOpReasons)] : [],
      ...baseResult,
    }
  }

  /**
   * Manual recursive compaction flow used by `/compact` in upward mode.
   *
   * Steps:
   * 1. Summarize all eligible oldest leaves into one sprig (preserve fresh tail).
   * 2. Force recursive condensation by level:
   *    - d1 sprigs -> d2 bindle
   *    - d2 bindles -> d3 bindle
   *    - ... continue until fanout constraints block the next level.
   * 3. Never evict bindles in this mode.
   */
  export async function compactForcedRecursive(input: {
    conversationId: number
    sessionID: string
    user: MessageV2.User
    model: Provider.Model
    abort?: AbortSignal
    overhead: number
    reserve: number
    contextWindow: number
    softThresholdOverride?: number
  }): Promise<ContextHandlerResult> {
    const initialThreshold = await isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
    })
    const baseResult = {
      beforeTokenCount: initialThreshold.currentTokens,
      maxTokens: input.contextWindow,
      threshold: initialThreshold.softThreshold / input.contextWindow,
    }

    let actionTaken = false
    let condensed = false
    let messagesSummarized = 0
    let createdSummary: Summary.Info | undefined
    const noOpReasons: string[] = []

    const protectedTailCount = Math.max(1, Math.floor(initialThreshold.lanePolicy.leaves.freshTailFloor))
    const messagesInContext = await getMessagesInContext(input.conversationId)
    const eligibleLeafCount = Math.max(0, messagesInContext.length - protectedTailCount)
    if (eligibleLeafCount >= initialThreshold.lanePolicy.leaves.minFanout) {
      const selectedMessages = messagesInContext.slice(0, eligibleLeafCount)
      const inputTokens = selectedMessages.reduce((sum, m) => sum + m.tokenCount, 0)
      const messagesToSummarize = await convertToMessageV2(selectedMessages)
      const dbMessageIds = selectedMessages.map((m) => m.messageId)
      const sprigSummary = await LcmSummarize.summarize({
        messages: messagesToSummarize,
        conversationId: input.conversationId,
        sessionID: input.sessionID,
        user: input.user,
        dbMessageIds,
        model: input.model,
        abort: input.abort,
      })

      if (sprigSummary.tokenCount < inputTokens) {
        await LcmDb.replacePositionsWithSummary({
          conversationId: input.conversationId,
          positions: selectedMessages.map((m) => m.position),
          summaryId: sprigSummary.summaryId,
        })
        actionTaken = true
        messagesSummarized = selectedMessages.length
        createdSummary = sprigSummary
      } else {
        log.warn("upward recursive leaf summarization was not smaller than input; skipping leaf replacement", {
          conversationId: input.conversationId,
          inputTokens,
          summaryTokens: sprigSummary.tokenCount,
        })
        noOpReasons.push("leaf_summary_not_smaller_than_input")
      }
    } else {
      log.info("upward recursive leaf step skipped: not enough leaves beyond protected tail", {
        conversationId: input.conversationId,
        totalLeaves: messagesInContext.length,
        protectedTailCount,
        eligibleLeafCount,
        minimumLeavesPerSprig: initialThreshold.lanePolicy.leaves.minFanout,
      })
      noOpReasons.push("eligible_leaves_below_min")
    }

    const minimumFanoutForOrder = (order: number) =>
      order === 1 ? initialThreshold.lanePolicy.sprigs.minFanout : initialThreshold.lanePolicy.bindles.minFanout

    const fanoutNoOpReasonForOrder = (order: number) => (order === 1 ? "sprigs_below_min_fanout" : `d${order}_below_min_fanout`)

    for (;;) {
      const activeSummaries = await getActiveSummariesForCompaction(input.conversationId)
      const candidateGroups = new Map<number, ActiveSummaryForCompaction[]>()
      for (const summary of activeSummaries) {
        if (summary.condensationOrder === 1 && summary.summaryType !== "sprig") continue
        if (summary.condensationOrder >= 2 && summary.summaryType !== "bindle") continue
        const existing = candidateGroups.get(summary.condensationOrder)
        if (existing) {
          existing.push(summary)
        } else {
          candidateGroups.set(summary.condensationOrder, [summary])
        }
      }

      const eligibleOrders = [...candidateGroups.keys()]
        .filter((order) => (candidateGroups.get(order)?.length ?? 0) >= minimumFanoutForOrder(order))
        .sort((a, b) => a - b)
      if (eligibleOrders.length === 0) {
        const lowestOrder = [...candidateGroups.keys()].sort((a, b) => a - b)[0]
        if (lowestOrder != null) {
          noOpReasons.push(fanoutNoOpReasonForOrder(lowestOrder))
        }
        break
      }
      const parentOrder = eligibleOrders[0]!
      const candidates = candidateGroups.get(parentOrder)!

      const condensationResult = await attemptCondensationForOrder({
        input,
        parentSummaries: candidates,
      })
      if (!condensationResult.actionTaken) {
        noOpReasons.push(
          parentOrder === 1
            ? "sprig_condensation_not_smaller_than_input"
            : `d${parentOrder}_condensation_not_smaller_than_input`,
        )
        break
      }

      actionTaken = true
      condensed = true
      if (condensationResult.createdSummary) {
        createdSummary = condensationResult.createdSummary
      }
    }

    if (!actionTaken) {
      noOpReasons.push("no_legal_compaction_group")
    }

    return {
      actionTaken,
      condensed,
      createdSummary,
      messagesSummarized,
      newTokenCount: await LcmDb.getContextTokenCount(input.conversationId),
      noOpReasons: [...new Set(noOpReasons)],
      ...baseResult,
    }
  }

  /**
   * Attempt to condense sprig summaries into a bindle.
   *
   * L2 bindles are only formed from L1 sprigs. Existing bindles are never
   * aggregated again, preventing bindle->bindle compaction chains.
   *
   * @param input - The base input parameters
   * @param summaries - The summaries currently in context
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

    const sprigSummaries = summaries
      .map((summary) => {
        const condensationOrder = summary.condensationOrder ?? Summary.condensationOrderFromKind(summary.kind)
        const summaryType = summary.summaryType ?? (summary.kind === "sprig" ? "sprig" : "bindle")
        return {
          ...summary,
          position: -1,
          condensationOrder,
          summaryType,
        } satisfies ActiveSummaryForCompaction
      })
      .filter((summary) => summary.condensationOrder === 1 && summary.summaryType === "sprig")
    if (sprigSummaries.length < 1) {
      log.info("attemptCondensation: skipping, no sprig summaries available", {
        conversationId: input.conversationId,
        summaryCount: summaries.length,
      })
      return { actionTaken: false, condensed: false }
    }

    return await attemptCondensationForOrder({
      input,
      parentSummaries: sprigSummaries,
    })
  }

  async function getActiveSummariesForCompaction(conversationId: number): Promise<ActiveSummaryForCompaction[]> {
    const entries = await LcmDb.getCurrentContextWithRefs(conversationId)
    const summaries: ActiveSummaryForCompaction[] = []
    for (const entry of entries) {
      if (entry.item_type !== "summary" || !entry.summary_id) continue
      const summary = await LcmDb.getSummaryById(entry.summary_id)
      if (!summary) continue
      const condensationOrder = summary.condensation_order
      const summaryType = summary.summary_type
      if (condensationOrder == null || summaryType == null) continue
      summaries.push({
        summaryId: summary.summary_id,
        content: summary.content,
        kind: summary.kind,
        level: summary.summary_level,
        condensationOrder,
        summaryType,
        tokenCount: summary.token_count,
        conversationId: conversationId.toString(),
        parents: summary.kind === "bindle" ? await LcmDb.getSummaryParentIds(summary.summary_id) : [],
        fileIds: summary.file_ids,
        createdAt: summary.created_at.getTime(),
        position: entry.position,
      })
    }
    return summaries
  }

  async function attemptCondensationForOrder(input: {
    input: {
      conversationId: number
      sessionID: string
      user: MessageV2.User
      model: Provider.Model
      abort?: AbortSignal
    }
    parentSummaries: ActiveSummaryForCompaction[]
  }): Promise<ContextHandlerResult> {
    if (input.parentSummaries.length < 1) {
      return { actionTaken: false, condensed: false }
    }

    const parentOrder = input.parentSummaries[0]!.condensationOrder
    const condensationOrder = parentOrder + 1
    const inputTokens = input.parentSummaries.reduce((sum, summary) => sum + summary.tokenCount, 0)

    log.debug("attemptCondensationForOrder", {
      conversationId: input.input.conversationId,
      parentOrder,
      condensationOrder,
      parentCount: input.parentSummaries.length,
      inputTokens,
      summaryIds: input.parentSummaries.map((summary) => summary.summaryId),
    })

    const bindleSummary = await Condense.condenseSummaries({
      summaries: input.parentSummaries,
      conversationId: input.input.conversationId.toString(),
      dbConversationId: input.input.conversationId,
      model: input.input.model,
      condensationOrder,
      abort: input.input.abort,
    })

    if (bindleSummary.tokenCount >= inputTokens) {
      log.warn("condensation not smaller than input; skipping condensation round", {
        conversationId: input.input.conversationId,
        parentOrder,
        condensationOrder,
        bindleTokens: bindleSummary.tokenCount,
        inputTokens,
      })
      return {
        actionTaken: false,
        condensed: false,
      }
    }

    const positions = input.parentSummaries.map((summary) => summary.position)
    if (positions.length > 0) {
      await LcmDb.replacePositionsWithSummary({
        conversationId: input.input.conversationId,
        positions,
        summaryId: bindleSummary.summaryId,
      })
      log.info("replaced summaries with condensed summary in context", {
        conversationId: input.input.conversationId,
        condensationOrder,
        parentOrder,
        replacedCount: positions.length,
        summaryId: bindleSummary.summaryId,
      })
    }

    return {
      actionTaken: true,
      newTokenCount: await LcmDb.getContextTokenCount(input.input.conversationId),
      createdSummary: bindleSummary,
      condensed: true,
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
    messages: TurnMessageInContext[],
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

}
