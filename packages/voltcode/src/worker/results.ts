import path from "path"

export interface RunResult {
  success: boolean
  score?: number
  error?: string
}

export interface TokenUsage {
  tokens_in: number
  tokens_out: number
  tokens_cached?: number
}

/**
 * Parse result.json from an output directory.
 *
 * @param outputDir - Directory containing result.json
 * @returns RunResult or null if file doesn't exist or is malformed
 */
export async function parseResult(outputDir: string): Promise<RunResult | null> {
  const resultPath = path.join(outputDir, "result.json")
  const file = Bun.file(resultPath)

  const exists = await file.exists()
  if (!exists) return null

  const text = await file.text().catch(() => null)
  if (!text) return null

  try {
    const data = JSON.parse(text)
    return {
      success: Boolean(data.success),
      score: typeof data.score === "number" ? data.score : undefined,
      error: typeof data.error === "string" ? data.error : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Extract token usage from trace.jsonl in an output directory.
 *
 * Each line in trace.jsonl should contain a `usage` field with:
 * - input_tokens
 * - output_tokens
 * - cache_read_input_tokens (optional)
 *
 * If trace.jsonl has no usage data, falls back to parsing raw trace files
 * in traces/ directory (JSON event streams with step_finish events).
 *
 * @param outputDir - Directory containing trace.jsonl and/or traces/
 * @returns TokenUsage with summed values (zeros if no data found)
 */
export async function extractTokens(outputDir: string): Promise<TokenUsage> {
  // First try trace.jsonl
  const tracePath = path.join(outputDir, "trace.jsonl")
  const file = Bun.file(tracePath)
  const exists = await file.exists()

  if (exists) {
    const text = await file.text().catch(() => "")
    if (text) {
      let tokensIn = 0
      let tokensOut = 0
      let tokensCached = 0

      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const data = JSON.parse(trimmed)
          const usage = data.usage
          if (usage && typeof usage === "object") {
            if (typeof usage.input_tokens === "number") tokensIn += usage.input_tokens
            if (typeof usage.output_tokens === "number") tokensOut += usage.output_tokens
            if (typeof usage.cache_read_input_tokens === "number") tokensCached += usage.cache_read_input_tokens
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (tokensIn > 0 || tokensOut > 0) {
        return {
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          tokens_cached: tokensCached > 0 ? tokensCached : undefined,
        }
      }
    }
  }

  // Fallback: parse raw trace files in traces/ directory
  // These contain JSON event streams with step_finish events that have usage data
  const tracesDir = path.join(outputDir, "traces")
  const { readdir, stat } = await import("fs/promises")
  const tracesDirExists = await stat(tracesDir)
    .then((s) => s.isDirectory())
    .catch(() => false)

  if (tracesDirExists) {
    let tokensIn = 0
    let tokensOut = 0
    let tokensCached = 0

    const files = await readdir(tracesDir).catch(() => [] as string[])

    for (const filename of files) {
      if (!filename.endsWith(".json")) continue
      const traceFile = Bun.file(path.join(tracesDir, filename))
      const content = await traceFile.text().catch(() => "")
      if (!content) continue

      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("{")) continue
        try {
          const event = JSON.parse(trimmed)
          if (event.type === "step_finish" && event.part?.usage) {
            const usage = event.part.usage
            if (typeof usage.input_tokens === "number") tokensIn += usage.input_tokens
            if (typeof usage.output_tokens === "number") tokensOut += usage.output_tokens
            if (typeof usage.cache_read_input_tokens === "number") tokensCached += usage.cache_read_input_tokens
          }
        } catch {
          // skip
        }
      }
    }

    return {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cached: tokensCached > 0 ? tokensCached : undefined,
    }
  }

  return { tokens_in: 0, tokens_out: 0, tokens_cached: 0 }
}
