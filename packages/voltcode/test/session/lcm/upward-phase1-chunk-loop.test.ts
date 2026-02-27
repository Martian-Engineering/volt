import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { Summary } from "../../../src/session/lcm/summary"
import { LcmSummarize } from "../../../src/session/lcm/summarize"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

function makeUpwardPolicyForPhase1Tests() {
  return parseLcmPolicyConfig({
    VOLTCODE_LCM_MODE: "upward",
    VOLTCODE_LCM_UPWARD_LEAVES_FRESH_TAIL_FLOOR: "1",
    VOLTCODE_LCM_UPWARD_LEAVES_MIN_FANOUT: "2",
    VOLTCODE_LCM_UPWARD_SPRIGS_MIN_FANOUT: "99",
    VOLTCODE_LCM_UPWARD_BINDLES_MIN_FANOUT: "99",
  })
}

let summaryIdCounter = 0
function nextSummaryId(prefix = "sum"): string {
  summaryIdCounter += 1
  return `${prefix}_${summaryIdCounter.toString(16).padStart(16, "0")}`
}

function makeCompactionUser(sessionID: string) {
  return {
    id: `${sessionID}-user`,
    sessionID,
    role: "user",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now() },
  } as any
}

function makeCompactionModel() {
  return { id: "test-model", providerID: "test" } as any
}

async function cleanupConversation(id: number) {
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

async function overwriteContextOrder(input: {
  conversationId: number
  orderedItems: Array<{ itemType: "message"; messageId: number } | { itemType: "summary"; summaryId: string }>
}): Promise<void> {
  const conn = LcmDb.getConnection()
  await conn.begin(async (tx) => {
    await tx`DELETE FROM context_items WHERE conversation_id = ${input.conversationId}`
    for (const [position, item] of input.orderedItems.entries()) {
      const messageId = item.itemType === "message" ? item.messageId : null
      const summaryId = item.itemType === "summary" ? item.summaryId : null
      await tx`
        INSERT INTO context_items (conversation_id, position, item_type, message_id, summary_id)
        VALUES (${input.conversationId}, ${position}, ${item.itemType}::context_item_type, ${messageId}, ${summaryId})
      `
    }
  })
}

function installDeterministicSummarizerStub() {
  const summarizeCalls: number[][] = []
  const originalSummarize = LcmSummarize.summarize
  let syntheticCounter = 0

  ;(LcmSummarize as any).summarize = async (input: any) => {
    syntheticCounter += 1
    const linkedMessageIds: number[] = [...(input.dbMessageIds ?? [])]
    summarizeCalls.push(linkedMessageIds)

    const summary = Summary.createSprig(
      {
        content: `synthetic phase1 summary #${syntheticCounter}`,
        tokenCount: 1,
        conversationId: input.conversationId.toString(),
        messageIds: linkedMessageIds.map((messageId) => `lcm_msg_${messageId}`),
        fileIds: [],
      },
      Date.now() + syntheticCounter,
    )

    await LcmDb.insertSprigSummary({
      summaryId: summary.summaryId,
      conversationId: input.conversationId,
      content: summary.content,
      tokenCount: summary.tokenCount,
      messageIds: linkedMessageIds,
      fileIds: [],
    })

    return {
      ...summary,
      messageIds: linkedMessageIds.map((messageId) => `lcm_msg_${messageId}`),
    }
  }

  return {
    summarizeCalls,
    restore() {
      ;(LcmSummarize as any).summarize = originalSummarize
    },
  }
}

describe("session.lcm.upward-phase1-chunk-loop", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping upward phase1 loop tests", () => {})
    return
  }

  const createdConversationIds: number[] = []

  async function createConversation(title: string): Promise<number> {
    const id = await LcmDb.createConversation({
      title,
      modelName: "test-model",
      modelCtxMaxTokens: 300_000,
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

  afterEach(() => {
    setLcmPolicyConfigForTesting(null)
  })

  test("backlog larger than one chunk yields multiple d1 summaries in one sweep", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForPhase1Tests())

    const conversationId = await createConversation("[Test] Upward phase1 multi chunk")
    await LcmDb.appendMessage({ conversationId, role: "user", content: "m1", tokenCount: 12_000 })
    await LcmDb.appendMessage({ conversationId, role: "user", content: "m2", tokenCount: 12_000 })
    await LcmDb.appendMessage({ conversationId, role: "user", content: "m3", tokenCount: 12_000 })
    await LcmDb.appendMessage({ conversationId, role: "user", content: "tail", tokenCount: 500 })

    const summarizeStub = installDeterministicSummarizerStub()
    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-phase1-multi",
        user: makeCompactionUser("upward-phase1-multi"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
      })

      expect(result.actionTaken).toBe(true)
      expect(summarizeStub.summarizeCalls.length).toBeGreaterThan(1)

      const context = await LcmDb.getCurrentContextWithRefs(conversationId)
      const d1Summaries = context.filter(
        (entry) => entry.item_type === "summary" && entry.summary_type === "sprig" && entry.condensation_order === 1,
      )
      expect(d1Summaries.length).toBeGreaterThan(1)
    } finally {
      summarizeStub.restore()
    }
  })

  test("oversized first eligible message still compacts one message chunk", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForPhase1Tests())

    const conversationId = await createConversation("[Test] Upward phase1 oversized first message")
    const oversizedFirstMessageId = await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "oversized",
      tokenCount: 25_001,
    })
    await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "tail",
      tokenCount: 500,
    })

    const summarizeStub = installDeterministicSummarizerStub()
    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-phase1-oversized",
        user: makeCompactionUser("upward-phase1-oversized"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
      })

      expect(result.actionTaken).toBe(true)
      expect(summarizeStub.summarizeCalls.length).toBe(1)
      expect(summarizeStub.summarizeCalls[0]).toEqual([oversizedFirstMessageId])
    } finally {
      summarizeStub.restore()
    }
  })

  test("phase1 chunk stops at first non-message boundary", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForPhase1Tests())

    const conversationId = await createConversation("[Test] Upward phase1 non-message boundary")
    const firstMessageId = await LcmDb.appendMessage({ conversationId, role: "user", content: "m1", tokenCount: 1_000 })
    const secondMessageId = await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "m2",
      tokenCount: 1_000,
    })
    const thirdMessageId = await LcmDb.appendMessage({ conversationId, role: "user", content: "m3", tokenCount: 1_000 })
    const fourthMessageId = await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "m4",
      tokenCount: 1_000,
    })
    const tailMessageId = await LcmDb.appendMessage({ conversationId, role: "user", content: "tail", tokenCount: 500 })

    const boundarySummaryId = nextSummaryId("sum_boundary")
    await LcmDb.insertSprigSummary({
      summaryId: boundarySummaryId,
      conversationId,
      content: "boundary summary",
      tokenCount: 10,
      messageIds: [],
    })
    await overwriteContextOrder({
      conversationId,
      orderedItems: [
        { itemType: "message", messageId: firstMessageId },
        { itemType: "message", messageId: secondMessageId },
        { itemType: "summary", summaryId: boundarySummaryId },
        { itemType: "message", messageId: thirdMessageId },
        { itemType: "message", messageId: fourthMessageId },
        { itemType: "message", messageId: tailMessageId },
      ],
    })

    const summarizeStub = installDeterministicSummarizerStub()
    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-phase1-boundary",
        user: makeCompactionUser("upward-phase1-boundary"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
      })

      expect(result.actionTaken).toBe(true)
      expect(summarizeStub.summarizeCalls[0]).toEqual([firstMessageId, secondMessageId])
    } finally {
      summarizeStub.restore()
    }
  })
})
