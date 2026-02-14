import { describe, expect, test } from "bun:test"
import { LcmSummarize } from "../../../src/session/lcm/summarize"
import type { MessageV2 } from "../../../src/session/message-v2"

/**
 * Helper to create a minimal WithParts message.
 */
function makeMessage(
  overrides: {
    id?: string
    role?: "user" | "assistant"
    parts?: MessageV2.Part[]
  } = {},
): MessageV2.WithParts {
  const role = overrides.role ?? "assistant"
  const id = overrides.id ?? "msg_test1"
  const sessionID = "ses_test1"
  const parts = overrides.parts ?? []

  if (role === "user") {
    return {
      info: {
        id,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "default",
        model: { providerID: "test", modelID: "test-model" },
      },
      parts,
    }
  }

  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent",
      modelID: "test-model",
      providerID: "test",
      mode: "normal",
      agent: "default",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts,
  }
}

function partBase(messageID?: string): { id: string; sessionID: string; messageID: string } {
  return {
    id: "part_" + Math.random().toString(36).slice(2, 10),
    sessionID: "ses_test1",
    messageID: messageID ?? "msg_test1",
  }
}

describe("session.lcm.summarize.formatMessagesForSummary", () => {
  test("text parts are included in output", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "text",
          text: "Hello, this is a text part",
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).toContain("Hello, this is a text part")
  })

  test("ignored text parts are excluded from output", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "text",
          text: "This should be ignored",
          ignored: true,
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).not.toContain("This should be ignored")
  })

  test("completed tool parts are included with [Tool: name], Input, Output", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "tool",
          callID: "call_1",
          tool: "read_file",
          state: {
            status: "completed",
            input: { path: "/tmp/test.ts" },
            output: "file contents here",
            title: "Read File",
            metadata: {},
            time: { start: 1000, end: 2000 },
          },
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).toContain("[Tool: read_file]")
    expect(result).toContain('Input: {"path":"/tmp/test.ts"}')
    expect(result).toContain("Output: file contents here")
  })

  test("error tool parts are included with error text", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "tool",
          callID: "call_2",
          tool: "write_file",
          state: {
            status: "error",
            input: { path: "/tmp/test.ts" },
            error: "Permission denied",
            time: { start: 1000, end: 2000 },
          },
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).toContain("[Tool: write_file] Error: Permission denied")
  })

  test("reasoning parts are included", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "reasoning",
          text: "Let me think about this step by step",
          time: { start: 1000 },
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).toContain("[Reasoning] Let me think about this step by step")
  })

  test("patch parts are NOT included in output", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "patch",
          hash: "abc123",
          files: ["src/index.ts", "src/util.ts"],
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).not.toContain("[Patch")
    expect(result).not.toContain("abc123")
    expect(result).not.toContain("src/index.ts")
  })

  test("file parts are NOT included in output", () => {
    const msg = makeMessage({
      parts: [
        {
          ...partBase(),
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,abc",
          filename: "screenshot.png",
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    expect(result).not.toContain("[File")
    expect(result).not.toContain("screenshot.png")
    expect(result).not.toContain("data:image/png")
  })

  test("message with only metadata parts produces minimal output (just the header)", () => {
    const msg = makeMessage({
      id: "msg_metadata_only",
      parts: [
        {
          ...partBase("msg_metadata_only"),
          type: "patch",
          hash: "def456",
          files: ["a.ts"],
        },
        {
          ...partBase("msg_metadata_only"),
          type: "file",
          mime: "text/plain",
          url: "file:///tmp/a.ts",
        },
        {
          ...partBase("msg_metadata_only"),
          type: "step-start",
        },
        {
          ...partBase("msg_metadata_only"),
          type: "step-finish",
          reason: "stop",
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    // Should contain the message header
    expect(result).toContain("[Message msg_metadata_only]")
    // Should NOT contain any part-specific content
    expect(result).not.toContain("[Patch")
    expect(result).not.toContain("[File")
    expect(result).not.toContain("def456")
    expect(result).not.toContain("a.ts")
  })

  test("mixed message with text + patch + file + tool -- only text and tool appear", () => {
    const msg = makeMessage({
      id: "msg_mixed",
      parts: [
        {
          ...partBase("msg_mixed"),
          type: "text",
          text: "I will now edit the file",
        },
        {
          ...partBase("msg_mixed"),
          type: "patch",
          hash: "patchhash",
          files: ["src/main.ts"],
        },
        {
          ...partBase("msg_mixed"),
          type: "file",
          mime: "text/plain",
          url: "file:///src/main.ts",
          filename: "main.ts",
        },
        {
          ...partBase("msg_mixed"),
          type: "tool",
          callID: "call_3",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file1.ts\nfile2.ts",
            title: "Bash",
            metadata: {},
            time: { start: 1000, end: 2000 },
          },
        },
      ],
    })

    const result = LcmSummarize.formatMessagesForSummary([msg])

    // Text and tool should be present
    expect(result).toContain("I will now edit the file")
    expect(result).toContain("[Tool: bash]")
    expect(result).toContain("Output: file1.ts\nfile2.ts")

    // Patch and file should NOT be present
    expect(result).not.toContain("patchhash")
    expect(result).not.toContain("main.ts")
    expect(result).not.toContain("[Patch")
    expect(result).not.toContain("[File")
  })
})
