import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * YAML File Exploration Agent
 *
 * Analyzes YAML files and produces structured summaries that describe
 * the structure, types, and shape of the data without including all values.
 *
 * Uses a simple built-in YAML parser to avoid external dependencies.
 */
export namespace YamlExplorer {
  const log = Log.create({ service: "lcm.explore.yaml" })

  /**
   * Maximum depth to analyze for nested structures
   */
  const MAX_DEPTH = 10

  /**
   * Maximum number of array items to sample
   */
  const MAX_ARRAY_SAMPLE = 3

  /**
   * Maximum string length to show in samples
   */
  const MAX_STRING_LENGTH = 50

  /**
   * Type information for a YAML value
   */
  export interface TypeInfo {
    type: "string" | "number" | "boolean" | "null" | "array" | "object"
    /** For arrays: element type info */
    elementType?: TypeInfo
    /** For objects: key-type pairs */
    properties?: Record<string, TypeInfo>
    /** For arrays: length */
    length?: number
    /** Sample values (for primitives) */
    sample?: unknown
    /** Whether this type is consistent across array elements */
    consistent?: boolean
  }

  /**
   * Metadata about the YAML structure
   */
  export interface YamlMetadata {
    /** Root type of the YAML */
    rootType: "array" | "object" | "primitive"
    /** Maximum nesting depth */
    maxDepth: number
    /** Total number of keys at all levels */
    totalKeys: number
    /** Total number of array elements */
    totalArrayElements: number
    /** Whether the YAML has multiple documents */
    hasMultipleDocuments: boolean
    /** Number of documents (if multiple) */
    documentCount: number
  }

  /**
   * Result of YAML exploration
   */
  export interface YamlExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the YAML */
    metadata: YamlMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Simple YAML parser that handles common cases
   */
  function parseYaml(content: string): unknown {
    const lines = content.split("\n")
    let lineIndex = 0

    function getIndent(line: string): number {
      const match = line.match(/^(\s*)/)
      return match ? match[1].length : 0
    }

    function parseValue(value: string): unknown {
      const trimmed = value.trim()

      // Null
      if (trimmed === "" || trimmed === "null" || trimmed === "~") {
        return null
      }

      // Boolean
      if (trimmed === "true" || trimmed === "yes" || trimmed === "on") {
        return true
      }
      if (trimmed === "false" || trimmed === "no" || trimmed === "off") {
        return false
      }

      // Number
      const num = Number(trimmed)
      if (!isNaN(num) && trimmed !== "") {
        return num
      }

      // Quoted string
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1)
      }

      // Inline array
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          return JSON.parse(trimmed)
        } catch {
          return trimmed
        }
      }

      // Inline object
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          return JSON.parse(trimmed)
        } catch {
          return trimmed
        }
      }

      return trimmed
    }

    function parseBlock(baseIndent: number): unknown {
      const result: Record<string, unknown> = {}
      let currentArray: unknown[] | null = null
      let isArray = false

      while (lineIndex < lines.length) {
        const line = lines[lineIndex]
        const trimmedLine = line.trim()

        // Skip empty lines and comments
        if (trimmedLine === "" || trimmedLine.startsWith("#")) {
          lineIndex++
          continue
        }

        const indent = getIndent(line)

        // If we've dedented, return
        if (indent < baseIndent) {
          break
        }

        // Array item
        if (trimmedLine.startsWith("- ")) {
          if (!isArray) {
            isArray = true
            currentArray = []
          }

          const afterDash = trimmedLine.slice(2).trim()

          // Check if it's a nested object
          if (afterDash === "" || afterDash.includes(":")) {
            lineIndex++
            if (afterDash.includes(":")) {
              // Inline key-value after dash
              const colonIndex = afterDash.indexOf(":")
              const key = afterDash.slice(0, colonIndex).trim()
              const value = afterDash.slice(colonIndex + 1).trim()

              const item: Record<string, unknown> = {}
              item[key] = value === "" ? parseBlock(indent + 2) : parseValue(value)

              // Check for more keys at same level
              while (lineIndex < lines.length) {
                const nextLine = lines[lineIndex]
                const nextTrimmed = nextLine.trim()
                if (nextTrimmed === "" || nextTrimmed.startsWith("#")) {
                  lineIndex++
                  continue
                }
                const nextIndent = getIndent(nextLine)
                if (nextIndent <= indent || nextTrimmed.startsWith("-")) break

                if (nextTrimmed.includes(":")) {
                  const ci = nextTrimmed.indexOf(":")
                  const k = nextTrimmed.slice(0, ci).trim()
                  const v = nextTrimmed.slice(ci + 1).trim()
                  item[k] = v === "" ? parseBlock(nextIndent + 2) : parseValue(v)
                }
                lineIndex++
              }

              currentArray!.push(item)
            } else {
              const nested = parseBlock(indent + 2)
              currentArray!.push(nested)
            }
          } else {
            currentArray!.push(parseValue(afterDash))
            lineIndex++
          }
          continue
        }

        // Key-value pair
        const colonIndex = trimmedLine.indexOf(":")
        if (colonIndex > 0) {
          const key = trimmedLine.slice(0, colonIndex).trim()
          const value = trimmedLine.slice(colonIndex + 1).trim()

          lineIndex++

          if (value === "") {
            // Nested block
            result[key] = parseBlock(indent + 2)
          } else {
            result[key] = parseValue(value)
          }
          continue
        }

        lineIndex++
      }

      return isArray ? currentArray : result
    }

    // Skip document markers
    while (lineIndex < lines.length) {
      const trimmed = lines[lineIndex].trim()
      if (trimmed === "---" || trimmed === "") {
        lineIndex++
        continue
      }
      break
    }

    return parseBlock(0)
  }

  /**
   * Count document separators in YAML content
   */
  function countDocuments(content: string): number {
    const matches = content.match(/^---$/gm)
    return matches ? Math.max(1, matches.length) : 1
  }

  /**
   * Analyze a YAML value and extract type information
   */
  function analyzeType(value: unknown, depth: number = 0): TypeInfo {
    if (value === null || value === undefined) {
      return { type: "null" }
    }

    if (Array.isArray(value)) {
      const length = value.length
      if (length === 0) {
        return { type: "array", length: 0 }
      }

      // Sample elements to determine type consistency
      const sampleSize = Math.min(MAX_ARRAY_SAMPLE, length)
      const samples: TypeInfo[] = []
      for (let i = 0; i < sampleSize; i++) {
        samples.push(analyzeType(value[i], depth + 1))
      }

      // Check if all sampled elements have the same type
      const firstType = samples[0].type
      const consistent = samples.every((s) => s.type === firstType)

      return {
        type: "array",
        length,
        elementType: samples[0],
        consistent,
      }
    }

    if (typeof value === "object") {
      const keys = Object.keys(value as object)
      if (keys.length === 0) {
        return { type: "object", properties: {} }
      }

      if (depth >= MAX_DEPTH) {
        return { type: "object", properties: {} }
      }

      const properties: Record<string, TypeInfo> = {}
      for (const key of keys.slice(0, 20)) {
        properties[key] = analyzeType((value as Record<string, unknown>)[key], depth + 1)
      }

      return { type: "object", properties }
    }

    if (typeof value === "string") {
      const sample = value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) + "..." : value
      return { type: "string", sample }
    }

    if (typeof value === "number") {
      return { type: "number", sample: value }
    }

    if (typeof value === "boolean") {
      return { type: "boolean", sample: value }
    }

    return { type: "null" }
  }

  /**
   * Calculate the maximum depth of a structure
   */
  function calculateMaxDepth(value: unknown, currentDepth: number = 0): number {
    if (value === null || value === undefined || typeof value !== "object") {
      return currentDepth
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return currentDepth
      return Math.max(...value.slice(0, 10).map((v) => calculateMaxDepth(v, currentDepth + 1)))
    }

    const keys = Object.keys(value)
    if (keys.length === 0) return currentDepth
    return Math.max(
      ...keys.slice(0, 20).map((k) => calculateMaxDepth((value as Record<string, unknown>)[k], currentDepth + 1)),
    )
  }

  /**
   * Count total keys in the structure
   */
  function countKeys(value: unknown): number {
    if (value === null || value === undefined || typeof value !== "object") {
      return 0
    }

    if (Array.isArray(value)) {
      return value.slice(0, 100).reduce((sum, v) => sum + countKeys(v), 0)
    }

    const keys = Object.keys(value)
    return keys.length + keys.slice(0, 50).reduce((sum, k) => sum + countKeys((value as Record<string, unknown>)[k]), 0)
  }

  /**
   * Count total array elements in the structure
   */
  function countArrayElements(value: unknown): number {
    if (value === null || value === undefined || typeof value !== "object") {
      return 0
    }

    if (Array.isArray(value)) {
      return value.length + value.slice(0, 100).reduce((sum, v) => sum + countArrayElements(v), 0)
    }

    const keys = Object.keys(value)
    return keys.slice(0, 50).reduce((sum, k) => sum + countArrayElements((value as Record<string, unknown>)[k]), 0)
  }

  /**
   * Format type info as a readable string
   */
  function formatTypeInfo(info: TypeInfo, indent: string = ""): string {
    switch (info.type) {
      case "null":
        return "null"
      case "string":
        return info.sample ? `string (e.g. "${info.sample}")` : "string"
      case "number":
        return info.sample !== undefined ? `number (e.g. ${info.sample})` : "number"
      case "boolean":
        return info.sample !== undefined ? `boolean (${info.sample})` : "boolean"
      case "array": {
        if (info.length === 0) return "array (empty)"
        const elementDesc = info.elementType ? formatTypeInfo(info.elementType, indent) : "unknown"
        const consistency = info.consistent ? "" : " (mixed types)"
        return `array[${info.length}] of ${elementDesc}${consistency}`
      }
      case "object": {
        if (!info.properties || Object.keys(info.properties).length === 0) {
          return "object (empty)"
        }
        const lines: string[] = ["object {"]
        const entries = Object.entries(info.properties)
        for (const [key, typeInfo] of entries.slice(0, 15)) {
          lines.push(`${indent}  ${key}: ${formatTypeInfo(typeInfo, indent + "  ")}`)
        }
        if (entries.length > 15) {
          lines.push(`${indent}  ... and ${entries.length - 15} more keys`)
        }
        lines.push(`${indent}}`)
        return lines.join("\n")
      }
      default:
        return "unknown"
    }
  }

  /**
   * Format the YAML summary
   */
  function formatSummary(filePath: string, metadata: YamlMetadata, typeInfo: TypeInfo): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: YAML`)
    if (metadata.hasMultipleDocuments) {
      lines.push(`Documents: ${metadata.documentCount}`)
    }
    lines.push("")
    lines.push(`Structure:`)
    lines.push(`- Root type: ${metadata.rootType}`)
    lines.push(`- Max depth: ${metadata.maxDepth}`)
    lines.push(`- Total keys: ${metadata.totalKeys.toLocaleString("en-US")}`)
    if (metadata.totalArrayElements > 0) {
      lines.push(`- Total array elements: ${metadata.totalArrayElements.toLocaleString("en-US")}`)
    }
    lines.push("")
    lines.push("Schema:")
    lines.push(formatTypeInfo(typeInfo, ""))

    return lines.join("\n")
  }

  /**
   * Explore a YAML file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<YamlExplorationResult> {
    const filePath = input.filePath ?? "unknown.yaml"
    log.info("exploring YAML file", { filePath })

    try {
      // Check for multiple documents
      const documentCount = countDocuments(input.content)
      const hasMultipleDocuments = documentCount > 1

      // Parse the YAML
      const parsed = parseYaml(input.content)

      // Determine root type
      let rootType: "array" | "object" | "primitive"
      if (Array.isArray(parsed)) {
        rootType = "array"
      } else if (parsed !== null && typeof parsed === "object") {
        rootType = "object"
      } else {
        rootType = "primitive"
      }

      // Analyze structure
      const typeInfo = analyzeType(parsed)
      const maxDepth = calculateMaxDepth(parsed)
      const totalKeys = countKeys(parsed)
      const totalArrayElements = countArrayElements(parsed)

      const metadata: YamlMetadata = {
        rootType,
        maxDepth,
        totalKeys,
        totalArrayElements,
        hasMultipleDocuments,
        documentCount,
      }

      const summary = formatSummary(filePath, metadata, typeInfo)
      const tokenCount = Token.estimate(summary)

      log.info("YAML exploration complete", {
        filePath,
        rootType,
        maxDepth,
        totalKeys,
        documentCount,
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
      log.error("failed to parse YAML", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          rootType: "object",
          maxDepth: 0,
          totalKeys: 0,
          totalArrayElements: 0,
          hasMultipleDocuments: false,
          documentCount: 0,
        },
        tokenCount: 0,
        error: `Failed to parse YAML: ${errorMessage}`,
      }
    }
  }
}
