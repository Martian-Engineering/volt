import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../../src/session/prompt"
import { Log } from "../../../src/util/log"
import type { MessageV2 } from "../../../src/session/message-v2"

Log.init({ print: false })

const SESSION_ID = "session_01"
const MESSAGE_ID = "message_01"

function makeUserInfo(overrides?: Partial<MessageV2.User>): MessageV2.User {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: Date.now() },
    agent: "default",
    model: { providerID: "test", modelID: "test-model" },
    ...overrides,
  }
}

function makeAssistantInfo(overrides?: Partial<MessageV2.Assistant>): MessageV2.Assistant {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "message_00",
    modelID: "test-model",
    providerID: "test",
    mode: "default",
    agent: "default",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

function partBase(id: string): { id: string; sessionID: string; messageID: string } {
  return { id, sessionID: SESSION_ID, messageID: MESSAGE_ID }
}

describe("formatMessageForLcm", () => {
  test("text part is included in content and mapped to structured part", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "text",
          text: "Hello world",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("Hello world")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("text")
    expect(result.parts[0].textContent).toBe("Hello world")
    expect(result.parts[0].partId).toBe("part_01")
    expect(result.parts[0].sessionId).toBe(SESSION_ID)
    expect(result.parts[0].ordinal).toBe(0)
  })

  test("ignored text part is NOT included in content but still mapped", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "text",
          text: "ignored text",
          ignored: true,
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("text")
    expect(result.parts[0].textContent).toBe("ignored text")
    expect(result.parts[0].isIgnored).toBe(true)
  })

  test("reasoning part is wrapped in <reasoning> tags in content", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "reasoning",
          text: "Thinking deeply",
          time: { start: 100 },
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("<reasoning>\nThinking deeply\n</reasoning>")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("reasoning")
    expect(result.parts[0].textContent).toBe("Thinking deeply")
  })

  test("completed tool part is included in content as <tool> tag and mapped with tool fields", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "tool",
          callID: "call_01",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/tmp/file.txt" },
            output: "file contents",
            title: "Read /tmp/file.txt",
            metadata: {},
            time: { start: 100, end: 200 },
          },
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toContain('<tool name="read">')
    expect(result.content).toContain('Input: {"path":"/tmp/file.txt"}')
    expect(result.content).toContain("Output: file contents")
    expect(result.content).toContain("</tool>")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("tool")
    expect(result.parts[0].toolName).toBe("read")
    expect(result.parts[0].toolCallId).toBe("call_01")
    expect(result.parts[0].toolInput).toEqual({ path: "/tmp/file.txt" })
    expect(result.parts[0].toolOutput).toBe("file contents")
    expect(result.parts[0].toolTitle).toBe("Read /tmp/file.txt")
    expect(result.parts[0].toolStatus).toBe("completed")
  })

  test("error tool part is included in content and mapped with toolError", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "tool",
          callID: "call_02",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "bad-cmd" },
            error: "Command not found",
            time: { start: 100, end: 200 },
          },
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toContain('<tool name="bash">')
    expect(result.content).toContain("Error: Command not found")
    expect(result.content).toContain("</tool>")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("tool")
    expect(result.parts[0].toolError).toBe("Command not found")
    expect(result.parts[0].toolStatus).toBe("error")
  })

  test("patch part is NOT in content string but mapped with patchHash and patchFiles", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "patch",
          hash: "abc123",
          files: ["src/a.ts", "src/b.ts"],
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("patch")
    expect(result.parts[0].patchHash).toBe("abc123")
    expect(result.parts[0].patchFiles).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("file part is NOT in content string but mapped with fileMime, fileName, fileUrl", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "file",
          mime: "image/png",
          filename: "screenshot.png",
          url: "data:image/png;base64,abc",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("file")
    expect(result.parts[0].fileMime).toBe("image/png")
    expect(result.parts[0].fileName).toBe("screenshot.png")
    expect(result.parts[0].fileUrl).toBe("data:image/png;base64,abc")
  })

  test("subtask part is NOT in content string but mapped with subtask fields", () => {
    const msg: MessageV2.WithParts = {
      info: makeUserInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "subtask",
          prompt: "Fix the bug",
          description: "Fixes a null pointer",
          agent: "coder",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("subtask")
    expect(result.parts[0].subtaskPrompt).toBe("Fix the bug")
    expect(result.parts[0].subtaskDesc).toBe("Fixes a null pointer")
    expect(result.parts[0].subtaskAgent).toBe("coder")
  })

  test("compaction part is NOT in content string but mapped with compactionAuto", () => {
    const msg: MessageV2.WithParts = {
      info: makeUserInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "compaction",
          auto: true,
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.content).toBe("")
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("compaction")
    expect(result.parts[0].compactionAuto).toBe(true)
  })

  test("step-start part is mapped with snapshotHash", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "step-start",
          snapshot: "snap_abc",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("step_start")
    expect(result.parts[0].snapshotHash).toBe("snap_abc")
  })

  test("step-start with no snapshot maps snapshotHash to null", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "step-start",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.parts[0].snapshotHash).toBeNull()
  })

  test("step-finish part is mapped with stepReason, stepCost, stepTokensIn, stepTokensOut", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "step-finish",
          reason: "end_turn",
          cost: 0.005,
          tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 50, write: 25 } },
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].partType).toBe("step_finish")
    expect(result.parts[0].stepReason).toBe("end_turn")
    expect(result.parts[0].stepCost).toBe(0.005)
    expect(result.parts[0].stepTokensIn).toBe(1000)
    expect(result.parts[0].stepTokensOut).toBe(500)
  })

  test("ordinal numbering matches array index", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "text",
          text: "first",
        },
        {
          ...partBase("part_02"),
          type: "reasoning",
          text: "second",
          time: { start: 100 },
        },
        {
          ...partBase("part_03"),
          type: "text",
          text: "third",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.parts).toHaveLength(3)
    expect(result.parts[0].ordinal).toBe(0)
    expect(result.parts[1].ordinal).toBe(1)
    expect(result.parts[2].ordinal).toBe(2)
  })

  test("user role maps to 'user'", () => {
    const msg: MessageV2.WithParts = {
      info: makeUserInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "text",
          text: "Hello",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.role).toBe("user")
  })

  test("assistant role maps to 'assistant'", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "text",
          text: "Hello",
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)
    expect(result.role).toBe("assistant")
  })

  test("mixed parts message with multiple types", () => {
    const msg: MessageV2.WithParts = {
      info: makeAssistantInfo(),
      parts: [
        {
          ...partBase("part_01"),
          type: "step-start",
          snapshot: "snap_start",
        },
        {
          ...partBase("part_02"),
          type: "reasoning",
          text: "Let me think",
          time: { start: 100 },
        },
        {
          ...partBase("part_03"),
          type: "text",
          text: "I will read the file.",
        },
        {
          ...partBase("part_04"),
          type: "tool",
          callID: "call_01",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/tmp/f.txt" },
            output: "contents",
            title: "Read file",
            metadata: {},
            time: { start: 100, end: 200 },
          },
        },
        {
          ...partBase("part_05"),
          type: "patch",
          hash: "h1",
          files: ["a.ts"],
        },
        {
          ...partBase("part_06"),
          type: "text",
          text: "Done.",
        },
        {
          ...partBase("part_07"),
          type: "step-finish",
          reason: "end_turn",
          cost: 0.01,
          tokens: { input: 500, output: 200, reasoning: 50, cache: { read: 10, write: 5 } },
        },
      ],
    }
    const result = SessionPrompt.formatMessageForLcm(msg)

    // Content should include text, reasoning, and tool parts only
    expect(result.content).toContain("<reasoning>\nLet me think\n</reasoning>")
    expect(result.content).toContain("I will read the file.")
    expect(result.content).toContain('<tool name="read">')
    expect(result.content).toContain("Done.")

    // Content should NOT include patch, step-start, step-finish
    expect(result.content).not.toContain("h1")
    expect(result.content).not.toContain("snap_start")
    expect(result.content).not.toContain("end_turn")

    // All 7 parts should be mapped
    expect(result.parts).toHaveLength(7)

    // Verify types
    expect(result.parts[0].partType).toBe("step_start")
    expect(result.parts[1].partType).toBe("reasoning")
    expect(result.parts[2].partType).toBe("text")
    expect(result.parts[3].partType).toBe("tool")
    expect(result.parts[4].partType).toBe("patch")
    expect(result.parts[5].partType).toBe("text")
    expect(result.parts[6].partType).toBe("step_finish")

    // Ordinals
    for (let i = 0; i < 7; i++) {
      expect(result.parts[i].ordinal).toBe(i)
    }

    // Role
    expect(result.role).toBe("assistant")

    // tokenCount should be positive
    expect(result.tokenCount).toBeGreaterThan(0)
  })
})
