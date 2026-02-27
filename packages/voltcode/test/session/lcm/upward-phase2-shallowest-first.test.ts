import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { Condense } from "../../../src/session/lcm/condense"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { Summary } from "../../../src/session/lcm/summary"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

function makeUpwardPolicyForPhase2Tests() {
  return parseLcmPolicyConfig({
    VOLTCODE_LCM_MODE: "upward",
    VOLTCODE_LCM_UPWARD_LEAVES_FRESH_TAIL_FLOOR: "1",
    VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT: "2",
    VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT: "2",
    VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT_HARD: "2",
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

async function insertSummaryAtPosition(input: {
  conversationId: number
  position: number
  summaryId: string
}): Promise<void> {
  const conn = LcmDb.getConnection()
  await conn`
    INSERT INTO context_items (conversation_id, position, item_type, message_id, summary_id)
    VALUES (${input.conversationId}, ${input.position}, 'summary'::context_item_type, NULL, ${input.summaryId})
  `
}

async function insertSummary(input: {
  conversationId: number
  summaryId: string
  condensationOrder: number
  tokenCount: number
  content: string
}) {
  if (input.condensationOrder === 1) {
    await LcmDb.insertSprigSummary({
      summaryId: input.summaryId,
      conversationId: input.conversationId,
      content: input.content,
      tokenCount: input.tokenCount,
      messageIds: [],
    })
    return
  }

  await LcmDb.insertBindleSummary({
    summaryId: input.summaryId,
    conversationId: input.conversationId,
    content: input.content,
    tokenCount: input.tokenCount,
    parentSummaryIds: [],
    condensationOrder: input.condensationOrder,
  })
}

function installCondenseStub(options?: { fixedTokenCount?: number }) {
  const calls: Array<{ condensationOrder: number; parentSummaryIds: string[] }> = []
  const originalCondense = Condense.condenseSummaries
  let syntheticCounter = 0

  ;(Condense as any).condenseSummaries = async (input: any) => {
    syntheticCounter += 1
    const condensationOrder = input.condensationOrder ?? 2
    const parentSummaryIds = input.summaries.map((summary: any) => summary.summaryId)
    calls.push({ condensationOrder, parentSummaryIds })

    const inputTokens = input.summaries.reduce((sum: number, summary: any) => sum + summary.tokenCount, 0)
    const tokenCount = options?.fixedTokenCount ?? Math.max(1, Math.floor(inputTokens / 2))
    const summary = Summary.createBindle(
      {
        content: `synthetic d${condensationOrder} #${syntheticCounter}`,
        tokenCount,
        conversationId: input.conversationId,
        parents: parentSummaryIds,
        condensationOrder,
        fileIds: [],
      },
      Date.now() + syntheticCounter,
    )

    await LcmDb.insertBindleSummary({
      summaryId: summary.summaryId,
      conversationId: input.dbConversationId,
      content: summary.content,
      tokenCount: summary.tokenCount,
      parentSummaryIds: summary.parents,
      condensationOrder: summary.condensationOrder,
      fileIds: summary.fileIds,
    })

    return summary
  }

  return {
    calls,
    restore() {
      ;(Condense as any).condenseSummaries = originalCondense
    },
  }
}

describe("session.lcm.upward-phase2-shallowest-first", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping upward phase2 shallowest-first tests", () => {})
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

  test("when d1 and d2 are both eligible, d1 condenses first", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForPhase2Tests())
    const conversationId = await createConversation("[Test] Upward phase2 shallowest-first")

    const d1a = nextSummaryId("d1")
    const d1b = nextSummaryId("d1")
    const d2a = nextSummaryId("d2")
    const d2b = nextSummaryId("d2")

    await insertSummary({ conversationId, summaryId: d1a, condensationOrder: 1, tokenCount: 1_200, content: "d1 A" })
    await insertSummary({ conversationId, summaryId: d1b, condensationOrder: 1, tokenCount: 1_200, content: "d1 B" })
    await insertSummary({ conversationId, summaryId: d2a, condensationOrder: 2, tokenCount: 1_300, content: "d2 A" })
    await insertSummary({ conversationId, summaryId: d2b, condensationOrder: 2, tokenCount: 1_300, content: "d2 B" })

    await insertSummaryAtPosition({ conversationId, position: 0, summaryId: d1a })
    await insertSummaryAtPosition({ conversationId, position: 1, summaryId: d1b })
    await insertSummaryAtPosition({ conversationId, position: 2, summaryId: d2a })
    await insertSummaryAtPosition({ conversationId, position: 3, summaryId: d2b })
    await LcmDb.appendMessage({ conversationId, role: "user", content: "fresh tail", tokenCount: 10 })

    const condenseStub = installCondenseStub()
    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-phase2-shallowest",
        user: makeCompactionUser("upward-phase2-shallowest"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
      })

      expect(result.actionTaken).toBe(true)
      expect(result.condensed).toBe(true)
      expect(condenseStub.calls.length).toBeGreaterThan(0)
      expect(condenseStub.calls[0]?.condensationOrder).toBe(2)
      expect(condenseStub.calls[0]?.parentSummaryIds).toEqual([d1a, d1b])
    } finally {
      condenseStub.restore()
    }
  })

  test("chunk token floor blocks condensation below max(condensedTargetTokens, floor(leafChunkTokens*0.1))", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForPhase2Tests())
    const conversationId = await createConversation("[Test] Upward phase2 token floor")

    const d1a = nextSummaryId("d1")
    const d1b = nextSummaryId("d1")
    await insertSummary({
      conversationId,
      summaryId: d1a,
      condensationOrder: 1,
      tokenCount: 900,
      content: "d1 small A",
    })
    await insertSummary({
      conversationId,
      summaryId: d1b,
      condensationOrder: 1,
      tokenCount: 900,
      content: "d1 small B",
    })
    await insertSummaryAtPosition({ conversationId, position: 0, summaryId: d1a })
    await insertSummaryAtPosition({ conversationId, position: 1, summaryId: d1b })
    await LcmDb.appendMessage({ conversationId, role: "assistant", content: "fresh tail", tokenCount: 10 })

    const condenseStub = installCondenseStub()
    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-phase2-floor",
        user: makeCompactionUser("upward-phase2-floor"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
      })

      expect(result.actionTaken).toBe(false)
      expect(result.condensed).toBe(false)
      expect(condenseStub.calls.length).toBe(0)
      expect(result.noOpReasons).toContain("sprigs_below_min_chunk_tokens")
      expect(result.noOpReasons).toContain("no_legal_compaction_group")
    } finally {
      condenseStub.restore()
    }
  })

  test("phase2 loop stops when a condensed pass makes no token-count progress", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForPhase2Tests())
    const conversationId = await createConversation("[Test] Upward phase2 non-progress guard")

    const d1a = nextSummaryId("d1")
    const d1b = nextSummaryId("d1")
    const d1c = nextSummaryId("d1")
    const d1d = nextSummaryId("d1")
    await insertSummary({ conversationId, summaryId: d1a, condensationOrder: 1, tokenCount: 1_200, content: "d1 A" })
    await insertSummary({ conversationId, summaryId: d1b, condensationOrder: 1, tokenCount: 1_200, content: "d1 B" })
    await insertSummary({ conversationId, summaryId: d1c, condensationOrder: 1, tokenCount: 1_200, content: "d1 C" })
    await insertSummary({ conversationId, summaryId: d1d, condensationOrder: 1, tokenCount: 1_200, content: "d1 D" })
    await insertSummaryAtPosition({ conversationId, position: 0, summaryId: d1a })
    await insertSummaryAtPosition({ conversationId, position: 1, summaryId: d1b })
    await insertSummaryAtPosition({ conversationId, position: 2, summaryId: d1c })
    await insertSummaryAtPosition({ conversationId, position: 3, summaryId: d1d })
    await LcmDb.appendMessage({ conversationId, role: "user", content: "fresh tail", tokenCount: 10 })

    const condenseStub = installCondenseStub({ fixedTokenCount: 10 })
    const originalGetContextTokenCount = LcmDb.getContextTokenCount
    ;(LcmDb as any).getContextTokenCount = async () => 50_000
    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-phase2-no-progress",
        user: makeCompactionUser("upward-phase2-no-progress"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
      })

      expect(result.actionTaken).toBe(true)
      expect(result.condensed).toBe(true)
      expect(condenseStub.calls.length).toBe(1)
    } finally {
      ;(LcmDb as any).getContextTokenCount = originalGetContextTokenCount
      condenseStub.restore()
    }
  })
})
