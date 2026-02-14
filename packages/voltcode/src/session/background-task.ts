import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import z from "zod"

export namespace BackgroundTask {
  const log = Log.create({ service: "background-task" })

  export const Status = z.enum(["running", "backgrounded", "completed", "error", "cancelled"])
  export type Status = z.infer<typeof Status>

  export const Result = z.object({
    output: z.string().optional(),
    error: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  export type Result = z.infer<typeof Result>

  /**
   * Serializable schema for background task info (excludes AbortController).
   * Used for API responses and bus events.
   */
  export const InfoSchema = z
    .object({
      id: z.string(),
      sessionID: z.string(),
      taskSessionID: z.string(),
      toolPartID: z.string(),
      assistantMessageID: z.string(),
      description: z.string(),
      status: Status,
      startedAt: z.number(),
      completedAt: z.number().optional(),
      result: Result.optional(),
    })
    .meta({
      ref: "BackgroundTask",
    })
  export type InfoSchema = z.infer<typeof InfoSchema>

  /**
   * Full runtime type including AbortController (not serializable).
   */
  export interface Info extends InfoSchema {
    abort: AbortController
  }

  export const Event = {
    Created: BusEvent.define(
      "background_task.created",
      z.object({
        task: InfoSchema,
      }),
    ),
    Updated: BusEvent.define(
      "background_task.updated",
      z.object({
        task: InfoSchema,
      }),
    ),
    Completed: BusEvent.define(
      "background_task.completed",
      z.object({
        task: InfoSchema,
      }),
    ),
  }

  const state = Instance.state(() => {
    const tasks: Map<string, Info> = new Map()
    return tasks
  })

  function toSerializable(info: Info): InfoSchema {
    const { abort: _abort, ...rest } = info
    return rest
  }

  export interface CreateInput {
    sessionID: string
    taskSessionID: string
    toolPartID: string
    assistantMessageID: string
    description: string
    abort: AbortController
  }

  export function create(input: CreateInput): Info {
    const id = Identifier.ascending("task")
    const info: Info = {
      id,
      sessionID: input.sessionID,
      taskSessionID: input.taskSessionID,
      toolPartID: input.toolPartID,
      assistantMessageID: input.assistantMessageID,
      description: input.description,
      status: "running",
      startedAt: Date.now(),
      abort: input.abort,
    }
    state().set(id, info)
    log.info("created", { id, description: input.description })
    Bus.publish(Event.Created, { task: toSerializable(info) })
    return info
  }

  export function get(id: string): Info | undefined {
    return state().get(id)
  }

  export function getBySession(sessionID: string): Info[] {
    const result: Info[] = []
    for (const info of state().values()) {
      if (info.sessionID === sessionID) {
        result.push(info)
      }
    }
    return result
  }

  export function update(id: string, updater: (info: Info) => void): Info | undefined {
    const info = state().get(id)
    if (!info) {
      log.warn("update: task not found", { id })
      return undefined
    }
    updater(info)
    log.info("updated", { id, status: info.status })
    Bus.publish(Event.Updated, { task: toSerializable(info) })
    return info
  }

  export function complete(id: string, result: Result): Info | undefined {
    const info = state().get(id)
    if (!info) {
      log.warn("complete: task not found", { id })
      return undefined
    }
    info.status = "completed"
    info.completedAt = Date.now()
    info.result = result
    log.info("completed", { id, description: info.description })
    Bus.publish(Event.Completed, { task: toSerializable(info) })
    return info
  }

  export function error(id: string, err: Error): Info | undefined {
    const info = state().get(id)
    if (!info) {
      log.warn("error: task not found", { id })
      return undefined
    }
    info.status = "error"
    info.completedAt = Date.now()
    info.result = { error: err.message }
    log.info("error", { id, description: info.description, error: err.message })
    Bus.publish(Event.Completed, { task: toSerializable(info) })
    return info
  }

  export function cancel(id: string): Info | undefined {
    const info = state().get(id)
    if (!info) {
      log.warn("cancel: task not found", { id })
      return undefined
    }
    info.abort.abort()
    info.status = "cancelled"
    info.completedAt = Date.now()
    log.info("cancelled", { id, description: info.description })
    Bus.publish(Event.Completed, { task: toSerializable(info) })
    return info
  }

  /**
   * List all background tasks (across all sessions).
   */
  export function list(): Info[] {
    return Array.from(state().values())
  }

  /**
   * Remove a completed/cancelled/errored task from state.
   * Useful for cleanup after results have been consumed.
   */
  export function remove(id: string): boolean {
    return state().delete(id)
  }
}
