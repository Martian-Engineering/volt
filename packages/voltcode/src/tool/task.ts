import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { BackgroundTask } from "../session/background-task"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.task" })

export const taskSchema = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  delegated_scope: z
    .string()
    .describe("Required for sub-agents: the specific slice of work being delegated")
    .optional(),
  kept_work: z.string().describe("Required for sub-agents: the work you will still do yourself").optional(),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
  run_in_background: z
    .boolean()
    .describe("Run this task in the background and return immediately with a task_id")
    .optional(),
})

export type TaskParams = z.infer<typeof taskSchema>

// Shared execution logic used by both Task and Tasks tools
export async function executeTask(
  taskParams: TaskParams,
  ctx: Tool.Context,
  config: Awaited<ReturnType<typeof Config.get>>,
  options?: {
    onMetadataUpdate?: (metadata: Record<string, unknown>) => void
    skipDelegationCheck?: boolean
  },
): Promise<{
  title: string
  metadata: Record<string, unknown>
  output: string
}> {
  const callerAgent = await Agent.get(ctx.agent).catch(() => undefined)
  const isModelToolCall = Boolean(ctx.extra?.model)
  // Skip delegation check for explore agents — they're read-only and can't
  // spawn further sub-agents, so there's no recursion risk.
  const targetIsExplore = taskParams.subagent_type === "explore"
  if (callerAgent?.mode === "subagent" && isModelToolCall && !options?.skipDelegationCheck && !targetIsExplore) {
    const delegatedScope = taskParams.delegated_scope?.trim()
    const keptWork = taskParams.kept_work?.trim()
    if (!delegatedScope || !keptWork) {
      throw new Error(
        "Sub-agents must provide delegated_scope and kept_work when spawning tasks. " +
          "If you cannot describe what you are keeping, do the task yourself.",
      )
    }
  }

  // Skip permission check when user explicitly invoked via @ or command subtask
  if (!ctx.extra?.bypassAgentCheck) {
    await ctx.ask({
      permission: "task",
      patterns: [taskParams.subagent_type],
      always: ["*"],
      metadata: {
        description: taskParams.description,
        subagent_type: taskParams.subagent_type,
      },
    })
  }

  const agent = await Agent.get(taskParams.subagent_type)
  if (!agent) throw new Error(`Unknown agent type: ${taskParams.subagent_type} is not a valid agent type`)

  const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
  // 'general' agent inherits root agent permissions (no restrictions)
  const inheritRootPermissions = agent.name === "general"

  const session = await iife(async () => {
    if (taskParams.session_id) {
      const found = await Session.get(taskParams.session_id).catch(() => {})
      if (found) return found
    }

    return await Session.create({
      parentID: ctx.sessionID,
      title: taskParams.description + ` (@${agent.name} subagent)`,
      permission: inheritRootPermissions
        ? [
            // Only add experimental primary_tools allowances
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ]
        : [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            // Allow subagents to read/write files in /tmp without permission prompts
            {
              permission: "read",
              pattern: "/tmp/*",
              action: "allow",
            },
            {
              permission: "edit",
              pattern: "/tmp/*",
              action: "allow",
            },
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
    })
  })

  const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
  if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

  // Extract model info for use in helper (helps TypeScript with type narrowing)
  const msgInfo = msg.info
  const defaultModel = { modelID: msgInfo.modelID, providerID: msgInfo.providerID }

  // Helper to update metadata (either directly or via callback for parallel mode)
  function updateMetadata(metadata: Record<string, unknown>) {
    if (options?.onMetadataUpdate) {
      options.onMetadataUpdate(metadata)
    } else {
      ctx.metadata({
        title: taskParams.description,
        metadata,
      })
    }
  }

  // Core execution logic extracted into helper
  async function runTaskCore(
    abortSignal: AbortSignal,
    extraContext: Record<string, unknown>,
  ): Promise<{
    title: string
    metadata: Record<string, unknown>
    output: string
  }> {
    const messageID = Identifier.ascending("message")
    const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
    const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      if (evt.properties.part.sessionID !== session.id) return
      if (evt.properties.part.messageID === messageID) return
      if (evt.properties.part.type !== "tool") return
      const part = evt.properties.part
      parts[part.id] = {
        id: part.id,
        tool: part.tool,
        state: {
          status: part.state.status,
          title: part.state.status === "completed" ? part.state.title : undefined,
        },
      }
      updateMetadata({
        summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
        sessionId: session.id,
        ...extraContext,
      })
    })

    const model = agent.model ?? defaultModel

    function cancel() {
      SessionPrompt.cancel(session.id)
    }
    abortSignal.addEventListener("abort", cancel)
    const cleanupAbort = () => abortSignal.removeEventListener("abort", cancel)
    const promptParts = await SessionPrompt.resolvePromptParts(taskParams.prompt)

    try {
      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: inheritRootPermissions
          ? {
              // Only disable experimental primary_tools for general agent
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
            }
          : {
              todowrite: false,
              todoread: false,
              ...(hasTaskPermission ? {} : { task: false }),
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
            },
        parts: promptParts,
      }).finally(() => {
        unsub()
      })

      cleanupAbort()
      const postStart = performance.now()
      const messages = await Session.messages({ sessionID: session.id })
      log.trace("task.timing.loadMessages", { sessionID: session.id, ms: Math.round(performance.now() - postStart) })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((m) => m.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
            error: part.state.status === "error" ? part.state.error : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      // Include error information in output so parent agent sees failures
      const errorParts = summary.filter((s) => s.state.status === "error")
      const escapeXml = (str: string) => str.replace(/</g, "&lt;").replace(/>/g, "&gt;")
      const errorSummary =
        errorParts.length > 0
          ? "\n\n<task_errors>\n" +
            errorParts.map((e) => `Tool "${escapeXml(e.tool)}" failed: ${escapeXml(e.state.error ?? "")}`).join("\n") +
            "\n</task_errors>"
          : ""

      const output =
        text + errorSummary + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")

      return {
        title: taskParams.description,
        metadata: {
          summary,
          sessionId: session.id,
          ...extraContext,
        },
        output,
      }
    } catch (err) {
      cleanupAbort()
      // Don't re-throw RejectedError - return it as an error result so it doesn't
      // cascade to abort other parallel tool calls in the parent session
      if (
        err instanceof PermissionNext.RejectedError ||
        err instanceof PermissionNext.CorrectedError ||
        err instanceof PermissionNext.DeniedError
      ) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return {
          title: taskParams.description,
          metadata: {
            sessionId: session.id,
            error: true,
            ...extraContext,
          },
          output: `Task failed: ${errMsg}\n\n<task_metadata>\nsession_id: ${session.id}\n</task_metadata>`,
        }
      }
      throw err
    }
  }

  // Handle background execution
  if (taskParams.run_in_background) {
    const bgAbort = new AbortController()
    const taskInfo = BackgroundTask.create({
      sessionID: ctx.sessionID,
      taskSessionID: session.id,
      toolPartID: ctx.callID ?? Identifier.ascending("part"),
      assistantMessageID: ctx.messageID,
      description: taskParams.description,
      abort: bgAbort,
    })

    // Update status to backgrounded
    BackgroundTask.update(taskInfo.id, (t) => {
      t.status = "backgrounded"
    })

    updateMetadata({
      sessionId: session.id,
      background: { taskId: taskInfo.id, status: "running" },
    })

    // Fire and forget with error handling
    void runTaskCore(bgAbort.signal, { background: true, taskId: taskInfo.id })
      .then((res) => {
        BackgroundTask.complete(taskInfo.id, {
          output: res.output,
          metadata: res.metadata,
        })
      })
      .catch((err) => {
        BackgroundTask.error(taskInfo.id, err instanceof Error ? err : new Error(String(err)))
      })

    return {
      title: taskParams.description,
      output: `Task running in background. task_id: ${taskInfo.id}`,
      metadata: {
        sessionId: session.id,
        background: { taskId: taskInfo.id, status: "running" },
      },
    }
  }

  // Normal synchronous execution
  updateMetadata({ sessionId: session.id })

  return await runTaskCore(ctx.abort, {})
}

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters: taskSchema,
    async execute(params: TaskParams, ctx) {
      const config = await Config.get()
      return executeTask(params, ctx, config)
    },
  }
})
