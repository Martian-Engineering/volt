import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import { getLcmPolicyConfig, type LcmMode } from "./config"
import { LcmContext } from "./context"
import { LcmDb } from "./db"
import { LcmRetrievalFacade } from "./retrieval-facade"
import type { LcmRetrieval } from "./retrieval"
import { createDoltRuntimeStrategy } from "./strategy-dolt"

const log = Log.create({ service: "lcm.strategy" })

type StrategyFactory = () => LcmRuntimeStrategy

type StrategyFactories = Record<LcmMode, StrategyFactory>

const defaultFactories: StrategyFactories = {
  dolt: () => createDoltRuntimeStrategy(),
  upward: () => upwardStrategy,
}

let factoryOverrides: Partial<StrategyFactories> | null = null
let cachedStrategy: { mode: LcmMode; strategy: LcmRuntimeStrategy } | null = null
const inFlightCompactions = new Map<number, Promise<LcmContext.ContextHandlerResult | null>>()

/**
 * Shared input contract for mode-dispatched threshold compaction.
 */
export interface ThresholdCompactionInput {
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
}

/**
 * Shared input contract for mode-dispatched manual compaction (`/compact`).
 */
export interface ManualCompactionInput {
  conversationId: number
  sessionID: string
  user: MessageV2.User
  model: Provider.Model
  abort?: AbortSignal
  overhead: number
  reserve: number
  contextWindow: number
  softThresholdOverride?: number
}

/**
 * Runtime strategy contract for LCM mode implementations.
 */
export interface LcmRuntimeStrategy {
  name: LcmMode
  compactOnThreshold(input: ThresholdCompactionInput): Promise<LcmContext.ContextHandlerResult>
  compactManual(input: ManualCompactionInput): Promise<LcmContext.ContextHandlerResult>
  assembleContext(conversationId: number): Promise<LcmDb.ContextEntry[]>
  resolveRetrieval(input: LcmRetrieval.QueryInput): Promise<LcmRetrieval.QueryResult>
}

const upwardStrategy: LcmRuntimeStrategy = {
  name: "upward",
  compactOnThreshold: async (input) => {
    const policy = getLcmPolicyConfig()
    const tokenBudget = Math.max(0, input.contextWindow - input.overhead - input.reserve)
    const contextThreshold = policy.runtime.defaultCtxCutoffThreshold
    const threshold = Math.floor(contextThreshold * tokenBudget)
    const currentTokens = await LcmDb.getContextTokenCount(input.conversationId)
    const rawTokensOutsideTail = await LcmContext.countRawTokensOutsideFreshTail({
      conversationId: input.conversationId,
      freshTailCount: policy.strategies.upward.leaves.freshTailFloor,
    })
    const leafChunkTokens = LcmContext.resolveUpwardLeafChunkTokens()
    const thresholdTriggered = currentTokens > threshold
    const leafTriggered = rawTokensOutsideTail >= leafChunkTokens

    if (!input.force && !thresholdTriggered && !leafTriggered) {
      return {
        actionTaken: false,
        condensed: false,
      }
    }
    return await LcmContext.compactForcedRecursive(input)
  },
  compactManual: (input) => LcmContext.compactForcedRecursive(input),
  assembleContext: (conversationId) => LcmDb.getCurrentContext(conversationId),
  resolveRetrieval: (input) => LcmRetrievalFacade.resolveOffContextRetrieval(input, "upward"),
}

/**
 * Resolve the active mode strategy from typed startup policy.
 */
export function getActiveLcmRuntimeStrategy(): LcmRuntimeStrategy {
  const mode = getLcmPolicyConfig().mode
  if (cachedStrategy && cachedStrategy.mode === mode) {
    return cachedStrategy.strategy
  }

  const strategy = resolveStrategyForMode(mode)
  cachedStrategy = { mode, strategy }
  return strategy
}

/**
 * Validate startup mode selection and return the configured strategy.
 */
export function ensureLcmRuntimeStrategyConfigured(): LcmRuntimeStrategy {
  return getActiveLcmRuntimeStrategy()
}

/**
 * Check whether a threshold compaction job is currently running.
 */
export function isThresholdCompactionInFlight(conversationId: number): boolean {
  return inFlightCompactions.has(conversationId)
}

/**
 * Schedule async threshold compaction via the active strategy.
 * Returns null when a conversation already has a running compaction job.
 */
export function scheduleThresholdCompaction(
  input: ThresholdCompactionInput,
): Promise<LcmContext.ContextHandlerResult | null> | null {
  if (inFlightCompactions.has(input.conversationId)) {
    log.debug("scheduleThresholdCompaction: already in flight", { conversationId: input.conversationId })
    return null
  }

  const strategy = getActiveLcmRuntimeStrategy()
  const job = (async () => {
    try {
      return await strategy.compactOnThreshold(input)
    } catch (error) {
      log.warn("async threshold compaction failed", {
        conversationId: input.conversationId,
        strategy: strategy.name,
        error,
      })
      return null
    }
  })()

  inFlightCompactions.set(input.conversationId, job)
  void job.finally(() => {
    inFlightCompactions.delete(input.conversationId)
  })

  return job
}

/**
 * Run blocking threshold compaction rounds until context is under hard limit.
 */
export async function compactUntilUnderHardLimit(input: ThresholdCompactionInput): Promise<{
  success: boolean
  rounds: number
  finalTokens: number
  hardLimit: number
}> {
  const strategy = getActiveLcmRuntimeStrategy()
  const initialCheck = await LcmContext.isOverThreshold({
    conversationId: input.conversationId,
    overhead: input.overhead,
    reserve: input.reserve,
    contextWindow: input.contextWindow,
    softThresholdOverride: input.softThresholdOverride,
  })

  if (initialCheck.currentTokens <= initialCheck.hardLimit) {
    return {
      success: true,
      rounds: 0,
      finalTokens: initialCheck.currentTokens,
      hardLimit: initialCheck.hardLimit,
    }
  }

  let lastTokenCount = initialCheck.currentTokens
  const maxCompactionRounds = getLcmPolicyConfig().runtime.maxCompactionRounds

  for (let round = 1; round <= maxCompactionRounds; round++) {
    const result = await strategy.compactOnThreshold({
      ...input,
      force: true,
    })

    const recheck = await LcmContext.isOverThreshold({
      conversationId: input.conversationId,
      overhead: input.overhead,
      reserve: input.reserve,
      contextWindow: input.contextWindow,
      softThresholdOverride: input.softThresholdOverride,
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
      return {
        success: false,
        rounds: round,
        finalTokens: recheck.currentTokens,
        hardLimit: recheck.hardLimit,
      }
    }

    lastTokenCount = recheck.currentTokens
  }

  const finalCheck = await LcmContext.isOverThreshold({
    conversationId: input.conversationId,
    overhead: input.overhead,
    reserve: input.reserve,
    contextWindow: input.contextWindow,
    softThresholdOverride: input.softThresholdOverride,
  })

  return {
    success: false,
    rounds: maxCompactionRounds,
    finalTokens: finalCheck.currentTokens,
    hardLimit: finalCheck.hardLimit,
  }
}

/**
 * Test-only helper for replacing mode strategy factories.
 */
export function setLcmRuntimeStrategyFactoriesForTesting(overrides: Partial<StrategyFactories> | null): void {
  factoryOverrides = overrides
  cachedStrategy = null
  inFlightCompactions.clear()
}

function resolveStrategyForMode(mode: string): LcmRuntimeStrategy {
  switch (mode) {
    case "dolt": {
      const factory = factoryOverrides?.dolt ?? defaultFactories.dolt
      return factory()
    }
    case "upward": {
      const factory = factoryOverrides?.upward ?? defaultFactories.upward
      return factory()
    }
    default:
      throw new Error(`Unsupported LCM runtime mode: ${mode}. Expected one of: dolt, upward`)
  }
}
