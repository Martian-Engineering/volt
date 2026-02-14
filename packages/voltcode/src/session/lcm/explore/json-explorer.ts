import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * JSON File Exploration Agent
 *
 * Analyzes JSON files and produces structured summaries that describe
 * the structure, types, and shape of the data without including all values.
 */
export namespace JsonExplorer {
  const log = Log.create({ service: "lcm.explore.json" })

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
   * Type information for a JSON value
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
   * Metadata about the JSON structure
   */
  export interface JsonMetadata {
    /** Root type of the JSON */
    rootType: "array" | "object" | "primitive"
    /** Maximum nesting depth */
    maxDepth: number
    /** Total number of keys at all levels */
    totalKeys: number
    /** Total number of array elements */
    totalArrayElements: number
    /** Whether the JSON is minified (no formatting) */
    isMinified: boolean
  }

  /**
   * Result of JSON exploration
   */
  export interface JsonExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the JSON */
    metadata: JsonMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Analyze a JSON value and extract type information
   */
  function analyzeType(value: unknown, depth: number = 0): TypeInfo {
    if (value === null) {
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
        // Limit to 20 keys per level
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
   * Calculate the maximum depth of a JSON structure
   */
  function calculateMaxDepth(value: unknown, currentDepth: number = 0): number {
    if (value === null || typeof value !== "object") {
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
   * Count total keys in the JSON structure
   */
  function countKeys(value: unknown): number {
    if (value === null || typeof value !== "object") {
      return 0
    }

    if (Array.isArray(value)) {
      return value.slice(0, 100).reduce((sum, v) => sum + countKeys(v), 0)
    }

    const keys = Object.keys(value)
    return keys.length + keys.slice(0, 50).reduce((sum, k) => sum + countKeys((value as Record<string, unknown>)[k]), 0)
  }

  /**
   * Count total array elements in the JSON structure
   */
  function countArrayElements(value: unknown): number {
    if (value === null || typeof value !== "object") {
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
   * Format the JSON summary
   */
  function formatSummary(filePath: string, metadata: JsonMetadata, typeInfo: TypeInfo): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: JSON${metadata.isMinified ? " (minified)" : ""}`)
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
   * Explore a JSON file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<JsonExplorationResult> {
    const filePath = input.filePath ?? "unknown.json"
    log.info("exploring JSON file", { filePath })

    try {
      const parsed = JSON.parse(input.content)

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

      // Check if minified (no newlines in original content)
      const isMinified = !input.content.includes("\n") && input.content.length > 100

      const metadata: JsonMetadata = {
        rootType,
        maxDepth,
        totalKeys,
        totalArrayElements,
        isMinified,
      }

      const summary = formatSummary(filePath, metadata, typeInfo)
      const tokenCount = Token.estimate(summary)

      log.info("JSON exploration complete", {
        filePath,
        rootType,
        maxDepth,
        totalKeys,
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
      log.error("failed to parse JSON", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          rootType: "object",
          maxDepth: 0,
          totalKeys: 0,
          totalArrayElements: 0,
          isMinified: false,
        },
        tokenCount: 0,
        error: `Failed to parse JSON: ${errorMessage}`,
      }
    }
  }
}
