import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Log File Exploration Agent
 *
 * Analyzes log files and produces structured summaries including
 * log format detection, timestamp ranges, log level distribution,
 * error patterns, and sample entries.
 */
export namespace LogExplorer {
  const log = Log.create({ service: "lcm.explore.log" })

  /**
   * Maximum number of sample lines to include per category
   */
  const MAX_SAMPLE_LINES = 5

  /**
   * Maximum line length for samples
   */
  const MAX_LINE_LENGTH = 200

  /**
   * Number of lines to analyze for pattern detection
   */
  const ANALYSIS_LINES = 1000

  /**
   * Known log levels (case-insensitive)
   */
  const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "WARNING", "ERROR", "FATAL", "CRITICAL", "SEVERE"] as const
  type LogLevel = (typeof LOG_LEVELS)[number]

  /**
   * Detected log format
   */
  export type LogFormat =
    | "json"
    | "apache_combined"
    | "apache_common"
    | "nginx"
    | "syslog"
    | "systemd"
    | "iso_timestamp"
    | "custom_timestamp"
    | "unknown"

  /**
   * Log level statistics
   */
  export interface LevelStats {
    level: string
    count: number
    percentage: number
  }

  /**
   * Metadata about the log file
   */
  export interface LogMetadata {
    /** Total number of lines */
    lineCount: number
    /** Detected log format */
    format: LogFormat
    /** Earliest timestamp found (if any) */
    earliestTimestamp?: string
    /** Latest timestamp found (if any) */
    latestTimestamp?: string
    /** Log level distribution */
    levelStats: LevelStats[]
    /** Number of error/fatal entries */
    errorCount: number
    /** Number of warning entries */
    warningCount: number
    /** Common patterns/sources detected */
    sources: string[]
    /** Whether timestamps were detected */
    hasTimestamps: boolean
  }

  /**
   * Result of log exploration
   */
  export interface LogExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the log */
    metadata: LogMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Common timestamp patterns
   */
  const TIMESTAMP_PATTERNS: { pattern: RegExp; name: string }[] = [
    // ISO 8601: 2024-01-15T10:30:45.123Z or 2024-01-15 10:30:45
    { pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/, name: "iso" },
    // Apache/Nginx: [15/Jan/2024:10:30:45 +0000]
    { pattern: /\[\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}/, name: "apache" },
    // Syslog: Jan 15 10:30:45
    { pattern: /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/, name: "syslog" },
    // Unix timestamp: 1705315845
    { pattern: /^\d{10}(?:\.\d+)?/, name: "unix" },
    // Common log: 15/01/2024 10:30:45
    { pattern: /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/, name: "common" },
  ]

  /**
   * Detect the log format from content
   */
  function detectFormat(lines: string[]): LogFormat {
    const sampleLines = lines.slice(0, 100)
    let jsonCount = 0
    let apacheCount = 0
    let syslogCount = 0
    let isoCount = 0

    for (const line of sampleLines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Check for JSON logs
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          JSON.parse(trimmed)
          jsonCount++
          continue
        } catch {
          // Not valid JSON
        }
      }

      // Check for Apache Combined/Common format
      // 127.0.0.1 - - [15/Jan/2024:10:30:45 +0000] "GET /path HTTP/1.1" 200 1234
      if (/^\S+\s+\S+\s+\S+\s+\[[\d\/\w:+ ]+\]\s+"/.test(trimmed)) {
        apacheCount++
        continue
      }

      // Check for syslog format
      // Jan 15 10:30:45 hostname process[pid]: message
      if (/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+/.test(trimmed)) {
        syslogCount++
        continue
      }

      // Check for ISO timestamp format
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(trimmed)) {
        isoCount++
        continue
      }
    }

    const total = sampleLines.length
    const threshold = 0.3 // 30% of lines must match

    if (jsonCount / total > threshold) return "json"
    if (apacheCount / total > threshold) {
      // Distinguish between combined and common
      const hasCombined = sampleLines.some((l) => /"[^"]*"\s+\d+\s+\d+\s+"[^"]*"\s+"[^"]*"/.test(l))
      return hasCombined ? "apache_combined" : "apache_common"
    }
    if (syslogCount / total > threshold) return "syslog"
    if (isoCount / total > threshold) return "iso_timestamp"

    // Check if any timestamp pattern matches
    for (const line of sampleLines.slice(0, 20)) {
      for (const { pattern } of TIMESTAMP_PATTERNS) {
        if (pattern.test(line)) {
          return "custom_timestamp"
        }
      }
    }

    return "unknown"
  }

  /**
   * Extract timestamp from a log line
   */
  function extractTimestamp(line: string, format: LogFormat): string | undefined {
    switch (format) {
      case "json": {
        try {
          const obj = JSON.parse(line)
          // Common timestamp field names
          const tsFields = ["timestamp", "time", "ts", "@timestamp", "datetime", "date", "created_at"]
          for (const field of tsFields) {
            if (obj[field]) return String(obj[field])
          }
        } catch {
          // Not valid JSON
        }
        return undefined
      }

      case "apache_combined":
      case "apache_common": {
        const match = line.match(/\[(\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}[^\]]*)\]/)
        return match?.[1]
      }

      case "syslog": {
        const match = line.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/)
        return match?.[1]
      }

      case "iso_timestamp":
      case "custom_timestamp": {
        for (const { pattern } of TIMESTAMP_PATTERNS) {
          const match = line.match(pattern)
          if (match) return match[0]
        }
        return undefined
      }

      default:
        return undefined
    }
  }

  /**
   * Extract log level from a line
   */
  function extractLogLevel(line: string, format: LogFormat): string | undefined {
    const upperLine = line.toUpperCase()

    if (format === "json") {
      try {
        const obj = JSON.parse(line)
        const levelFields = ["level", "severity", "log_level", "loglevel", "lvl"]
        for (const field of levelFields) {
          if (obj[field]) {
            const val = String(obj[field]).toUpperCase()
            if (LOG_LEVELS.includes(val as LogLevel)) return val
          }
        }
      } catch {
        // Not valid JSON
      }
    }

    // Check for log levels in the line
    for (const level of LOG_LEVELS) {
      // Match level surrounded by non-word characters or brackets
      const patterns = [
        new RegExp(`\\b${level}\\b`, "i"),
        new RegExp(`\\[${level}\\]`, "i"),
        new RegExp(`<${level}>`, "i"),
      ]
      for (const pattern of patterns) {
        if (pattern.test(line)) return level
      }
    }

    return undefined
  }

  /**
   * Extract source/component from a log line
   */
  function extractSource(line: string, format: LogFormat): string | undefined {
    switch (format) {
      case "json": {
        try {
          const obj = JSON.parse(line)
          const sourceFields = ["source", "logger", "component", "service", "module", "class", "name"]
          for (const field of sourceFields) {
            if (obj[field]) return String(obj[field])
          }
        } catch {
          // Not valid JSON
        }
        return undefined
      }

      case "syslog": {
        // hostname process[pid]:
        const match = line.match(/^\S+\s+\d+\s+[\d:]+\s+(\S+)\s+(\S+?)(?:\[\d+\])?:/)
        return match?.[2]
      }

      default: {
        // Try to find bracketed component like [component] or (component)
        const bracketMatch = line.match(/\[([a-zA-Z][\w.-]*)\]/)
        if (bracketMatch) return bracketMatch[1]

        const parenMatch = line.match(/\(([a-zA-Z][\w.-]*)\)/)
        if (parenMatch) return parenMatch[1]

        return undefined
      }
    }
  }

  /**
   * Check if a line looks like an error
   */
  function isErrorLine(line: string): boolean {
    const level = extractLogLevel(line, "unknown")
    if (level && ["ERROR", "FATAL", "CRITICAL", "SEVERE"].includes(level)) return true

    // Check for common error patterns
    const errorPatterns = [
      /\b(exception|error|failed|failure|fatal|crash|panic|abort)\b/i,
      /\b(traceback|stack\s*trace)\b/i,
      /HTTP\/\d\.\d"\s+[45]\d\d\s/, // HTTP 4xx/5xx
    ]

    return errorPatterns.some((p) => p.test(line))
  }

  /**
   * Check if a line looks like a warning
   */
  function isWarningLine(line: string): boolean {
    const level = extractLogLevel(line, "unknown")
    if (level && ["WARN", "WARNING"].includes(level)) return true

    const warnPatterns = [/\b(warning|deprecated|timeout|retry|retrying)\b/i]

    return warnPatterns.some((p) => p.test(line))
  }

  /**
   * Truncate a line for display
   */
  function truncateLine(line: string): string {
    if (line.length <= MAX_LINE_LENGTH) return line
    return line.slice(0, MAX_LINE_LENGTH - 3) + "..."
  }

  /**
   * Input for exploring a log file
   */
  export interface ExploreInput {
    /** The file content to explore */
    content: string
    /** Optional file path for context */
    filePath?: string
    /** Optional model for LLM-based summary generation */
    model?: Provider.Model
    /** Optional abort signal */
    abort?: AbortSignal
  }

  /**
   * Format the log summary
   */
  function formatSummary(
    filePath: string,
    metadata: LogMetadata,
    errorSamples: string[],
    warnSamples: string[],
    recentSamples: string[],
  ): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: ${formatFormatName(metadata.format)}`)
    lines.push("")

    lines.push(`Statistics:`)
    lines.push(`- Total lines: ${metadata.lineCount.toLocaleString("en-US")}`)
    lines.push(`- Errors: ${metadata.errorCount.toLocaleString("en-US")}`)
    lines.push(`- Warnings: ${metadata.warningCount.toLocaleString("en-US")}`)

    if (metadata.hasTimestamps && metadata.earliestTimestamp && metadata.latestTimestamp) {
      lines.push("")
      lines.push(`Time Range:`)
      lines.push(`- Earliest: ${metadata.earliestTimestamp}`)
      lines.push(`- Latest: ${metadata.latestTimestamp}`)
    }

    if (metadata.levelStats.length > 0) {
      lines.push("")
      lines.push(`Log Levels:`)
      for (const stat of metadata.levelStats) {
        lines.push(`- ${stat.level}: ${stat.count.toLocaleString("en-US")} (${stat.percentage.toFixed(1)}%)`)
      }
    }

    if (metadata.sources.length > 0) {
      lines.push("")
      lines.push(`Sources/Components (top ${Math.min(metadata.sources.length, 10)}):`)
      for (const source of metadata.sources.slice(0, 10)) {
        lines.push(`- ${source}`)
      }
    }

    if (errorSamples.length > 0) {
      lines.push("")
      lines.push(`Sample Errors (first ${errorSamples.length}):`)
      for (const sample of errorSamples) {
        lines.push(`  ${truncateLine(sample)}`)
      }
    }

    if (warnSamples.length > 0) {
      lines.push("")
      lines.push(`Sample Warnings (first ${warnSamples.length}):`)
      for (const sample of warnSamples) {
        lines.push(`  ${truncateLine(sample)}`)
      }
    }

    if (recentSamples.length > 0) {
      lines.push("")
      lines.push(`Recent Entries (last ${recentSamples.length}):`)
      for (const sample of recentSamples) {
        lines.push(`  ${truncateLine(sample)}`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Get human-readable format name
   */
  function formatFormatName(format: LogFormat): string {
    switch (format) {
      case "json":
        return "JSON (structured)"
      case "apache_combined":
        return "Apache Combined Log"
      case "apache_common":
        return "Apache Common Log"
      case "nginx":
        return "Nginx Access Log"
      case "syslog":
        return "Syslog"
      case "systemd":
        return "Systemd Journal"
      case "iso_timestamp":
        return "ISO Timestamp Format"
      case "custom_timestamp":
        return "Custom Timestamp Format"
      default:
        return "Unknown/Plain Text"
    }
  }

  /**
   * Explore a log file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<LogExplorationResult> {
    const filePath = input.filePath ?? "unknown.log"
    log.info("exploring log file", { filePath })

    try {
      const allLines = input.content.split("\n")
      const nonEmptyLines = allLines.filter((line) => line.trim() !== "")
      const lineCount = nonEmptyLines.length

      if (lineCount === 0) {
        return {
          success: true,
          summary: `File: ${filePath.split("/").pop()}\nFormat: Log\nEmpty file`,
          metadata: {
            lineCount: 0,
            format: "unknown",
            levelStats: [],
            errorCount: 0,
            warningCount: 0,
            sources: [],
            hasTimestamps: false,
          },
          tokenCount: 10,
        }
      }

      // Detect format
      const format = detectFormat(nonEmptyLines)

      // Analyze lines
      const analysisLines = nonEmptyLines.slice(0, ANALYSIS_LINES)
      const levelCounts: Record<string, number> = {}
      const sourceCounts: Record<string, number> = {}
      const timestamps: string[] = []
      const errorLines: string[] = []
      const warnLines: string[] = []
      let errorCount = 0
      let warningCount = 0

      for (const line of analysisLines) {
        // Extract and count levels
        const level = extractLogLevel(line, format)
        if (level) {
          levelCounts[level] = (levelCounts[level] || 0) + 1
        }

        // Extract sources
        const source = extractSource(line, format)
        if (source) {
          sourceCounts[source] = (sourceCounts[source] || 0) + 1
        }

        // Extract timestamps
        const ts = extractTimestamp(line, format)
        if (ts) {
          timestamps.push(ts)
        }

        // Count and collect errors/warnings
        if (isErrorLine(line)) {
          errorCount++
          if (errorLines.length < MAX_SAMPLE_LINES) {
            errorLines.push(line)
          }
        } else if (isWarningLine(line)) {
          warningCount++
          if (warnLines.length < MAX_SAMPLE_LINES) {
            warnLines.push(line)
          }
        }
      }

      // Scale counts to full file if we only sampled
      const scaleFactor = lineCount / analysisLines.length
      if (scaleFactor > 1) {
        errorCount = Math.round(errorCount * scaleFactor)
        warningCount = Math.round(warningCount * scaleFactor)
      }

      // Build level stats
      const levelStats: LevelStats[] = Object.entries(levelCounts)
        .map(([level, count]) => ({
          level,
          count: Math.round(count * scaleFactor),
          percentage: (count / analysisLines.length) * 100,
        }))
        .sort((a, b) => b.count - a.count)

      // Get top sources
      const sources = Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([source]) => source)

      // Get recent samples (last lines of file)
      const recentSamples = nonEmptyLines.slice(-MAX_SAMPLE_LINES)

      const metadata: LogMetadata = {
        lineCount,
        format,
        earliestTimestamp: timestamps[0],
        latestTimestamp: timestamps[timestamps.length - 1],
        levelStats,
        errorCount,
        warningCount,
        sources,
        hasTimestamps: timestamps.length > 0,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        // Generate LLM-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(filePath, metadata, errorLines, warnLines, recentSamples)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "Log",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        // Fall back to template-based summary
        summary = formatSummary(filePath, metadata, errorLines, warnLines, recentSamples)
        tokenCount = Token.estimate(summary)
      }

      log.info("log exploration complete", {
        filePath,
        format,
        lineCount,
        errorCount,
        warningCount,
        tokenCount,
        usedLLM: !!input.model,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse log file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          lineCount: 0,
          format: "unknown",
          levelStats: [],
          errorCount: 0,
          warningCount: 0,
          sources: [],
          hasTimestamps: false,
        },
        tokenCount: 0,
        error: `Failed to parse log file: ${errorMessage}`,
      }
    }
  }
}
