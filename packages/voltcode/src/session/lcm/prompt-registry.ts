import path from "path"
import { getLcmPolicyConfig, type LcmMode } from "./config"

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
export type LcmPromptRegistryKey = `${LcmMode}:${LcmPromptOperation}:d${number}`

/**
 * Registry map to prompt file paths relative to this directory.
 */
export type LcmPromptRegistry = Record<LcmPromptRegistryKey, string>

const PROMPT_REGISTRY: LcmPromptRegistry = {
  "dolt:summarize:d1": "prompts/dolt/summarize/d1.txt",
  "dolt:condense:d2": "prompts/dolt/condense/d2.txt",
  "upward:summarize:d1": "prompts/upward/summarize/d1.txt",
  "upward:condense:d2": "prompts/upward/condense/d2.txt",
}

let promptRegistryOverride: Partial<LcmPromptRegistry> | null = null

/**
 * Build a canonical prompt registry key from mode, operation, and order.
 */
export function createLcmPromptRegistryKey(input: {
  mode: LcmMode
  operation: LcmPromptOperation
  condensationOrder: number
}): LcmPromptRegistryKey {
  const condensationOrder = Number.parseInt(String(input.condensationOrder), 10)
  if (!Number.isInteger(condensationOrder) || condensationOrder < 1) {
    throw new Error(`Invalid LCM condensation order: ${input.condensationOrder}. Expected integer >= 1`)
  }
  return `${input.mode}:${input.operation}:d${condensationOrder}` as LcmPromptRegistryKey
}

/**
 * Resolve a prompt template by active mode + operation + condensation order.
 * Fails explicitly when mapping or file is missing.
 */
export async function resolveLcmPrompt(input: ResolveLcmPromptInput): Promise<string> {
  const mode = input.mode ?? getLcmPolicyConfig().mode
  const key = createLcmPromptRegistryKey({
    mode,
    operation: input.operation,
    condensationOrder: input.condensationOrder,
  })
  const registry = promptRegistryOverride ?? PROMPT_REGISTRY
  const relativePath = registry[key]
  if (!relativePath) {
    throw new Error(`Missing LCM prompt mapping for key: ${key}`)
  }

  const filePath = path.join(path.dirname(import.meta.path), relativePath)
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new Error(`Missing LCM prompt file for key ${key}: ${filePath}`)
  }

  const prompt = (await file.text()).trim()
  if (prompt.length === 0) {
    throw new Error(`Empty LCM prompt file for key ${key}: ${filePath}`)
  }
  return prompt
}

/**
 * Test-only helper for overriding prompt mapping.
 */
export function setLcmPromptRegistryForTesting(registry: Partial<LcmPromptRegistry> | null): void {
  promptRegistryOverride = registry
}
