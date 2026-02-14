import { EvalTypes } from "../types"
import { exec, execShell } from "../util"
import path from "path"
import fs from "fs/promises"

/**
 * Aider Polyglot Benchmark Runner
 *
 * The Aider Polyglot benchmark tests LLMs on solving programming problems across
 * multiple languages (C++, Go, Java, JavaScript, Python, Rust) and their ability
 * to edit files and correct mistakes.
 *
 * Features:
 * - 225 hard problems from Exercism across 6 languages
 * - Two attempts per problem with test feedback
 * - Unit test validation per language
 *
 * @see https://aider.chat/2024/12/21/polyglot.html
 * @see https://github.com/Aider-AI/polyglot-benchmark
 */
export namespace AiderPolyglot {
  export const NAME = "aider-polyglot"
  export const VERSION = "1.0.0"
  export const DESCRIPTION = "Multi-language coding benchmark with 225 Exercism problems across 6 languages"

  /** Supported programming languages */
  export type Language = "cpp" | "go" | "java" | "javascript" | "python" | "rust"

  /** Language-specific test commands */
  export const TEST_COMMANDS: Record<Language, string> = {
    cpp: "cmake -B build && cmake --build build && ctest --test-dir build",
    go: "go test",
    java: "gradle test",
    javascript: "npm test",
    python: "pytest",
    rust: "cargo test",
  }

  /** Aider Polyglot task */
  export interface Task {
    id: string
    slug: string
    language: Language
    description: string
    instructions: string
    starterFiles: { path: string; content: string }[]
    testFiles: { path: string; content: string }[]
    difficulty: number // 1-10
  }

  /** Attempt result */
  export interface AttemptResult {
    attemptNumber: number
    passed: boolean
    testOutput: string
    duration: number
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
        "aider-polyglot",
      )
      await fs.mkdir(this.workDir, { recursive: true })

      // Clone Aider polyglot benchmark repository
      const repoDir = path.join(this.workDir, "polyglot-benchmark")
      const exists = await fs.access(repoDir).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Cloning Aider Polyglot Benchmark repository...")
        await exec(["git", "clone", "https://github.com/Aider-AI/polyglot-benchmark.git", repoDir], { quiet: true })
      }

      // Load dataset
      await this.loadDataset(repoDir)
    }

    private async loadDataset(repoDir: string): Promise<void> {
      const datasetFile = path.join(this.workDir, "polyglot-tasks.json")
      const exists = await fs.access(datasetFile).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Loading Aider Polyglot tasks...")
        const tasks: Task[] = []

        // Scan languages - exercises are at repo/lang/exercises/practice/
        const languages: Language[] = ["cpp", "go", "java", "javascript", "python", "rust"]

        for (const lang of languages) {
          // Structure: polyglot-benchmark/lang/exercises/practice/exercise_name/
          const langDir = path.join(repoDir, lang, "exercises", "practice")
          if (
            !(await fs.access(langDir).then(
              () => true,
              () => false,
            ))
          )
            continue

          const exercises = await fs.readdir(langDir).catch(() => [])

          for (const exercise of exercises) {
            const exerciseDir = path.join(langDir, exercise)
            const stat = await fs.stat(exerciseDir).catch(() => null)
            if (!stat?.isDirectory()) continue

            // Load exercise metadata
            const configPath = path.join(exerciseDir, ".meta", "config.json")
            let config: { blurb?: string; difficulty?: number } = {}
            try {
              config = JSON.parse(await fs.readFile(configPath, "utf-8"))
            } catch {
              // Use defaults
            }

            // Load instructions
            const instructionsPath = path.join(exerciseDir, ".docs", "instructions.md")
            const instructions = await fs.readFile(instructionsPath, "utf-8").catch(() => "")

            // Load starter files
            const starterFiles: { path: string; content: string }[] = []
            const testFiles: { path: string; content: string }[] = []

            const allFiles = await this.walkDirectory(exerciseDir)
            for (const file of allFiles) {
              const relativePath = path.relative(exerciseDir, file)

              // Skip hidden/meta files
              if (relativePath.startsWith(".")) continue

              const content = await fs.readFile(file, "utf-8")

              if (this.isTestFile(relativePath, lang)) {
                testFiles.push({ path: relativePath, content })
              } else if (this.isSourceFile(relativePath, lang)) {
                starterFiles.push({ path: relativePath, content })
              }
            }

            if (starterFiles.length > 0) {
              tasks.push({
                id: `${lang}-${exercise}`,
                slug: exercise,
                language: lang,
                description: config.blurb || exercise,
                instructions,
                starterFiles,
                testFiles,
                difficulty: config.difficulty || 5,
              })
            }
          }
        }

        this.tasks = tasks
        await fs.writeFile(datasetFile, JSON.stringify(tasks, null, 2))
      } else {
        const content = await fs.readFile(datasetFile, "utf-8")
        this.tasks = JSON.parse(content)
      }

      console.log(`Loaded ${this.tasks.length} Aider Polyglot tasks`)
    }

    private async walkDirectory(dir: string): Promise<string[]> {
      const files: string[] = []
      const entries = await fs.readdir(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          files.push(...(await this.walkDirectory(fullPath)))
        } else {
          files.push(fullPath)
        }
      }

      return files
    }

    private isTestFile(filePath: string, lang: Language): boolean {
      const testPatterns: Record<Language, RegExp[]> = {
        cpp: [/_test\.cpp$/, /test_.*\.cpp$/],
        go: [/_test\.go$/],
        java: [/Test\.java$/, /Tests\.java$/],
        javascript: [/\.test\.js$/, /\.spec\.js$/, /test.*\.js$/],
        python: [/_test\.py$/, /test_.*\.py$/],
        rust: [/_test\.rs$/, /tests\.rs$/],
      }

      return testPatterns[lang].some((pattern) => pattern.test(filePath))
    }

    private isSourceFile(filePath: string, lang: Language): boolean {
      const extensions: Record<Language, string[]> = {
        cpp: [".cpp", ".hpp", ".h", ".cc"],
        go: [".go"],
        java: [".java"],
        javascript: [".js", ".mjs"],
        python: [".py"],
        rust: [".rs"],
      }

      const ext = path.extname(filePath)
      return extensions[lang].includes(ext) && !this.isTestFile(filePath, lang)
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
        await fs.rm(taskDir, { recursive: true, force: true })
        await fs.mkdir(taskDir, { recursive: true })

        // Write starter files
        for (const file of task.starterFiles) {
          const filePath = path.join(taskDir, file.path)
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, file.content)
        }

        // Write test files
        for (const file of task.testFiles) {
          const filePath = path.join(taskDir, file.path)
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await fs.writeFile(filePath, file.content)
        }

        // Setup language-specific project files
        await this.setupProjectFiles(taskDir, task.language)

        // Attempt 1
        const attempt1 = await this.runAttempt(task, taskDir, 1, config, null)

        if (attempt1.passed) {
          return {
            taskId,
            passed: true,
            score: 1,
            duration: Date.now() - startTime,
            metadata: {
              language: task.language,
              attempts: 1,
              attempt1,
            },
          }
        }

        // Attempt 2 with feedback from first attempt
        const attempt2 = await this.runAttempt(task, taskDir, 2, config, attempt1.testOutput)

        const passed = attempt2.passed
        const score = attempt1.passed ? 1 : attempt2.passed ? 0.5 : 0

        return {
          taskId,
          passed,
          score,
          duration: Date.now() - startTime,
          metadata: {
            language: task.language,
            attempts: 2,
            attempt1,
            attempt2,
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

    private async setupProjectFiles(taskDir: string, language: Language): Promise<void> {
      switch (language) {
        case "python":
          await fs.writeFile(path.join(taskDir, "pytest.ini"), "[pytest]\ntestpaths = .\n")
          break
        case "javascript":
          await fs.writeFile(
            path.join(taskDir, "package.json"),
            JSON.stringify(
              { name: "exercise", scripts: { test: "jest" }, devDependencies: { jest: "^29.0.0" } },
              null,
              2,
            ),
          )
          break
        case "rust":
          await fs.writeFile(
            path.join(taskDir, "Cargo.toml"),
            '[package]\nname = "exercise"\nversion = "0.1.0"\nedition = "2021"\n',
          )
          break
        case "go":
          await fs.writeFile(path.join(taskDir, "go.mod"), "module exercise\n\ngo 1.21\n")
          break
        // Add more as needed
      }
    }

    private async runAttempt(
      task: Task,
      taskDir: string,
      attemptNumber: number,
      config: EvalTypes.RunConfig,
      previousError: string | null,
    ): Promise<AttemptResult> {
      const startTime = Date.now()

      // Build prompt
      let prompt = `You are solving a coding exercise in ${task.language}.

## Problem Description
${task.description}

## Instructions
${task.instructions}

## Files to Modify
${task.starterFiles.map((f) => `- ${f.path}`).join("\n")}

Implement the solution by modifying the source files. Do NOT modify any test files.
`

      if (previousError) {
        prompt += `
## Previous Attempt Failed
The tests produced the following error. Fix the code:

\`\`\`
${previousError.slice(0, 2000)}
\`\`\`
`
      }

      const modelArgs = config.model ? ["--model", config.model] : []

      try {
        // Run agent to generate solution
        await exec(["volt", "run", ...modelArgs, "--cwd", taskDir, "--headless", prompt], {
          timeout: Math.floor(config.timeout / 2),
        })

        // Run tests
        const testCommand = TEST_COMMANDS[task.language]
        const testResult = await execShell(`cd ${taskDir} && ${testCommand}`, { timeout: 60000, quiet: true })

        return {
          attemptNumber,
          passed: testResult.exitCode === 0,
          testOutput: testResult.stdout + testResult.stderr,
          duration: Date.now() - startTime,
        }
      } catch (error) {
        return {
          attemptNumber,
          passed: false,
          testOutput: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        }
      }
    }

    async run(config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
      const startedAt = new Date().toISOString()
      let taskIds = config.taskIds ?? (await this.listTasks())

      if (config.limit) {
        taskIds = taskIds.slice(0, config.limit)
      }

      const results: EvalTypes.TaskResult[] = []

      // Track by language
      const byLanguage: Record<string, { passed: number; total: number }> = {}

      for (const taskId of taskIds) {
        const result = await this.runTask(taskId, config)
        results.push(result)

        const task = this.tasks.find((t) => t.id === taskId)
        if (task) {
          if (!byLanguage[task.language]) {
            byLanguage[task.language] = { passed: 0, total: 0 }
          }
          byLanguage[task.language].total++
          if (result.passed) byLanguage[task.language].passed++
        }

        console.log(
          `[${results.length}/${taskIds.length}] ${taskId}: ${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)})`,
        )
      }

      const completedAt = new Date().toISOString()
      const passedTasks = results.filter((r) => r.passed).length

      // Log per-language stats
      console.log("\nResults by language:")
      for (const [lang, stats] of Object.entries(byLanguage)) {
        console.log(`  ${lang}: ${stats.passed}/${stats.total} (${((stats.passed / stats.total) * 100).toFixed(1)}%)`)
      }

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
      // Optional: clean up run directories
    }
  }
}
