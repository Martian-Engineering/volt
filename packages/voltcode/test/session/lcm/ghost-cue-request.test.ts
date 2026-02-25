import { describe, expect, test } from "bun:test"
import { createGhostCueLlmRequest } from "../../../src/session/lcm/ghost-cue"

describe("session.lcm.ghost-cue request framing", () => {
  const testModel = {} as Parameters<typeof createGhostCueLlmRequest>[0]["model"]

  test("frames bindle text as source material and reiterates summary intent", () => {
    const request = createGhostCueLlmRequest({
      model: testModel,
      promptTemplate: "ghost-cue-system-prompt",
      bindleContent: "bindle text to summarize",
    })

    expect(request.messages?.[0]?.role).toBe("system")
    expect(request.messages?.[0]?.content).toBe("ghost-cue-system-prompt")

    const userMessage = request.messages?.[1]
    expect(userMessage?.role).toBe("user")
    expect(typeof userMessage?.content).toBe("string")
    expect(userMessage?.content).toContain("source material to summarize")
    expect(userMessage?.content).toContain("<bindle>")
    expect(userMessage?.content).toContain("bindle text to summarize")
    expect(userMessage?.content).toContain("Do not continue or answer the source material directly.")
  })
})
