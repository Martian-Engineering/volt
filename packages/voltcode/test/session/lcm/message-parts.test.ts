import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import postgres from "postgres"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"

// The test preload redirects XDG_DATA_HOME to a temp dir, which means the embedded
// postgres binaries aren't found and ensureLcmReady() would try to download them.
// Instead, probe the default embedded postgres port to see if it's running, and
// set LCM_DATABASE_URL before importing LcmDb (which reads the URL at module load).
const LCM_PORT = 54329
const LCM_HOST = "127.0.0.1"
const LCM_USER = "voltcode"
const LCM_DB = "voltcode_lcm"
const LCM_URL = `postgres://${LCM_USER}@${LCM_HOST}:${LCM_PORT}/${LCM_DB}`

let isLcmAvailable = false
if (isEmbeddedPostgresSupported()) {
  try {
    const probe = postgres(LCM_URL, { connect_timeout: 3, max: 1 })
    await probe`SELECT 1`
    await probe.end()
    // Set the env var BEFORE importing LcmDb so its lazy sql() picks it up
    process.env.LCM_DATABASE_URL = LCM_URL
    isLcmAvailable = true
  } catch {
    isLcmAvailable = false
  }
}

// Dynamic import so LCM_DATABASE_URL is set before config.ts evaluates
const { LcmDb } = await import("../../../src/session/lcm/db")

describe("message_parts", () => {
  if (!isLcmAvailable) {
    test.skip("PostgreSQL not available", () => {})
    return
  }

  let testConversationId: number
  const createdConversationIds: number[] = []

  async function cleanup(conversationId: number) {
    const conn = LcmDb.getConnection()
    await conn`DELETE FROM message_parts WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ${conversationId})`.catch(
      () => {},
    )
    await conn`DELETE FROM context_items WHERE conversation_id = ${conversationId}`.catch(() => {})
    await conn`DELETE FROM messages WHERE conversation_id = ${conversationId}`.catch(() => {})
    await conn`DELETE FROM conversations WHERE conversation_id = ${conversationId}`.catch(() => {})
  }

  beforeAll(async () => {
    await LcmDb.initialize()
  })

  afterAll(async () => {
    for (const id of createdConversationIds) {
      await cleanup(id)
    }
  })

  beforeEach(async () => {
    testConversationId = await LcmDb.createConversation({
      title: "[Test] message_parts",
      modelName: "test-model",
      modelCtxMaxTokens: 10_000,
      ctxCutoffThreshold: 0.6,
    })
    createdConversationIds.push(testConversationId)
  })

  test("insertMessageParts + getMessageParts roundtrip for a text part", async () => {
    const messageId = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "user",
      content: "hello world",
      tokenCount: 2,
    })

    await LcmDb.insertMessageParts(messageId, [
      {
        partId: `part_text_${Date.now()}`,
        sessionId: "sess_1",
        partType: "text",
        ordinal: 0,
        textContent: "hello world",
      },
    ])

    const parts = await LcmDb.getMessageParts(messageId)
    expect(parts).not.toBeNull()
    expect(parts!.length).toBe(1)
    expect(parts![0].part_type).toBe("text")
    expect(parts![0].text_content).toBe("hello world")
    expect(parts![0].ordinal).toBe(0)
    expect(parts![0].message_id).toBe(messageId)
    expect(parts![0].session_id).toBe("sess_1")
  })

  test("insertMessageParts + getMessageParts roundtrip for a tool part", async () => {
    const messageId = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "assistant",
      content: "tool call",
      tokenCount: 2,
    })

    const toolInput = { path: "/tmp/foo.ts", content: "console.log('hi')" }

    await LcmDb.insertMessageParts(messageId, [
      {
        partId: `part_tool_${Date.now()}`,
        sessionId: "sess_1",
        partType: "tool",
        ordinal: 0,
        toolCallId: "call_abc123",
        toolName: "write",
        toolStatus: "completed",
        toolInput,
        toolOutput: "File written",
        toolTitle: "Write /tmp/foo.ts",
      },
    ])

    const parts = await LcmDb.getMessageParts(messageId)
    expect(parts).not.toBeNull()
    expect(parts!.length).toBe(1)
    const part = parts![0]
    expect(part.part_type).toBe("tool")
    expect(part.tool_call_id).toBe("call_abc123")
    expect(part.tool_name).toBe("write")
    expect(part.tool_status).toBe("completed")
    expect(part.tool_input).toEqual(toolInput)
    expect(part.tool_output).toBe("File written")
    expect(part.tool_title).toBe("Write /tmp/foo.ts")
  })

  test("insertMessageParts + getMessageParts roundtrip for a patch part", async () => {
    const messageId = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "assistant",
      content: "patch applied",
      tokenCount: 2,
    })

    const patchFiles = ["/src/index.ts", "/src/util.ts", "/test/index.test.ts"]

    await LcmDb.insertMessageParts(messageId, [
      {
        partId: `part_patch_${Date.now()}`,
        sessionId: "sess_1",
        partType: "patch",
        ordinal: 0,
        patchHash: "abc123def456",
        patchFiles,
      },
    ])

    const parts = await LcmDb.getMessageParts(messageId)
    expect(parts).not.toBeNull()
    expect(parts!.length).toBe(1)
    const part = parts![0]
    expect(part.part_type).toBe("patch")
    expect(part.patch_hash).toBe("abc123def456")
    expect(part.patch_files).toEqual(patchFiles)
  })

  test("insertMessageParts with multiple parts preserves ordinal ordering", async () => {
    const messageId = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "assistant",
      content: "multi-part message",
      tokenCount: 3,
    })

    const now = Date.now()
    await LcmDb.insertMessageParts(messageId, [
      {
        partId: `part_a_${now}`,
        sessionId: "sess_1",
        partType: "text",
        ordinal: 0,
        textContent: "first",
      },
      {
        partId: `part_b_${now}`,
        sessionId: "sess_1",
        partType: "tool",
        ordinal: 1,
        toolCallId: "call_1",
        toolName: "read",
        toolStatus: "completed",
      },
      {
        partId: `part_c_${now}`,
        sessionId: "sess_1",
        partType: "text",
        ordinal: 2,
        textContent: "third",
      },
    ])

    const parts = await LcmDb.getMessageParts(messageId)
    expect(parts).not.toBeNull()
    expect(parts!.length).toBe(3)
    expect(parts![0].ordinal).toBe(0)
    expect(parts![0].part_type).toBe("text")
    expect(parts![0].text_content).toBe("first")
    expect(parts![1].ordinal).toBe(1)
    expect(parts![1].part_type).toBe("tool")
    expect(parts![1].tool_name).toBe("read")
    expect(parts![2].ordinal).toBe(2)
    expect(parts![2].part_type).toBe("text")
    expect(parts![2].text_content).toBe("third")
  })

  test("getMessageParts returns null for a message with no parts", async () => {
    const messageId = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "user",
      content: "no parts here",
      tokenCount: 3,
    })

    const parts = await LcmDb.getMessageParts(messageId)
    expect(parts).toBeNull()
  })

  test("getMessagePartsForMessages bulk query returns correct mapping", async () => {
    const msgId1 = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "user",
      content: "message one",
      tokenCount: 2,
    })

    const msgId2 = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "assistant",
      content: "message two",
      tokenCount: 2,
    })

    const now = Date.now()
    await LcmDb.insertMessageParts(msgId1, [
      {
        partId: `part_m1_${now}`,
        sessionId: "sess_1",
        partType: "text",
        ordinal: 0,
        textContent: "content for msg1",
      },
    ])

    await LcmDb.insertMessageParts(msgId2, [
      {
        partId: `part_m2a_${now}`,
        sessionId: "sess_1",
        partType: "text",
        ordinal: 0,
        textContent: "first part of msg2",
      },
      {
        partId: `part_m2b_${now}`,
        sessionId: "sess_1",
        partType: "tool",
        ordinal: 1,
        toolCallId: "call_bulk",
        toolName: "bash",
        toolStatus: "completed",
      },
    ])

    const partsMap = await LcmDb.getMessagePartsForMessages([msgId1, msgId2])
    expect(partsMap.size).toBe(2)

    const msg1Parts = partsMap.get(msgId1)
    expect(msg1Parts).not.toBeUndefined()
    expect(msg1Parts!.length).toBe(1)
    expect(msg1Parts![0].text_content).toBe("content for msg1")

    const msg2Parts = partsMap.get(msgId2)
    expect(msg2Parts).not.toBeUndefined()
    expect(msg2Parts!.length).toBe(2)
    expect(msg2Parts![0].ordinal).toBe(0)
    expect(msg2Parts![0].text_content).toBe("first part of msg2")
    expect(msg2Parts![1].ordinal).toBe(1)
    expect(msg2Parts![1].tool_name).toBe("bash")
  })

  test("getMessagePartsForMessages with empty array returns empty map", async () => {
    const partsMap = await LcmDb.getMessagePartsForMessages([])
    expect(partsMap.size).toBe(0)
    expect(partsMap).toBeInstanceOf(Map)
  })

  test("getCurrentContext returns message_id for message entries", async () => {
    const msgId1 = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "user",
      content: "context message one",
      tokenCount: 3,
    })

    const msgId2 = await LcmDb.appendMessage({
      conversationId: testConversationId,
      role: "assistant",
      content: "context message two",
      tokenCount: 3,
    })

    const context = await LcmDb.getCurrentContext(testConversationId)
    expect(context.length).toBe(2)

    expect(context[0].item_type).toBe("message")
    expect(context[0].message_id).toBe(msgId1)
    expect(context[0].position).toBe(0)

    expect(context[1].item_type).toBe("message")
    expect(context[1].message_id).toBe(msgId2)
    expect(context[1].position).toBe(1)
  })
})
