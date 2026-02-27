import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { SystemPrompt } from "./system"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { Tool } from "ai"
import { getLcmPolicyConfig, type LcmMode, type LcmModePolicy } from "./lcm/config"

const log = Log.create({ service: "token-budget" })

const DEFAULT_OUTPUT_RESERVE = 20_000

export namespace TokenBudget {
  export type LaneName = "leaves" | "sprigs" | "bindles"

  export interface LaneThreshold {
    soft: number
    delta: number
    target: number
    minFanout: number
  }

  export interface LeavesLaneThreshold extends LaneThreshold {
    cap: number
    freshTailFloor: number
  }

  export interface DoltLanePolicy {
    leaves: LeavesLaneThreshold
    sprigs: LaneThreshold
    bindles: LaneThreshold
    hardLimitRiskBuffer: number
  }

  export interface LaneTokenCounts {
    leaves: number
    sprigs: number
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
    leaves: LaneDecision
    sprigs: LaneDecision
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
    const policyConfig = getLcmPolicyConfig()
    const overhead = input.systemPromptTokens + input.toolTokens
    const reserve = outputReserve(input.model)
    const contextWindow = input.model.limit.context
    const hardLimit = contextWindow - overhead - reserve
    const softRaw =
      (input.softThresholdOverride ?? Math.floor(contextWindow * policyConfig.runtime.defaultCtxCutoffThreshold)) -
      overhead
    const softThreshold = Math.max(0, Math.min(softRaw, hardLimit))
    const lanePolicy = computeLanePolicy({ hardLimit, mode: policyConfig.mode })

    log.debug("computed budget", {
      mode: policyConfig.mode,
      overhead,
      reserve,
      hardLimit,
      softThreshold,
      leavesCap: lanePolicy.leaves.cap,
      leavesSoft: lanePolicy.leaves.soft,
      leavesDelta: lanePolicy.leaves.delta,
      leavesTarget: lanePolicy.leaves.target,
      leavesMinFanout: lanePolicy.leaves.minFanout,
      leavesFreshTailFloor: lanePolicy.leaves.freshTailFloor,
      sprigsSoft: lanePolicy.sprigs.soft,
      sprigsDelta: lanePolicy.sprigs.delta,
      sprigsTarget: lanePolicy.sprigs.target,
      sprigsMinFanout: lanePolicy.sprigs.minFanout,
      bindlesSoft: lanePolicy.bindles.soft,
      bindlesDelta: lanePolicy.bindles.delta,
      bindlesTarget: lanePolicy.bindles.target,
      bindlesMinFanout: lanePolicy.bindles.minFanout,
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
    return computeLanePolicy({
      hardLimit: input.hardLimit,
      mode: "dolt",
    })
  }

  /**
   * Build lane-policy thresholds for the active strategy mode.
   */
  export function computeLanePolicy(input: {
    hardLimit: number
    mode?: LcmMode
    policy?: LcmModePolicy
  }): DoltLanePolicy {
    const hardLimit = nonNegativeInteger(input.hardLimit)
    const policyConfig = getLcmPolicyConfig()
    const mode = input.mode ?? policyConfig.mode
    const modePolicy = input.policy ?? policyConfig.strategies[mode]
    const leavesCap = clampToCap(modePolicy.leaves.cap, hardLimit)
    const leaves = clampLane({
      soft: modePolicy.leaves.soft,
      delta: modePolicy.leaves.delta,
      target: modePolicy.leaves.target,
      minFanout: modePolicy.leaves.minFanout,
      cap: leavesCap,
    })
    const sprigs = clampLane({
      soft: modePolicy.sprigs.soft,
      delta: modePolicy.sprigs.delta,
      target: modePolicy.sprigs.target,
      minFanout: modePolicy.sprigs.minFanout,
      cap: hardLimit,
    })
    const bindles = clampLane({
      soft: modePolicy.bindles.soft,
      delta: modePolicy.bindles.delta,
      target: modePolicy.bindles.target,
      minFanout: modePolicy.bindles.minFanout,
      cap: hardLimit,
    })

    return {
      leaves: {
        ...leaves,
        cap: leavesCap,
        freshTailFloor: Math.max(1, nonNegativeInteger(modePolicy.leaves.freshTailFloor)),
      },
      sprigs,
      bindles,
      hardLimitRiskBuffer: Math.min(hardLimit, nonNegativeInteger(modePolicy.hardLimitRiskBuffer)),
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
      leaves: Boolean(input.currentlyCompacting?.leaves),
      sprigs: Boolean(input.currentlyCompacting?.sprigs),
      bindles: Boolean(input.currentlyCompacting?.bindles),
    }
    const laneTokens = {
      leaves: nonNegativeInteger(input.laneTokens.leaves),
      sprigs: nonNegativeInteger(input.laneTokens.sprigs),
      bindles: nonNegativeInteger(input.laneTokens.bindles),
      total: nonNegativeInteger(input.laneTokens.total),
    }
    const riskThreshold = Math.max(0, hardLimit - input.policy.hardLimitRiskBuffer)
    const hardLimitRisk = laneTokens.total >= riskThreshold

    const leaves = evaluateLaneDecision({
      lane: "leaves",
      laneTokens: laneTokens.leaves,
      threshold: input.policy.leaves,
      currentlyCompacting: currentlyCompacting.leaves,
      hardLimitRisk,
    })
    const sprigs = evaluateLaneDecision({
      lane: "sprigs",
      laneTokens: laneTokens.sprigs,
      threshold: input.policy.sprigs,
      currentlyCompacting: currentlyCompacting.sprigs,
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
      leaves,
      sprigs,
      bindles,
      currentlyCompacting,
      nextCompacting: {
        leaves: leaves.shouldCompact,
        sprigs: sprigs.shouldCompact,
        bindles: bindles.shouldCompact,
      },
      compactAny: leaves.shouldCompact || sprigs.shouldCompact || bindles.shouldCompact,
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

  function nonNegativeInteger(value: number): number {
    if (!Number.isFinite(value)) return 0
    const floored = Math.floor(value)
    return floored < 0 ? 0 : floored
  }

  function clampToCap(value: number, cap: number): number {
    return Math.min(nonNegativeInteger(cap), nonNegativeInteger(value))
  }

  function clampLane(input: {
    soft: number
    delta: number
    target: number
    minFanout: number
    cap: number
  }): LaneThreshold {
    const cap = nonNegativeInteger(input.cap)
    const soft = Math.min(nonNegativeInteger(input.soft), cap)
    const delta = nonNegativeInteger(input.delta)
    const target = Math.min(soft, nonNegativeInteger(input.target))
    const minFanout = Math.max(2, nonNegativeInteger(input.minFanout))
    return { soft, delta, target, minFanout }
  }
}
