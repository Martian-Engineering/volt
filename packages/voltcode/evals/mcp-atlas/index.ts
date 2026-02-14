import { EvalTypes } from "../types"
import { exec, execShell } from "../util"
import path from "path"
import fs from "fs/promises"

/**
 * MCP Atlas Benchmark Runner
 *
 * MCP-Atlas evaluates AI models' tool-use capabilities across 36 Model Context Protocol
 * (MCP) servers with 220+ tools. Tasks require agents to identify and orchestrate 3-6
 * tool calls across multiple servers using natural language prompts.
 *
 * Evaluation criteria:
 * - Pass rate: percentage of tasks with ≥75% coverage score
 * - Coverage: claims verified against ground truth via LLM judge
 *
 * @see https://scale.com/blog/mcp-atlas
 * @see https://github.com/scaleapi/mcp-atlas
 */
export namespace MCPAtlas {
  export const NAME = "mcp-atlas"
  export const VERSION = "1.0.0"
  export const DESCRIPTION = "Multi-tool MCP benchmark with 1000 tasks across 36 servers and 220+ tools"

  /** MCP Atlas task */
  export interface Task {
    id: string
    prompt: string
    expectedTools: string[]
    groundTruth: {
      claims: string[]
      answer: string
    }
    servers: string[]
    category: string
  }

  /** Tool call made by the agent */
  export interface ToolCall {
    server: string
    tool: string
    arguments: Record<string, unknown>
    result: unknown
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
        "mcp-atlas",
      )
      await fs.mkdir(this.workDir, { recursive: true })

      // Clone MCP Atlas repository if not present
      const repoDir = path.join(this.workDir, "mcp-atlas")
      const exists = await fs.access(repoDir).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Cloning MCP Atlas repository...")
        await exec(["git", "clone", "https://github.com/scaleapi/mcp-atlas.git", repoDir], { quiet: true })
      }

      // Load tasks from dataset
      await this.loadDataset(repoDir)
    }

    private async loadDataset(repoDir: string): Promise<void> {
      // Try loading from HuggingFace dataset
      const datasetFile = path.join(this.workDir, "mcp-atlas-tasks.json")
      const exists = await fs.access(datasetFile).then(
        () => true,
        () => false,
      )

      if (!exists) {
        console.log("Attempting to load MCP Atlas dataset...")

        // Try HuggingFace first (dataset may require authentication)
        try {
          const pythonScript = `
import json
from datasets import load_dataset
ds = load_dataset("ScaleAI/MCP-Atlas", split="test")
with open("${datasetFile}", "w") as f:
    json.dump([dict(row) for row in ds], f, indent=2)
`
          const scriptFile = path.join(this.workDir, "download_mcp_atlas.py")
          await fs.writeFile(scriptFile, pythonScript)
          await execShell(`pip install datasets -q && python ${scriptFile}`, { timeout: 300_000 })
        } catch {
          // Fallback: try to load from cloned repo
          const localDataset = path.join(repoDir, "data", "tasks.json")
          if (
            await fs.access(localDataset).then(
              () => true,
              () => false,
            )
          ) {
            await fs.copyFile(localDataset, datasetFile)
          } else {
            console.warn("Could not load MCP Atlas dataset.")
            console.warn("MCP Atlas may require HuggingFace authentication or the dataset is not yet public.")
            console.warn("To authenticate: huggingface-cli login")
            this.tasks = []
            return
          }
        }
      }

      try {
        const content = await fs.readFile(datasetFile, "utf-8")
        this.tasks = JSON.parse(content)
        console.log(`Loaded ${this.tasks.length} MCP Atlas tasks`)
      } catch {
        console.error("Failed to parse MCP Atlas dataset")
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
        // Configure MCP servers for this task
        const mcpConfig = await this.configureMCPServers(task.servers)

        // Run VoltCode agent with MCP tools
        const agentResult = await this.runAgent(task, mcpConfig, config)

        // Evaluate response using LLM judge
        const evalResult = await this.evaluateResponse(task, agentResult)

        return {
          taskId,
          passed: evalResult.passed,
          score: evalResult.coverage,
          duration: Date.now() - startTime,
          metadata: {
            toolCalls: agentResult.toolCalls,
            claimScores: evalResult.claimScores,
            response: agentResult.response,
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

    private async configureMCPServers(servers: string[]): Promise<string> {
      // Create temporary MCP config for the required servers
      const configPath = path.join(this.workDir, "mcp-config.json")

      // Map server names to their configurations
      const serverConfigs: Record<string, { command: string; args?: string[] }> = {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        brave_search: { command: "npx", args: ["-y", "@anthropic-ai/mcp-server-brave-search"] },
        fetch: { command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] },
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
        // Add more server configurations as needed
      }

      const mcpServers: Record<string, { command: string; args?: string[] }> = {}
      for (const server of servers) {
        if (serverConfigs[server]) {
          mcpServers[server] = serverConfigs[server]
        }
      }

      await fs.writeFile(configPath, JSON.stringify({ mcpServers }, null, 2))
      return configPath
    }

    private async runAgent(
      task: Task,
      mcpConfigPath: string,
      config: EvalTypes.RunConfig,
    ): Promise<{ response: string; toolCalls: ToolCall[] }> {
      const taskDir = path.join(this.workDir, "runs", task.id)
      await fs.mkdir(taskDir, { recursive: true })

      // Build prompt that doesn't hint at specific tools (per MCP Atlas design)
      const prompt = task.prompt

      // Run volt with MCP configuration
      const modelArgs = config.model ? ["--model", config.model] : []

      try {
        const result = await exec(["volt", "run", ...modelArgs, "--mcp-config", mcpConfigPath, "--headless", prompt], {
          timeout: config.timeout,
        })

        const output = result.stdout

        // Parse tool calls from output (format depends on VoltCode output)
        const toolCalls = this.parseToolCalls(output)

        return {
          response: output,
          toolCalls,
        }
      } catch (error) {
        return {
          response: error instanceof Error ? error.message : String(error),
          toolCalls: [],
        }
      }
    }

    private parseToolCalls(output: string): ToolCall[] {
      // Parse tool calls from VoltCode output
      // This is a simplified parser - actual implementation depends on output format
      const toolCalls: ToolCall[] = []

      // Look for tool call patterns in the output
      const toolCallRegex = /Tool: (\w+)\.(\w+)\nArguments: ({[\s\S]*?})\nResult: ([\s\S]*?)(?=Tool:|$)/g
      let match

      while ((match = toolCallRegex.exec(output)) !== null) {
        try {
          toolCalls.push({
            server: match[1],
            tool: match[2],
            arguments: JSON.parse(match[3]),
            result: match[4].trim(),
          })
        } catch {
          // Skip malformed tool calls
        }
      }

      return toolCalls
    }

    private async evaluateResponse(
      task: Task,
      agentResult: { response: string; toolCalls: ToolCall[] },
    ): Promise<{ passed: boolean; coverage: number; claimScores: number[] }> {
      const claimScores: number[] = []

      // Evaluate each claim from ground truth
      for (const claim of task.groundTruth.claims) {
        const score = await this.evaluateClaim(claim, agentResult.response)
        claimScores.push(score)
      }

      // Calculate coverage (average of claim scores)
      const coverage = claimScores.length > 0 ? claimScores.reduce((a, b) => a + b, 0) / claimScores.length : 0

      // Task passes if coverage >= 75%
      const passed = coverage >= 0.75

      return { passed, coverage, claimScores }
    }

    private async evaluateClaim(claim: string, response: string): Promise<number> {
      // Use LLM-as-judge to evaluate if claim is satisfied
      // Simplified implementation - real version would use GPT-4 or similar

      // For now, use simple string matching as placeholder
      const normalizedClaim = claim.toLowerCase()
      const normalizedResponse = response.toLowerCase()

      // Check if key terms from claim appear in response
      const terms = normalizedClaim.split(/\s+/).filter((t) => t.length > 3)
      const matchedTerms = terms.filter((t) => normalizedResponse.includes(t))

      if (matchedTerms.length === terms.length) return 1
      if (matchedTerms.length >= terms.length * 0.5) return 0.5
      return 0
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
        console.log(
          `[${results.length}/${taskIds.length}] ${taskId}: ${result.passed ? "PASS" : "FAIL"} (${result.score.toFixed(2)})`,
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
      // Cleanup MCP processes if any
    }
  }
}
