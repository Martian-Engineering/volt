import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * INI File Exploration Agent
 *
 * Analyzes INI files and produces structured summaries showing
 * sections and key-value pairs.
 */
export namespace IniExplorer {
  const log = Log.create({ service: "lcm.explore.ini" })

  /**
   * Maximum string length to show in samples
   */
  const MAX_VALUE_LENGTH = 50

  /**
   * Section information
   */
  export interface SectionInfo {
    name: string
    keys: KeyValueInfo[]
  }

  /**
   * Key-value pair information
   */
  export interface KeyValueInfo {
    key: string
    value: string
    isComment: boolean
  }

  /**
   * Metadata about the INI structure
   */
  export interface IniMetadata {
    /** Number of sections */
    sectionCount: number
    /** Total number of key-value pairs */
    totalKeys: number
    /** List of section names */
    sections: string[]
    /** Number of comments */
    commentCount: number
  }

  /**
   * Result of INI exploration
   */
  export interface IniExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the INI */
    metadata: IniMetadata
    /** Parsed sections with their key-value pairs */
    parsedSections: SectionInfo[]
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Parse an INI file into sections and key-value pairs
   */
  function parseIni(content: string): { sections: SectionInfo[]; commentCount: number } {
    const lines = content.split("\n")
    const sections: SectionInfo[] = []
    let currentSection: SectionInfo = { name: "(global)", keys: [] }
    let commentCount = 0

    for (const rawLine of lines) {
      const line = rawLine.trim()

      // Skip empty lines
      if (!line) continue

      // Check for comments
      if (line.startsWith(";") || line.startsWith("#")) {
        commentCount++
        continue
      }

      // Check for section header
      const sectionMatch = line.match(/^\[([^\]]+)\]$/)
      if (sectionMatch) {
        // Save current section if it has keys
        if (currentSection.keys.length > 0 || currentSection.name !== "(global)") {
          sections.push(currentSection)
        }
        currentSection = { name: sectionMatch[1], keys: [] }
        continue
      }

      // Check for key-value pair
      const kvMatch = line.match(/^([^=]+)=(.*)$/)
      if (kvMatch) {
        const key = kvMatch[1].trim()
        let value = kvMatch[2].trim()

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }

        currentSection.keys.push({
          key,
          value,
          isComment: false,
        })
      }
    }

    // Save the last section
    if (currentSection.keys.length > 0 || currentSection.name !== "(global)") {
      sections.push(currentSection)
    }

    // Remove empty global section if it's empty
    if (sections.length > 0 && sections[0].name === "(global)" && sections[0].keys.length === 0) {
      sections.shift()
    }

    return { sections, commentCount }
  }

  /**
   * Truncate a string to a maximum length
   */
  function truncate(value: string, maxLen: number): string {
    if (value.length <= maxLen) return value
    return value.slice(0, maxLen - 3) + "..."
  }

  /**
   * Format the INI summary
   */
  function formatSummary(filePath: string, metadata: IniMetadata, sections: SectionInfo[]): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: INI`)
    lines.push("")
    lines.push(`Structure:`)
    lines.push(`- Sections: ${metadata.sectionCount}`)
    lines.push(`- Total keys: ${metadata.totalKeys}`)
    if (metadata.commentCount > 0) {
      lines.push(`- Comments: ${metadata.commentCount}`)
    }
    lines.push("")

    // List sections and their keys
    lines.push("Sections:")
    for (const section of sections.slice(0, 15)) {
      lines.push(``)
      lines.push(`[${section.name}] (${section.keys.length} keys)`)

      for (const kv of section.keys.slice(0, 10)) {
        const truncatedValue = truncate(kv.value, MAX_VALUE_LENGTH)
        lines.push(`  ${kv.key} = ${truncatedValue}`)
      }

      if (section.keys.length > 10) {
        lines.push(`  ... and ${section.keys.length - 10} more keys`)
      }
    }

    if (sections.length > 15) {
      lines.push(``)
      lines.push(`... and ${sections.length - 15} more sections`)
    }

    return lines.join("\n")
  }

  /**
   * Explore an INI file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<IniExplorationResult> {
    const filePath = input.filePath ?? "unknown.ini"
    log.info("exploring INI file", { filePath })

    try {
      const { sections, commentCount } = parseIni(input.content)

      const sectionCount = sections.length
      const totalKeys = sections.reduce((sum, s) => sum + s.keys.length, 0)
      const sectionNames = sections.map((s) => s.name)

      const metadata: IniMetadata = {
        sectionCount,
        totalKeys,
        sections: sectionNames,
        commentCount,
      }

      const summary = formatSummary(filePath, metadata, sections)
      const tokenCount = Token.estimate(summary)

      log.info("INI exploration complete", {
        filePath,
        sectionCount,
        totalKeys,
        tokenCount,
      })

      return {
        success: true,
        summary,
        metadata,
        parsedSections: sections,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse INI", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          sectionCount: 0,
          totalKeys: 0,
          sections: [],
          commentCount: 0,
        },
        parsedSections: [],
        tokenCount: 0,
        error: `Failed to parse INI: ${errorMessage}`,
      }
    }
  }
}
