import { Token } from "@/util/token"

/**
 * Escalation tiers for compaction-generation passes.
 */
export type CompactionEscalationTier = "normal" | "aggressive" | "fallback"

/**
 * Marker header appended to prompts in aggressive mode.
 */
const AGGRESSIVE_DIRECTIVE_HEADER = "## Aggressive Compression Override"

/**
 * Prompt directive used for second-pass aggressive compression.
 */
export function withAggressiveCompactionDirective(promptTemplate: string): string {
  if (promptTemplate.includes(AGGRESSIVE_DIRECTIVE_HEADER)) {
    return promptTemplate
  }
  return `${promptTemplate.trim()}\n\n${AGGRESSIVE_DIRECTIVE_HEADER}
- You are in escalation pass 2 because pass 1 was not shorter than input.
- Compress more aggressively than normal while preserving task-critical facts.
- Remove repetition, low-value narrative, and secondary detail.
- Output must still be coherent and safe for continuation.`
}

/**
 * Check whether a compaction output is acceptable for convergence.
 *
 * We require non-empty content and strict token reduction versus the source.
 */
export function shouldAcceptCompactionOutput(output: string, inputTokens: number): boolean {
  const trimmed = output.trim()
  if (!trimmed) return false
  if (!Number.isFinite(inputTokens) || inputTokens <= 1) return false
  return Token.estimate(trimmed) < inputTokens
}

/**
 * Build deterministic fallback output (pass 3) by truncating source text until
 * it is strictly smaller than the source token count.
 */
export function buildDeterministicFallbackCompaction(input: {
  sourceText: string
  inputTokens: number
  suffixLabel: string
}): string {
  const source = input.sourceText.trim()
  if (!source) return ""

  const targetTokens = Number.isFinite(input.inputTokens) ? Math.max(1, Math.floor(input.inputTokens)) : Infinity
  if (!Number.isFinite(targetTokens) || targetTokens <= 1) {
    return source
  }

  const suffix = `\n[${input.suffixLabel}; truncated from ${targetTokens} tokens]`
  const sourceLen = source.length

  // Binary-search largest prefix that satisfies the strict token-reduction goal.
  const fitPrefix = (extra: string): string => {
    let lo = 1
    let hi = sourceLen
    let best = ""
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const prefix = source.slice(0, mid).trimEnd()
      const candidate = `${prefix}${extra}`.trim()
      if (!candidate) {
        hi = mid - 1
        continue
      }
      const candidateTokens = Token.estimate(candidate)
      if (candidateTokens < targetTokens) {
        best = candidate
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return best
  }

  const withSuffix = fitPrefix(suffix)
  if (withSuffix) return withSuffix

  const plainPrefix = fitPrefix("")
  if (plainPrefix) return plainPrefix

  // Last resort for pathological tiny inputs.
  return source.slice(0, 1)
}
