import { getLcmPolicyConfig, type LcmMode } from "./config"
import DOLT_CONDENSE_D2_PROMPT from "./prompts/dolt/condense/d2.txt"
import DOLT_SUMMARIZE_D1_PROMPT from "./prompts/dolt/summarize/d1.txt"
import UPWARD_CONDENSE_D2_PROMPT from "./prompts/upward/condense/d2.txt"
import UPWARD_CONDENSE_D3_PROMPT from "./prompts/upward/condense/d3.txt"
import UPWARD_SUMMARIZE_D1_PROMPT from "./prompts/upward/summarize/d1.txt"

/**
 * LCM prompt operations keyed in the mode-aware registry.
 */
export type LcmPromptOperation = "summarize" | "condense"

/**
 * Prompt lookup input for deterministic mode-aware resolution.
 */
export interface ResolveLcmPromptInput {
  mode?: LcmMode
  operation: LcmPromptOperation
  condensationOrder: number
}

/**
 * Registry key format: "<mode>:<operation>:d<order>".
 */
export type LcmPromptLookupKey = `${LcmMode}:${LcmPromptOperation}:d${number}`
export type LcmPromptRegistryKey =
  | "dolt:summarize:d1"
  | "dolt:condense:d2"
  | "upward:summarize:d1"
  | "upward:condense:d2"
  | "upward:condense:d3"

/**
 * Registry map to prompt templates.
 */
export type LcmPromptRegistry = Record<LcmPromptRegistryKey, string>

const PROMPT_REGISTRY: LcmPromptRegistry = {
  "dolt:summarize:d1": DOLT_SUMMARIZE_D1_PROMPT,
  "dolt:condense:d2": DOLT_CONDENSE_D2_PROMPT,
  "upward:summarize:d1": UPWARD_SUMMARIZE_D1_PROMPT,
  "upward:condense:d2": UPWARD_CONDENSE_D2_PROMPT,
  "upward:condense:d3": UPWARD_CONDENSE_D3_PROMPT,
}

let promptRegistryOverride: Partial<LcmPromptRegistry> | null = null
let promptConfigOverrideForTesting: Partial<LcmPromptRegistry> | null = null

/**
 * Build a canonical prompt registry key from mode, operation, and order.
 */
export function createLcmPromptRegistryKey(input: {
  mode: LcmMode
  operation: LcmPromptOperation
  condensationOrder: number
}): LcmPromptLookupKey {
  const condensationOrder = Number(input.condensationOrder)
  if (!Number.isFinite(condensationOrder) || !Number.isInteger(condensationOrder) || condensationOrder < 1) {
    throw new Error(`Invalid LCM condensation order: ${input.condensationOrder}. Expected integer >= 1`)
  }
  return `${input.mode}:${input.operation}:d${condensationOrder}` as LcmPromptLookupKey
}

/**
 * Apply finite-depth prompt policy for mode/operation lookup.
 *
 * Upward condensation supports recursive dN compaction, but prompt templates
 * are finite: d2 has a dedicated prompt and d3 is shared for d3+.
 */
function normalizeCondensationOrderForLookup(input: {
  mode: LcmMode
  operation: LcmPromptOperation
  condensationOrder: number
}): number {
  const condensationOrder = Number(input.condensationOrder)
  if (!Number.isFinite(condensationOrder) || !Number.isInteger(condensationOrder) || condensationOrder < 1) {
    throw new Error(`Invalid LCM condensation order: ${input.condensationOrder}. Expected integer >= 1`)
  }
  if (input.mode === "upward" && input.operation === "condense" && condensationOrder >= 3) {
    return 3
  }
  return condensationOrder
}

function isLcmPromptRegistryKey(key: LcmPromptLookupKey): key is LcmPromptRegistryKey {
  return Object.prototype.hasOwnProperty.call(PROMPT_REGISTRY, key)
}

/**
 * Resolve a prompt template by active mode + operation + condensation order.
 * Fails explicitly when mapping is missing.
 */
async function resolveConfiguredPromptOverride(key: LcmPromptRegistryKey): Promise<string | null> {
  const testOverride = promptConfigOverrideForTesting?.[key]
  if (typeof testOverride === "string") {
    const trimmed = testOverride.trim()
    if (trimmed.length > 0) return trimmed
  }

  const { Config } = await import("@/config/config")
  const configured = await Config.get().catch(() => null)
  if (!configured) return null
  const override = configured.lcm?.prompts?.[key]
  if (typeof override !== "string") return null

  const trimmed = override.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function resolveLcmPrompt(input: ResolveLcmPromptInput): Promise<string> {
  const mode = input.mode ?? getLcmPolicyConfig().mode
  const condensationOrder = normalizeCondensationOrderForLookup({
    mode,
    operation: input.operation,
    condensationOrder: input.condensationOrder,
  })
  const lookupKey = createLcmPromptRegistryKey({
    mode,
    operation: input.operation,
    condensationOrder,
  })
  if (!isLcmPromptRegistryKey(lookupKey)) {
    throw new Error(`Missing LCM prompt mapping for key: ${lookupKey}`)
  }
  const key = lookupKey
  const registry = promptRegistryOverride ?? PROMPT_REGISTRY
  const bakedInPrompt = registry[key]
  if (!bakedInPrompt) {
    throw new Error(`Missing LCM prompt mapping for key: ${key}`)
  }

  if (promptRegistryOverride === null) {
    const configuredPrompt = await resolveConfiguredPromptOverride(key)
    if (configuredPrompt) {
      return configuredPrompt
    }
  }

  const prompt = bakedInPrompt.trim()
  if (prompt.length === 0) {
    throw new Error(`Empty LCM prompt for key: ${key}`)
  }
  return prompt
}

/**
 * Test-only helper for overriding prompt mapping.
 */
export function setLcmPromptRegistryForTesting(registry: Partial<LcmPromptRegistry> | null): void {
  promptRegistryOverride = registry
}

/**
 * Test-only helper for overriding config prompt values.
 */
export function setLcmPromptConfigOverridesForTesting(registry: Partial<LcmPromptRegistry> | null): void {
  promptConfigOverrideForTesting = registry
}
