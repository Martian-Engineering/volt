import z from "zod"
import { Tool } from "./tool"
import { BackgroundTask } from "../session/background-task"
import { Bus } from "@/bus"

export const TaskOutputTool = Tool.define("task_output", {
  description: `Retrieve output from a background task.

Use this to check status or get results from tasks started with run_in_background
or moved to background mid-execution.

Parameters:
- task_id: The task_id returned when the task was backgrounded
- wait: If true, block until task completes (default: false)
- timeout: Maximum milliseconds to wait (default: 30000, max: 300000)

Returns the task's current status and output. If the task is completed or errored,
returns the final result. If still running and wait=false, returns current status.`,

  parameters: z.object({
    task_id: z.string().describe("The task_id returned when the task was backgrounded"),
    wait: z.boolean().optional().describe("Wait for completion (default: false)"),
    timeout: z.number().optional().describe("Max milliseconds to wait (default: 30000)"),
  }),

  async execute(params, ctx) {
    const task = BackgroundTask.get(params.task_id)
    if (!task) {
      throw new Error(`No background task found with id: ${params.task_id}`)
    }

    // If completed or error, return the result immediately
    if (task.status === "completed" || task.status === "error" || task.status === "cancelled") {
      return formatResult(task)
    }

    // If not waiting, return current status
    if (!params.wait) {
      return {
        title: `Task "${task.description}" still running`,
        output: formatStatusOutput(task),
        metadata: {
          taskId: task.id,
          status: task.status,
          taskSessionID: task.taskSessionID,
        },
      }
    }

    // Wait for completion with timeout
    const timeout = Math.min(params.timeout ?? 30000, 300000) // Cap at 5 minutes
    const result = await waitForTaskCompletion(task.id, timeout, ctx.abort)

    if (!result) {
      return {
        title: `Task "${task.description}" timed out`,
        output: `Task did not complete within ${timeout}ms. Current status: ${task.status}\nUse task_output again to check progress.`,
        metadata: {
          taskId: task.id,
          status: "timeout",
          taskSessionID: task.taskSessionID,
        },
      }
    }

    return formatResult(result)
  },
})

function formatStatusOutput(task: BackgroundTask.Info): string {
  const lines = [`Status: ${task.status}`, `Started: ${new Date(task.startedAt).toISOString()}`]
  if (task.completedAt) {
    lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`)
  }
  lines.push(`Task Session: ${task.taskSessionID}`)
  return lines.join("\n")
}

function formatResult(task: BackgroundTask.Info) {
  const output = task.result?.output ?? task.result?.error ?? "No output"

  return {
    title: `Task "${task.description}" ${task.status}`,
    output,
    metadata: {
      taskId: task.id,
      status: task.status,
      taskSessionID: task.taskSessionID,
      ...(task.result?.metadata ?? {}),
    },
  }
}

async function waitForTaskCompletion(
  taskId: string,
  timeout: number,
  abort: AbortSignal,
): Promise<BackgroundTask.Info | undefined> {
  return new Promise((resolve) => {
    let resolved = false

    const cleanup = () => {
      if (resolved) return
      resolved = true
      unsub()
      clearTimeout(timer)
    }

    // Set up timeout
    const timer = setTimeout(() => {
      cleanup()
      resolve(undefined)
    }, timeout)

    // Listen for abort signal
    const abortHandler = () => {
      cleanup()
      resolve(undefined)
    }
    abort.addEventListener("abort", abortHandler, { once: true })

    // Subscribe to completion events
    const unsub = Bus.subscribe(BackgroundTask.Event.Completed, (event) => {
      if (event.properties.task.id !== taskId) return
      cleanup()
      abort.removeEventListener("abort", abortHandler)
      // Get the full task info (with abort controller) from the store
      const fullTask = BackgroundTask.get(taskId)
      resolve(fullTask)
    })

    // Check if already completed (race condition protection)
    const current = BackgroundTask.get(taskId)
    if (current && (current.status === "completed" || current.status === "error" || current.status === "cancelled")) {
      cleanup()
      abort.removeEventListener("abort", abortHandler)
      resolve(current)
    }
  })
}
