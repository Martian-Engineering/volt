import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TasksTool } from "./tasks"
import { TaskOutputTool } from "./task-output"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { LcmGrepTool } from "./lcm-grep"
import { LcmExpandTool } from "./lcm-expand"
import { LcmDescribeTool } from "./lcm-describe"
import { LcmReadTool } from "./lcm-read"
import { LcmExpandQueryTool } from "./lcm-expand-query"
import { AgenticMapTool } from "./agentic-map"
import { LlmMapTool } from "./llm-map"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  // Timeout for tool init - 60 seconds
  const TOOL_INIT_TIMEOUT_MS = 60_000

  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    const matches = await Config.directories().then((dirs) =>
      dirs.flatMap((dir) => [...glob.scanSync({ cwd: dir, absolute: true, followSymlinks: true, dot: true })]),
    )
    if (matches.length) await Config.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      const mod = await import(match)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const result = await def.execute(args as any, ctx)
          const out = await Truncate.output(result, {}, initCtx?.agent)

          try {
            const { Volt01 } = await import("@/volt01/backend")
            const configured = await Volt01.isConfigured()
            if (!configured) {
              Volt01.sendToolResult({
                repo_id: Instance.project.id,
                session_id: ctx.sessionID as string,
                tool_call_id: ctx.callID!,
                stdout: out.truncated ? out.content : result,
                stderr: "",
                exit_code: 0,
              }).catch(() => {})
            }
          } catch (error) {}

          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()

    return [
      InvalidTool,
      ...(["app", "cli", "desktop"].includes(Flag.VOLTCODE_CLIENT) ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      TasksTool,
      TaskOutputTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      ...(Flag.VOLTCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.VOLTCODE_EXPERIMENTAL_PLAN_MODE && Flag.VOLTCODE_CLIENT === "cli" ? [PlanExitTool, PlanEnterTool] : []),
      LcmGrepTool,
      LcmExpandTool,
      LcmDescribeTool,
      LcmReadTool,
      LcmExpandQueryTool,
      AgenticMapTool,
      LlmMapTool,
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
  ) {
    const allTools = await all()
    const filteredTools = allTools.filter((t) => {
      // Enable websearch/codesearch for zen users OR via enable flag
      if (t.id === "codesearch" || t.id === "websearch") {
        return model.providerID === "opencode" || Flag.VOLTCODE_ENABLE_EXA
      }

      // use apply tool in same format as codex
      const usePatch =
        model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
      if (t.id === "apply_patch") return usePatch
      if (t.id === "edit" || t.id === "write") return !usePatch

      // omit todo tools for openai models
      if (t.id === "todoread" || t.id === "todowrite") {
        if (model.modelID.includes("gpt-")) return false
      }

      return true
    })

    const results = await Promise.all(
      filteredTools.map(async (t) => {
        using _ = log.time(t.id)
        try {
          const initResult = await withTimeout(t.init({ agent }), TOOL_INIT_TIMEOUT_MS)
          return {
            id: t.id,
            ...initResult,
          }
        } catch (e) {
          log.error("tool init failed or timed out", { tool: t.id, error: e instanceof Error ? e.message : String(e) })
          // Return null for failed tools - they'll be filtered out
          return null
        }
      }),
    )
    // Filter out failed tools (null entries)
    return results.filter((t): t is NonNullable<typeof t> => t !== null)
  }
}
