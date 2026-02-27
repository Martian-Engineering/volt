import fs from "fs/promises"
import path from "path"

export namespace OolongOverlay {
  export interface GenerateInput {
    claudePath: string
    voltPath: string
    doltPath: string
    outputPath?: string
    tablePath?: string
  }

  export interface Row {
    system: "Claude Code" | "Volt" | "Dolt"
    sourcePath: string
    format: "benchmark-result" | "summary-result"
    score: number
    passRate: number | null
    passedTasks: number | null
    totalTasks: number | null
    totalDurationMs: number | null
    model: string | null
    startedAt: string | null
    completedAt: string | null
  }

  export interface Report {
    generatedAt: string
    rows: Row[]
    markdownTable: string
  }

  interface BenchmarkLikeResult {
    averageScore?: unknown
    passRate?: unknown
    passedTasks?: unknown
    totalTasks?: unknown
    totalDuration?: unknown
    model?: unknown
    startedAt?: unknown
    completedAt?: unknown
    score?: unknown
  }

  interface ParsedCliArgs {
    claudePath: string
    voltPath: string
    doltPath: string
    outputPath?: string
    tablePath?: string
  }

  export async function generate(input: GenerateInput): Promise<Report> {
    const rows: Row[] = [
      await loadRow("Claude Code", input.claudePath),
      await loadRow("Volt", input.voltPath),
      await loadRow("Dolt", input.doltPath),
    ]

    const markdownTable = renderMarkdownTable(rows)
    const report: Report = {
      generatedAt: new Date().toISOString(),
      rows,
      markdownTable,
    }

    if (input.outputPath) {
      await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
      await fs.writeFile(input.outputPath, JSON.stringify(report, null, 2))
    }

    if (input.tablePath) {
      await fs.mkdir(path.dirname(input.tablePath), { recursive: true })
      await fs.writeFile(input.tablePath, markdownTable + "\n")
    }

    return report
  }

  export function parseCliArgs(args: string[]): ParsedCliArgs {
    const parsed: Partial<ParsedCliArgs> = {}
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]
      const value = args[index + 1]
      switch (arg) {
        case "--cc":
          parsed.claudePath = mustValue("--cc", value)
          index++
          break
        case "--volt":
          parsed.voltPath = mustValue("--volt", value)
          index++
          break
        case "--dolt":
          parsed.doltPath = mustValue("--dolt", value)
          index++
          break
        case "--output":
          parsed.outputPath = mustValue("--output", value)
          index++
          break
        case "--table":
          parsed.tablePath = mustValue("--table", value)
          index++
          break
      }
    }

    if (!parsed.claudePath || !parsed.voltPath || !parsed.doltPath) {
      throw new Error(
        "oolong-overlay requires --cc <path> --volt <path> --dolt <path> (file or directory for each run)",
      )
    }

    return {
      claudePath: parsed.claudePath,
      voltPath: parsed.voltPath,
      doltPath: parsed.doltPath,
      outputPath: parsed.outputPath,
      tablePath: parsed.tablePath,
    }
  }

  function mustValue(flag: string, value: string | undefined): string {
    if (!value) throw new Error(`${flag} requires a value`)
    return value
  }

  async function loadRow(system: Row["system"], inputPath: string): Promise<Row> {
    const resolvedPath = await resolveResultPath(inputPath)
    const raw = JSON.parse(await fs.readFile(resolvedPath, "utf8")) as BenchmarkLikeResult
    const parsed = parseResult(raw)

    return {
      system,
      sourcePath: resolvedPath,
      ...parsed,
    }
  }

  async function resolveResultPath(inputPath: string): Promise<string> {
    const stats = await fs.stat(inputPath)
    if (stats.isFile()) return inputPath
    if (!stats.isDirectory()) {
      throw new Error(`Expected a file or directory path, received: ${inputPath}`)
    }

    const resultJsonPath = path.join(inputPath, "result.json")
    const entries = await fs.readdir(inputPath, { withFileTypes: true })
    const benchmarkFiles = entries
      .filter(
        (entry) => entry.isFile() && /^oolong(?:-(?:bare|claude-code))?-\d{4}-\d{2}-\d{2}T.*\.json$/.test(entry.name),
      )
      .map((entry) => path.join(inputPath, entry.name))

    if (benchmarkFiles.length > 0) {
      const withStats = await Promise.all(
        benchmarkFiles.map(async (filePath) => ({
          filePath,
          mtimeMs: (await fs.stat(filePath)).mtimeMs,
        })),
      )
      withStats.sort((left, right) => right.mtimeMs - left.mtimeMs)
      return withStats[0]!.filePath
    }

    await fs.access(resultJsonPath)
    return resultJsonPath
  }

  function parseResult(raw: BenchmarkLikeResult): Omit<Row, "system" | "sourcePath"> {
    if (typeof raw.averageScore === "number") {
      return {
        format: "benchmark-result",
        score: raw.averageScore,
        passRate: typeof raw.passRate === "number" ? raw.passRate : null,
        passedTasks: typeof raw.passedTasks === "number" ? raw.passedTasks : null,
        totalTasks: typeof raw.totalTasks === "number" ? raw.totalTasks : null,
        totalDurationMs: typeof raw.totalDuration === "number" ? raw.totalDuration : null,
        model: typeof raw.model === "string" ? raw.model : null,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
        completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
      }
    }

    if (typeof raw.score === "number") {
      return {
        format: "summary-result",
        score: raw.score,
        passRate: null,
        passedTasks: null,
        totalTasks: null,
        totalDurationMs: null,
        model: null,
        startedAt: null,
        completedAt: null,
      }
    }

    throw new Error("Unsupported OOLONG artifact format: expected averageScore or score")
  }

  function renderMarkdownTable(rows: Row[]): string {
    const header = [
      "| System | Score % | Pass Rate % | Tasks (pass/total) | Duration (s) | Model | Artifact |",
      "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    ]

    const lines = rows.map((row) => {
      const scorePct = (row.score * 100).toFixed(2)
      const passRatePct = row.passRate == null ? "-" : (row.passRate * 100).toFixed(2)
      const tasks =
        row.passedTasks == null || row.totalTasks == null ? "-" : `${String(row.passedTasks)}/${String(row.totalTasks)}`
      const duration = row.totalDurationMs == null ? "-" : (row.totalDurationMs / 1000).toFixed(1)
      const model = row.model ?? "-"
      return `| ${row.system} | ${scorePct} | ${passRatePct} | ${tasks} | ${duration} | ${model} | ${row.sourcePath} |`
    })

    return [...header, ...lines].join("\n")
  }

  export function printHelp(): void {
    console.log(`
OOLONG overlay generator

USAGE:
  bun evals/cli.ts oolong-overlay --cc <path> --volt <path> --dolt <path> [--output <json>] [--table <md>]

INPUTS:
  Each path may be either:
  - A result file (full benchmark JSON or summary result.json), or
  - A run directory containing result artifacts.

OUTPUTS:
  --output  Write overlay report JSON (rows + markdownTable)
  --table   Write markdown comparison table
`)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    OolongOverlay.printHelp()
    process.exit(0)
  }
  const parsed = OolongOverlay.parseCliArgs(args)
  const report = await OolongOverlay.generate(parsed)
  console.log(report.markdownTable)
}
