import { afterEach, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { createCondenseLlmRequest } from "../../../src/session/lcm/condense"
import {
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
})
