#!/usr/bin/env bun
/**
 * VoltCode Evaluation CLI
 *
 * Usage:
 *   bun evals/cli.ts <benchmark> [options]
 *   bun evals/cli.ts list
 *   bun evals/cli.ts swe-bench --limit 10 --model anthropic/claude-sonnet-4
 *   bun evals/cli.ts all --limit 5
 *
 * Options:
 *   --limit <n>        Maximum tasks to run
 *   --model <model>    Model to use (provider/model format)
 *   --timeout <ms>     Timeout per task in milliseconds
 *   --concurrency <n>  Number of parallel tasks
 *   --output <dir>     Output directory for result.json and trace.jsonl
 *   --tasks <ids>      Comma-separated list of specific task IDs
 *   --agent <agent>    Agent to use: voltcode (default) or claude-code
 *   --runId <id>       Unique identifier for this evaluation run
 *   --backend <name>   Backend identifier (e.g., 'anthropic:claude-opus-4.5')
 *   --variant <name>   Variant for model options (e.g., 'xhigh' for reasoning_effort)
 *   --log-level <lvl>  Eval log level: TRACE|DEBUG|INFO|WARN|ERROR
 */

import { EvalRunner } from "./runner"
import { EvalTypes } from "./types"
import { Oolong } from "./oolong/index"
import { OolongOverlay } from "./oolong/overlay"
import { EvalLog } from "./log"
import path from "path"
import fs from "fs/promises"

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp()
    process.exit(0)
  }

  const command = args[0]

  // Build OOLONG comparison overlays from existing run artifacts.
  if (command === "oolong-overlay") {
    const overlayArgs = OolongOverlay.parseCliArgs(args.slice(1))
    const report = await OolongOverlay.generate({
      claudePath: overlayArgs.claudePath,
      voltPath: overlayArgs.voltPath,
      doltPath: overlayArgs.doltPath,
      outputPath: overlayArgs.outputPath,
      tablePath: overlayArgs.tablePath,
    })
    console.log(report.markdownTable)
    if (overlayArgs.outputPath) {
      console.log(`Overlay JSON written to: ${overlayArgs.outputPath}`)
    }
    if (overlayArgs.tablePath) {
      console.log(`Overlay table written to: ${overlayArgs.tablePath}`)
    }
    process.exit(0)
  }

  // List available benchmarks
  if (command === "list") {
    console.log("Available benchmarks:")
    for (const name of EvalRunner.list()) {
      const runner = EvalRunner.get(name)!
      console.log(`  ${name.padEnd(20)} - ${runner.description}`)
    }
    process.exit(0)
  }

  // Parse options
  const config = parseConfig(args.slice(1))

  // Handle --bare and --claude-code modes for OOLONG
  const isBare = args.slice(1).includes("--bare")
  const isClaudeCode = args.slice(1).includes("--claude-code")

  let finalResult: EvalTypes.BenchmarkResult | null = null
  let benchmarkName = command ?? "unknown"

  // Run specific benchmark or all
  if (command === "all") {
    console.log("Running all benchmarks...")
    const results = await EvalRunner.runAll(config)
    await saveResults(results, config.outputDir)
    printSummary(results)
    // For "all", use the worst result to determine success
    const allResults = Object.values(results)
    if (allResults.length > 0) {
      finalResult = allResults.reduce((worst, r) => (r.averageScore < worst.averageScore ? r : worst), allResults[0]!)
    }
  } else if (command === "oolong" && isClaudeCode) {
    benchmarkName = "oolong-claude-code"
    const ctxLabel = config.contextLen ? `${(config.contextLen / 1024).toFixed(0)}K` : "128K"
    const cc = new Oolong.ClaudeCodeRunner(config.contextLen)
    console.log(`Running ${cc.name} (${cc.description})...`)
    console.log(`Model: ${config.model ?? "default"} (Claude Code agentic harness, ${ctxLabel} context)`)
    await cc.setup()
    finalResult = await cc.run(config)
    await cc.cleanup()
    await saveResults({ [benchmarkName]: finalResult }, config.outputDir)
    printSummary({ [benchmarkName]: finalResult })
  } else if (command === "oolong" && isBare) {
    benchmarkName = "oolong-bare"
    if (!config.model) {
      console.error("--bare requires --model provider/model (e.g., openai/gpt-4o, anthropic/claude-sonnet-4)")
      process.exit(1)
    }
    const ctxLabel = config.contextLen ? `${(config.contextLen / 1024).toFixed(0)}K` : "128K"
    const bare = new Oolong.BareRunner(config.contextLen)
    console.log(`Running ${bare.name} (${bare.description})...`)
    console.log(`Model: ${config.model} (bare API — no tools, no system prompt, ${ctxLabel} context)`)
    await bare.setup()
    finalResult = await bare.run(config)
    await bare.cleanup()
    await saveResults({ [benchmarkName]: finalResult }, config.outputDir)
    printSummary({ [benchmarkName]: finalResult })
  } else if (command === "oolong") {
    // VoltCode agentic mode — handle directly to support --context-len
    benchmarkName = "oolong"
    const ctxLabel = config.contextLen ? `${(config.contextLen / 1024).toFixed(0)}K` : "128K"
    const runner = new Oolong.Runner(config.contextLen)
    console.log(`Running ${runner.name} (${runner.description})...`)
    if (config.contextLen) console.log(`Context length: ${ctxLabel} (${config.contextLen} tokens)`)
    await runner.setup()
    finalResult = await runner.run(config)
    await runner.cleanup()
    await saveResults({ [benchmarkName]: finalResult }, config.outputDir)
    printSummary({ [benchmarkName]: finalResult })
  } else {
    benchmarkName = command!
    const runner = EvalRunner.get(command!)
    if (!runner) {
      console.error(`Unknown benchmark: ${command}`)
      console.error(`Available: ${EvalRunner.list().join(", ")}`)
      process.exit(1)
    }

    console.log(`Running ${runner.name} (${runner.description})...`)
    finalResult = await EvalRunner.run(command!, config)
    await saveResults({ [benchmarkName]: finalResult }, config.outputDir)
    printSummary({ [benchmarkName]: finalResult })
  }

  // Write result.json and trace.jsonl to outputDir if specified
  if (config.outputDir && finalResult) {
    await writeEvalOutput(config.outputDir, benchmarkName, finalResult)
  }

  // Exit with code 1 only if ALL tasks failed (score === 0).
  // Partial success (some tasks failed) is still a valid result.
  if (finalResult && finalResult.averageScore === 0) {
    process.exit(1)
  }
}

function parseConfig(args: string[]): EvalTypes.RunConfig {
  const config: EvalTypes.RunConfig = {
    agent: "voltcode",
    concurrency: 1,
    binary: false,
    timeout: 7_200_000,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = args[i + 1]

    switch (arg) {
      case "--limit":
        config.limit = parseInt(value, 10)
        i++
        break
      case "--model":
        config.model = value
        i++
        break
      case "--timeout":
        config.timeout = parseInt(value, 10)
        i++
        break
      case "--concurrency":
        config.concurrency = parseInt(value, 10)
        i++
        break
      case "--output":
        config.outputDir = value
        i++
        break
      case "--tasks":
        config.taskIds = value.split(",").map((s) => s.trim())
        i++
        break
      case "--context-len":
        config.contextLen = parseInt(value, 10)
        i++
        break
      case "--agent":
        config.agent = value as "voltcode" | "claude-code"
        i++
        break
      case "--binary":
        config.binary = true
        break
      case "--bare":
      case "--claude-code":
        // Handled separately in main(), just consume it here
        break
      case "--runId":
        config.runId = value
        i++
        break
      case "--backend":
        config.backend = value
        i++
        break
      case "--variant":
        config.variant = value
        i++
        break
      case "--log-level":
        process.env.VOLTCODE_EVAL_LOG_LEVEL = value?.toUpperCase()
        EvalLog.setLevel(value)
        i++
        break
    }
  }

  return config
}

async function saveResults(results: Record<string, EvalTypes.BenchmarkResult>, outputDir?: string): Promise<void> {
  const dir = outputDir || path.join(process.cwd(), "eval-results")
  await fs.mkdir(dir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

  for (const [name, result] of Object.entries(results)) {
    const filename = `${name}-${timestamp}.json`
    const filepath = path.join(dir, filename)
    await fs.writeFile(filepath, JSON.stringify(result, null, 2))
    console.log(`Results saved to: ${filepath}`)
  }
}

/**
 * Write standardized eval output files to the output directory.
 *
 * Creates:
 * - result.json: Summary with {success, score, error?}
 * - trace.jsonl: Per-task trace data (one JSON object per line)
 */
async function writeEvalOutput(
  outputDir: string,
  benchmarkName: string,
  result: EvalTypes.BenchmarkResult,
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true })

  // Determine success: all tasks passed and no errors
  const hasErrors = result.tasks.some((t) => t.error)
  const allPassed = result.passedTasks === result.totalTasks
  const success = allPassed && !hasErrors

  // Write result.json with the required structure
  const resultJson = {
    success,
    score: result.averageScore,
    ...(hasErrors && {
      error: result.tasks
        .filter((t) => t.error)
        .map((t) => `${t.taskId}: ${t.error}`)
        .join("; "),
    }),
  }
  const resultPath = path.join(outputDir, "result.json")
  await fs.writeFile(resultPath, JSON.stringify(resultJson, null, 2))
  console.log(`Result summary written to: ${resultPath}`)

  // Write trace.jsonl with per-task data
  const traceLines = result.tasks.map((task) =>
    JSON.stringify({
      benchmark: benchmarkName,
      taskId: task.taskId,
      passed: task.passed,
      score: task.score,
      duration: task.duration,
      error: task.error,
      metadata: task.metadata,
    }),
  )
  const tracePath = path.join(outputDir, "trace.jsonl")
  await fs.writeFile(tracePath, traceLines.join("\n") + "\n")
  console.log(`Trace written to: ${tracePath}`)
}

function printSummary(results: Record<string, EvalTypes.BenchmarkResult>): void {
  console.log("\n" + "=".repeat(60))
  console.log("EVALUATION SUMMARY")
  console.log("=".repeat(60))

  for (const [name, result] of Object.entries(results)) {
    console.log(`\n${name.toUpperCase()}`)
    console.log("-".repeat(40))
    console.log(`  Model:        ${result.model}`)
    console.log(`  Tasks:        ${result.passedTasks}/${result.totalTasks} passed`)
    console.log(`  Pass Rate:    ${(result.passRate * 100).toFixed(1)}%`)
    console.log(`  Avg Score:    ${(result.averageScore * 100).toFixed(1)}%`)
    console.log(`  Duration:     ${(result.totalDuration / 1000).toFixed(1)}s`)
  }

  console.log("\n" + "=".repeat(60))
}

function printHelp(): void {
  console.log(`
VoltCode Evaluation Suite

USAGE:
  bun evals/cli.ts <benchmark> [options]
  bun evals/cli.ts list
  bun evals/cli.ts all [options]

BENCHMARKS:
  oolong          OOLONG - Long-context classification and aggregation
  oolong-overlay  Build CC vs Volt vs Dolt overlay table from run artifacts
  swe-bench       SWE-bench Verified - Real GitHub issue resolution
  mcp-atlas       MCP Atlas - Multi-tool MCP server tasks
  locobench-agent LoCoBench-Agent - Long-context software engineering
  context-bench   Context-Bench - Context engineering proficiency
  terminal-bench  Terminal-Bench 2.0 - Terminal/CLI tasks
  aider-polyglot  Aider Polyglot - Multi-language coding problems

OPTIONS:
  --limit <n>        Maximum number of tasks to run (useful for testing)
  --model <model>    Model to use (e.g., anthropic/claude-sonnet-4)
  --timeout <ms>     Timeout per task in milliseconds (default: 7200000)
  --concurrency <n>  Number of parallel tasks (default: 1)
  --output <dir>     Output directory for result.json and trace.jsonl
  --tasks <ids>      Comma-separated list of specific task IDs
  --agent <agent>    Agent to use: voltcode (default) or claude-code
  --runId <id>       Unique identifier for this evaluation run
  --backend <name>   Backend identifier (e.g., 'anthropic:claude-opus-4.5')
  --variant <name>   Variant for model options (e.g., 'xhigh' for reasoning_effort)
  --log-level <lvl>  Eval log level: TRACE|DEBUG|INFO|WARN|ERROR

EXAMPLES:
  # List all benchmarks
  bun evals/cli.ts list

  # Run SWE-bench with 10 tasks using VoltCode
  bun evals/cli.ts swe-bench --limit 10 --agent voltcode

  # Run SWE-bench with 10 tasks using Claude Code
  bun evals/cli.ts swe-bench --limit 10 --agent claude-code

  # Run all benchmarks with specific model
  bun evals/cli.ts all --model anthropic/claude-sonnet-4 --limit 5

  # Run specific tasks from Aider Polyglot
  bun evals/cli.ts aider-polyglot --tasks python-hello-world,rust-hello-world

  # Build an overlay table from OOLONG run outputs
  bun evals/cli.ts oolong-overlay \
    --cc eval-results/oolong/cc-baseline \
    --volt eval-results/oolong/volt-baseline \
    --dolt eval-results/oolong/dolt-run \
    --output eval-results/oolong/overlay.json \
    --table eval-results/oolong/overlay.md

EXIT CODES:
  0  All tasks passed with no errors
  1  One or more tasks failed or had errors

OUTPUT FILES (when --output is specified):
  result.json   Summary: {success: bool, score: number, error?: string}
  trace.jsonl   Per-task trace data (one JSON object per line)
`)
}

main().catch(async (error) => {
  console.error("Error:", error)

  // Try to write a result.json for fatal errors if --output was provided
  const args = process.argv.slice(2)
  const outputIdx = args.indexOf("--output")
  if (outputIdx !== -1 && args[outputIdx + 1]) {
    const outputDir = args[outputIdx + 1]!
    try {
      await fs.mkdir(outputDir, { recursive: true })
      const resultJson = {
        success: false,
        score: 0,
        error: error instanceof Error ? error.message : String(error),
      }
      await fs.writeFile(path.join(outputDir, "result.json"), JSON.stringify(resultJson, null, 2))
      // Also write an empty trace.jsonl
      await fs.writeFile(path.join(outputDir, "trace.jsonl"), "")
    } catch {
      // Ignore errors writing failure result
    }
  }

  process.exit(1)
})
