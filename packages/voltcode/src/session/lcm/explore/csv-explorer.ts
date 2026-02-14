import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * CSV File Exploration Agent
 *
 * Analyzes CSV files and produces structured summaries including
 * headers, row count, sample rows, and inferred column types.
 */
export namespace CsvExplorer {
  const log = Log.create({ service: "lcm.explore.csv" })

  /**
   * Maximum number of sample rows to include
   */
  const MAX_SAMPLE_ROWS = 5

  /**
   * Maximum string length for cell values
   */
  const MAX_CELL_LENGTH = 50

  /**
   * Number of rows to analyze for type inference
   */
  const TYPE_INFERENCE_ROWS = 100

  /**
   * Inferred column type
   */
  export type ColumnType = "string" | "number" | "boolean" | "date" | "empty" | "mixed"

  /**
   * Column metadata
   */
  export interface ColumnInfo {
    name: string
    type: ColumnType
    emptyCount: number
    uniqueValues?: number
  }

  /**
   * Metadata about the CSV structure
   */
  export interface CsvMetadata {
    /** Number of columns */
    columnCount: number
    /** Number of data rows (excluding header) */
    rowCount: number
    /** Column information */
    columns: ColumnInfo[]
    /** Detected delimiter */
    delimiter: string
    /** Whether the CSV has a header row */
    hasHeader: boolean
  }

  /**
   * Result of CSV exploration
   */
  export interface CsvExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the CSV */
    metadata: CsvMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Detect the delimiter used in the CSV
   */
  function detectDelimiter(content: string): string {
    const firstLines = content.split("\n").slice(0, 5).join("\n")

    const delimiters = [",", "\t", ";", "|"]
    const counts: Record<string, number> = {}

    for (const delim of delimiters) {
      counts[delim] = (firstLines.match(new RegExp(delim.replace(/[|]/g, "\\$&"), "g")) || []).length
    }

    // Return the delimiter with the highest count
    let maxDelim = ","
    let maxCount = 0
    for (const [delim, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count
        maxDelim = delim
      }
    }

    return maxDelim
  }

  /**
   * Parse a CSV line, handling quoted fields
   */
  function parseLine(line: string, delimiter: string): string[] {
    const fields: string[] = []
    let current = ""
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      const nextChar = line[i + 1]

      if (inQuotes) {
        if (char === '"' && nextChar === '"') {
          // Escaped quote
          current += '"'
          i++
        } else if (char === '"') {
          // End of quoted field
          inQuotes = false
        } else {
          current += char
        }
      } else {
        if (char === '"') {
          // Start of quoted field
          inQuotes = true
        } else if (char === delimiter) {
          fields.push(current.trim())
          current = ""
        } else {
          current += char
        }
      }
    }

    fields.push(current.trim())
    return fields
  }

  /**
   * Infer the type of a cell value
   */
  function inferCellType(value: string): ColumnType {
    if (value === "" || value === null || value === undefined) {
      return "empty"
    }

    const trimmed = value.trim().toLowerCase()

    // Boolean check
    if (trimmed === "true" || trimmed === "false" || trimmed === "yes" || trimmed === "no") {
      return "boolean"
    }

    // Number check
    const num = Number(value.replace(/,/g, ""))
    if (!isNaN(num) && value.trim() !== "") {
      return "number"
    }

    // Date check (common formats)
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
      /^\d{2}\/\d{2}\/\d{4}$/, // MM/DD/YYYY
      /^\d{2}-\d{2}-\d{4}$/, // DD-MM-YYYY
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO datetime
    ]

    for (const pattern of datePatterns) {
      if (pattern.test(value.trim())) {
        return "date"
      }
    }

    return "string"
  }

  /**
   * Infer the overall type for a column based on multiple values
   */
  function inferColumnType(values: string[]): ColumnType {
    const types = new Set<ColumnType>()

    for (const value of values) {
      const type = inferCellType(value)
      if (type !== "empty") {
        types.add(type)
      }
    }

    if (types.size === 0) return "empty"
    if (types.size === 1) return Array.from(types)[0]
    return "mixed"
  }

  /**
   * Check if first row looks like a header
   */
  function detectHeader(rows: string[][]): boolean {
    if (rows.length < 2) return false

    const firstRow = rows[0]
    const secondRow = rows[1]

    // If first row has all strings and second row has numbers, likely a header
    let firstRowAllStrings = true
    let secondRowHasNumbers = false

    for (const cell of firstRow) {
      if (!isNaN(Number(cell.replace(/,/g, ""))) && cell.trim() !== "") {
        firstRowAllStrings = false
      }
    }

    for (const cell of secondRow) {
      if (!isNaN(Number(cell.replace(/,/g, ""))) && cell.trim() !== "") {
        secondRowHasNumbers = true
      }
    }

    return firstRowAllStrings && secondRowHasNumbers
  }

  /**
   * Truncate a string to a maximum length
   */
  function truncate(value: string, maxLen: number): string {
    if (value.length <= maxLen) return value
    return value.slice(0, maxLen - 3) + "..."
  }

  /**
   * Format the CSV summary
   */
  function formatSummary(filePath: string, metadata: CsvMetadata, sampleRows: string[][], headers: string[]): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: CSV (delimiter: ${metadata.delimiter === "\t" ? "TAB" : `"${metadata.delimiter}"`})`)
    lines.push("")
    lines.push(`Structure:`)
    lines.push(`- Columns: ${metadata.columnCount}`)
    lines.push(`- Rows: ${metadata.rowCount.toLocaleString("en-US")}${metadata.hasHeader ? " (excluding header)" : ""}`)
    lines.push("")

    // Column info
    lines.push("Columns:")
    for (const col of metadata.columns) {
      const emptyPct = metadata.rowCount > 0 ? Math.round((col.emptyCount / metadata.rowCount) * 100) : 0
      const emptyInfo = emptyPct > 0 ? `, ${emptyPct}% empty` : ""
      lines.push(`- ${col.name}: ${col.type}${emptyInfo}`)
    }

    // Sample data
    if (sampleRows.length > 0) {
      lines.push("")
      lines.push(`Sample rows (first ${sampleRows.length}):`)

      // Header row
      const truncatedHeaders = headers.map((h) => truncate(h, MAX_CELL_LENGTH))
      lines.push(truncatedHeaders.join(" | "))

      // Data rows
      for (const row of sampleRows) {
        const truncatedRow = row.map((cell) => truncate(cell, MAX_CELL_LENGTH))
        lines.push(truncatedRow.join(" | "))
      }
    }

    return lines.join("\n")
  }

  /**
   * Explore a CSV file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<CsvExplorationResult> {
    const filePath = input.filePath ?? "unknown.csv"
    log.info("exploring CSV file", { filePath })

    try {
      const delimiter = detectDelimiter(input.content)
      const allLines = input.content.split("\n").filter((line) => line.trim() !== "")

      if (allLines.length === 0) {
        return {
          success: true,
          summary: `File: ${filePath.split("/").pop()}\nFormat: CSV\nEmpty file`,
          metadata: {
            columnCount: 0,
            rowCount: 0,
            columns: [],
            delimiter,
            hasHeader: false,
          },
          tokenCount: 10,
        }
      }

      // Parse all rows
      const rows = allLines.map((line) => parseLine(line, delimiter))
      const hasHeader = detectHeader(rows)

      // Extract headers and data rows
      const headers = hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`)
      const dataRows = hasHeader ? rows.slice(1) : rows

      const columnCount = headers.length
      const rowCount = dataRows.length

      // Analyze columns
      const columns: ColumnInfo[] = []
      for (let i = 0; i < columnCount; i++) {
        const columnValues = dataRows.slice(0, TYPE_INFERENCE_ROWS).map((row) => row[i] ?? "")
        const emptyCount = dataRows.filter((row) => !row[i] || row[i].trim() === "").length

        columns.push({
          name: headers[i] ?? `Column ${i + 1}`,
          type: inferColumnType(columnValues),
          emptyCount,
        })
      }

      const metadata: CsvMetadata = {
        columnCount,
        rowCount,
        columns,
        delimiter,
        hasHeader,
      }

      // Get sample rows
      const sampleRows = dataRows.slice(0, MAX_SAMPLE_ROWS)

      const summary = formatSummary(filePath, metadata, sampleRows, headers)
      const tokenCount = Token.estimate(summary)

      log.info("CSV exploration complete", {
        filePath,
        columnCount,
        rowCount,
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
      log.error("failed to parse CSV", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          columnCount: 0,
          rowCount: 0,
          columns: [],
          delimiter: ",",
          hasHeader: false,
        },
        tokenCount: 0,
        error: `Failed to parse CSV: ${errorMessage}`,
      }
    }
  }
}
