import { EvalTypes } from "../types"
import { exec, execShell, commandExists } from "../util"
import path from "path"
import fs from "fs/promises"

/**
 * SWE-bench Verified Benchmark Runner
 *
 * SWE-bench evaluates LLMs on real-world GitHub issues. Given a codebase and issue
 * description, the model must generate a patch that resolves the problem.
 *
 * Evaluation criteria:
 * - FAIL_TO_PASS tests must pass (issue is resolved)
 * - PASS_TO_PASS tests must pass (no regressions)
 *
 * @see https://www.swebench.com/
 * @see https://github.com/SWE-bench/SWE-bench
 */
export namespace SWEBench {
  export const NAME = "swe-bench-verified"
  export const VERSION = "1.0.0"
  export const DESCRIPTION = "Real-world GitHub issue resolution benchmark with 500 human-validated tasks"

  /** SWE-bench task instance */
  export interface Task {
    instance_id: string
    repo: string
    base_commit: string
    problem_statement: string
    hints_text: string
    patch: string
    test_patch: string
    fail_to_pass: string[]
    pass_to_pass: string[]
    environment_setup_commit: string
  }

  /** Configuration specific to SWE-bench */
  export interface Config extends EvalTypes.RunConfig {
    /** Path to SWE-bench dataset (or will download) */
    datasetPath?: string
    /** Use Modal for cloud execution */
    useModal?: boolean
    /** Docker image to use for evaluation */
    dockerImage?: string
  }

  export class Runner implements EvalTypes.BenchmarkRunner {
    name = NAME
    version = VERSION
    description = DESCRIPTION

    private tasks: Task[] = []
    private workDir = ""

    async setup(): Promise<void> {
      // Create work directory
      this.workDir = path.join(
        process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache"),
        "voltcode",
        "evals",
        "swe-bench",
      )
      await fs.mkdir(this.workDir, { recursive: true })

      // Check if SWE-bench is installed
      const hasSWEBench = await commandExists("swe-bench")

      if (!hasSWEBench) {
        console.log("SWE-bench not found. Installing...")
        await execShell("pip install swe-bench", { quiet: true })
      }

      // Load dataset
      await this.loadDataset()
    }

    private async loadDataset(): Promise<void> {
      const datasetFile = path.join(this.workDir, "swe-bench-verified.json")

      // Check if dataset exists
      const exists = await fs.access(datasetFile).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Downloading SWE-bench Verified dataset...")
        // Dataset is in parquet format on HuggingFace, need to use Python datasets library
        const pythonScript = `
import json
from datasets import load_dataset
ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
with open("${datasetFile}", "w") as f:
    json.dump([dict(row) for row in ds], f, indent=2)
`
        const scriptFile = path.join(this.workDir, "download_dataset.py")
        await fs.writeFile(scriptFile, pythonScript)

        try {
          await execShell(`pip install datasets -q && python ${scriptFile}`, { timeout: 300_000 })
        } catch (error) {
          console.error("Failed to download SWE-bench dataset. Please ensure Python and pip are available.")
          console.error(
            "You can manually download using: pip install datasets && python -c 'from datasets import load_dataset; ...'",
          )
          this.tasks = []
          return
        }
      }

      try {
        const content = await fs.readFile(datasetFile, "utf-8")
        this.tasks = JSON.parse(content)
        console.log(`Loaded ${this.tasks.length} SWE-bench tasks`)
      } catch {
        console.error("Failed to parse SWE-bench dataset")
        this.tasks = []
      }
    }

    async listTasks(): Promise<string[]> {
      return this.tasks.map((t) => t.instance_id)
    }

    async runTask(taskId: string, config: EvalTypes.RunConfig): Promise<EvalTypes.TaskResult> {
      const startTime = Date.now()
      const task = this.tasks.find((t) => t.instance_id === taskId)

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
        // Create isolated workspace for this task
        const taskDir = path.join(this.workDir, "runs", taskId.replace(/[^a-zA-Z0-9-_]/g, "_"))
        await fs.mkdir(taskDir, { recursive: true })

        // Clone the repository at the specified commit
        const repoDir = path.join(taskDir, "repo")
        await exec(["git", "clone", "--depth", "1", `https://github.com/${task.repo}.git`, repoDir], { quiet: true })
        await exec(["git", "-C", repoDir, "fetch", "--depth", "1", "origin", task.base_commit], { quiet: true })
        await exec(["git", "-C", repoDir, "checkout", task.base_commit], { quiet: true })

        // Write problem statement for the agent
        const problemFile = path.join(taskDir, "problem.md")
        await fs.writeFile(
          problemFile,
          `# Issue\n\n${task.problem_statement}\n\n## Hints\n\n${task.hints_text || "No hints provided."}`,
        )

        // Run agent (VoltCode or ClaudeCode) to generate patch
        const patchFile = path.join(taskDir, "generated.patch")
        const agentResult = await this.runAgent(repoDir, problemFile, patchFile, config)

        if (!agentResult.success) {
          return {
            taskId,
            passed: false,
            score: 0,
            duration: Date.now() - startTime,
            error: agentResult.error,
          }
        }

        // Agent already modified files in-place; patch file is saved for record-keeping
        // Run evaluation using SWE-bench harness
        const evalResult = await this.evaluatePatch(task, repoDir)

        return {
          taskId,
          passed: evalResult.passed,
          score: evalResult.score,
          duration: Date.now() - startTime,
          metadata: {
            failToPassResults: evalResult.failToPass,
            passToPassResults: evalResult.passToPass,
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

    private async runAgent(
      repoDir: string,
      problemFile: string,
      patchFile: string,
      config: EvalTypes.RunConfig,
    ): Promise<{ success: boolean; error?: string }> {
      const agent = config.agent ?? "voltcode"

      if (agent === "claude-code") {
        return this.runClaudeCodeAgent(repoDir, problemFile, patchFile, config)
      }

      return this.runVoltCodeAgent(repoDir, problemFile, patchFile, config)
    }

    private async runVoltCodeAgent(
      repoDir: string,
      problemFile: string,
      patchFile: string,
      config: EvalTypes.RunConfig,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const problem = await fs.readFile(problemFile, "utf-8")

        // Build the prompt for VoltCode - emphasize editing files directly
        const prompt = `Fix the following GitHub issue by directly editing the source code files. Do NOT just analyze the issue - you MUST use the edit tool to modify the code.

${problem}

IMPORTANT: You must edit the source files to fix this bug. Do not just explain the fix - apply it using the edit tool. Do NOT modify any test files. Make minimal changes.`

        // Write a project config that auto-allows all permissions (no interactive prompts)
        const voltcodeDir = path.join(repoDir, ".voltcode")
        await fs.mkdir(voltcodeDir, { recursive: true })
        await fs.writeFile(path.join(voltcodeDir, "voltcode.json"), JSON.stringify({ permission: "allow" }))

        // Run volt CLI with --format json
        const args = ["volt", "run", "--format", "json"]
        if (config.model) args.push("--model", config.model)
        args.push(prompt)
        const agentOut = await exec(args, { cwd: repoDir, timeout: config.timeout })

        // Agent edits files directly in the repo; capture changes via git diff
        const diff = await exec(["git", "diff"], { cwd: repoDir, quiet: true })
        if (diff.stdout.trim()) {
          await fs.writeFile(patchFile, diff.stdout)
        }

        return { success: true }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[voltcode agent error] ${msg}`)
        return {
          success: false,
          error: msg,
        }
      }
    }

    private async runClaudeCodeAgent(
      repoDir: string,
      problemFile: string,
      patchFile: string,
      config: EvalTypes.RunConfig,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const problem = await fs.readFile(problemFile, "utf-8")

        // Build the prompt for Claude Code - emphasize editing files directly
        const prompt = `Fix the following GitHub issue by directly editing the source code files. Do NOT just analyze the issue - you MUST use the edit tool to modify the code.

${problem}

IMPORTANT: You must edit the source files to fix this bug. Do not just explain the fix - apply it using the edit tool. Do NOT modify any test files. Make minimal changes.`

        // Run claude CLI in print mode using exec() to avoid shell escaping issues
        const args = ["claude", "-p"]
        if (config.model) args.push("--model", config.model)
        args.push(prompt)
        await exec(args, {
          cwd: repoDir,
          timeout: config.timeout,
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
        })

        // Agent edits files directly in the repo; capture changes via git diff
        const diff = await exec(["git", "diff"], { cwd: repoDir, quiet: true })
        if (diff.stdout.trim()) {
          await fs.writeFile(patchFile, diff.stdout)
        }

        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    private async evaluatePatch(
      task: Task,
      repoDir: string,
    ): Promise<{ passed: boolean; score: number; failToPass: boolean[]; passToPass: boolean[] }> {
      const failToPass: boolean[] = []
      const passToPass: boolean[] = []

      // Run FAIL_TO_PASS tests (these should now pass after the fix)
      for (const test of task.fail_to_pass) {
        try {
          const result = await execShell(`cd ${repoDir} && pytest ${test} -x`, { timeout: 60_000, quiet: true })
          failToPass.push(result.exitCode === 0)
        } catch {
          failToPass.push(false)
        }
      }

      // Run PASS_TO_PASS tests (these should still pass - no regressions)
      for (const test of task.pass_to_pass) {
        try {
          const result = await execShell(`cd ${repoDir} && pytest ${test} -x`, { timeout: 60_000, quiet: true })
          passToPass.push(result.exitCode === 0)
        } catch {
          passToPass.push(false)
        }
      }

      const failToPassPassed = failToPass.every((r) => r)
      const passToPassPassed = passToPass.every((r) => r)
      const passed = failToPassPassed && passToPassPassed

      // Score: weighted average (FAIL_TO_PASS is more important)
      const f2pScore = failToPass.length ? failToPass.filter((r) => r).length / failToPass.length : 1
      const p2pScore = passToPass.length ? passToPass.filter((r) => r).length / passToPass.length : 1
      const score = passed ? 1 : f2pScore * 0.7 + p2pScore * 0.3

      return { passed, score, failToPass, passToPass }
    }

    async run(config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
      const startedAt = new Date().toISOString()
      let taskIds = config.taskIds ?? (await this.listTasks())

      if (config.limit) {
        taskIds = taskIds.slice(0, config.limit)
      }

      const results: EvalTypes.TaskResult[] = []

      // Run tasks with concurrency control
      const queue = [...taskIds]
      const running: Promise<void>[] = []

      while (queue.length > 0 || running.length > 0) {
        while (running.length < config.concurrency && queue.length > 0) {
          const taskId = queue.shift()!
          const promise = this.runTask(taskId, config).then((result) => {
            results.push(result)
            console.log(
              `[${results.length}/${taskIds.length}] ${taskId}: ${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)})`,
            )
          })
          running.push(promise)
        }

        if (running.length > 0) {
          await Promise.race(running)
          // Remove completed promises
          for (let i = running.length - 1; i >= 0; i--) {
            const status = await Promise.race([running[i].then(() => "done"), Promise.resolve("pending")])
            if (status === "done") running.splice(i, 1)
          }
        }
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
      // Optionally clean up work directory
      // await fs.rm(this.workDir, { recursive: true, force: true })
    }
  }
}
