import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  // Default timeout for questions - 30 minutes
  export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
        timeoutId?: ReturnType<typeof setTimeout>
        resolved?: boolean // Prevents race between timeout and reply
      }
    > = {}

    return {
      pending,
    }
  })

  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
    timeoutMs?: number
  }): Promise<Answer[]> {
    const s = await state()
    const id = Identifier.ascending("question")
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    log.info("asking", { id, questions: input.questions.length, timeoutMs: timeout })

    return new Promise<Answer[]>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }

      // Set up timeout to prevent indefinite blocking
      const timeoutId = setTimeout(() => {
        const pending = s.pending[id]
        if (!pending || pending.resolved) return // Already resolved - race condition avoided
        pending.resolved = true
        delete s.pending[id]
        log.info("question request timed out", { id, sessionID: input.sessionID, timeoutMs: timeout })
        Bus.publish(Event.Rejected, {
          sessionID: info.sessionID,
          requestID: info.id,
        })
        reject(new TimeoutError(timeout))
      }, timeout)

      s.pending[id] = {
        info,
        resolve,
        reject,
        timeoutId,
        resolved: false,
      }
      Bus.publish(Event.Asked, info)
    })
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing || existing.resolved) {
      log.warn("reply for unknown or already resolved request", { requestID: input.requestID })
      return
    }
    existing.resolved = true // Mark resolved before clearing timeout to avoid race
    if (existing.timeoutId) clearTimeout(existing.timeoutId)
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    existing.resolve(input.answers)
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing || existing.resolved) {
      log.warn("reject for unknown or already resolved request", { requestID })
      return
    }
    existing.resolved = true // Mark resolved before clearing timeout to avoid race
    if (existing.timeoutId) clearTimeout(existing.timeoutId)
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    existing.reject(new RejectedError())
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  export class TimeoutError extends Error {
    public readonly timeoutMs: number
    constructor(timeoutMs: number) {
      super(`Question timed out after ${Math.round(timeoutMs / 1000)} seconds`)
      this.timeoutMs = timeoutMs
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
