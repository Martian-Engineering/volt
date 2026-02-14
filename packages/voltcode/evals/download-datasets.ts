#!/usr/bin/env bun
/**
 * Download datasets for VoltCode Evaluation Suite
 *
 * Usage: bun packages/voltcode/evals/download-datasets.ts [benchmark]
 *
 * Available benchmarks:
 *   - aider-polyglot (public, no auth required)
 *   - terminal-bench (public, no auth required)
 *   - context-bench (built-in tasks, no download needed)
 *   - swe-bench (requires Python datasets library)
 *   - locobench-agent (requires HuggingFace auth)
 *   - mcp-atlas (may require HuggingFace auth)
 */

import path from "path"
import fs from "fs/promises"
import { exec, execShell } from "./util"

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache"), "voltcode", "evals")

async function downloadAiderPolyglot(): Promise<boolean> {
  const dir = path.join(CACHE_DIR, "aider-polyglot", "polyglot-benchmark")
  const exists = await fs.access(dir).then(
    () => true,
    () => false,
  )

  if (exists) {
    console.log("✓ Aider Polyglot benchmark already downloaded")
    return true
  }

  console.log("Downloading Aider Polyglot benchmark...")
  await fs.mkdir(path.dirname(dir), { recursive: true })

  try {
    await exec(["git", "clone", "--depth", "1", "https://github.com/Aider-AI/polyglot-benchmark.git", dir])
    console.log("✓ Aider Polyglot benchmark downloaded successfully")
    return true
  } catch (error) {
    console.error("✗ Failed to download Aider Polyglot benchmark:", error)
    return false
  }
}

async function downloadTerminalBench(): Promise<boolean> {
  const dir = path.join(CACHE_DIR, "terminal-bench", "terminal-bench")
  const exists = await fs.access(dir).then(
    () => true,
    () => false,
  )

  if (exists) {
    console.log("✓ Terminal-Bench already downloaded")
    return true
  }

  console.log("Downloading Terminal-Bench...")
  await fs.mkdir(path.dirname(dir), { recursive: true })

  try {
    await exec(["git", "clone", "--depth", "1", "https://github.com/laude-institute/terminal-bench.git", dir])
    console.log("✓ Terminal-Bench downloaded successfully")
    return true
  } catch (error) {
    console.error("✗ Failed to download Terminal-Bench:", error)
    return false
  }
}

async function downloadSWEBench(): Promise<boolean> {
  const datasetFile = path.join(CACHE_DIR, "swe-bench", "swe-bench-verified.json")
  const exists = await fs.access(datasetFile).then(
    () => true,
    () => false,
  )

  if (exists) {
    console.log("✓ SWE-bench Verified dataset already downloaded")
    return true
  }

  console.log("Downloading SWE-bench Verified dataset (requires Python)...")
  await fs.mkdir(path.dirname(datasetFile), { recursive: true })

  const pythonScript = `
import json
from datasets import load_dataset
print("Loading SWE-bench Verified dataset from HuggingFace...")
ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
print(f"Loaded {len(ds)} tasks")
with open("${datasetFile}", "w") as f:
    json.dump([dict(row) for row in ds], f, indent=2)
print("Dataset saved successfully")
`
  const scriptFile = path.join(CACHE_DIR, "swe-bench", "download.py")
  await fs.writeFile(scriptFile, pythonScript)

  // Use a virtual environment to avoid system Python issues
  const venvDir = path.join(CACHE_DIR, "venv")

  try {
    // Create venv if it doesn't exist
    const venvExists = await fs.access(venvDir).then(
      () => true,
      () => false,
    )
    if (!venvExists) {
      console.log("  Creating Python virtual environment...")
      await execShell(`python3 -m venv ${venvDir}`, { timeout: 60_000 })
    }

    // Install datasets and run script
    await execShell(`source ${venvDir}/bin/activate && pip install datasets -q && python ${scriptFile}`, {
      timeout: 300_000,
    })

    // Verify file was created
    const created = await fs.access(datasetFile).then(
      () => true,
      () => false,
    )
    if (!created) {
      throw new Error("Dataset file not created")
    }

    console.log("✓ SWE-bench Verified dataset downloaded successfully")
    return true
  } catch (error) {
    console.error("✗ Failed to download SWE-bench dataset")
    console.error("  Ensure Python 3 is available")
    console.error("  Error:", error instanceof Error ? error.message : String(error))
    return false
  }
}

async function downloadLoCoBench(): Promise<boolean> {
  const datasetFile = path.join(CACHE_DIR, "locobench-agent", "locobench-tasks.json")
  const exists = await fs.access(datasetFile).then(
    () => true,
    () => false,
  )

  if (exists) {
    console.log("✓ LoCoBench-Agent dataset already downloaded")
    return true
  }

  console.log("Downloading LoCoBench-Agent dataset (requires HuggingFace auth)...")
  await fs.mkdir(path.dirname(datasetFile), { recursive: true })

  const pythonScript = `
import json
from datasets import load_dataset
print("Loading LoCoBench-Agent dataset from HuggingFace...")
ds = load_dataset("SalesforceAIResearch/LoCoBench-Agent", split="test")
print(f"Loaded {len(ds)} tasks")
with open("${datasetFile}", "w") as f:
    json.dump([dict(row) for row in ds], f, indent=2)
print("Dataset saved successfully")
`
  const scriptFile = path.join(CACHE_DIR, "locobench-agent", "download.py")
  await fs.writeFile(scriptFile, pythonScript)

  // Use shared virtual environment
  const venvDir = path.join(CACHE_DIR, "venv")

  try {
    // Ensure venv exists
    const venvExists = await fs.access(venvDir).then(
      () => true,
      () => false,
    )
    if (!venvExists) {
      console.log("  Creating Python virtual environment...")
      await execShell(`python3 -m venv ${venvDir}`, { timeout: 60_000 })
    }

    await execShell(`source ${venvDir}/bin/activate && pip install datasets -q && python ${scriptFile}`, {
      timeout: 300_000,
    })

    const created = await fs.access(datasetFile).then(
      () => true,
      () => false,
    )
    if (!created) {
      throw new Error("Dataset file not created")
    }

    console.log("✓ LoCoBench-Agent dataset downloaded successfully")
    return true
  } catch (error) {
    console.error("✗ Failed to download LoCoBench-Agent dataset")
    console.error("  This dataset requires HuggingFace authentication")
    console.error("  Run: huggingface-cli login")
    return false
  }
}

async function downloadMCPAtlas(): Promise<boolean> {
  const datasetFile = path.join(CACHE_DIR, "mcp-atlas", "mcp-atlas-tasks.json")
  const exists = await fs.access(datasetFile).then(
    () => true,
    () => false,
  )

  if (exists) {
    console.log("✓ MCP Atlas dataset already downloaded")
    return true
  }

  console.log("Downloading MCP Atlas dataset...")
  await fs.mkdir(path.dirname(datasetFile), { recursive: true })

  // Try GitHub repo first
  const repoDir = path.join(CACHE_DIR, "mcp-atlas", "mcp-atlas")
  try {
    await exec(["git", "clone", "--depth", "1", "https://github.com/scaleapi/mcp-atlas.git", repoDir])

    // Check if dataset exists in repo
    const localDataset = path.join(repoDir, "data", "tasks.json")
    if (
      await fs.access(localDataset).then(
        () => true,
        () => false,
      )
    ) {
      await fs.copyFile(localDataset, datasetFile)
      console.log("✓ MCP Atlas dataset downloaded from GitHub")
      return true
    }
  } catch {
    // GitHub repo may not have the dataset
  }

  // Try HuggingFace
  const pythonScript = `
import json
from datasets import load_dataset
print("Loading MCP Atlas dataset from HuggingFace...")
ds = load_dataset("ScaleAI/MCP-Atlas", split="test")
print(f"Loaded {len(ds)} tasks")
with open("${datasetFile}", "w") as f:
    json.dump([dict(row) for row in ds], f, indent=2)
print("Dataset saved successfully")
`
  const scriptFile = path.join(CACHE_DIR, "mcp-atlas", "download.py")
  await fs.writeFile(scriptFile, pythonScript)

  // Use shared virtual environment
  const venvDir = path.join(CACHE_DIR, "venv")

  try {
    const venvExists = await fs.access(venvDir).then(
      () => true,
      () => false,
    )
    if (!venvExists) {
      console.log("  Creating Python virtual environment...")
      await execShell(`python3 -m venv ${venvDir}`, { timeout: 60_000 })
    }

    await execShell(`source ${venvDir}/bin/activate && pip install datasets -q && python ${scriptFile}`, {
      timeout: 300_000,
    })

    const created = await fs.access(datasetFile).then(
      () => true,
      () => false,
    )
    if (!created) {
      throw new Error("Dataset file not created")
    }

    console.log("✓ MCP Atlas dataset downloaded successfully")
    return true
  } catch (error) {
    console.error("✗ Failed to download MCP Atlas dataset")
    console.error("  Dataset may not be publicly available yet")
    return false
  }
}

async function main() {
  const args = process.argv.slice(2)
  const benchmark = args[0]

  console.log("VoltCode Evaluation Suite - Dataset Downloader\n")
  console.log(`Cache directory: ${CACHE_DIR}\n`)

  const results: Record<string, boolean> = {}

  if (!benchmark || benchmark === "all") {
    // Download all benchmarks
    results["aider-polyglot"] = await downloadAiderPolyglot()
    results["terminal-bench"] = await downloadTerminalBench()
    results["swe-bench"] = await downloadSWEBench()
    results["locobench-agent"] = await downloadLoCoBench()
    results["mcp-atlas"] = await downloadMCPAtlas()
    results["context-bench"] = true // Built-in tasks

    console.log("\n=== Summary ===")
    for (const [name, success] of Object.entries(results)) {
      console.log(`${success ? "✓" : "✗"} ${name}`)
    }

    const successful = Object.values(results).filter((v) => v).length
    console.log(`\n${successful}/${Object.keys(results).length} benchmarks ready`)
  } else {
    // Download specific benchmark
    switch (benchmark) {
      case "aider-polyglot":
        await downloadAiderPolyglot()
        break
      case "terminal-bench":
        await downloadTerminalBench()
        break
      case "swe-bench":
        await downloadSWEBench()
        break
      case "locobench-agent":
        await downloadLoCoBench()
        break
      case "mcp-atlas":
        await downloadMCPAtlas()
        break
      case "context-bench":
        console.log("Context-Bench uses built-in tasks, no download needed")
        break
      default:
        console.error(`Unknown benchmark: ${benchmark}`)
        console.error("Available: aider-polyglot, terminal-bench, swe-bench, locobench-agent, mcp-atlas, context-bench")
        process.exit(1)
    }
  }
}

main().catch(console.error)
