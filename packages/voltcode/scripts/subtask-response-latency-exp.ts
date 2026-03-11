import { Session } from "../src/session"
import { SessionPrompt } from "../src/session/prompt"
import { Provider } from "../src/provider/provider"
import { LLMProfiler } from "../src/session/llm-profiler"
import { Identifier } from "../src/id/id"
import { Log } from "../src/util/log"
import { Instance } from "../src/project/instance"

function childTextChars(value: string) {
  return value.length
}

async function runCase(name: string, parts: any[]) {
  const model = await Provider.getModel("anthropic", "claude-opus-4-6")
  const root = await Session.createNext({
    title: `subtask-exp-${name}-${Identifier.ascending("session")}`,
    directory: process.cwd(),
    permission: [{ permission: "read", action: "allow", pattern: "*" }],
  })

  LLMProfiler.setEnabled(true)
  LLMProfiler.clear()

  const before = await Session.messages({ sessionID: root.id })
  const beforeIds = new Set(before.map((x) => x.info.id))

  await SessionPrompt.prompt({
    sessionID: root.id,
    model: { providerID: model.providerID, modelID: model.id },
    agent: "general",
    parts,
  })

  const after = await Session.messages({ sessionID: root.id })
  const newMsgs = after.filter((m) => !beforeIds.has(m.info.id))
  const toolParts = newMsgs
    .flatMap((m) => m.parts)
    .filter((p: any) => p.type === "tool" && p.tool === "task") as any[]

  const allCalls = LLMProfiler.snapshot().calls
  const completed = allCalls.filter((c) => c.status === "completed")

  console.log(`\n=== ${name} ===`)
  console.log(`root=${root.id} completedCalls=${completed.length}`)
  for (const c of completed) {
    console.log(
      `${c.callID} session=${c.sessionID} source=${c.source} model=${c.providerID}/${c.modelID} outputTok=${c.usage?.outputTokens ?? 0} input=${c.usage?.inputTokens ?? 0} cacheRead=${c.usage?.cacheReadTokens ?? 0} cacheWrite=${c.usage?.cacheWriteTokens ?? 0} totalMs=${c.totalMs ?? 0}`,
    )
  }

  if (toolParts.length === 0) {
    console.log("No task tool outputs")
  } else {
    for (let i = 0; i < toolParts.length; i++) {
      const part = toolParts[i]
      const output = typeof part.state.output === "string" ? part.state.output : ""
      const childSession = (part.state?.metadata?.sessionId || "") as string
      console.log(`tool#${i + 1} outputChars=${output.length} session=${childSession}`)
      console.log(`tool output preview=${JSON.stringify(output.slice(0, 260))}`)
      console.log(`tool output tail=${JSON.stringify(output.slice(-260))}`)
      if (childSession) {
        const childMessages = await Session.messages({ sessionID: childSession })
        const childTexts = childMessages
          .flatMap((m) => m.parts)
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
        console.log(`childTextChars=${childTextChars(childTexts)} preview=${JSON.stringify(childTexts.slice(0, 260))}`)
      }
    }
  }

  await Session.remove(root.id)
}

await Instance.provide({
  directory: process.cwd(),
  init: async () => {
    await Log.init({ print: false, dev: true, level: "ERROR" })
  },
  fn: async () => {
    await runCase("short-subtask", [
      {
        type: "subtask",
        agent: "general",
        description: "short-task",
        prompt: "Give a short 1-paragraph status update and stop.",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      },
    ])

    await runCase("long-subtask", [
      {
        type: "subtask",
        agent: "general",
        description: "long-task",
        prompt:
          "You are asked to produce a very detailed design review for a hypothetical module named VoltScheduler, including at least 12 concrete risks, 8 recommended mitigations, 6 concrete follow-up test cases, and a short migration checklist. " +
          "Be explicit and granular with names/examples. Include section headers. Return a full response around 700-900 words.",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      },
    ])

    await runCase("baseline", [{ type: "text", text: "Reply with a concise one-sentence summary of how many subagents you think would help." }])
  },
})
