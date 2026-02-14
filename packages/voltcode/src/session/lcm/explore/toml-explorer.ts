import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * TOML File Exploration Agent
 *
 * Analyzes TOML files and produces structured summaries showing
 * sections, keys, and value types.
 *
 * Uses a simple built-in TOML parser to avoid external dependencies.
 */
export namespace TomlExplorer {
  const log = Log.create({ service: "lcm.explore.toml" })

  /**
   * Maximum string length to show in samples
   */
  const MAX_STRING_LENGTH = 50

  /**
   * Section information
   */
  export interface SectionInfo {
    name: string
    keys: KeyInfo[]
    subsections: string[]
  }

  /**
   * Key information
   */
  export interface KeyInfo {
    name: string
    type: string
    sample?: string
  }

  /**
   * Metadata about the TOML structure
   */
  export interface TomlMetadata {
    /** Number of top-level sections */
    sectionCount: number
    /** Total number of keys */
    totalKeys: number
    /** List of section names */
    sections: string[]
    /** Maximum nesting depth */
    maxDepth: number
  }

  /**
   * Result of TOML exploration
   */
  export interface TomlExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the TOML */
    metadata: TomlMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Simple TOML parser that handles common cases
   */
  function parseToml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const lines = content.split("\n")
    let currentSection: Record<string, unknown> = result
    let currentPath: string[] = []

    for (const rawLine of lines) {
      const line = rawLine.trim()

      // Skip empty lines and comments
      if (line === "" || line.startsWith("#")) {
        continue
      }

      // Section header [section] or [section.subsection]
      const sectionMatch = line.match(/^\[([^\]]+)\]$/)
      if (sectionMatch) {
        currentPath = sectionMatch[1].split(".")
        currentSection = result

        for (const part of currentPath) {
          if (!(part in currentSection)) {
            currentSection[part] = {}
          }
          currentSection = currentSection[part] as Record<string, unknown>
        }
        continue
      }

      // Array of tables [[section]]
      const arrayTableMatch = line.match(/^\[\[([^\]]+)\]\]$/)
      if (arrayTableMatch) {
        currentPath = arrayTableMatch[1].split(".")
        let target: Record<string, unknown> = result

        for (let i = 0; i < currentPath.length - 1; i++) {
          const part = currentPath[i]
          if (!(part in target)) {
            target[part] = {}
          }
          target = target[part] as Record<string, unknown>
        }

        const lastPart = currentPath[currentPath.length - 1]
        if (!(lastPart in target)) {
          target[lastPart] = []
        }

        const arr = target[lastPart] as unknown[]
        const newObj: Record<string, unknown> = {}
        arr.push(newObj)
        currentSection = newObj
        continue
      }

      // Key-value pair
      const kvMatch = line.match(/^([^=]+)=(.*)$/)
      if (kvMatch) {
        const key = kvMatch[1].trim()
        const rawValue = kvMatch[2].trim()
        currentSection[key] = parseValue(rawValue)
      }
    }

    return result
  }

  /**
   * Parse a TOML value
   */
  function parseValue(rawValue: string): unknown {
    const value = rawValue.trim()

    // Boolean
    if (value === "true") return true
    if (value === "false") return false

    // String (double or single quoted)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1)
    }

    // Multi-line string (basic or literal)
    if (value.startsWith('"""') || value.startsWith("'''")) {
      return value.slice(3, -3)
    }

    // Array
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim()
      if (inner === "") return []

      // Simple array parsing (handles basic cases)
      const elements: unknown[] = []
      let current = ""
      let depth = 0
      let inString = false
      let stringChar = ""

      for (let i = 0; i < inner.length; i++) {
        const char = inner[i]

        if (!inString && (char === '"' || char === "'")) {
          inString = true
          stringChar = char
          current += char
        } else if (inString && char === stringChar && inner[i - 1] !== "\\") {
          inString = false
          current += char
        } else if (!inString && (char === "[" || char === "{")) {
          depth++
          current += char
        } else if (!inString && (char === "]" || char === "}")) {
          depth--
          current += char
        } else if (!inString && depth === 0 && char === ",") {
          const trimmed = current.trim()
          if (trimmed) {
            elements.push(parseValue(trimmed))
          }
          current = ""
        } else {
          current += char
        }
      }

      const trimmed = current.trim()
      if (trimmed) {
        elements.push(parseValue(trimmed))
      }

      return elements
    }

    // Inline table
    if (value.startsWith("{") && value.endsWith("}")) {
      const inner = value.slice(1, -1).trim()
      if (inner === "") return {}

      const result: Record<string, unknown> = {}
      const pairs = inner.split(",")

      for (const pair of pairs) {
        const eqIndex = pair.indexOf("=")
        if (eqIndex > 0) {
          const key = pair.slice(0, eqIndex).trim()
          const val = pair.slice(eqIndex + 1).trim()
          result[key] = parseValue(val)
        }
      }

      return result
    }

    // Date/time (basic detection)
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value // Keep as string for now
    }

    // Number (integer or float)
    const num = Number(value.replace(/_/g, ""))
    if (!isNaN(num) && value !== "") {
      return num
    }

    // Unquoted string or unknown
    return value
  }

  /**
   * Get the type name for a TOML value
   */
  function getTypeName(value: unknown): string {
    if (value === null || value === undefined) {
      return "null"
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return "array (empty)"
      const firstType = getTypeName(value[0])
      return `array[${value.length}] of ${firstType}`
    }
    if (typeof value === "object") {
      return "table"
    }
    return typeof value
  }

  /**
   * Get a sample string representation of a value
   */
  function getSample(value: unknown): string | undefined {
    if (value === null || value === undefined) return "null"
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) {
        return `"${value.slice(0, MAX_STRING_LENGTH)}..."`
      }
      return `"${value}"`
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value)
    }
    if (Array.isArray(value)) {
      return `[${value.length} items]`
    }
    return undefined
  }

  /**
   * Count total keys in a TOML object
   */
  function countKeys(obj: Record<string, unknown>, depth: number = 0): number {
    let count = 0
    for (const [, value] of Object.entries(obj)) {
      count++
      if (value && typeof value === "object" && !Array.isArray(value)) {
        count += countKeys(value as Record<string, unknown>, depth + 1)
      }
    }
    return count
  }

  /**
   * Calculate maximum depth
   */
  function calculateMaxDepth(obj: Record<string, unknown>, currentDepth: number = 0): number {
    let maxDepth = currentDepth
    for (const [, value] of Object.entries(obj)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const depth = calculateMaxDepth(value as Record<string, unknown>, currentDepth + 1)
        maxDepth = Math.max(maxDepth, depth)
      }
    }
    return maxDepth
  }

  /**
   * Get all section names (tables) at any depth
   */
  function getSectionNames(obj: Record<string, unknown>, prefix: string = ""): string[] {
    const sections: string[] = []
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const fullName = prefix ? `${prefix}.${key}` : key
        sections.push(fullName)
        sections.push(...getSectionNames(value as Record<string, unknown>, fullName))
      }
    }
    return sections
  }

  /**
   * Recursively format all sections
   */
  function formatAllSections(obj: Record<string, unknown>, prefix: string = "", indent: string = ""): string[] {
    const lines: string[] = []

    // First, format the current level's keys
    const currentKeys: { name: string; type: string; sample?: string }[] = []
    const subsections: Array<{ key: string; value: Record<string, unknown> }> = []

    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        subsections.push({ key, value: value as Record<string, unknown> })
      } else {
        currentKeys.push({
          name: key,
          type: getTypeName(value),
          sample: getSample(value),
        })
      }
    }

    // Format current level keys
    for (const key of currentKeys.slice(0, 15)) {
      const sampleStr = key.sample ? ` = ${key.sample}` : ""
      lines.push(`${indent}${key.name}: ${key.type}${sampleStr}`)
    }

    if (currentKeys.length > 15) {
      lines.push(`${indent}... and ${currentKeys.length - 15} more keys`)
    }

    // Format subsections
    for (const { key, value } of subsections.slice(0, 10)) {
      const fullName = prefix ? `${prefix}.${key}` : key
      lines.push("")
      lines.push(`${indent}[${fullName}]`)
      lines.push(...formatAllSections(value, fullName, indent + "  "))
    }

    if (subsections.length > 10) {
      lines.push(`${indent}... and ${subsections.length - 10} more sections`)
    }

    return lines
  }

  /**
   * Format the TOML summary
   */
  function formatSummary(filePath: string, metadata: TomlMetadata, parsed: Record<string, unknown>): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: TOML`)
    lines.push("")
    lines.push(`Structure:`)
    lines.push(`- Sections: ${metadata.sectionCount}`)
    lines.push(`- Total keys: ${metadata.totalKeys}`)
    lines.push(`- Max depth: ${metadata.maxDepth}`)
    lines.push("")
    lines.push("Content:")
    lines.push(...formatAllSections(parsed, "", ""))

    return lines.join("\n")
  }

  /**
   * Explore a TOML file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<TomlExplorationResult> {
    const filePath = input.filePath ?? "unknown.toml"
    log.info("exploring TOML file", { filePath })

    try {
      const parsed = parseToml(input.content)

      const sections = getSectionNames(parsed)
      const sectionCount = sections.length
      const totalKeys = countKeys(parsed)
      const maxDepth = calculateMaxDepth(parsed)

      const metadata: TomlMetadata = {
        sectionCount,
        totalKeys,
        sections,
        maxDepth,
      }

      const summary = formatSummary(filePath, metadata, parsed)
      const tokenCount = Token.estimate(summary)

      log.info("TOML exploration complete", {
        filePath,
        sectionCount,
        totalKeys,
        maxDepth,
        tokenCount,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse TOML", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          sectionCount: 0,
          totalKeys: 0,
          sections: [],
          maxDepth: 0,
        },
        tokenCount: 0,
        error: `Failed to parse TOML: ${errorMessage}`,
      }
    }
  }
}
