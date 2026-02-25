import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { ReadCoordinator } from "@/tool/read"
import { Flag } from "@/flag/flag"
import { handleLargeToolOutput, LARGE_TOOL_OUTPUT_THRESHOLD } from "./large-tool-output"
import { Token } from "@/util/token"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const DOOM_LOOP_HISTORY_SIZE = 10
  const log = Log.create({ service: "session.processor" })

  /**
   * Custom error for streaming chunk timeout.
   * Thrown when no data is received within the timeout period.
   */
  export class StreamChunkTimeoutError extends Error {
    public readonly timeoutMs: number

    constructor(timeoutMs: number) {
      super(`Streaming timeout: no data received for ${Math.round(timeoutMs / 1000)} seconds`)
      this.name = "StreamChunkTimeoutError"
      this.timeoutMs = timeoutMs
    }
  }

  /**
   * Mutable timeout config for withChunkTimeout.
   * The streaming loop updates `ms` to extend the timeout during tool execution
   * (e.g. when waiting for user input via AskUserQuestion).
   */
  interface ChunkTimeoutConfig {
    ms: number
  }

  /**
   * Wraps an async iterator with a per-chunk timeout.
   * The timeout resets after each successful chunk.
   * This prevents the for-await loop from blocking forever if the network dies mid-stream.
   *
   * The timeout duration is read from `timeout.ms` at the start of each wait,
   * allowing the consumer to adjust it dynamically (e.g. extend during tool execution).
   */
  async function* withChunkTimeout<T>(
    iterator: AsyncIterable<T>,
    timeout: ChunkTimeoutConfig,
    signal: AbortSignal,
  ): AsyncGenerator<T> {
    const asyncIterator = iterator[Symbol.asyncIterator]()

    while (true) {
      // Check abort signal before waiting for next chunk
      signal.throwIfAborted()

      // timeout.ms === 0 means timeout is suspended (e.g. during tool execution
      // waiting for user input). Just await the next chunk with no deadline.
      if (timeout.ms === 0) {
        const result = await asyncIterator.next()
        if (result.done) return
        yield result.value
        continue
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let abortHandler: (() => void) | undefined
      let timedOut = false

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            reject(new StreamChunkTimeoutError(timeout.ms))
          }, timeout.ms)
          abortHandler = () => clearTimeout(timeoutId)
          signal.addEventListener("abort", abortHandler, { once: true })
        })

        const result = await Promise.race([asyncIterator.next(), timeoutPromise])

        if (result.done) return
        yield result.value
      } finally {
        // Clean up timeout and abort listener after each chunk
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        if (abortHandler !== undefined) signal.removeEventListener("abort", abortHandler)
        // Close the underlying stream on timeout
        if (timedOut) await asyncIterator.return?.()
      }
    }
  }

  /**
   * Tracks recent tool calls across messages within a session.
   * Used to detect doom loops that span multiple assistant turns.
   */
  interface ToolCallEntry {
    tool: string
    input: string
  }

  interface SessionToolHistory {
    calls: ToolCallEntry[]
    cleanupTimer?: ReturnType<typeof setTimeout>
  }

  const sessionToolHistory = new Map<string, SessionToolHistory>()

  /**
   * Tracks consecutive empty responses per session.
   * Used to escalate when the model repeatedly produces only reasoning with no visible output.
   */
  const sessionEmptyResponseCount = new Map<string, number>()

  function getOrCreateToolHistory(sessionID: string): SessionToolHistory {
    let history = sessionToolHistory.get(sessionID)
    if (!history) {
      history = { calls: [] }
      sessionToolHistory.set(sessionID, history)
    }
    // Reset cleanup timer on activity (30 min timeout)
    if (history.cleanupTimer) clearTimeout(history.cleanupTimer)
    history.cleanupTimer = setTimeout(() => cleanupToolHistory(sessionID), 30 * 60 * 1000)
    return history
  }

  function cleanupToolHistory(sessionID: string) {
    const history = sessionToolHistory.get(sessionID)
    if (history?.cleanupTimer) clearTimeout(history.cleanupTimer)
    sessionToolHistory.delete(sessionID)
  }

  function addToolCall(sessionID: string, tool: string, input: unknown): void {
    const history = getOrCreateToolHistory(sessionID)
    const inputStr = JSON.stringify(input)
    history.calls.push({ tool, input: inputStr })
    // Keep only the last DOOM_LOOP_HISTORY_SIZE calls
    if (history.calls.length > DOOM_LOOP_HISTORY_SIZE) {
      history.calls.shift()
    }
  }

  function checkDoomLoop(sessionID: string, tool: string, input: unknown): boolean {
    const history = sessionToolHistory.get(sessionID)
    if (!history || history.calls.length < DOOM_LOOP_THRESHOLD - 1) {
      return false
    }
    const inputStr = JSON.stringify(input)
    // Check if the last (DOOM_LOOP_THRESHOLD - 1) calls plus this one are all identical
    const recentCalls = history.calls.slice(-(DOOM_LOOP_THRESHOLD - 1))
    return recentCalls.every((call) => call.tool === tool && call.input === inputStr)
  }

  /**
   * Clear tool history, error history, and empty response counts for a session.
   * Called when a session is destroyed or needs cleanup.
   */
  export function clearToolHistory(sessionID: string): void {
    cleanupToolHistory(sessionID)
    sessionEmptyResponseCount.delete(sessionID)
    resetErrorHistory(sessionID)
  }

  /**
   * Tracks consecutive identical errors per session.
   * Used to detect error loops where the same error repeats (e.g. JSON parse errors
   * caused by corrupt data in session history that re-trigger on every retry).
   */
  const MAX_CONSECUTIVE_ERRORS = 3

  interface SessionErrorHistory {
    lastError: string
    count: number
    cleanupTimer?: ReturnType<typeof setTimeout>
  }

  const sessionErrorHistory = new Map<string, SessionErrorHistory>()

  function trackError(sessionID: string, errorMessage: string): boolean {
    const existing = sessionErrorHistory.get(sessionID)
    if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer)

    const cleanupTimer = setTimeout(() => sessionErrorHistory.delete(sessionID), 30 * 60 * 1000)

    if (existing && existing.lastError === errorMessage) {
      existing.count++
      existing.cleanupTimer = cleanupTimer
      return existing.count >= MAX_CONSECUTIVE_ERRORS
    }

    sessionErrorHistory.set(sessionID, {
      lastError: errorMessage,
      count: 1,
      cleanupTimer,
    })
    return false
  }

  function resetErrorHistory(sessionID: string): void {
    const existing = sessionErrorHistory.get(sessionID)
    if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer)
    sessionErrorHistory.delete(sessionID)
  }

  /**
   * Drop the last assistant turn (assistant message + following tool-result messages)
   * from the messages array in-place. Used for error loop recovery when the last
   * assistant response contains data the API cannot process (e.g. malformed tool
   * call arguments that crash the upstream chat template).
   *
   * @returns Number of messages dropped, or 0 if no assistant turn was found.
   */
  function dropLastAssistantTurn(messages: import("ai").ModelMessage[]): number {
    // Find the last assistant message
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistantIdx = i
        break
      }
    }
    if (lastAssistantIdx < 0) return 0

    // Count messages to drop: the assistant message + any immediately following
    // "tool" role messages (tool results belonging to this turn)
    let dropEnd = lastAssistantIdx + 1
    while (dropEnd < messages.length && messages[dropEnd].role === "tool") {
      dropEnd++
    }

    // Safety: don't drop everything — keep at least one user message
    if (lastAssistantIdx === 0) return 0

    const dropped = dropEnd - lastAssistantIdx
    messages.splice(lastAssistantIdx, dropped)
    return dropped
  }

  function summarizeStreamEvent(value: any): Record<string, unknown> {
    if (!value || typeof value !== "object") return { type: "unknown" }
    const type = typeof value.type === "string" ? value.type : "unknown"
    switch (type) {
      case "reasoning-start":
      case "reasoning-end":
        return { type, reasoningID: value.id }
      case "reasoning-delta":
        return { type, reasoningID: value.id, deltaChars: value.text?.length ?? 0 }
      case "tool-input-start":
        return { type, toolCallID: value.id, tool: value.toolName }
      case "tool-input-delta":
        return { type, toolCallID: value.id, deltaChars: value.inputTextDelta?.length ?? value.text?.length ?? 0 }
      case "tool-input-end":
        return { type, toolCallID: value.id }
      case "tool-call":
        return { type, toolCallID: value.toolCallId, tool: value.toolName }
      case "tool-result":
        return {
          type,
          toolCallID: value.toolCallId,
          hasOutput: !!value.output,
          hasResult: !!value.result,
        }
      case "tool-error":
        return {
          type,
          toolCallID: value.toolCallId,
          error: value.error instanceof Error ? value.error.message : String(value.error ?? ""),
        }
      case "text-delta":
        return { type, deltaChars: value.text?.length ?? 0 }
      case "finish":
        return { type, finishReason: value.finishReason }
      case "error":
        return { type, error: value.error instanceof Error ? value.error.message : String(value.error ?? "") }
      default:
        return { type }
    }
  }

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        log.trace("process.start", {
          sessionID: input.sessionID,
          messageID: input.assistantMessage.id,
          modelID: input.model.id,
          providerID: input.model.providerID,
        })
        needsCompaction = false
        let recoveryAttempted = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          log.trace("process.loop", {
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            attempt: attempt + 1,
          })
          let stream: LLM.StreamOutput | undefined
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const llmStreamStart = performance.now()
            stream = await LLM.stream(streamInput)
            log.trace("process.timing.llmStreamCreated", { sessionID: input.sessionID, ms: Math.round(performance.now() - llmStreamStart) })

            // Use dedicated chunk timeout from Flag, separate from fetch timeout
            // Set to 0 to disable chunk timeout entirely
            // Default to 5 minutes between chunks - if no data received for 5min, consider stream dead
            const chunkTimeoutMs = Flag.VOLTCODE_CHUNK_TIMEOUT_MS ?? 5 * 60 * 1000
            log.trace("stream.timeout.config", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              chunkTimeoutMs,
            })
            // Mutable config: streaming loop extends timeout during tool execution
            // (tools may block on user input, e.g. AskUserQuestion)
            const chunkTimeout: ChunkTimeoutConfig = { ms: chunkTimeoutMs }
            const timedStream =
              chunkTimeoutMs === 0 ? stream.fullStream : withChunkTimeout(stream.fullStream, chunkTimeout, input.abort)

            let firstChunk = true
            for await (const value of timedStream) {
              if (firstChunk) {
                log.trace("process.timing.ttft", { sessionID: input.sessionID, ms: Math.round(performance.now() - llmStreamStart) })
                firstChunk = false
              }
              input.abort.throwIfAborted()
              log.trace("stream.event", {
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                ...summarizeStreamEvent(value),
              })
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    // Check for doom loop across session history (multiple messages)
                    if (checkDoomLoop(input.sessionID, value.toolName, value.input)) {
                      log.warn("doom loop pattern detected", {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        tool: value.toolName,
                      })
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }

                    // Add this tool call to session history for future doom loop detection
                    addToolCall(input.sessionID, value.toolName, value.input)
                    log.trace("tool.history.recorded", {
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      tool: value.toolName,
                      toolCallID: value.toolCallId,
                    })
                  }
                  // Tool execution may block indefinitely on user input (AskUserQuestion,
                  // permissions). Suspend chunk timeout until tool completes.
                  if (chunkTimeoutMs > 0) {
                    chunkTimeout.ms = 0
                    log.trace("stream.timeout.suspended", {
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      toolCallID: value.toolCallId,
                      tool: value.toolName,
                    })
                  }
                  break
                }
                case "tool-result": {
                  // Tool execution done - restore normal chunk timeout
                  if (chunkTimeoutMs > 0) {
                    chunkTimeout.ms = chunkTimeoutMs
                    log.trace("stream.timeout.restored", {
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      toolCallID: value.toolCallId,
                      reason: "tool-result",
                    })
                  }
                  const match = toolcalls[value.toolCallId]
                  // AI SDK v5 uses 'result' property, but we map it to 'output' via tool definition
                  const toolResult = (value as any).output ?? (value as any).result
                  log.info("tool-result received", {
                    toolCallId: value.toolCallId,
                    toolName: match?.tool,
                    hasMatch: !!match,
                    matchStatus: match?.state.status,
                    hasOutput: !!(value as any).output,
                    hasResult: !!(value as any).result,
                    outputLength: toolResult?.output?.length ?? 0,
                    hasMetadata: !!toolResult?.metadata,
                    metadataKeys: toolResult?.metadata ? Object.keys(toolResult.metadata) : [],
                    hasLcmMetadata: !!toolResult?.metadata?.lcm,
                  })
                  if (match && match.state.status === "running") {
                    const attachments = toolResult.attachments?.map(
                      (attachment: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID">) => ({
                        ...attachment,
                        id: Identifier.ascending("part"),
                        messageID: match.messageID,
                        sessionID: match.sessionID,
                      }),
                    )
                    // Handle large tool outputs by storing in LCM
                    let finalOutput = toolResult.output
                    let lcmMetadata = toolResult.metadata?.lcm

                    if (typeof toolResult.output === "string") {
                      const outputTokens = Token.estimate(toolResult.output)

                      // Skip LCM re-storage if the output is already from LCM (e.g. lcm_read)
                      if (outputTokens > LARGE_TOOL_OUTPUT_THRESHOLD && !lcmMetadata?.storedInLcm) {
                        // Large output: store in LCM and replace with reference
                        const lcmResult = await handleLargeToolOutput({
                          sessionID: input.sessionID,
                          toolName: match.tool,
                          toolCallId: value.toolCallId,
                          output: toolResult.output,
                          model: input.model,
                        })
                        finalOutput = lcmResult.output
                        if (lcmResult.storedInLcm && lcmResult.fileId) {
                          lcmMetadata = {
                            ...lcmMetadata,
                            storedInLcm: true,
                            fileId: lcmResult.fileId,
                            originalTokenCount: lcmResult.tokenCount,
                          }
                        }
                        log.info("large tool output handled", {
                          toolCallId: value.toolCallId,
                          toolName: match.tool,
                          originalTokens: outputTokens,
                          storedInLcm: lcmResult.storedInLcm,
                          fileId: lcmResult.fileId,
                        })
                      }
                    }

                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input,
                        output: finalOutput,
                        metadata: lcmMetadata ? { ...toolResult.metadata, lcm: lcmMetadata } : toolResult.metadata,
                        title: toolResult.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                    log.info("tool-result processed", {
                      toolCallId: value.toolCallId,
                      toolName: match.tool,
                    })
                  }
                  break
                }

                case "tool-error": {
                  // Tool execution done (with error) - restore normal chunk timeout
                  if (chunkTimeoutMs > 0) {
                    chunkTimeout.ms = chunkTimeoutMs
                    log.trace("stream.timeout.restored", {
                      sessionID: input.sessionID,
                      messageID: input.assistantMessage.id,
                      toolCallID: value.toolCallId,
                      reason: "tool-error",
                    })
                  }
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError ||
                      value.error instanceof Question.TimeoutError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step": {
                  // In ai@6.x, finish-step is a bare marker with no data.
                  // usage/finishReason are promises on StreamTextResult that only
                  // resolve after the stream is fully consumed — awaiting them here
                  // would deadlock. Use placeholders now; the "finish" event and
                  // post-stream resolution will update with real values.
                  const stepFinishReason = "stop"
                  const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
                  log.info("finish-step", {
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.id,
                  })
                  input.assistantMessage.finish = stepFinishReason
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: stepFinishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: zeroTokens,
                    cost: 0,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  }).catch((e) => log.warn("session summary failed", { error: e }))
                  if (await SessionCompaction.isOverflow({ tokens: zeroTokens, model: input.model })) {
                    needsCompaction = true
                  }
                  // Reset parallel read coordinator after step completes
                  // This allows fresh token budgets for the next model turn
                  ReadCoordinator.reset(input.sessionID)
                  break
                }

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish": {
                  // In ai@6.x, finishReason is on the "finish" event
                  const finishReason = (value as any).finishReason ?? "stop"
                  input.assistantMessage.finish = finishReason
                  break
                }

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }

            // Stream is fully consumed — now safe to resolve usage/finishReason
            // promises (they would deadlock if awaited inside the stream loop)
            if (stream) {
              const usageRaw = await Promise.resolve(stream.usage).catch(() => undefined)
              const providerMeta = await Promise.resolve(stream.providerMetadata).catch(() => undefined)
              if (usageRaw) {
                const usage = Session.getUsage({
                  model: input.model,
                  usage: usageRaw,
                  metadata: providerMeta,
                })
                input.assistantMessage.cost += usage.cost
                input.assistantMessage.tokens = usage.tokens
                await Session.updateMessage(input.assistantMessage)
              }
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })

            // On timeout, finalize any in-flight tool calls with error status
            // so they don't remain as "running" in session history (which causes
            // corrupt data when the session retries or continues)
            if (e instanceof StreamChunkTimeoutError) {
              for (const [callId, toolPart] of Object.entries(toolcalls)) {
                if (toolPart.state.status === "running") {
                  await Session.updatePart({
                    ...toolPart,
                    state: {
                      status: "error",
                      input: toolPart.state.input,
                      error: "Tool execution was interrupted by a streaming timeout",
                      time: {
                        start: toolPart.state.time.start,
                        end: Date.now(),
                      },
                    },
                  })
                  delete toolcalls[callId]
                }
              }
            }

            // Detect "prompt is too long" errors — trigger compaction and retry
            const errMsg = e?.message ?? e?.responseBody ?? ""
            if (typeof errMsg === "string" && errMsg.includes("prompt is too long")) {
              const promptTooLongKey = `PromptTooLong:${errMsg}`
              if (trackError(input.sessionID, promptTooLongKey)) {
                log.error("prompt too long loop detected — compaction not reducing context", {
                  sessionID: input.sessionID,
                  error: errMsg,
                })
                // Fall through to normal error handling instead of looping
              } else {
                log.warn("prompt too long, triggering compaction", {
                  sessionID: input.sessionID,
                  error: errMsg,
                })
                needsCompaction = true
                log.trace("process.compaction.requested", {
                  sessionID: input.sessionID,
                  messageID: input.assistantMessage.id,
                  reason: "prompt-too-long",
                })
                break
              }
            }

            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)

            // Only apply error loop detection to non-retryable errors.
            // Retryable errors (overloaded, rate-limited) are transient and should
            // keep retrying with exponential backoff until they resolve or the user cancels.
            // The error loop detector is for unrecoverable loops (e.g. corrupt session data
            // causing repeated JSON parse failures).
            const errorKey = `${error.name}:${error.data?.message ?? e.message ?? ""}`
            const isErrorLoop = retry === undefined && trackError(input.sessionID, errorKey)

            if (isErrorLoop) {
              log.error("error loop detected - same error repeated too many times", {
                sessionID: input.sessionID,
                errorKey,
                count: MAX_CONSECUTIVE_ERRORS,
              })

              // Attempt recovery before giving up: drop the last assistant turn from
              // the message context. This removes potentially corrupt tool call data
              // (e.g. malformed JSON arguments that the upstream API cannot process)
              // and retries with the shortened context.
              if (!recoveryAttempted) {
                const originalLen = streamInput.messages.length
                const dropped = dropLastAssistantTurn(streamInput.messages)
                if (dropped > 0) {
                  recoveryAttempted = true
                  log.info("error loop recovery: dropped last assistant turn from context", {
                    sessionID: input.sessionID,
                    droppedMessages: dropped,
                    originalCount: originalLen,
                    remainingCount: streamInput.messages.length,
                  })
                  continue
                }
              }

              // Recovery already attempted or no messages to drop — give up with hint.
              const hint = recoveryAttempted
                ? `\n\nRecovery was attempted by dropping recent context, but the error persists. The session history likely contains data the API cannot process. Press Ctrl+N to start a new session.`
                : `\n\nThis error has repeated multiple times — the session history likely contains data the API cannot process. Press Ctrl+N to start a new session.`
              if (MessageV2.APIError.isInstance(error)) {
                error.data.message = `${error.data.message}${hint}`
              } else if (error.data && typeof error.data.message === "string") {
                error.data.message = `${error.data.message}${hint}`
              }
            }
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              log.trace("process.retry.scheduled", {
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                attempt,
                delayMs: delay,
                reason: retry,
              })
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            log.trace("process.error.finalized", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              errorName: error.name,
            })
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          } finally {
            // Cleanup handled by stream completion
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          let hasToolParts = false
          let hasTextContent = false
          let hasReasoningParts = false
          const toolStatuses: string[] = []
          for (const part of p) {
            if (part.type === "tool") {
              hasToolParts = true
              if (part.state.status !== "completed" && part.state.status !== "error") {
                // Tool was still running/pending when stream ended - mark as error
                await Session.updatePart({
                  ...part,
                  state: {
                    ...part.state,
                    status: "error",
                    error: "Tool execution aborted",
                    time: {
                      start: Date.now(),
                      end: Date.now(),
                    },
                  },
                })
                toolStatuses.push(`${part.tool}:aborted`)
              } else {
                toolStatuses.push(`${part.tool}:${part.state.status}`)
              }
            }
            // Check for visible text content (not ignored/internal)
            if (part.type === "text" && part.text.trim() && !part.ignored) {
              hasTextContent = true
            }
            if (part.type === "reasoning" && part.text.trim()) {
              hasReasoningParts = true
            }
          }

          // Detect empty responses - model returned no visible output.
          // Two sub-cases: reasoning-only (recoverable) vs truly empty (error).
          let reasoningOnly = false
          if (!hasToolParts && !hasTextContent && !input.assistantMessage.error) {
            const emptyCount = (sessionEmptyResponseCount.get(input.sessionID) ?? 0) + 1
            sessionEmptyResponseCount.set(input.sessionID, emptyCount)

            if (hasReasoningParts && emptyCount <= 3) {
              // Reasoning-only response: model produced thinking but no visible output.
              // Preserve reasoning in context and let the loop continue with a nudge.
              log.info("reasoning-only response detected", {
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                modelID: input.model.id,
                providerID: input.model.providerID,
                partsCount: p.length,
                consecutiveEmptyCount: emptyCount,
              })
              reasoningOnly = true
            } else {
              // Truly empty or exceeded reasoning-only cap
              log.error("empty response - model produced no visible output", {
                sessionID: input.sessionID,
                messageID: input.assistantMessage.id,
                modelID: input.model.id,
                providerID: input.model.providerID,
                partsCount: p.length,
                partTypes: p.map((part) => part.type),
                consecutiveEmptyCount: emptyCount,
                hasReasoningParts,
              })
              if (emptyCount >= 2) {
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  messageID: input.assistantMessage.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: "[System: Your previous response contained only reasoning with no visible output. Please provide a visible text response or tool call.]",
                  synthetic: true,
                })
              }
              input.assistantMessage.error = MessageV2.fromError(
                new Error("Model produced no visible response. This may be a temporary issue - please try again."),
                { providerID: input.model.providerID },
              )
            }
          } else if (hasToolParts || hasTextContent) {
            // Successful visible output - reset empty response counter
            sessionEmptyResponseCount.delete(input.sessionID)
          }

          // CRITICAL FIX: Ensure finish reason is set even if finish-step event was missing.
          // Without this, the main loop continues indefinitely creating new assistant messages.
          // If ANY tools were called (completed, errored, or aborted), set to "tool-calls"
          // so the model gets a chance to see the results/errors and react appropriately.
          // Only default to "stop" when no tools were invoked at all.
          if (!input.assistantMessage.finish) {
            const inferredFinish = hasToolParts ? "tool-calls" : "stop"
            log.warn("finish-step event missing, inferring finish reason", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              modelID: input.model.id,
              providerID: input.model.providerID,
              inferredFinish,
              hasToolParts,
              toolStatuses,
            })
            input.assistantMessage.finish = inferredFinish
          }

          // Override finish to "tool-calls" for any response containing tool calls.
          // This ensures the loop continues to process tool results even if
          // the provider incorrectly reported "stop". Any response with tool calls
          // must continue so the model sees the results — even if the model also
          // emitted text (e.g. reasoning models that produce <reasoning> text parts
          // alongside tool calls).
          if (hasToolParts && input.assistantMessage.finish !== "tool-calls") {
            log.info("overriding finish to tool-calls for response with tool calls", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              originalFinish: input.assistantMessage.finish,
            })
            input.assistantMessage.finish = "tool-calls"
          }

          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) {
            log.trace("process.complete", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              result: "compact",
            })
            return "compact"
          }
          if (blocked) {
            log.trace("process.complete", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              result: "stop",
              reason: "blocked",
            })
            return "stop"
          }
          if (input.assistantMessage.error) {
            log.trace("process.complete", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              result: "stop",
              reason: "error",
            })
            return "stop"
          }
          // Successful processing - reset error history so future errors
          // start fresh (prevents stale error counts from previous failures)
          resetErrorHistory(input.sessionID)
          attempt = 0
          if (reasoningOnly) {
            log.trace("process.complete", {
              sessionID: input.sessionID,
              messageID: input.assistantMessage.id,
              result: "reasoning-only",
            })
            return "reasoning-only"
          }
          log.trace("process.complete", {
            sessionID: input.sessionID,
            messageID: input.assistantMessage.id,
            result: "continue",
          })
          return "continue"
        }
      },
    }
    return result
  }
}
