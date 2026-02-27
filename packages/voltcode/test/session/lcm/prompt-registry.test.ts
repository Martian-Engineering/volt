import { afterEach, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { createCondenseLlmRequest } from "../../../src/session/lcm/condense"
import { createGhostCueLlmRequest } from "../../../src/session/lcm/ghost-cue"
import {
  createLcmPromptRegistryKey,
  resolveLcmPrompt,
  setLcmPromptRegistryForTesting,
} from "../../../src/session/lcm/prompt-registry"
import { createSummarizeLlmRequest } from "../../../src/session/lcm/summarize"

describe("session.lcm.prompt-registry", () => {
  const testModel = {} as Parameters<typeof createSummarizeLlmRequest>[0]["model"]

  afterEach(() => {
    setLcmPolicyConfigForTesting(null)
    setLcmPromptRegistryForTesting(null)
  })

  test("resolves summarize and condense prompts for both modes", async () => {
    const doltSummarize = await resolveLcmPrompt({
      mode: "dolt",
      operation: "summarize",
      condensationOrder: 1,
    })
    const upwardCondense = await resolveLcmPrompt({
      mode: "upward",
      operation: "condense",
      condensationOrder: 2,
    })

    expect(doltSummarize).toContain("Dolt d1 Message Summarization Prompt")
    expect(upwardCondense).toContain("Upward d2 Summary Condensation Prompt")
  })

  test("resolves upward condense d3 prompt", async () => {
    const upwardCondenseD3 = await resolveLcmPrompt({
      mode: "upward",
      operation: "condense",
      condensationOrder: 3,
    })

    expect(upwardCondenseD3).toContain("Upward d3+ Summary Condensation Prompt")
  })

  test("resolves upward condense d4 to shared d3+ prompt", async () => {
    const upwardCondenseD3 = await resolveLcmPrompt({
      mode: "upward",
      operation: "condense",
      condensationOrder: 3,
    })
    const upwardCondenseD4 = await resolveLcmPrompt({
      mode: "upward",
      operation: "condense",
      condensationOrder: 4,
    })

    expect(upwardCondenseD4).toBe(upwardCondenseD3)
  })

  test("fails explicitly when prompt mapping is missing", async () => {
    setLcmPromptRegistryForTesting({})

    await expect(
      resolveLcmPrompt({
        mode: "dolt",
        operation: "summarize",
        condensationOrder: 1,
      }),
    ).rejects.toThrow("Missing LCM prompt mapping")
  })

  test("fails explicitly when prompt file is missing", async () => {
    setLcmPromptRegistryForTesting({
      "dolt:summarize:d1": "prompts/dolt/summarize/does-not-exist.txt",
    })

    await expect(
      resolveLcmPrompt({
        mode: "dolt",
        operation: "summarize",
        condensationOrder: 1,
      }),
    ).rejects.toThrow("Missing LCM prompt file")
  })

  test("rejects non-integer condensation order for prompt keys", () => {
    expect(() =>
      createLcmPromptRegistryKey({
        mode: "dolt",
        operation: "summarize",
        condensationOrder: 2.5,
      }),
    ).toThrow("Invalid LCM condensation order")
  })

  test("summarize and condense requests apply maxOutputTokens from policy", () => {
    setLcmPolicyConfigForTesting(
      parseLcmPolicyConfig({
        VOLTCODE_LCM_SUMMARY_MAX_OUTPUT_TOKENS: "111",
        VOLTCODE_LCM_CONDENSE_MAX_OUTPUT_TOKENS: "222",
      }),
    )

    const summarizeRequest = createSummarizeLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      formattedMessages: "messages",
    })
    const condenseRequest = createCondenseLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      userMessage: "summary inputs",
    })

    expect(summarizeRequest.maxOutputTokens).toBe(111)
    expect(condenseRequest.maxOutputTokens).toBe(222)
  })

  test("aggressive summarize/condense requests use lower output-token caps", () => {
    setLcmPolicyConfigForTesting(
      parseLcmPolicyConfig({
        VOLTCODE_LCM_SUMMARY_MAX_OUTPUT_TOKENS: "1000",
        VOLTCODE_LCM_CONDENSE_MAX_OUTPUT_TOKENS: "900",
      }),
    )

    const summarizeRequest = createSummarizeLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      formattedMessages: "messages",
      aggressive: true,
    })
    const condenseRequest = createCondenseLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      userMessage: "summary inputs",
      aggressive: true,
    })

    expect(summarizeRequest.maxOutputTokens).toBe(600)
    expect(condenseRequest.maxOutputTokens).toBe(540)
  })

  test("aggressive requests append escalation directive to system prompt", () => {
    const summarizeRequest = createSummarizeLlmRequest({
      model: testModel,
      promptTemplate: "base summarize prompt",
      formattedMessages: "messages",
      aggressive: true,
    })
    const condenseRequest = createCondenseLlmRequest({
      model: testModel,
      promptTemplate: "base condense prompt",
      userMessage: "summary inputs",
      aggressive: true,
    })

    const summarizeSystem = summarizeRequest.messages?.[0]
    const condenseSystem = condenseRequest.messages?.[0]
    expect(typeof summarizeSystem?.content).toBe("string")
    expect(typeof condenseSystem?.content).toBe("string")
    expect(summarizeSystem?.content).toContain("## Aggressive Compression Override")
    expect(condenseSystem?.content).toContain("## Aggressive Compression Override")
  })

  test("summarize request frames source text as material and reiterates summarize intent", () => {
    const summarizeRequest = createSummarizeLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      formattedMessages: "[Message lcm_msg_1] (user)\nhello",
    })

    const userMessage = summarizeRequest.messages?.[1]
    expect(userMessage?.role).toBe("user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("source material to summarize")
    expect(userMessage?.content).toContain("<messages>")
    expect(userMessage?.content).toContain("[Message lcm_msg_1] (user)")
    expect(userMessage?.content).toContain("Do not continue or answer the source conversation directly.")
  })

  test("condense request frames source summaries as material and reiterates condense intent", () => {
    const condenseRequest = createCondenseLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      userMessage: "## Summaries to Condense\n\n--- Summary sum_1 ---\nalpha",
    })

    const userMessage = condenseRequest.messages?.[1]
    expect(userMessage?.role).toBe("user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("source material to condense")
    expect(userMessage?.content).toContain("<source_summaries>")
    expect(userMessage?.content).toContain("## Summaries to Condense")
    expect(userMessage?.content).toContain("Do not continue or answer the source material directly.")
  })

  test("summarize request can include preceding chain summaries for continuity", () => {
    const summarizeRequest = createSummarizeLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      previousSummaryContext: "Earlier summary A\n\nEarlier summary B",
      formattedMessages: "[Message lcm_msg_2] (assistant)\nnew work",
    })

    const userMessage = summarizeRequest.messages?.[1]
    expect(userMessage?.role).toBe("user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("The preceding summaries in this chain are as follows:")
    expect(userMessage?.content).toContain("<preceding_summaries>")
    expect(userMessage?.content).toContain("Earlier summary A")
    expect(userMessage?.content).toContain("The new segment is:")
    expect(userMessage?.content).toContain("Summarize only the new segment while maintaining narrative continuity")
  })

  test("condense request can include preceding chain summaries for continuity", () => {
    const condenseRequest = createCondenseLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      previousSummaryContext: "Earlier d2 node",
      userMessage: "## Summaries to Condense\n\n--- Summary sum_2 ---\nbeta",
    })

    const userMessage = condenseRequest.messages?.[1]
    expect(userMessage?.role).toBe("user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("The preceding summaries in this chain are as follows:")
    expect(userMessage?.content).toContain("<preceding_summaries>")
    expect(userMessage?.content).toContain("Earlier d2 node")
    expect(userMessage?.content).toContain("The new segment is:")
    expect(userMessage?.content).toContain("Summarize only the new segment while maintaining narrative continuity")
  })

  test("ghost cue request frames bindle content as source material and reiterates summarize intent", () => {
    const ghostCueRequest = createGhostCueLlmRequest({
      model: testModel,
      promptTemplate: "prompt",
      bindleContent: "Long bindle body",
    })

    const userMessage = ghostCueRequest.messages?.[1]
    expect(userMessage?.role).toBe("user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("source material to summarize")
    expect(userMessage?.content).toContain("<bindle>")
    expect(userMessage?.content).toContain("Long bindle body")
    expect(userMessage?.content).toContain("Do not continue or answer the source material directly.")
  })
})
