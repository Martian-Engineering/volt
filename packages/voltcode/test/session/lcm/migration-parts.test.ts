import { describe, expect, test } from "bun:test"
import { LcmMigration } from "../../../src/session/lcm/migration"
import { Log } from "../../../src/util/log"
import type { MessageV2 } from "../../../src/session/message-v2"

Log.init({ print: false })

const SESSION_ID = "ses_test000000000000000000"
const MESSAGE_ID = "msg_test000000000000000000"

function makeBase(id: string) {
  return { id, sessionID: SESSION_ID, messageID: MESSAGE_ID }
}

function makeUserInfo(): MessageV2.User {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: Date.now() },
    agent: "default",
    model: { providerID: "test", modelID: "test-model" },
  }
}

describe("session.lcm.migration.partsToMessagePartInputs", () => {
  test("maps text part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_text01"),
        type: "text",
        text: "Hello world",
        ignored: true,
        synthetic: true,
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("text")
    expect(result[0].textContent).toBe("Hello world")
    expect(result[0].isIgnored).toBe(true)
    expect(result[0].isSynthetic).toBe(true)
  })

  test("maps tool (completed) correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_tool01"),
        type: "tool",
        callID: "call_abc",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "file.txt",
          title: "List files",
          metadata: {},
          time: { start: 1000, end: 2000 },
        },
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("tool")
    expect(result[0].toolCallId).toBe("call_abc")
    expect(result[0].toolName).toBe("bash")
    expect(result[0].toolStatus).toBe("completed")
    expect(result[0].toolInput).toEqual({ command: "ls" })
    expect(result[0].toolOutput).toBe("file.txt")
    expect(result[0].toolTitle).toBe("List files")
  })

  test("maps tool (error) correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_tool02"),
        type: "tool",
        callID: "call_err",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "fail" },
          error: "command not found",
          time: { start: 1000, end: 2000 },
        },
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].toolStatus).toBe("error")
    expect(result[0].toolError).toBe("command not found")
    expect(result[0].toolOutput).toBeUndefined()
  })

  test("maps patch part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_patch01"),
        type: "patch",
        hash: "abc123",
        files: ["src/a.ts", "src/b.ts"],
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("patch")
    expect(result[0].patchHash).toBe("abc123")
    expect(result[0].patchFiles).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("maps file part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_file01"),
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,abc",
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("file")
    expect(result[0].fileMime).toBe("image/png")
    expect(result[0].fileName).toBe("screenshot.png")
    expect(result[0].fileUrl).toBe("data:image/png;base64,abc")
  })

  test("maps subtask part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_sub01"),
        type: "subtask",
        prompt: "Run tests",
        description: "Execute the test suite",
        agent: "coder",
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("subtask")
    expect(result[0].subtaskPrompt).toBe("Run tests")
    expect(result[0].subtaskDesc).toBe("Execute the test suite")
    expect(result[0].subtaskAgent).toBe("coder")
  })

  test("maps compaction part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_comp01"),
        type: "compaction",
        auto: true,
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("compaction")
    expect(result[0].compactionAuto).toBe(true)
  })

  test("maps step-start part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_ss01"),
        type: "step-start",
        snapshot: "snap_abc",
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("step_start")
    expect(result[0].snapshotHash).toBe("snap_abc")
  })

  test("maps step-finish part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_sf01"),
        type: "step-finish",
        reason: "end_turn",
        snapshot: "snap_def",
        cost: 0.005,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("step_finish")
    expect(result[0].stepReason).toBe("end_turn")
    expect(result[0].snapshotHash).toBe("snap_def")
    expect(result[0].stepCost).toBe(0.005)
    expect(result[0].stepTokensIn).toBe(100)
    expect(result[0].stepTokensOut).toBe(50)
  })

  test("maps snapshot part correctly", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_snap01"),
        type: "snapshot",
        snapshot: "snap_xyz",
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(1)
    expect(result[0].partType).toBe("snapshot")
    expect(result[0].snapshotHash).toBe("snap_xyz")
  })

  test("ordinal assignment matches array index", () => {
    const parts: MessageV2.Part[] = [
      {
        ...makeBase("part_a"),
        type: "text",
        text: "first",
      },
      {
        ...makeBase("part_b"),
        type: "text",
        text: "second",
      },
      {
        ...makeBase("part_c"),
        type: "text",
        text: "third",
      },
    ]

    const result = LcmMigration.partsToMessagePartInputs(parts)
    expect(result).toHaveLength(3)
    expect(result[0].ordinal).toBe(0)
    expect(result[1].ordinal).toBe(1)
    expect(result[2].ordinal).toBe(2)
  })
})

describe("session.lcm.migration.partsToContent", () => {
  test("excludes patch, file, subtask, and compaction from content string", () => {
    const msg: MessageV2.WithParts = {
      info: makeUserInfo(),
      parts: [
        {
          ...makeBase("part_patch_ex"),
          type: "patch",
          hash: "abc",
          files: ["a.ts"],
        },
        {
          ...makeBase("part_file_ex"),
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,abc",
        },
        {
          ...makeBase("part_sub_ex"),
          type: "subtask",
          prompt: "do thing",
          description: "desc",
          agent: "coder",
        },
        {
          ...makeBase("part_comp_ex"),
          type: "compaction",
          auto: false,
        },
      ],
    }

    const content = LcmMigration.partsToContent(msg)
    expect(content).toBe("")
  })

  test("includes text and tool parts in content string", () => {
    const msg: MessageV2.WithParts = {
      info: makeUserInfo(),
      parts: [
        {
          ...makeBase("part_t1"),
          type: "text",
          text: "Hello there",
        },
        {
          ...makeBase("part_tool_c"),
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/tmp" },
            output: "contents",
            title: "Read file",
            metadata: {},
            time: { start: 1000, end: 2000 },
          },
        },
      ],
    }

    const content = LcmMigration.partsToContent(msg)
    expect(content).toContain("Hello there")
    expect(content).toContain('<tool name="read">')
    expect(content).toContain("contents")
  })
})
