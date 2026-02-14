import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { SystemPrompt } from "./system"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { Tool } from "ai"

const log = Log.create({ service: "token-budget" })

const DEFAULT_OUTPUT_RESERVE = 20_000

export namespace TokenBudget {
  export interface Budget {
    overhead: number
    reserve: number
    hardLimit: number
    softThreshold: number
    contextWindow: number
    systemPromptTokens: number
    toolTokens: number
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

    log.debug("computed budget", {
      overhead,
      reserve,
      hardLimit,
      softThreshold,
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
}
