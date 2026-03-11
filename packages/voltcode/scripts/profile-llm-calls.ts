import { Session } from "../src/session"
import { SessionPrompt } from "../src/session/prompt"
import { Provider } from "../src/provider/provider"
import { bootstrap } from "../src/cli/bootstrap"
import { LLMProfiler } from "../src/session/llm-profiler"
import { Identifier } from "../src/id/id"
import { promises as fs } from "fs"
import { Log } from "../src/util/log"

const MODEL = {
  providerID: "anthropic",
  modelID: "claude-opus-4-6",
}

type TestCase = {
  name: string
  depth: number
  breadth: number
}

type RunResult = {
  name: string
  totalDurationMs: number
  sessionID: string
  sessions: string[]
  calls: ReturnType<typeof LLMProfiler.snapshot>["calls"]
}

const CASES: TestCase[] = [
  { name: "baseline-no-subtask", depth: 0, breadth: 0 },
  { name: "single-subtask", depth: 1, breadth: 1 },
  { name: "tree-depth-2-breadth-2", depth: 2, breadth: 2 },
]

function toArg(name: string, fallback: string): string {
  const index = process.argv.findIndex((item) => item === `--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

async function readModel() {
  return Provider.getModel(MODEL.providerID, MODEL.modelID)
}

function buildSubtaskPrompt(parts: { sessionID: string; depth: number; index: number }) {
  return [
    {
      type: "subtask",
      agent: "general",
      description: `tree-${parts.depth}-node-${parts.index} for ${parts.sessionID}`,
      prompt: "Perform this leaf task with one short sentence and stop.",
      model: MODEL,
    },
  ] as const
}

function buildLeafPrompt() {
  return [{ type: "text", text: "Reply with a short acknowledgement and stop." }]
}

async function collectChildren(
  beforeMessageIDs: Set<string>,
  sessionID: string,
): Promise<string[]> {
  const messages = await Session.messages({ sessionID })
  const newMessages = messages.filter((message) => !beforeMessageIDs.has(message.info.id))
  const childSessionIDs = new Set<string>()

  for (const message of newMessages) {
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "task") continue
      const state = part.state as { metadata?: { sessionId?: string }; output?: string }
      const metaSession = state.metadata?.sessionId
      const outputSession = typeof part.state === "object" && typeof state.output === "string" ? state.output : undefined
      const fromMetadata = metaSession && childSessionIDs.has(metaSession) ? undefined : metaSession
      const fromOutput = outputSession ? outputSession.match(/session_id:\s*([A-Za-z0-9_-]+)/i)?.[1] : undefined
      const child = fromMetadata ?? fromOutput
      if (child) childSessionIDs.add(child)
        }
      }

  return [...childSessionIDs]
}

async function executeSubtaskTree(input: {
  sessionID: string
  depthRemaining: number
  path: string
  breadth: number
  model: Awaited<ReturnType<typeof readModel>>
  sessions: Set<string>
}) {
  input.sessions.add(input.sessionID)

  const parts =
    input.depthRemaining > 0
      ? Array.from({ length: input.breadth }, (_, index) =>
          buildSubtaskPrompt({
            sessionID: input.sessionID,
            depth: input.depthRemaining,
            index: index + 1,
          }),
        ).flat()
      : buildLeafPrompt()

  const before = await Session.messages({ sessionID: input.sessionID })
  const beforeIDs = new Set(before.map((msg) => msg.info.id))

  await SessionPrompt.prompt({
    sessionID: input.sessionID,
    model: {
      providerID: input.model.providerID,
      modelID: input.model.id,
    },
    agent: "general",
    parts,
  })

  if (input.depthRemaining === 0) return

  const childSessions = await collectChildren(beforeIDs, input.sessionID)
  for (let i = 0; i < childSessions.length; i++) {
    await executeSubtaskTree({
      sessionID: childSessions[i],
      depthRemaining: input.depthRemaining - 1,
      path: `${input.path}.${i + 1}`,
      breadth: input.breadth,
      model: input.model,
      sessions: input.sessions,
    })
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index] ?? 0
}

function hashPrefix(hash: string): string {
  return hash.slice(0, 10)
}

function hashReuseStats(values: string[]) {
  const seen = new Set<string>()
  let reused = 0
  for (const value of values) {
    if (seen.has(value)) {
      reused += 1
    } else {
      seen.add(value)
    }
  }
  return { uniqueCount: seen.size, reusedCount: reused }
}

async function summarizeCase(result: RunResult) {
  const allCalls = result.calls
  const completed = allCalls.filter((call) => call.status === "completed")
  const failed = allCalls.filter((call) => call.status === "failed")
  const active = allCalls.filter((call) => call.status === "started")

  const sessionDepth = new Map<string, number>()
  const sessionParent = new Map<string, string | undefined>()
  for (const id of result.sessions) {
    if (sessionDepth.has(id)) continue
    const root = await Session.get(id).catch(() => undefined)
    if (!root) continue
    sessionParent.set(id, root.parentID)
    let depth = 0
    let cursor: string | undefined = root.parentID
    const visited = new Set<string>()
    while (cursor) {
      if (visited.has(cursor)) break
      visited.add(cursor)
      if (sessionDepth.has(cursor)) {
        depth += sessionDepth.get(cursor)! + 1
        break
      }
      const parent = await Session.get(cursor).catch(() => undefined)
      if (!parent?.parentID) break
      cursor = parent.parentID
      depth += 1
    }
    sessionDepth.set(id, Math.max(0, depth))
  }

  const callsWithDepth = allCalls.map((call) => ({
    ...call,
    depth: sessionDepth.get(call.sessionID) ?? 0,
  }))

  const totalLlmMs = completed.reduce((sum, call) => sum + (call.totalMs ?? 0), 0)
  const totalFirstChunk = completed.reduce((sum, call) => sum + (call.firstChunkMs ?? 0), 0)
  const totalStreamCreated = completed.reduce((sum, call) => sum + (call.streamCreatedMs ?? 0), 0)

  const completedByDepth = new Map<number, number[]>()
  for (const call of completed) {
    const depth = sessionDepth.get(call.sessionID) ?? 0
    const bucket = completedByDepth.get(depth) ?? []
    bucket.push(call.totalMs ?? 0)
    completedByDepth.set(depth, bucket)
  }

  const tokenTotals = completed.reduce(
    (acc, call) => {
      acc.input += call.usage?.inputTokens ?? 0
      acc.output += call.usage?.outputTokens ?? 0
      acc.reasoning += call.usage?.reasoningTokens ?? 0
      acc.cacheRead += call.usage?.cacheReadTokens ?? 0
      acc.cacheWrite += call.usage?.cacheWriteTokens ?? 0
      return acc
    },
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )

  const processorCalls = completed.filter((call) => call.source === "session.processor")
  const orderedCompleted = [...completed].sort((a, b) => a.startedAt - b.startedAt)
  const firstCallBySession = new Map<string, (typeof completed)[number]>()
  for (const call of orderedCompleted) {
    if (!firstCallBySession.has(call.sessionID)) firstCallBySession.set(call.sessionID, call)
  }

  const processorHashes = processorCalls.map((call) => call.context.systemPromptHash)
  const processorHistoryHashes = processorCalls.map((call) => call.context.messageHistoryHash)
  const processorHashStats = hashReuseStats(processorHashes)
  const historyHashStats = hashReuseStats(processorHistoryHashes)

  let subtaskHashMatch = 0
  let subtaskHashDiff = 0
  let subtaskHashUnknown = 0
  let subtaskHistoryMatch = 0
  let subtaskHistoryDiff = 0
  let subtaskHistoryUnknown = 0
  let subtaskSystemMatchHistoryDiff = 0
  for (const [sessionID, firstCall] of firstCallBySession) {
    const parentID = sessionParent.get(sessionID)
    if (!parentID) continue
    const parentFirstCall = firstCallBySession.get(parentID)
    if (!parentFirstCall) {
      subtaskHashUnknown += 1
      subtaskHistoryUnknown += 1
      continue
    }
    const systemMatch = parentFirstCall.context.systemPromptHash === firstCall.context.systemPromptHash
    const historyMatch = parentFirstCall.context.messageHistoryHash === firstCall.context.messageHistoryHash

    if (systemMatch) {
      subtaskHashMatch += 1
      if (!historyMatch) {
        subtaskSystemMatchHistoryDiff += 1
      }
    } else {
      subtaskHashDiff += 1
    }

    if (historyMatch) {
      subtaskHistoryMatch += 1
    } else {
      subtaskHistoryDiff += 1
    }
  }
  const subtaskSessionsWithCallData = subtaskHashMatch + subtaskHashDiff + subtaskHashUnknown

  const latency = completed.map((call) => call.totalMs ?? 0)
  const ttft = completed
    .map((call) => call.firstChunkMs ?? 0)
    .filter((value) => value > 0)
  const streamCreated = completed
    .map((call) => call.streamCreatedMs ?? 0)
    .filter((value) => value > 0)

  console.log(`\n=== ${result.name} ===`)
  console.log(`total runtime: ${Math.round(result.totalDurationMs)}ms`)
  console.log(`sessions touched: ${result.sessions.length}`)
  console.log(`llm calls: ${allCalls.length} total, ${completed.length} completed, ${failed.length} failed`)
  if (active.length > 0) {
    console.log(`active llm calls at snapshot: ${active.length}`)
  }
  console.log(`output tokens: ${tokenTotals.output} (input ${tokenTotals.input}, reasoning ${tokenTotals.reasoning})`)
  console.log(
    `cache tokens: read ${tokenTotals.cacheRead} (${Math.round((tokenTotals.cacheRead / Math.max(1, completed.length)) * 10_000) / 10_000} ` +
      `avg, ${Math.round((tokenTotals.cacheRead / Math.max(1, tokenTotals.input + tokenTotals.output || 1)) * 100)}% of in+out), ` +
      `write ${tokenTotals.cacheWrite}`,
  )
  console.log(
    `llm latency total: ${Math.round(totalLlmMs)}ms (mean ${Math.round(totalLlmMs / Math.max(1, completed.length))}ms)`,
  )
  console.log(`ttft total: ${Math.round(totalFirstChunk)}ms`)
  console.log(`stream-init total: ${Math.round(totalStreamCreated)}ms`)
  if (result.totalDurationMs > 0) {
    console.log(`llm share of wall time: ${((totalLlmMs / result.totalDurationMs) * 100).toFixed(1)}%`)
  }
  if (latency.length) {
    console.log(
      `latency p50=${percentile(latency, 0.5)}ms p95=${percentile(latency, 0.95)}ms p99=${percentile(latency, 0.99)}ms`,
    )
  }
  if (ttft.length) {
    console.log(`ttft p50=${percentile(ttft, 0.5)}ms p95=${percentile(ttft, 0.95)}ms p99=${percentile(ttft, 0.99)}ms`)
  }
  if (streamCreated.length) {
    console.log(
      `stream-init p50=${percentile(streamCreated, 0.5)}ms p95=${percentile(streamCreated, 0.95)}ms p99=${percentile(
        streamCreated,
        0.99,
      )}ms`,
    )
  }
  if (processorCalls.length > 0) {
    console.log(
      `system prompt hashes: ${processorCalls.length} processor calls, ${processorHashStats.uniqueCount} unique; ` +
        `reused from earlier ${processorHashStats.reusedCount} (${Math.round((processorHashStats.reusedCount / processorCalls.length) * 100)}%)`,
    )
    console.log(
      `full-prompt history hashes: ${processorCalls.length} processor calls, ${historyHashStats.uniqueCount} unique; ` +
        `reused from earlier ${historyHashStats.reusedCount} (${Math.round((historyHashStats.reusedCount / processorCalls.length) * 100)}%)`,
    )
  }
  if (subtaskSessionsWithCallData > 0) {
    console.log(
      `subtask first-call system hash: match=${subtaskHashMatch} diff=${subtaskHashDiff} unknown=${subtaskHashUnknown} ` +
        `(match ${Math.round((subtaskHashMatch / subtaskSessionsWithCallData) * 100)}%)`,
    )
    console.log(
      `subtask first-call full prompt hash: match=${subtaskHistoryMatch} diff=${subtaskHistoryDiff} unknown=${subtaskHistoryUnknown} ` +
        `(match ${Math.round((subtaskHistoryMatch / subtaskSessionsWithCallData) * 100)}%)`,
    )
    if (subtaskHashMatch > 0) {
      console.log(
        `system-match but different full prompt: ${subtaskSystemMatchHistoryDiff} of ${subtaskHashMatch} ` +
          `(${Math.round((subtaskSystemMatchHistoryDiff / Math.max(1, subtaskHashMatch)) * 100)}%)`,
      )
    }
  }

  const byDepthStats = [...completedByDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, items]) => `depth ${depth}: calls=${items.length} p50=${percentile(items, 0.5)}ms p95=${percentile(items, 0.95)}ms`)
  if (byDepthStats.length) {
    console.log("depth breakdown:")
    for (const row of byDepthStats) console.log(`  ${row}`)
  }

  const bySource = new Map<string, number[]>()
  for (const call of completed) {
    const bucket = bySource.get(call.source) ?? []
    bucket.push(call.totalMs ?? 0)
    bySource.set(call.source, bucket)
  }
  const sourceStats = [...bySource.entries()]
    .map(([source, items]) => `${source}: ${items.length} p50=${percentile(items, 0.5)}ms p95=${percentile(items, 0.95)}ms`)
    .sort()
  if (sourceStats.length) {
    console.log("source breakdown:")
    for (const row of sourceStats) console.log(`  ${row}`)
  }

  const slowest = [...completed]
    .sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0))
    .slice(0, 5)
    .map((call) => ({
      callID: call.callID,
      sessionID: call.sessionID,
      depth: sessionDepth.get(call.sessionID),
      ms: call.totalMs ?? 0,
      outputTokens: call.usage?.outputTokens ?? 0,
      promptChars: call.context.messageChars + call.context.systemChars,
      serializedChars: call.context.serializedMessageChars,
      model: `${call.providerID}/${call.modelID}`,
      modelPromptTokens: call.context.approxPromptTokens,
      systemPromptHash: call.context.systemPromptHash,
      messageHistoryHash: call.context.messageHistoryHash,
      cacheRead: call.usage?.cacheReadTokens ?? 0,
      cacheWrite: call.usage?.cacheWriteTokens ?? 0,
      ttft: call.firstChunkMs ?? 0,
      streamMs: call.streamCreatedMs ?? 0,
    }))

  console.log("top slowest processor calls:")
  for (const row of slowest) {
    console.log(
      `  ${row.callID} ${row.model} session=${row.sessionID} depth=${row.depth} ${row.ms}ms output=${row.outputTokens} ` +
        `prompt=${row.promptChars} serialized=${row.serializedChars} approxTokens=${row.modelPromptTokens} hash=${hashPrefix(
          row.systemPromptHash,
        )} history=${hashPrefix(row.messageHistoryHash)} cacheRead=${row.cacheRead} cacheWrite=${row.cacheWrite} ` +
          `ttft=${row.ttft} stream=${row.streamMs}`,
    )
  }

  const tokenBySize = [...processorCalls].sort(
    (a, b) => (b.context.messageChars + b.context.systemChars) - (a.context.messageChars + a.context.systemChars),
  )
  console.log("top context-size processor calls:")
  for (const call of tokenBySize.slice(0, 3)) {
    const promptChars = call.context.messageChars + call.context.systemChars
    const tokens = call.usage?.outputTokens ?? 0
    console.log(
      `  ${call.callID} ${call.sessionID} depth=${sessionDepth.get(call.sessionID)} ${promptChars} chars, output=${tokens}, tools=${
        call.context.toolNames.slice(0, 5).join(",")
      }, systemHash=${hashPrefix(call.context.systemPromptHash)} historyHash=${hashPrefix(call.context.messageHistoryHash)} ` +
        `cacheRead=${call.usage?.cacheReadTokens ?? 0} cacheWrite=${call.usage?.cacheWriteTokens ?? 0}`,
    )
  }

  const sessionCallCount = new Map<string, number>()
  const sessionDuration = new Map<string, number>()
  for (const call of allCalls) {
    sessionCallCount.set(call.sessionID, (sessionCallCount.get(call.sessionID) ?? 0) + 1)
    sessionDuration.set(call.sessionID, sessionDuration.get(call.sessionID) ?? 0)
    const base = sessionDuration.get(call.sessionID) ?? 0
    sessionDuration.set(call.sessionID, base + (call.totalMs ?? 0))
  }
  const sessionRows = [...sessionDuration.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  if (sessionRows.length) {
    console.log("sessions by llm time:")
    for (const [sessionID, ms] of sessionRows) {
      console.log(
        `  ${sessionID} calls=${sessionCallCount.get(sessionID) ?? 0} total=${Math.round(ms)}ms avg=${
          Math.round((ms / (sessionCallCount.get(sessionID) ?? 1)) || 0)
        }ms`,
      )
    }
  }
}

async function runCase(def: TestCase) {
  const model = await readModel()
  const root = await Session.createNext({
    title: `profiling-${Identifier.ascending("session")}-${def.name}`,
    directory: process.cwd(),
    permission: [{ permission: "read", action: "allow", pattern: "*" }],
  })
  const sessions = new Set<string>()
  const started = performance.now()
  try {
    await executeSubtaskTree({
      sessionID: root.id,
      depthRemaining: def.depth,
      path: def.name,
      breadth: def.breadth,
      model,
      sessions,
    })
  } finally {
    // no-op cleanup is handled by caller
  }
  const totalDurationMs = performance.now() - started
  const snapshot = LLMProfiler.snapshot()

  return {
    name: def.name,
    totalDurationMs,
    sessionID: root.id,
    sessions: [...sessions],
    calls: snapshot.calls,
  }
}

async function main() {
  const logLevelEnv = process.env.VOLTCODE_LOG_LEVEL?.toUpperCase()
  const parsedLogLevel = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].includes(logLevelEnv ?? "")
    ? (logLevelEnv as Log.Level)
    : "INFO"
  await Log.init({
    print: true,
    dev: true,
    level: parsedLogLevel,
  })

  const runDepth = Math.max(0, Number(toArg("depth", "1")))
  const runBreadth = Math.max(1, Number(toArg("breadth", "1")))
  const runModel = toArg("model", MODEL.modelID)
  if (runModel) {
    MODEL.modelID = runModel
  }
  const casesArg = toArg("cases", "short")
  const selectedCases = casesArg === "full" ? CASES : [
    { name: "baseline-no-subtask", depth: 0, breadth: 0 },
    { name: "single-subtask", depth: 1, breadth: 1 },
    { name: "short-tree", depth: runDepth, breadth: Math.min(runBreadth, 2) },
  ] as TestCase[]
  const exportJson = toArg("json", "")

  const model = await Provider.getModel(MODEL.providerID, MODEL.modelID)
  console.log(`Loaded model: ${model.providerID}/${model.id}`)
  console.log(`Running ${selectedCases.length} case(s) with Opus 4.6`)

  const results = []
  for (const item of selectedCases) {
    LLMProfiler.setEnabled(true)
    LLMProfiler.clear()
    const result = await runCase(item)
    results.push(result)
    await summarizeCase(result)
    await Session.remove(result.sessionID)
  }

  if (exportJson) {
    await fs.writeFile(
      exportJson,
      JSON.stringify(
        {
          model: `${MODEL.providerID}/${MODEL.modelID}`,
          createdAt: new Date().toISOString(),
          cases: results,
        },
        null,
        2,
      ),
    )
  }
}

await bootstrap(process.cwd(), async () => {
  await main()
})
