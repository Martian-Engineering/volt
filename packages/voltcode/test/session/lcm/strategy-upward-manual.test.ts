import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { Condense } from "../../../src/session/lcm/condense"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { Summary } from "../../../src/session/lcm/summary"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

function makeUpwardPolicyForManualTests() {
  return parseLcmPolicyConfig({
    VOLTCODE_LCM_MODE: "upward",
    VOLTCODE_LCM_UPWARD_LEAVES_MIN_FANOUT: "2",
    VOLTCODE_LCM_UPWARD_SPRIGS_MIN_FANOUT: "2",
    VOLTCODE_LCM_UPWARD_BINDLES_MIN_FANOUT: "2",
    VOLTCODE_LCM_UPWARD_LEAVES_FRESH_TAIL_FLOOR: "2",
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

async function placeSummaryInContext(input: { conversationId: number; summaryId: string }): Promise<void> {
  await LcmDb.appendMessage({
    conversationId: input.conversationId,
    role: "user",
    content: `placeholder for ${input.summaryId}`,
    tokenCount: 1,
  })
  const contextBeforeReplacement = await LcmDb.getCurrentContext(input.conversationId)
  const insertedMessagePosition = contextBeforeReplacement.length - 1
  await LcmDb.replaceContextWithSummary({
    conversationId: input.conversationId,
    startPosition: insertedMessagePosition,
    endPosition: insertedMessagePosition,
    summaryId: input.summaryId,
  })
}

describe("session.lcm.strategy.upward-manual", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping upward manual strategy tests", () => {})
    return
  }

  const createdConversationIds: number[] = []

  async function createConversation(title: string): Promise<number> {
    const id = await LcmDb.createConversation({
      title,
      modelName: "test-model",
      modelCtxMaxTokens: 1000,
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

  test("manual upward compaction reports explicit no-op when no legal group exists", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForManualTests())

    const conversationId = await createConversation("[Test] Upward manual no-op")
    await LcmDb.appendMessage({
      conversationId,
      role: "user",
      content: "tail leaf",
      tokenCount: 2,
    })

    const result = await LcmContext.compactForcedRecursive({
      conversationId,
      sessionID: "upward-no-op",
      user: makeCompactionUser("upward-no-op"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })

    expect(result.actionTaken).toBe(false)
    expect(result.condensed).toBe(false)
    expect(result.noOpReasons).toContain("no_legal_compaction_group")
    expect(result.noOpReasons).toContain("eligible_leaves_below_min")
  })

  test("manual upward compaction performs forced recursive condensation without eviction", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForManualTests())

    const conversationId = await createConversation("[Test] Upward manual recursive")

    const sprigA = nextSummaryId()
    const sprigB = nextSummaryId()
    await LcmDb.insertSprigSummary({
      summaryId: sprigA,
      conversationId,
      content: "sprig A",
      tokenCount: 6,
      messageIds: [],
    })
    await LcmDb.insertSprigSummary({
      summaryId: sprigB,
      conversationId,
      content: "sprig B",
      tokenCount: 6,
      messageIds: [],
    })
    await placeSummaryInContext({ conversationId, summaryId: sprigA })
    await placeSummaryInContext({ conversationId, summaryId: sprigB })

    const d2a = nextSummaryId()
    const d2b = nextSummaryId()
    await LcmDb.insertBindleSummary({
      summaryId: d2a,
      conversationId,
      content: "existing d2 A",
      tokenCount: 8,
      parentSummaryIds: [sprigA, sprigB],
      condensationOrder: 2,
    })
    await LcmDb.insertBindleSummary({
      summaryId: d2b,
      conversationId,
      content: "existing d2 B",
      tokenCount: 8,
      parentSummaryIds: [sprigA, sprigB],
      condensationOrder: 2,
    })
    await placeSummaryInContext({ conversationId, summaryId: d2a })
    await placeSummaryInContext({ conversationId, summaryId: d2b })

    const originalCondense = Condense.condenseSummaries
    let syntheticCounter = 0
    ;(Condense as any).condenseSummaries = async (input: any) => {
      syntheticCounter += 1
      const content = `synthetic d${input.condensationOrder} #${syntheticCounter}`
      const inputTokens = input.summaries.reduce((sum: number, summary: any) => sum + summary.tokenCount, 0)
      const tokenCount = Math.max(1, Math.floor(inputTokens / 2))
      const summary = Summary.createBindle(
        {
          content,
          tokenCount,
          conversationId: input.conversationId,
          parents: input.summaries.map((summary: any) => summary.summaryId),
          condensationOrder: input.condensationOrder,
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

    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-recursive",
        user: makeCompactionUser("upward-recursive"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 1000,
      })

      expect(result.actionTaken).toBe(true)
      expect(result.condensed).toBe(true)
      expect(result.noOpReasons).toContain("d3_below_min_fanout")

      const context = await LcmDb.getCurrentContextWithRefs(conversationId)
      expect(context.some((entry) => entry.summary_type === "archive_stub")).toBe(false)
      expect(
        context.some((entry) => entry.item_type === "summary" && entry.summary_type === "bindle" && entry.condensation_order === 3),
      ).toBe(true)
    } finally {
      ;(Condense as any).condenseSummaries = originalCondense
    }
  })
})
