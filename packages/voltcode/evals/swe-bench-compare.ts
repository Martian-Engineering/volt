#!/usr/bin/env bun
/**
 * SWE-bench Comparison Script
 *
 * Runs SWE-bench tests for both VoltCode and ClaudeCode with Opus 4.5
 * powered by the Anthropic API key.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   bun run evals/swe-bench-compare.ts --limit 10
 */

import { EvalRunner } from "./runner"
import { EvalTypes } from "./types"
import path from "path"
import fs from "fs/promises"

async function main() {
  const args = process.argv.slice(2)

  // Parse options
  let limit: number | undefined
  let outputDir = path.join(process.cwd(), "eval-results")
  let concurrency = 1

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = args[i + 1]
    switch (arg) {
      case "--limit":
        limit = parseInt(value, 10)
        i++
        break
      case "--output":
        outputDir = value
        i++
        break
      case "--concurrency":
        concurrency = parseInt(value, 10)
        i++
        break
      case "--help":
        printHelp()
        process.exit(0)
    }
  }

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY environment variable is required")
    console.error("Set it with: export ANTHROPIC_API_KEY=sk-ant-...")
    process.exit(1)
  }

  // Check for claude CLI
  try {
    await Bun.spawn(["which", "claude"]).exited
  } catch {
    console.error("❌ Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code")
    process.exit(1)
  }

  console.log("=".repeat(70))
  console.log("SWE-bench Comparison: VoltCode vs ClaudeCode (Opus 4.5)")
  console.log("=".repeat(70))
  console.log(`Limit: ${limit ?? "all tasks"}`)
  console.log(`Concurrency: ${concurrency}`)
  console.log(`Output: ${outputDir}`)
  console.log("")

  const baseConfig: EvalTypes.RunConfig = {
    timeout: 600_000,
    concurrency,
    limit,
    model: "opus", // Claude's Opus 4.5 model alias
    agent: "voltcode",
    binary: false,
  }

  const results: Record<string, EvalTypes.BenchmarkResult> = {}

  // Run 1: VoltCode with Opus 4.5
  console.log("\n" + "─".repeat(70))
  console.log("🏃 RUN 1/2: VoltCode + Opus 4.5")
  console.log("─".repeat(70))
  const voltConfig = { ...baseConfig, agent: "voltcode" as const }
  results["swe-bench-voltcode"] = await EvalRunner.run("swe-bench", voltConfig)

  // Run 2: ClaudeCode with Opus 4.5
  console.log("\n" + "─".repeat(70))
  console.log("🏃 RUN 2/2: ClaudeCode + Opus 4.5")
  console.log("─".repeat(70))
  const claudeConfig = { ...baseConfig, agent: "claude-code" as const }
  results["swe-bench-claude-code"] = await EvalRunner.run("swe-bench", claudeConfig)

  // Save results
  await fs.mkdir(outputDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filepath = path.join(outputDir, `swe-bench-comparison-${timestamp}.json`)
  await fs.writeFile(filepath, JSON.stringify(results, null, 2))

  // Print comparison
  printComparison(results, filepath)
}

function printComparison(results: Record<string, EvalTypes.BenchmarkResult>, filepath: string) {
  const volt = results["swe-bench-voltcode"]
  const claude = results["swe-bench-claude-code"]

  console.log("\n" + "=".repeat(70))
  console.log("📊 COMPARISON RESULTS")
  console.log("=".repeat(70))

  console.log("\n┌─────────────────────┬──────────────────┬──────────────────┐")
  console.log("│ Metric              │ VoltCode + Opus  │ ClaudeCode+Opus  │")
  console.log("├─────────────────────┼──────────────────┼──────────────────┤")
  console.log(
    `│ Tasks Passed        │ ${volt.passedTasks.toString().padStart(2)}/${volt.totalTasks.toString().padEnd(12)} │ ${claude.passedTasks.toString().padStart(2)}/${claude.totalTasks.toString().padEnd(12)} │`,
  )
  console.log(
    `│ Pass Rate           │ ${(volt.passRate * 100).toFixed(1).padStart(6)}%${" ".repeat(9)} │ ${(claude.passRate * 100).toFixed(1).padStart(6)}%${" ".repeat(9)} │`,
  )
  console.log(
    `│ Avg Score           │ ${(volt.averageScore * 100).toFixed(1).padStart(6)}%${" ".repeat(9)} │ ${(claude.averageScore * 100).toFixed(1).padStart(6)}%${" ".repeat(9)} │`,
  )
  console.log(
    `│ Total Duration      │ ${(volt.totalDuration / 1000).toFixed(1).padStart(7)}s${" ".repeat(7)} │ ${(claude.totalDuration / 1000).toFixed(1).padStart(7)}s${" ".repeat(7)} │`,
  )
  console.log("└─────────────────────┴──────────────────┴──────────────────┘")

  const winner = volt.passRate > claude.passRate ? "VoltCode" : volt.passRate < claude.passRate ? "ClaudeCode" : "Tie"
  console.log(`\n🏆 Winner: ${winner}`)

  const diff = Math.abs(volt.passRate - claude.passRate) * 100
  if (diff > 0) {
    const leader = volt.passRate > claude.passRate ? "VoltCode" : "ClaudeCode"
    console.log(`   ${leader} leads by ${diff.toFixed(1)} percentage points`)
  }

  console.log(`\n💾 Results saved to: ${filepath}`)
  console.log("=".repeat(70))
}

function printHelp() {
  console.log(`
SWE-bench Comparison Script

Runs SWE-bench tests comparing VoltCode and ClaudeCode, both powered by Opus 4.5
using your Anthropic API key.

USAGE:
  export ANTHROPIC_API_KEY=sk-ant-...
  bun run evals/swe-bench-compare.ts [options]

OPTIONS:
  --limit <n>        Maximum number of tasks to run (default: all)
  --concurrency <n>  Number of parallel tasks (default: 1)
  --output <dir>     Output directory for results (default: ./eval-results)
  --help             Show this help message

EXAMPLES:
  # Run comparison on 10 tasks
  bun run evals/swe-bench-compare.ts --limit 10

  # Run with higher concurrency
  bun run evals/swe-bench-compare.ts --limit 20 --concurrency 4

  # Save results to custom directory
  bun run evals/swe-bench-compare.ts --limit 10 --output ./my-results
`)
}

main().catch((error) => {
  console.error("Error:", error)
  process.exit(1)
})
