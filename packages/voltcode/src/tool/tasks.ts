import { Tool } from "./tool"
import DESCRIPTION from "./tasks.txt"
import z from "zod"
import { Agent } from "../agent/agent"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { taskSchema, executeTask, type TaskParams } from "./task"

const parallelTaskSchema = taskSchema.omit({ delegated_scope: true, kept_work: true })

const parameters = z.object({
  tasks: z
    .array(parallelTaskSchema)
    .min(2)
    .describe("Array of 2 or more tasks to execute in parallel. Each task runs as an independent sub-agent."),
})

export const TasksTool = Tool.define("tasks", async (ctx) => {
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
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()
      const tasks = params.tasks

      // Track metadata for all tasks and aggregate updates
      const taskMetadata: Record<string, unknown>[] = tasks.map(() => ({}))

      function updateAggregatedMetadata() {
        ctx.metadata({
          title: `${tasks.length} parallel tasks`,
          metadata: {
            tasks: taskMetadata,
          },
        })
      }

      // Send initial metadata so UI knows tasks are starting
      updateAggregatedMetadata()

      // Execute all tasks in parallel
      const results = await Promise.all(
        tasks.map((task, index) =>
          executeTask(task, ctx, config, {
            skipDelegationCheck: true,
            onMetadataUpdate: (metadata) => {
              taskMetadata[index] = metadata
              updateAggregatedMetadata()
            },
          }),
        ),
      )

      // Aggregate results
      const combinedOutput = results.map((r, i) => `## Task ${i + 1}: ${r.title}\n\n${r.output}`).join("\n\n---\n\n")

      return {
        title: `${results.length} parallel tasks`,
        metadata: {
          tasks: results.map((r) => r.metadata),
        },
        output: combinedOutput,
      }
    },
  }
})
