import { Database } from "bun:sqlite"
import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * SQLite Database Exploration Agent
 *
 * Analyzes SQLite database files and produces structured summaries that can
 * be placed in context instead of the full database content. This is useful
 * for LLMs to understand database structure without loading entire databases.
 */
export namespace SqliteExplorer {
  const log = Log.create({ service: "lcm.explore.sqlite" })

  /**
   * Escape a SQL identifier (table name, column name) for safe use in queries.
   * Uses double-quote escaping: wraps in double quotes and doubles any internal quotes.
   * Example: `my"table` becomes `"my""table"`
   */
  function escapeIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  }

  /**
   * Maximum number of sample rows to fetch per table
   */
  const MAX_SAMPLE_ROWS = 5

  /**
   * Maximum string length for sample values (truncate long values)
   */
  const MAX_VALUE_LENGTH = 100

  /**
   * Column metadata
   */
  export interface ColumnInfo {
    name: string
    type: string
  }

  /**
   * Table metadata including schema and statistics
   */
  export interface TableInfo {
    name: string
    columns: ColumnInfo[]
    rowCount: number
  }

  /**
   * Metadata about the database structure
   */
  export interface DatabaseMetadata {
    tables: TableInfo[]
    totalTables: number
    totalRows: number
  }

  /**
   * Index information
   */
  export interface IndexInfo {
    name: string
    tableName: string
    columns: string[]
    unique: boolean
  }

  /**
   * Result of database exploration
   */
  export interface SqliteExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted schema and sample data summary */
    summary: string
    /** Structured metadata about the database */
    metadata: DatabaseMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** List of indexes in the database */
    indexes: IndexInfo[]
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Explore a SQLite database file and produce a structured summary.
   *
   * @param input - The exploration input
   * @param input.filePath - Path to the SQLite database file
   * @returns Promise resolving to the exploration result
   */
  export async function explore(input: { filePath: string }): Promise<SqliteExplorationResult> {
    log.info("exploring sqlite database", { filePath: input.filePath })

    // Check if file exists
    const file = Bun.file(input.filePath)
    const exists = await file.exists()
    if (!exists) {
      log.warn("database file not found", { filePath: input.filePath })
      return createErrorResult(`File not found: ${input.filePath}`)
    }

    let db: Database | undefined
    try {
      // Open the database in read-only mode
      db = new Database(input.filePath, { readonly: true })

      // Extract schema information
      const tables = extractTables(db)
      const indexes = extractIndexes(db)

      // Calculate totals
      const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0)

      // Build the metadata
      const metadata: DatabaseMetadata = {
        tables,
        totalTables: tables.length,
        totalRows,
      }

      // Generate sample data for each table
      const samples = extractSamples(db, tables)

      // Format the summary
      const summary = formatSummary(input.filePath, metadata, indexes, samples)

      // Estimate token count
      const tokenCount = Token.estimate(summary)

      log.info("exploration complete", {
        filePath: input.filePath,
        tableCount: tables.length,
        totalRows,
        tokenCount,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
        indexes,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to explore database", { filePath: input.filePath, error: errorMessage })
      return createErrorResult(`Failed to open database: ${errorMessage}`)
    } finally {
      db?.close()
    }
  }

  /**
   * Extract table information from the database
   */
  function extractTables(db: Database): TableInfo[] {
    const tables: TableInfo[] = []

    // Get all user tables (excluding sqlite internal tables)
    const tableRows = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      )
      .all()

    for (const row of tableRows) {
      const tableName = row.name

      // Get column information using PRAGMA
      const columnRows = db.query<{ name: string; type: string }, [string]>(`PRAGMA table_info(?)`).all(tableName)

      const columns: ColumnInfo[] = columnRows.map((col) => ({
        name: col.name,
        type: col.type || "BLOB",
      }))

      // Get approximate row count
      // Using COUNT(*) is accurate but can be slow for large tables
      // For very large tables, we could use sqlite_stat1 if available
      let rowCount = 0
      try {
        const countResult = db
          .query<{ count: number }, []>(`SELECT COUNT(*) as count FROM ${escapeIdentifier(tableName)}`)
          .get()
        rowCount = countResult?.count ?? 0
      } catch {
        // Table might be corrupted or have issues
        rowCount = 0
      }

      tables.push({
        name: tableName,
        columns,
        rowCount,
      })
    }

    return tables
  }

  /**
   * Extract index information from the database
   */
  function extractIndexes(db: Database): IndexInfo[] {
    const indexes: IndexInfo[] = []

    // Get all indexes
    const indexRows = db
      .query<{ name: string; tbl_name: string }, []>(
        `SELECT name, tbl_name FROM sqlite_master
       WHERE type='index' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      )
      .all()

    for (const row of indexRows) {
      const indexName = row.name
      const tableName = row.tbl_name

      // Get index details using PRAGMA
      const indexInfo = db.query<{ name: string }, [string]>(`PRAGMA index_info(?)`).all(indexName)

      // Check if index is unique
      const indexListQuery = db
        .query<{ name: string; unique: number }, [string]>(`PRAGMA index_list(?)`)
        .all(tableName)
        .find((idx) => idx.name === indexName)

      indexes.push({
        name: indexName,
        tableName,
        columns: indexInfo.map((col) => col.name),
        unique: indexListQuery?.unique === 1,
      })
    }

    return indexes
  }

  /**
   * Extract sample rows from each table
   */
  function extractSamples(db: Database, tables: TableInfo[]): Map<string, Record<string, unknown>[]> {
    const samples = new Map<string, Record<string, unknown>[]>()

    for (const table of tables) {
      if (table.rowCount === 0) {
        samples.set(table.name, [])
        continue
      }

      try {
        const rows = db
          .query<Record<string, unknown>, []>(`SELECT * FROM ${escapeIdentifier(table.name)} LIMIT ${MAX_SAMPLE_ROWS}`)
          .all()

        // Truncate long string values
        const truncatedRows = rows.map((row) => {
          const truncated: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(row)) {
            if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
              truncated[key] = value.slice(0, MAX_VALUE_LENGTH) + "..."
            } else {
              truncated[key] = value
            }
          }
          return truncated
        })

        samples.set(table.name, truncatedRows)
      } catch {
        // Skip tables that can't be queried
        samples.set(table.name, [])
      }
    }

    return samples
  }

  /**
   * Format the database summary as a readable string
   */
  function formatSummary(
    filePath: string,
    metadata: DatabaseMetadata,
    indexes: IndexInfo[],
    samples: Map<string, Record<string, unknown>[]>,
  ): string {
    const lines: string[] = []

    // Database header
    const fileName = filePath.split("/").pop() ?? filePath
    lines.push(`Database: ${fileName}`)
    lines.push("")

    // Tables summary
    lines.push(`Tables (${metadata.totalTables}):`)
    for (const table of metadata.tables) {
      const colDef = table.columns.map((c) => `${c.name} ${c.type}`).join(", ")
      const rowCountStr = formatRowCount(table.rowCount)
      lines.push(`- ${table.name} (${colDef}) - ${rowCountStr} rows`)
    }

    // Indexes section (if any)
    if (indexes.length > 0) {
      lines.push("")
      lines.push(`Indexes (${indexes.length}):`)
      for (const idx of indexes) {
        const uniqueStr = idx.unique ? " UNIQUE" : ""
        lines.push(`- ${idx.name} on ${idx.tableName}(${idx.columns.join(", ")})${uniqueStr}`)
      }
    }

    // Sample data for each table with data
    for (const table of metadata.tables) {
      const tableSamples = samples.get(table.name) ?? []
      if (tableSamples.length === 0) continue

      lines.push("")
      lines.push(`Sample from ${table.name}:`)

      // Format as simple table
      const columns = table.columns.map((c) => c.name)
      lines.push(columns.join(" | "))

      for (const row of tableSamples) {
        const values = columns.map((col) => formatValue(row[col]))
        lines.push(values.join(" | "))
      }
    }

    return lines.join("\n")
  }

  /**
   * Format a row count with commas for readability
   */
  function formatRowCount(count: number): string {
    return count.toLocaleString("en-US")
  }

  /**
   * Format a value for display in the sample data
   */
  function formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL"
    }
    if (typeof value === "string") {
      return value
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value)
    }
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return `<blob ${value.length} bytes>`
    }
    return JSON.stringify(value)
  }

  /**
   * Create an error result
   */
  function createErrorResult(error: string): SqliteExplorationResult {
    return {
      success: false,
      summary: "",
      metadata: {
        tables: [],
        totalTables: 0,
        totalRows: 0,
      },
      tokenCount: 0,
      indexes: [],
      error,
    }
  }
}
