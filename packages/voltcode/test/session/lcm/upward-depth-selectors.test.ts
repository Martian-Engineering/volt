import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

let summaryIdCounter = 0
function nextSummaryId(prefix = "sum"): string {
  summaryIdCounter += 1
  return `${prefix}_${summaryIdCounter.toString(16).padStart(16, "0")}`
}

async function cleanupConversation(id: number): Promise<void> {
  const conn = LcmDb.getConnection()
  await conn`DELETE FROM context_items WHERE conversation_id = ${id}`.catch(() => {})
  await conn`DELETE FROM summary_lineage_pointers WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ${id})`.catch(
    () => {},
  )
  await conn`DELETE FROM summary_parents WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ${id})`.catch(
    () => {},
  )
  await conn`DELETE FROM summary_messages WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ${id})`.catch(
    () => {},
  )
  await conn`DELETE FROM summaries WHERE conversation_id = ${id}`.catch(() => {})
  await conn`DELETE FROM messages WHERE conversation_id = ${id}`.catch(() => {})
  await conn`DELETE FROM large_files WHERE conversation_id = ${id}`.catch(() => {})
  await conn`DELETE FROM conversations WHERE conversation_id = ${id}`.catch(() => {})
}

async function insertSummaryAtPosition(input: { conversationId: number; position: number; summaryId: string }): Promise<void> {
  const conn = LcmDb.getConnection()
  await conn`
    INSERT INTO context_items (conversation_id, position, item_type, message_id, summary_id)
    VALUES (${input.conversationId}, ${input.position}, 'summary'::context_item_type, NULL, ${input.summaryId})
  `
}

describe("session.lcm.upward-depth-selectors", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping upward depth selector tests", () => {})
    return
  }

  const createdConversationIds: number[] = []

  async function createConversation(title: string): Promise<number> {
    const id = await LcmDb.createConversation({
      title,
      modelName: "test-model",
      modelCtxMaxTokens: 4_000,
      ctxCutoffThreshold: 0.6,
    })
    createdConversationIds.push(id)
    return id
  }

  beforeAll(async () => {
    await LcmDb.initialize()
  })

  afterAll(async () => {
    for (const id of createdConversationIds) {
      await cleanupConversation(id)
    }
  })

  test("discovers d1/d2/d3 in ascending order before fresh-tail boundary", async () => {
    const conversationId = await createConversation("[Test] Upward depth discovery order")

    const d1 = nextSummaryId()
    const d2 = nextSummaryId()
    const d3 = nextSummaryId()
    const d4 = nextSummaryId()

    await LcmDb.insertSprigSummary({
      summaryId: d1,
      conversationId,
      content: "d1 summary",
      tokenCount: 5,
      messageIds: [],
    })
    await LcmDb.insertBindleSummary({
      summaryId: d2,
      conversationId,
      content: "d2 summary",
      tokenCount: 6,
      parentSummaryIds: [],
      condensationOrder: 2,
    })
    await LcmDb.insertBindleSummary({
      summaryId: d3,
      conversationId,
      content: "d3 summary",
      tokenCount: 7,
      parentSummaryIds: [],
      condensationOrder: 3,
    })
    await LcmDb.insertBindleSummary({
      summaryId: d4,
      conversationId,
      content: "d4 summary",
      tokenCount: 8,
      parentSummaryIds: [],
      condensationOrder: 4,
    })

    await insertSummaryAtPosition({ conversationId, position: 0, summaryId: d1 })
    await insertSummaryAtPosition({ conversationId, position: 1, summaryId: d2 })
    await insertSummaryAtPosition({ conversationId, position: 2, summaryId: d3 })

    await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "fresh tail A",
      tokenCount: 3,
    })
    await LcmDb.appendMessage({
      conversationId,
      role: "assistant",
      content: "fresh tail B",
      tokenCount: 3,
    })

    await insertSummaryAtPosition({ conversationId, position: 5, summaryId: d4 })

    const context = await LcmDb.getCurrentContextWithRefs(conversationId)
    const freshTailStart = context.find((entry) => entry.item_type === "message")?.position
    expect(freshTailStart).toBeDefined()
    if (freshTailStart == null) {
      throw new Error("Expected a fresh-tail message boundary")
    }

    const orders = await LcmDb.getDistinctActiveCondensationOrdersInContext({
      conversationId,
      maxPositionExclusive: freshTailStart,
    })
    expect(orders).toEqual([1, 2, 3])
  })

  test("d3-only depth remains first-class selectable", async () => {
    const conversationId = await createConversation("[Test] Upward d3-only selectable")

    const d3 = nextSummaryId()
    await LcmDb.insertBindleSummary({
      summaryId: d3,
      conversationId,
      content: "d3 singleton",
      tokenCount: 9,
      parentSummaryIds: [],
      condensationOrder: 3,
    })
    await insertSummaryAtPosition({ conversationId, position: 0, summaryId: d3 })

    await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "protected fresh tail",
      tokenCount: 2,
    })

    const context = await LcmDb.getCurrentContextWithRefs(conversationId)
    const freshTailStart = context.find((entry) => entry.item_type === "message")?.position
    expect(freshTailStart).toBeDefined()
    if (freshTailStart == null) {
      throw new Error("Expected a fresh-tail message boundary")
    }

    const orders = await LcmDb.getDistinctActiveCondensationOrdersInContext({
      conversationId,
      maxPositionExclusive: freshTailStart,
    })
    expect(orders).toEqual([3])

    const chunk = await LcmDb.getOldestContiguousSummaryChunkAtCondensationOrder({
      conversationId,
      condensationOrder: 3,
      maxPositionExclusive: freshTailStart,
    })
    expect(chunk.map((entry) => entry.summary_id)).toEqual([d3])
  })

  test("contiguous same-depth chunk selection stops when depth changes", async () => {
    const conversationId = await createConversation("[Test] Upward contiguous depth chunk")

    const d2a = nextSummaryId()
    const d2b = nextSummaryId()
    const d3 = nextSummaryId()
    const d2c = nextSummaryId()

    await LcmDb.insertBindleSummary({
      summaryId: d2a,
      conversationId,
      content: "d2 A",
      tokenCount: 5,
      parentSummaryIds: [],
      condensationOrder: 2,
    })
    await LcmDb.insertBindleSummary({
      summaryId: d2b,
      conversationId,
      content: "d2 B",
      tokenCount: 5,
      parentSummaryIds: [],
      condensationOrder: 2,
    })
    await LcmDb.insertBindleSummary({
      summaryId: d3,
      conversationId,
      content: "d3 break",
      tokenCount: 5,
      parentSummaryIds: [],
      condensationOrder: 3,
    })
    await LcmDb.insertBindleSummary({
      summaryId: d2c,
      conversationId,
      content: "d2 C after break",
      tokenCount: 5,
      parentSummaryIds: [],
      condensationOrder: 2,
    })

    await insertSummaryAtPosition({ conversationId, position: 0, summaryId: d2a })
    await insertSummaryAtPosition({ conversationId, position: 1, summaryId: d2b })
    await insertSummaryAtPosition({ conversationId, position: 2, summaryId: d3 })
    await insertSummaryAtPosition({ conversationId, position: 3, summaryId: d2c })

    const chunk = await LcmDb.getOldestContiguousSummaryChunkAtCondensationOrder({
      conversationId,
      condensationOrder: 2,
    })
    expect(chunk.map((entry) => entry.summary_id)).toEqual([d2a, d2b])
  })
})
