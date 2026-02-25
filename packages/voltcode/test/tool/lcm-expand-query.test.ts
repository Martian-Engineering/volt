import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { LcmExpandQueryTool } from "../../src/tool/lcm-expand-query"
import * as ConfigModule from "../../src/config/config"
import * as RetrievalFacadeModule from "../../src/session/lcm/retrieval-facade"
import * as SessionPromptModule from "../../src/session/prompt"
import * as TaskModule from "../../src/tool/task"

const ctx = {
  sessionID: "session-lcm-expand-query",
  messageID: "msg-lcm-expand-query",
  callID: "call-lcm-expand-query",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.lcm_expand_query", () => {
  let sessionConversationSpy: any
  let resolveCandidatesSpy: any
  let configGetSpy: any
  let executeTaskSpy: any

  beforeEach(() => {
    sessionConversationSpy = spyOn(SessionPromptModule.SessionPrompt, "getLcmConversationId").mockResolvedValue(42)
    resolveCandidatesSpy = spyOn(RetrievalFacadeModule.LcmRetrievalFacade, "resolveExpandQueryCandidates")
    configGetSpy = spyOn(ConfigModule.Config, "get").mockResolvedValue({} as any)
    executeTaskSpy = spyOn(TaskModule, "executeTask").mockResolvedValue({
      output:
        '{"answer":"Recovered from active summaries","cited_summary_ids":["sum_0000000000000010"],"expanded_summary_count":1,"truncated":false}',
    } as any)
  })

  afterEach(() => {
    sessionConversationSpy.mockRestore()
    resolveCandidatesSpy.mockRestore()
    configGetSpy.mockRestore()
    executeTaskSpy.mockRestore()
  })

  test("returns delegated query answers with stable metadata shape", async () => {
    const tool = await LcmExpandQueryTool.init()
    resolveCandidatesSpy.mockResolvedValue({
      conversationId: 42,
      summaryIds: ["sum_0000000000000010"],
      diagnostics: [],
    })

    const result = await tool.execute(
      {
        prompt: "What did we decide?",
        query: "decision log",
      },
      ctx,
    )

    expect(result.output).toBe("Recovered from active summaries")
    expect(result.metadata.conversationId).toBe(42)
    expect(result.metadata.sourceSummaryIds).toEqual(["sum_0000000000000010"])
    expect(result.metadata.diagnostics).toEqual([])
    expect(executeTaskSpy).toHaveBeenCalledTimes(1)
  })

  test("returns explicit no-result diagnostics without task delegation", async () => {
    const tool = await LcmExpandQueryTool.init()
    resolveCandidatesSpy.mockResolvedValue({
      conversationId: 42,
      summaryIds: [],
      diagnostics: [
        {
          code: "off_context_unavailable",
          message: "Upward mode skipped off-context summaries for this query.",
        },
      ],
    })

    const result = await tool.execute(
      {
        prompt: "What happened earlier?",
        query: "archived branch",
      },
      ctx,
    )

    expect(result.output).toContain("No matching summaries were found for this query scope.")
    expect(result.output).toContain("[off_context_unavailable]")
    expect(result.metadata.sourceSummaryCount).toBe(0)
    expect(result.metadata.diagnostics).toEqual([
      expect.objectContaining({
        code: "off_context_unavailable",
      }),
    ])
    expect(executeTaskSpy).not.toHaveBeenCalled()
  })
})
