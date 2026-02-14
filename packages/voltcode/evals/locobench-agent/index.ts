import { EvalTypes } from "../types"
import { exec, execShell } from "../util"
import path from "path"
import fs from "fs/promises"

/**
 * LoCoBench-Agent Benchmark Runner
 *
 * LoCoBench-Agent evaluates LLM agents on long-context software engineering tasks.
 * It extends LoCoBench's 8,000 scenarios into interactive agent environments, testing
 * multi-turn conversations, tool usage efficiency, error recovery, and architectural
 * consistency across extended development sessions.
 *
 * Features:
 * - 8,000 scenarios across 10 programming languages and 36 domain categories
 * - Context lengths ranging from 10K to 1M tokens
 * - 8 specialized tools (file operations, search, code analysis)
 * - 9 evaluation metrics (5 comprehension + 4 efficiency)
 *
 * @see https://arxiv.org/abs/2511.13998
 * @see https://github.com/SalesforceAIResearch/LoCoBench-Agent
 */
export namespace LoCoBenchAgent {
  export const NAME = "locobench-agent"
  export const VERSION = "1.0.0"
  export const DESCRIPTION = "Long-context software engineering benchmark with 8000 scenarios across 10 languages"

  /** LoCoBench-Agent task */
  export interface Task {
    id: string
    language: string
    domain: string
    contextLength: number // in tokens
    scenario: {
      description: string
      files: { path: string; content: string }[]
      question: string
      groundTruth: string
    }
    metrics: {
      comprehension: string[]
      efficiency: string[]
    }
  }

  /** Agent interaction record */
  export interface Interaction {
    turn: number
    type: "query" | "tool_call" | "response"
    content: string
    timestamp: number
  }

  export class Runner implements EvalTypes.BenchmarkRunner {
    name = NAME
    version = VERSION
    description = DESCRIPTION

    private tasks: Task[] = []
    private workDir = ""

    async setup(): Promise<void> {
      this.workDir = path.join(
        process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache"),
        "voltcode",
        "evals",
        "locobench-agent",
      )
      await fs.mkdir(this.workDir, { recursive: true })

      // Clone LoCoBench-Agent repository
      const repoDir = path.join(this.workDir, "LoCoBench-Agent")
      const exists = await fs.access(repoDir).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Cloning LoCoBench-Agent repository...")
        await exec(["git", "clone", "https://github.com/SalesforceAIResearch/LoCoBench-Agent.git", repoDir], {
          quiet: true,
        })
      }

      // Install dependencies
      console.log("Setting up LoCoBench-Agent environment...")
      await execShell(`cd ${repoDir} && pip install -e . 2>/dev/null || true`, { quiet: true })

      // Load dataset
      await this.loadDataset(repoDir)
    }

    private async loadDataset(repoDir: string): Promise<void> {
      const datasetFile = path.join(this.workDir, "locobench-tasks.json")
      const exists = await fs.access(datasetFile).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Loading LoCoBench-Agent dataset...")

        // Try to load via Python datasets library (handles authentication)
        try {
          const pythonScript = `
import json
from datasets import load_dataset
ds = load_dataset("SalesforceAIResearch/LoCoBench-Agent", split="test")
with open("${datasetFile}", "w") as f:
    json.dump([dict(row) for row in ds], f, indent=2)
`
          const scriptFile = path.join(this.workDir, "download_locobench.py")
          await fs.writeFile(scriptFile, pythonScript)
          await execShell(`pip install datasets -q && python ${scriptFile}`, { timeout: 300_000 })
        } catch {
          // Try local repo
          const localPath = path.join(repoDir, "data", "test.json")
          if (
            await fs.access(localPath).then(
              () => true,
              () => false,
            )
          ) {
            await fs.copyFile(localPath, datasetFile)
          } else {
            console.warn("Could not load LoCoBench-Agent dataset")
            console.warn("LoCoBench-Agent requires HuggingFace authentication.")
            console.warn("To authenticate: huggingface-cli login")
            this.tasks = []
            return
          }
        }
      }

      try {
        const content = await fs.readFile(datasetFile, "utf-8")
        this.tasks = JSON.parse(content)
        console.log(`Loaded ${this.tasks.length} LoCoBench-Agent tasks`)
      } catch {
        console.error("Failed to parse LoCoBench-Agent dataset")
        this.tasks = []
      }
    }

    async listTasks(): Promise<string[]> {
      return this.tasks.map((t) => t.id)
    }

    async runTask(taskId: string, config: EvalTypes.RunConfig): Promise<EvalTypes.TaskResult> {
      const startTime = Date.now()
      const task = this.tasks.find((t) => t.id === taskId)

      if (!task) {
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: `Task not found: ${taskId}`,
        }
      }

      try {
        // Setup task workspace with files
        const taskDir = path.join(this.workDir, "runs", taskId)
        await fs.mkdir(taskDir, { recursive: true })

        // Write scenario files
        for (const file of task.scenario.files) {
          const filePath = path.join(taskDir, file.path)
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, file.content)
        }

        // Run agent in interactive mode
        const interactions: Interaction[] = []
        const result = await this.runInteractiveAgent(task, taskDir, interactions, config)

        // Evaluate comprehension and efficiency
        const evalResult = await this.evaluateTask(task, result, interactions)

        return {
          taskId,
          passed: evalResult.passed,
          score: evalResult.score,
          duration: Date.now() - startTime,
          metadata: {
            comprehensionScores: evalResult.comprehension,
            efficiencyScores: evalResult.efficiency,
            interactions: interactions.length,
            contextLength: task.contextLength,
          },
        }
      } catch (error) {
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    private async runInteractiveAgent(
      task: Task,
      taskDir: string,
      interactions: Interaction[],
      config: EvalTypes.RunConfig,
    ): Promise<string> {
      // Build the initial prompt with scenario context
      const prompt = `You are working on a software engineering task in a codebase.

## Task Description
${task.scenario.description}

## Question
${task.scenario.question}

The codebase files have been loaded in your working directory: ${taskDir}

Use the available tools (file read, search, code analysis) to explore the codebase and answer the question thoroughly.`

      const modelArgs = config.model ? ["--model", config.model] : []

      try {
        // Record start interaction
        interactions.push({
          turn: 1,
          type: "query",
          content: prompt,
          timestamp: Date.now(),
        })

        const result = await exec(["volt", "run", ...modelArgs, "--cwd", taskDir, "--headless", prompt], {
          timeout: config.timeout,
        })

        const output = result.stdout

        // Record response
        interactions.push({
          turn: interactions.length + 1,
          type: "response",
          content: output,
          timestamp: Date.now(),
        })

        return output
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    private async evaluateTask(
      task: Task,
      response: string,
      interactions: Interaction[],
    ): Promise<{
      passed: boolean
      score: number
      comprehension: Record<string, number>
      efficiency: Record<string, number>
    }> {
      // Evaluate comprehension metrics
      const comprehension: Record<string, number> = {}

      // Simple evaluation: check if key parts of ground truth appear in response
      const groundTruthTerms = task.scenario.groundTruth.toLowerCase().split(/\s+/)
      const responseTerms = response.toLowerCase()

      const matchRate =
        groundTruthTerms.filter((t) => t.length > 3 && responseTerms.includes(t)).length /
        groundTruthTerms.filter((t) => t.length > 3).length

      comprehension["semantic_match"] = matchRate
      comprehension["coverage"] = matchRate > 0.5 ? 1 : matchRate * 2

      // Evaluate efficiency metrics
      const efficiency: Record<string, number> = {}

      // Conversation efficiency: fewer turns is better (normalize to 1-10 turns)
      const turnCount = interactions.filter((i) => i.type === "tool_call").length
      efficiency["turn_efficiency"] = Math.max(0, 1 - turnCount / 10)

      // Response time efficiency
      const totalTime =
        interactions.length > 1 ? interactions[interactions.length - 1].timestamp - interactions[0].timestamp : 0
      efficiency["time_efficiency"] = Math.max(0, 1 - totalTime / 300000) // 5 min max

      // Calculate overall scores
      const comprehensionScore =
        Object.values(comprehension).reduce((a, b) => a + b, 0) / Object.values(comprehension).length
      const efficiencyScore = Object.values(efficiency).reduce((a, b) => a + b, 0) / Object.values(efficiency).length

      // Combined score (comprehension weighted higher)
      const score = comprehensionScore * 0.7 + efficiencyScore * 0.3
      const passed = comprehensionScore >= 0.6

      return { passed, score, comprehension, efficiency }
    }

    async run(config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
      const startedAt = new Date().toISOString()
      let taskIds = config.taskIds ?? (await this.listTasks())

      if (config.limit) {
        taskIds = taskIds.slice(0, config.limit)
      }

      const results: EvalTypes.TaskResult[] = []

      for (const taskId of taskIds) {
        const result = await this.runTask(taskId, config)
        results.push(result)

        const task = this.tasks.find((t) => t.id === taskId)
        console.log(
          `[${results.length}/${taskIds.length}] ${taskId} (${task?.language}/${task?.domain}): ${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)})`,
        )
      }

      const completedAt = new Date().toISOString()
      const passedTasks = results.filter((r) => r.passed).length

      return {
        benchmark: this.name,
        version: this.version,
        model: config.model ?? "default",
        startedAt,
        completedAt,
        totalTasks: results.length,
        passedTasks,
        passRate: passedTasks / results.length,
        averageScore: results.reduce((sum, r) => sum + r.score, 0) / results.length,
        totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
        tasks: results,
      }
    }

    async cleanup(): Promise<void> {
      // Optional: clean up task directories
    }
  }
}
