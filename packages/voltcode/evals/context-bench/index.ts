import { EvalTypes } from "../types"
import { exec } from "../util"
import path from "path"
import fs from "fs/promises"

/**
 * Context-Bench Benchmark Runner
 *
 * Context-Bench evaluates how well language models can manage context in agentic
 * settings - how efficiently they manage memory, how often they revisit prior context,
 * and how much it costs to complete a task.
 *
 * Tests include:
 * - File operation chaining
 * - Entity relationship tracing
 * - Multi-step information retrieval in long-horizon tasks
 *
 * @see https://www.letta.com/blog/context-bench
 * @see https://github.com/letta-ai/letta-evals (Letta Evals framework)
 */
export namespace ContextBench {
  export const NAME = "context-bench"
  export const VERSION = "1.0.0"
  export const DESCRIPTION = "Context engineering benchmark measuring memory management and multi-step reasoning"

  /** Context-Bench task types */
  export type TaskType =
    | "file_chaining"
    | "entity_tracing"
    | "multi_step_retrieval"
    | "memory_management"
    | "context_switching"

  /** Context-Bench task */
  export interface Task {
    id: string
    type: TaskType
    description: string
    setup: {
      files?: { path: string; content: string }[]
      entities?: { name: string; relations: string[] }[]
      initialContext?: string
    }
    steps: {
      instruction: string
      expectedBehavior: string
      requiresContextRecall?: boolean
    }[]
    groundTruth: string
    metrics: {
      expectedContextAccesses: number
      expectedTokenCost: number
    }
  }

  /** Agent execution trace */
  export interface ExecutionTrace {
    step: number
    action: string
    contextAccessed: boolean
    tokenCount: number
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
        "context-bench",
      )
      await fs.mkdir(this.workDir, { recursive: true })

      // Try to get Letta Evals framework
      const lettaDir = path.join(this.workDir, "letta-evals")
      const exists = await fs.access(lettaDir).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Setting up Context-Bench environment...")
        try {
          await exec(["git", "clone", "https://github.com/letta-ai/letta-evals.git", lettaDir], { quiet: true })
        } catch {
          console.log("Letta Evals repo not available, using built-in tasks")
        }
      }

      // Load or generate tasks
      await this.loadDataset()
    }

    private async loadDataset(): Promise<void> {
      const datasetFile = path.join(this.workDir, "context-bench-tasks.json")
      const exists = await fs.access(datasetFile).then(
        () => true,
        () => false,
      )

      if (!exists) {
        // Generate built-in evaluation tasks
        console.log("Generating Context-Bench tasks...")
        this.tasks = this.generateBuiltinTasks()
        await fs.writeFile(datasetFile, JSON.stringify(this.tasks, null, 2))
      } else {
        const content = await fs.readFile(datasetFile, "utf-8")
        this.tasks = JSON.parse(content)
      }

      console.log(`Loaded ${this.tasks.length} Context-Bench tasks`)
    }

    private generateBuiltinTasks(): Task[] {
      return [
        // File chaining tasks
        {
          id: "file-chain-1",
          type: "file_chaining",
          description: "Follow a chain of file references to find the final value",
          setup: {
            files: [
              { path: "start.txt", content: "The next clue is in: step1.txt" },
              { path: "step1.txt", content: "Look for the answer in: step2.txt" },
              { path: "step2.txt", content: "Almost there! Check: final.txt" },
              { path: "final.txt", content: "SECRET_VALUE=42" },
            ],
          },
          steps: [
            {
              instruction: "Start from start.txt and follow the chain to find the secret value",
              expectedBehavior: "Agent reads files in sequence following references",
            },
          ],
          groundTruth: "42",
          metrics: { expectedContextAccesses: 4, expectedTokenCost: 500 },
        },
        // Entity tracing tasks
        {
          id: "entity-trace-1",
          type: "entity_tracing",
          description: "Trace relationships between entities across multiple files",
          setup: {
            files: [
              {
                path: "people.json",
                content: JSON.stringify({ alice: { manager: "bob" }, bob: { manager: "carol" } }),
              },
              { path: "departments.json", content: JSON.stringify({ engineering: { head: "carol" } }) },
            ],
          },
          steps: [
            {
              instruction: "Find Alice's skip-level manager and their department",
              expectedBehavior: "Agent traces alice -> bob -> carol, then finds carol's department",
              requiresContextRecall: true,
            },
          ],
          groundTruth: "Carol is Alice's skip-level manager and heads the engineering department",
          metrics: { expectedContextAccesses: 3, expectedTokenCost: 400 },
        },
        // Multi-step retrieval
        {
          id: "multi-step-1",
          type: "multi_step_retrieval",
          description: "Gather information from multiple sources and synthesize",
          setup: {
            files: [
              { path: "config.yaml", content: "database:\n  host: db.example.com\n  port: 5432" },
              { path: "credentials.txt", content: "user: admin\npassword: [SEE VAULT]" },
              { path: "vault.json", content: '{"db_password": "super_secret_123"}' },
            ],
          },
          steps: [
            {
              instruction: "Construct the full database connection string",
              expectedBehavior: "Agent gathers host, port, user from multiple files and password from vault",
              requiresContextRecall: true,
            },
          ],
          groundTruth: "postgresql://admin:super_secret_123@db.example.com:5432",
          metrics: { expectedContextAccesses: 3, expectedTokenCost: 600 },
        },
        // Memory management
        {
          id: "memory-mgmt-1",
          type: "memory_management",
          description: "Remember and recall information across multiple interactions",
          setup: {
            initialContext: "Remember: The project deadline is March 15th. The budget is $50,000.",
          },
          steps: [
            {
              instruction: "List current tasks in the project",
              expectedBehavior: "Agent maintains context about deadline and budget",
            },
            {
              instruction: "What is the project deadline?",
              expectedBehavior: "Agent recalls deadline without re-reading",
              requiresContextRecall: true,
            },
            {
              instruction: "How much budget do we have?",
              expectedBehavior: "Agent recalls budget without re-reading",
              requiresContextRecall: true,
            },
          ],
          groundTruth: "Deadline: March 15th, Budget: $50,000",
          metrics: { expectedContextAccesses: 1, expectedTokenCost: 300 },
        },
        // Context switching
        {
          id: "context-switch-1",
          type: "context_switching",
          description: "Handle multiple parallel contexts without confusion",
          setup: {
            files: [
              { path: "project_a/config.json", content: '{"version": "1.0", "env": "production"}' },
              { path: "project_b/config.json", content: '{"version": "2.0", "env": "staging"}' },
            ],
          },
          steps: [
            { instruction: "What version is Project A?", expectedBehavior: "Agent reads project_a config" },
            { instruction: "What environment is Project B in?", expectedBehavior: "Agent switches to project_b" },
            {
              instruction: "Compare the versions of both projects",
              expectedBehavior: "Agent recalls both contexts",
              requiresContextRecall: true,
            },
          ],
          groundTruth: "Project A is version 1.0, Project B is version 2.0",
          metrics: { expectedContextAccesses: 2, expectedTokenCost: 400 },
        },
      ]
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
        // Setup task workspace
        const taskDir = path.join(this.workDir, "runs", taskId)
        await fs.mkdir(taskDir, { recursive: true })

        // Write setup files
        if (task.setup.files) {
          for (const file of task.setup.files) {
            const filePath = path.join(taskDir, file.path)
            await fs.mkdir(path.dirname(filePath), { recursive: true })
            await fs.writeFile(filePath, file.content)
          }
        }

        // Run agent through steps
        const traces: ExecutionTrace[] = []
        let fullResponse = ""

        for (let i = 0; i < task.steps.length; i++) {
          const step = task.steps[i]
          const stepResult = await this.runStep(task, step, taskDir, i, config)
          traces.push(stepResult.trace)
          fullResponse += stepResult.response + "\n"
        }

        // Evaluate results
        const evalResult = await this.evaluateTask(task, fullResponse, traces)

        return {
          taskId,
          passed: evalResult.passed,
          score: evalResult.score,
          duration: Date.now() - startTime,
          metadata: {
            taskType: task.type,
            traces,
            contextEfficiency: evalResult.contextEfficiency,
            costEfficiency: evalResult.costEfficiency,
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

    private async runStep(
      task: Task,
      step: { instruction: string; expectedBehavior: string },
      taskDir: string,
      stepIndex: number,
      config: EvalTypes.RunConfig,
    ): Promise<{ response: string; trace: ExecutionTrace }> {
      const startTime = Date.now()

      // Build prompt with context
      let prompt = step.instruction
      if (stepIndex === 0 && task.setup.initialContext) {
        prompt = `${task.setup.initialContext}\n\n${step.instruction}`
      }

      const modelArgs = config.model ? ["--model", config.model] : []

      try {
        const stepTimeout = Math.floor(config.timeout / task.steps.length)
        const result = await exec(["volt", "run", ...modelArgs, "--cwd", taskDir, "--headless", prompt], {
          timeout: stepTimeout,
        })

        const output = result.stdout

        // Estimate token count (rough approximation)
        const tokenCount = Math.ceil(output.length / 4)

        // Detect if context was accessed (look for file read patterns)
        const contextAccessed = output.includes("Reading") || output.includes("file") || output.includes("content")

        return {
          response: output,
          trace: {
            step: stepIndex,
            action: step.instruction,
            contextAccessed,
            tokenCount,
            timestamp: Date.now() - startTime,
          },
        }
      } catch (error) {
        return {
          response: error instanceof Error ? error.message : String(error),
          trace: {
            step: stepIndex,
            action: step.instruction,
            contextAccessed: false,
            tokenCount: 0,
            timestamp: Date.now() - startTime,
          },
        }
      }
    }

    private async evaluateTask(
      task: Task,
      response: string,
      traces: ExecutionTrace[],
    ): Promise<{
      passed: boolean
      score: number
      contextEfficiency: number
      costEfficiency: number
    }> {
      // Check if ground truth is satisfied
      const normalizedResponse = response.toLowerCase()
      const groundTruthTerms = task.groundTruth.toLowerCase().split(/\s+/)
      const matchRate =
        groundTruthTerms.filter((t) => t.length > 2 && normalizedResponse.includes(t)).length /
        groundTruthTerms.filter((t) => t.length > 2).length

      // Calculate context efficiency
      const actualContextAccesses = traces.filter((t) => t.contextAccessed).length
      const contextEfficiency = Math.min(1, task.metrics.expectedContextAccesses / Math.max(1, actualContextAccesses))

      // Calculate cost efficiency (based on tokens)
      const actualTokens = traces.reduce((sum, t) => sum + t.tokenCount, 0)
      const costEfficiency = Math.min(1, task.metrics.expectedTokenCost / Math.max(1, actualTokens))

      // Combined score
      const accuracyScore = matchRate
      const efficiencyScore = (contextEfficiency + costEfficiency) / 2
      const score = accuracyScore * 0.6 + efficiencyScore * 0.4

      const passed = matchRate >= 0.7 && contextEfficiency >= 0.5

      return { passed, score, contextEfficiency, costEfficiency }
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
          `[${results.length}/${taskIds.length}] ${taskId} (${task?.type}): ${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)})`,
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
      // Optional cleanup
    }
  }
}
