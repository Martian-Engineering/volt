import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { SystemPrompt } from "./system"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { Tool } from "ai"

const log = Log.create({ service: "token-budget" })

const DEFAULT_OUTPUT_RESERVE = 20_000
const DEFAULT_DOLT_BINDLES_SOFT = 10_000
const DEFAULT_DOLT_BINDLES_DELTA = 1_000
const DEFAULT_DOLT_BINDLES_TARGET = 9_000
const DEFAULT_DOLT_LEAVES_SOFT = 20_000
const DEFAULT_DOLT_LEAVES_DELTA = 2_000
const DEFAULT_DOLT_LEAVES_TARGET = 18_000
const DEFAULT_DOLT_TURNS_CAP = 30_000
const DEFAULT_DOLT_TURNS_SOFT = 30_000
const DEFAULT_DOLT_TURNS_DELTA = 0
const DEFAULT_DOLT_TURNS_TARGET = 30_000
const DEFAULT_DOLT_TURNS_FRESH_TAIL_FLOOR = 4
const DEFAULT_DOLT_HARD_LIMIT_RISK_BUFFER = 0

export namespace TokenBudget {
  export type LaneName = "turns" | "leaves" | "bindles"

  export interface LaneThreshold {
    soft: number
    delta: number
    target: number
  }

  export interface TurnsLaneThreshold extends LaneThreshold {
    cap: number
    freshTailFloor: number
  }

  export interface DoltLanePolicy {
    turns: TurnsLaneThreshold
    leaves: LaneThreshold
    bindles: LaneThreshold
    hardLimitRiskBuffer: number
  }

  export interface LaneTokenCounts {
    turns: number
    leaves: number
    bindles: number
    total: number
  }

  export interface LaneDecision {
    lane: LaneName
    laneTokens: number
    soft: number
    delta: number
    target: number
    upperBound: number
    overUpperBand: boolean
    overTarget: boolean
    bypassedHysteresis: boolean
    shouldCompact: boolean
  }

  export interface DoltLaneDecisions {
    hardLimitRisk: boolean
    turns: LaneDecision
    leaves: LaneDecision
    bindles: LaneDecision
    currentlyCompacting: Record<LaneName, boolean>
    nextCompacting: Record<LaneName, boolean>
    compactAny: boolean
  }

  export interface Budget {
    overhead: number
    reserve: number
    hardLimit: number
    softThreshold: number
    contextWindow: number
    systemPromptTokens: number
    toolTokens: number
    lanePolicy: DoltLanePolicy
  }

  interface CachedSystemPrompt {
    parts: string[]
    tokenCount: number
    agentName: string
    toolSetHash: string
  }

  const systemPromptCache = new Map<string, CachedSystemPrompt>()
  const sessionBudgets = new Map<string, Budget>()

  /**
   * Assemble the full system prompt exactly as llm.ts does:
   * header(providerID) + agent.prompt or provider(model) + buildSections(model, apiConfig)
   * Then apply plugin transform.
   *
   * Caches per sessionID, invalidated when agentName or toolSetHash changes.
   * Does NOT include user.system (it can change per turn).
   */
  export async function getSystemPrompt(input: {
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    tools: Record<string, Tool>
    apiConfig?: { url: string; model: string; apiKey: string }
  }): Promise<{ parts: string[]; tokenCount: number }> {
    const toolHash = hashToolSet(input.tools)
    const cached = systemPromptCache.get(input.sessionID)
    if (cached && cached.agentName === input.agent.name && cached.toolSetHash === toolHash) {
      return { parts: cached.parts, tokenCount: cached.tokenCount }
    }

    // Assemble system prompt: header + agent/provider prompt + buildSections
    const system = SystemPrompt.header(input.model.providerID)
    system.push(
      [
        ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
        ...(await SystemPrompt.buildSections(input.model, input.apiConfig)),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    // Apply plugin transform (same as llm.ts)
    // Lazy import to avoid circular initialization:
    // token-budget → @/plugin → session/index → ./prompt → ./token-budget
    const { Plugin } = await import("@/plugin")
    const header = system[0]
    const original = [...system]
    await Plugin.trigger("experimental.chat.system.transform", { sessionID: input.sessionID }, { system })
    if (system.length === 0) {
      system.push(...original)
    }
    // Rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const tokenCount = system.reduce((sum, part) => sum + Token.estimate(part), 0)

    systemPromptCache.set(input.sessionID, {
      parts: system,
      tokenCount,
      agentName: input.agent.name,
      toolSetHash: toolHash,
    })

    log.debug("computed system prompt", {
      sessionID: input.sessionID,
      agent: input.agent.name,
      tokenCount,
      partCount: system.length,
    })

    return { parts: system, tokenCount }
  }

  /**
   * Estimate token count for tool definitions.
   * Same logic as the inline computation in prompt.ts.
   */
  export function estimateToolTokens(tools: Record<string, Tool>): number {
    return Object.values(tools).reduce((sum, t) => {
      const desc = (t as any).description ?? ""
      const params = (t as any).parameters ? JSON.stringify((t as any).parameters) : ""
      return sum + Token.estimate(desc + params)
    }, 0)
  }

  /**
   * Hash the tool set for cache invalidation.
   * Sorted key list joined by comma.
   */
  export function hashToolSet(tools: Record<string, Tool>): string {
    return Object.keys(tools).sort().join(",")
  }

  /**
   * Compute the output reserve for a model.
   * Uses per-model override if available, otherwise DEFAULT_OUTPUT_RESERVE.
   * Capped to min(result, model.limit.output, floor(context * 0.25)).
   */
  export function outputReserve(model: Provider.Model): number {
    const base = (model.limit as any).output_reserve ?? DEFAULT_OUTPUT_RESERVE
    return Math.min(base, model.limit.output, Math.floor(model.limit.context * 0.25))
  }

  /**
   * Pure function to compute the token budget.
   *
   * Returns overhead, reserve, hardLimit, softThreshold, contextWindow.
   */
  export function computeBudget(input: {
    model: Provider.Model
    systemPromptTokens: number
    toolTokens: number
    softThresholdOverride?: number
  }): Budget {
    const overhead = input.systemPromptTokens + input.toolTokens
    const reserve = outputReserve(input.model)
    const contextWindow = input.model.limit.context
    const hardLimit = contextWindow - overhead - reserve
    const softRaw = (input.softThresholdOverride ?? Math.floor(contextWindow * 0.6)) - overhead
    const softThreshold = Math.max(0, Math.min(softRaw, hardLimit))
    const lanePolicy = computeDoltLanePolicy({ hardLimit })

    log.debug("computed budget", {
      overhead,
      reserve,
      hardLimit,
      softThreshold,
      turnsCap: lanePolicy.turns.cap,
      turnsSoft: lanePolicy.turns.soft,
      turnsDelta: lanePolicy.turns.delta,
      turnsTarget: lanePolicy.turns.target,
      turnsFreshTailFloor: lanePolicy.turns.freshTailFloor,
      leavesSoft: lanePolicy.leaves.soft,
      leavesDelta: lanePolicy.leaves.delta,
      leavesTarget: lanePolicy.leaves.target,
      bindlesSoft: lanePolicy.bindles.soft,
      bindlesDelta: lanePolicy.bindles.delta,
      bindlesTarget: lanePolicy.bindles.target,
      hardLimitRiskBuffer: lanePolicy.hardLimitRiskBuffer,
      contextWindow,
      systemPromptTokens: input.systemPromptTokens,
      toolTokens: input.toolTokens,
      softThresholdOverride: input.softThresholdOverride ?? "none",
    })

    return {
      overhead,
      reserve,
      hardLimit,
      softThreshold,
      contextWindow,
      systemPromptTokens: input.systemPromptTokens,
      toolTokens: input.toolTokens,
      lanePolicy,
    }
  }

  /**
   * Build Dolt lane-policy thresholds from defaults + environment overrides.
   *
   * Lane behavior:
   * - Compact when laneTokens > soft + delta (upper hysteresis band)
   * - Keep compacting until laneTokens <= target
   * - Under global hard-limit risk, bypass the hysteresis band gate and compact
   *   whenever laneTokens > target.
   */
  export function computeDoltLanePolicy(input: { hardLimit: number }): DoltLanePolicy {
    const hardLimit = nonNegativeInteger(input.hardLimit)
    const turnsCap = clampToCap(readInt("VOLTCODE_LCM_DOLT_TURNS_CAP", DEFAULT_DOLT_TURNS_CAP), hardLimit)
    const turns = clampLane({
      soft: readInt("VOLTCODE_LCM_DOLT_TURNS_SOFT", DEFAULT_DOLT_TURNS_SOFT),
      delta: readInt("VOLTCODE_LCM_DOLT_TURNS_DELTA", DEFAULT_DOLT_TURNS_DELTA),
      target: readInt("VOLTCODE_LCM_DOLT_TURNS_TARGET", DEFAULT_DOLT_TURNS_TARGET),
      cap: turnsCap,
    })
    const leaves = clampLane({
      soft: readInt("VOLTCODE_LCM_DOLT_LEAVES_SOFT", DEFAULT_DOLT_LEAVES_SOFT),
      delta: readInt("VOLTCODE_LCM_DOLT_LEAVES_DELTA", DEFAULT_DOLT_LEAVES_DELTA),
      target: readInt("VOLTCODE_LCM_DOLT_LEAVES_TARGET", DEFAULT_DOLT_LEAVES_TARGET),
      cap: hardLimit,
    })
    const bindles = clampLane({
      soft: readInt("VOLTCODE_LCM_DOLT_BINDLES_SOFT", DEFAULT_DOLT_BINDLES_SOFT),
      delta: readInt("VOLTCODE_LCM_DOLT_BINDLES_DELTA", DEFAULT_DOLT_BINDLES_DELTA),
      target: readInt("VOLTCODE_LCM_DOLT_BINDLES_TARGET", DEFAULT_DOLT_BINDLES_TARGET),
      cap: hardLimit,
    })

    return {
      turns: {
        ...turns,
        cap: turnsCap,
        freshTailFloor: Math.max(
          1,
          readInt("VOLTCODE_LCM_DOLT_TURNS_FRESH_TAIL_FLOOR", DEFAULT_DOLT_TURNS_FRESH_TAIL_FLOOR),
        ),
      },
      leaves,
      bindles,
      hardLimitRiskBuffer: Math.min(
        hardLimit,
        nonNegativeInteger(readInt("VOLTCODE_LCM_DOLT_HARD_LIMIT_RISK_BUFFER", DEFAULT_DOLT_HARD_LIMIT_RISK_BUFFER)),
      ),
    }
  }

  /**
   * Evaluate Dolt lane decisions with hysteresis and hard-limit bypass semantics.
   */
  export function evaluateDoltLaneDecisions(input: {
    laneTokens: LaneTokenCounts
    policy: DoltLanePolicy
    hardLimit: number
    currentlyCompacting?: Partial<Record<LaneName, boolean>>
  }): DoltLaneDecisions {
    const hardLimit = nonNegativeInteger(input.hardLimit)
    const currentlyCompacting: Record<LaneName, boolean> = {
      turns: Boolean(input.currentlyCompacting?.turns),
      leaves: Boolean(input.currentlyCompacting?.leaves),
      bindles: Boolean(input.currentlyCompacting?.bindles),
    }
    const laneTokens = {
      turns: nonNegativeInteger(input.laneTokens.turns),
      leaves: nonNegativeInteger(input.laneTokens.leaves),
      bindles: nonNegativeInteger(input.laneTokens.bindles),
      total: nonNegativeInteger(input.laneTokens.total),
    }
    const riskThreshold = Math.max(0, hardLimit - input.policy.hardLimitRiskBuffer)
    const hardLimitRisk = laneTokens.total >= riskThreshold

    const turns = evaluateLaneDecision({
      lane: "turns",
      laneTokens: laneTokens.turns,
      threshold: input.policy.turns,
      currentlyCompacting: currentlyCompacting.turns,
      hardLimitRisk,
    })
    const leaves = evaluateLaneDecision({
      lane: "leaves",
      laneTokens: laneTokens.leaves,
      threshold: input.policy.leaves,
      currentlyCompacting: currentlyCompacting.leaves,
      hardLimitRisk,
    })
    const bindles = evaluateLaneDecision({
      lane: "bindles",
      laneTokens: laneTokens.bindles,
      threshold: input.policy.bindles,
      currentlyCompacting: currentlyCompacting.bindles,
      hardLimitRisk,
    })

    return {
      hardLimitRisk,
      turns,
      leaves,
      bindles,
      currentlyCompacting,
      nextCompacting: {
        turns: turns.shouldCompact,
        leaves: leaves.shouldCompact,
        bindles: bindles.shouldCompact,
      },
      compactAny: turns.shouldCompact || leaves.shouldCompact || bindles.shouldCompact,
    }
  }

  /**
   * Evaluate a single lane against soft/delta/target thresholds.
   */
  export function evaluateLaneDecision(input: {
    lane: LaneName
    laneTokens: number
    threshold: LaneThreshold
    currentlyCompacting?: boolean
    hardLimitRisk: boolean
  }): LaneDecision {
    const laneTokens = nonNegativeInteger(input.laneTokens)
    const soft = nonNegativeInteger(input.threshold.soft)
    const delta = nonNegativeInteger(input.threshold.delta)
    const target = Math.min(soft, nonNegativeInteger(input.threshold.target))
    const upperBound = soft + delta
    const overUpperBand = laneTokens > upperBound
    const overTarget = laneTokens > target
    const continuingCompaction = Boolean(input.currentlyCompacting) && overTarget && !overUpperBand
    const bypassedHysteresis = input.hardLimitRisk && overTarget && !overUpperBand
    const shouldCompact = overTarget && (overUpperBand || continuingCompaction || bypassedHysteresis)

    return {
      lane: input.lane,
      laneTokens,
      soft,
      delta,
      target,
      upperBound,
      overUpperBand,
      overTarget,
      bypassedHysteresis,
      shouldCompact,
    }
  }

  /**
   * Store the computed budget for a session.
   * Called by buildLcmModelMessages() after computing the budget each turn.
   * This makes the budget available to tools (like Read) that execute mid-turn.
   */
  export function storeSessionBudget(sessionID: string, budget: Budget): void {
    sessionBudgets.set(sessionID, budget)
  }

  /**
   * Retrieve the stored budget for a session.
   * Called by Read tool / other tools that need budget info mid-turn.
   *
   * Throws if no budget exists — this should never happen since
   * buildLcmModelMessages() always runs before any tool execution.
   */
  export function getSessionBudget(sessionID: string): Budget {
    const budget = sessionBudgets.get(sessionID)
    if (!budget) {
      throw new Error(
        `No token budget found for session ${sessionID}. ` +
          `This indicates buildLcmModelMessages() was not called before tool execution.`,
      )
    }
    return budget
  }

  /**
   * Clear the cached system prompt for a session.
   */
  export function invalidate(sessionID: string): void {
    systemPromptCache.delete(sessionID)
    sessionBudgets.delete(sessionID)
    log.debug("invalidated session cache", { sessionID })
  }

  function readInt(key: string, fallback: number): number {
    const value = process.env[key]
    if (!value) return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0) return fallback
    return parsed
  }

  function nonNegativeInteger(value: number): number {
    if (!Number.isFinite(value)) return 0
    const floored = Math.floor(value)
    return floored < 0 ? 0 : floored
  }

  function clampToCap(value: number, cap: number): number {
    return Math.min(nonNegativeInteger(cap), nonNegativeInteger(value))
  }

  function clampLane(input: { soft: number; delta: number; target: number; cap: number }): LaneThreshold {
    const cap = nonNegativeInteger(input.cap)
    const soft = Math.min(nonNegativeInteger(input.soft), cap)
    const delta = nonNegativeInteger(input.delta)
    const target = Math.min(soft, nonNegativeInteger(input.target))
    return { soft, delta, target }
  }
}
