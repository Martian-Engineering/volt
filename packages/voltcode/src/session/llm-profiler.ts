import { createHash } from "node:crypto"
import { Identifier } from "@/id/id"

export namespace LLMProfiler {
  export type Source = "session.processor" | "session.summary" | "session.title" | "other"
  export type Status = "started" | "completed" | "failed"

  export type Usage = {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }

  export type PromptMetrics = {
    messageCount: number
    systemMessageCount: number
    systemChars: number
    messageChars: number
    serializedMessageChars: number
    systemPromptHash: string
    messageHistoryHash: string
    toolCount: number
    toolNames: string[]
    approxPromptTokens: number
  }

  export type Call = {
    callID: string
    sessionID: string
    modelID: string
    providerID: string
    source: Source
    small: boolean
    messageID?: string
    agent?: string
    startedAt: number
    finishedAt?: number
    streamCreatedAt?: number
    streamCreatedMs?: number
    firstChunkAt?: number
    firstChunkMs?: number
    totalMs?: number
    usage?: Usage
    status: Status
    error?: string
    finishReason?: string
    context: PromptMetrics
    statusCode?: string
  }

  type MutableCall = Omit<Call, "startedAt" | "context"> & {
    startedAt: number
    context: PromptMetrics
  }

  type StartInput = {
    sessionID: string
    modelID: string
    providerID: string
    source: Source
    small: boolean
    context: PromptMetrics
    messageID?: string
    agent?: string
  }

  const enabledEnv = process.env["VOLTCODE_LLM_PROFILE"]?.toLowerCase()
  let enabled = enabledEnv === "1" || enabledEnv === "true" || enabledEnv === "yes"

  const activeCalls = new Map<string, MutableCall>()
  const completedCalls: MutableCall[] = []

  const now = () => performance.now()

  export function setEnabled(next: boolean) {
    enabled = next
  }

  export function clear() {
    activeCalls.clear()
    completedCalls.length = 0
  }

  export function isEnabled() {
    return enabled
  }

  function normalizeForHash(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "function") return undefined
    if (Array.isArray(value)) return value.map((entry) => normalizeForHash(entry))
    const source = value as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const next = normalizeForHash(source[key])
      if (typeof next !== "undefined") normalized[key] = next
    }
    return normalized
  }

  function stableHashString(value: unknown): string {
    return JSON.stringify(normalizeForHash(value))
  }

  export function start(input: StartInput): string {
    if (!enabled) return ""
    const callID = Identifier.ascending("part")
    const call: MutableCall = {
      ...input,
      callID,
      startedAt: now(),
      status: "started",
      source: input.source,
      small: !!input.small,
      streamCreatedMs: undefined,
      firstChunkMs: undefined,
      totalMs: undefined,
      usage: undefined,
      statusCode: undefined,
      context: input.context,
    }
    activeCalls.set(callID, call)
    return callID
  }

  export function ensure(callID: string, input: StartInput): string {
    if (!enabled) return ""
    if (callID) return callID
    return start(input)
  }

  function get(callID: string) {
    return activeCalls.get(callID)
  }

  function finalize(callID: string, status: Status) {
    const call = activeCalls.get(callID)
    if (!call) return
    activeCalls.delete(callID)
    call.status = status
    call.finishedAt = now()
    call.totalMs = Math.max(0, Math.round(call.finishedAt - call.startedAt))
    completedCalls.push(call)
  }

  export function complete(callID: string, input: {
    usage?: Usage
    statusCode?: string
    finishReason?: string
    context?: Partial<PromptMetrics>
  }) {
    if (!enabled || !callID) return
    const call = get(callID)
    if (!call) return
    if (input.context) {
      call.context = {
        ...call.context,
        ...input.context,
      }
    }
    if (input.usage) call.usage = input.usage
    if (input.statusCode) call.statusCode = input.statusCode
    if (input.finishReason) call.finishReason = input.finishReason
    finalize(callID, "completed")
  }

  export function fail(callID: string, error: unknown) {
    if (!enabled || !callID) return
    const call = get(callID)
    if (!call) return
    if (error !== undefined) {
      call.error = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
    }
    finalize(callID, "failed")
  }

  export function streamCreated(callID: string, ms: number) {
    if (!enabled || !callID) return
    const call = get(callID)
    if (!call) return
    call.streamCreatedAt = now()
    call.streamCreatedMs = ms
  }

  export function firstChunk(callID: string, ms: number) {
    if (!enabled || !callID) return
    const call = get(callID)
    if (!call) return
    call.firstChunkAt = now()
    call.firstChunkMs = ms
  }

  export function snapshot() {
    return {
      enabled,
      calls: [...Array.from(activeCalls.values()), ...completedCalls].sort((a, b) => a.startedAt - b.startedAt),
      activeCount: activeCalls.size,
      completedCount: completedCalls.length,
    }
  }

  export function buildPromptMetrics(input: {
    system: string[]
    messages: Array<{ content: string | unknown[] }>
    tools: Record<string, unknown>
    small: boolean
  }): PromptMetrics {
    const systemText = input.system.join("\n")
    const systemPromptHash = createHash("sha256").update(systemText).digest("hex")
    const messageHistoryHash = createHash("sha256")
      .update(stableHashString({ system: input.system, messages: input.messages }))
      .digest("hex")
    const messageText = input.messages
      .map((message) => {
        const content = Array.isArray(message.content)
          ? message.content
              .map((part: any) => {
                if (part == null) return ""
                if (typeof part.text === "string") return part.text
                if (typeof part.content === "string") return part.content
                return JSON.stringify(part)
              })
              .join("")
          : typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? "")
        return content
      })
      .join("\n")

    const serializedMessageChars = JSON.stringify(input.messages).length
    const messageChars = input.messages.reduce((sum, message) => {
      const normalized = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part: any) => {
                if (part == null) return ""
                if (typeof part.text === "string") return part.text
                if (typeof part.content === "string") return part.content
                return JSON.stringify(part)
              })
              .join("")
          : JSON.stringify(message.content ?? "")
      return sum + normalized.length
    }, 0)

    const contextChars = messageText.length + systemText.length
    return {
      systemMessageCount: input.system.length,
      systemChars: systemText.length,
      messageCount: input.messages.length,
      messageChars,
      serializedMessageChars,
      systemPromptHash,
      messageHistoryHash,
      toolCount: Object.keys(input.tools).length,
      toolNames: Object.keys(input.tools),
      approxPromptTokens: Math.max(1, Math.round(contextChars / 4)),
    }
  }
}
