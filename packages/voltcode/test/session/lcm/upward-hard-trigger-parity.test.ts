import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { Condense } from "../../../src/session/lcm/condense"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { LcmGhostCue } from "../../../src/session/lcm/ghost-cue"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { compactUntilUnderHardLimit, getActiveLcmRuntimeStrategy } from "../../../src/session/lcm/strategy"
import { Summary } from "../../../src/session/lcm/summary"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

function makeUpwardPolicyForHardTriggerParity() {
  return parseLcmPolicyConfig({
    VOLTCODE_LCM_MODE: "upward",
    VOLTCODE_LCM_UPWARD_LEAVES_FRESH_TAIL_FLOOR: "1",
    VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT: "8",
    VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT: "4",
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

async function insertSummaryAtPosition(input: { conversationId: number; position: number; summaryId: string }): Promise<void> {
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

describe("session.lcm.upward-hard-trigger-parity", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping upward hard-trigger parity tests", () => {})
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

  async function seedTwoD2Summaries(input: { conversationId: number; tokenCount: number }): Promise<[string, string]> {
    const d2a = nextSummaryId("d2")
    const d2b = nextSummaryId("d2")
    await insertSummary({
      conversationId: input.conversationId,
      summaryId: d2a,
      condensationOrder: 2,
      tokenCount: input.tokenCount,
      content: "d2 A",
    })
    await insertSummary({
      conversationId: input.conversationId,
      summaryId: d2b,
      condensationOrder: 2,
      tokenCount: input.tokenCount,
      content: "d2 B",
    })
    await insertSummaryAtPosition({ conversationId: input.conversationId, position: 0, summaryId: d2a })
    await insertSummaryAtPosition({ conversationId: input.conversationId, position: 1, summaryId: d2b })
    await LcmDb.appendMessage({ conversationId: input.conversationId, role: "user", content: "fresh tail", tokenCount: 10 })
    return [d2a, d2b]
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
    LcmGhostCue.setGhostCuePromptLoaderForTesting(null)
  })

  test("normal sweep fails fanout while hard-trigger sweep succeeds with relaxed fanout", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForHardTriggerParity())
    const conversationId = await createConversation("[Test] Upward hard-trigger fanout parity")

    const [d2a, d2b] = await seedTwoD2Summaries({ conversationId, tokenCount: 1_200 })
    const condenseStub = installCondenseStub()
    try {
      const normalResult = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-hard-trigger-normal",
        user: makeCompactionUser("upward-hard-trigger-normal"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
        sweepMode: "normal",
      })

      expect(normalResult.actionTaken).toBe(false)
      expect(normalResult.condensed).toBe(false)
      expect(normalResult.noOpReasons).toContain("d2_below_min_fanout")
      expect(normalResult.noOpReasons).toContain("no_legal_compaction_group")
      expect(condenseStub.calls.length).toBe(0)

      const hardTriggerResult = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-hard-trigger-hard",
        user: makeCompactionUser("upward-hard-trigger-hard"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
        sweepMode: "hard-trigger",
      })

      expect(hardTriggerResult.actionTaken).toBe(true)
      expect(hardTriggerResult.condensed).toBe(true)
      expect(condenseStub.calls.length).toBeGreaterThan(0)
      expect(condenseStub.calls[0]?.condensationOrder).toBe(3)
      expect(condenseStub.calls[0]?.parentSummaryIds).toEqual([d2a, d2b])
    } finally {
      condenseStub.restore()
    }
  })

  test("manual /compact and hard-limit forced round both execute normal sweep mode", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForHardTriggerParity())

    const originalForcedRecursive = LcmContext.compactForcedRecursive
    const originalIsOverThreshold = LcmContext.isOverThreshold
    const originalCountRawTokensOutsideFreshTail = LcmContext.countRawTokensOutsideFreshTail
    const originalGetContextTokenCount = LcmDb.getContextTokenCount

    const sweepModes: string[] = []
    let thresholdChecks = 0

    ;(LcmContext as any).compactForcedRecursive = async (input: any) => {
      sweepModes.push(input.sweepMode ?? "normal")
      return {
        actionTaken: true,
        condensed: true,
        newTokenCount: 900,
      }
    }
    ;(LcmContext as any).countRawTokensOutsideFreshTail = async () => 0
    ;(LcmDb as any).getContextTokenCount = async () => 2_000
    ;(LcmContext as any).isOverThreshold = async () => {
      thresholdChecks += 1
      if (thresholdChecks === 1) {
        return {
          overHard: true,
          overSoft: true,
          currentTokens: 2_000,
          hardLimit: 1_000,
          softThreshold: 600,
          lanePolicy: { leaves: { freshTailFloor: 1 } },
          laneTokens: { leaves: 0, sprigs: 0, bindles: 0, total: 2_000 },
          laneDecisions: {},
        }
      }

      return {
        overHard: false,
        overSoft: false,
        currentTokens: 900,
        hardLimit: 1_000,
        softThreshold: 600,
        lanePolicy: { leaves: { freshTailFloor: 1 } },
        laneTokens: { leaves: 0, sprigs: 0, bindles: 0, total: 900 },
        laneDecisions: {},
      }
    }

    try {
      const strategy = getActiveLcmRuntimeStrategy()
      expect(strategy.name).toBe("upward")

      await strategy.compactManual({
        conversationId: 101,
        sessionID: "upward-manual-hard-trigger",
        user: makeCompactionUser("upward-manual-hard-trigger"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 1_000,
      })

      const hardLimitResult = await compactUntilUnderHardLimit({
        conversationId: 101,
        sessionID: "upward-hard-limit-hard-trigger",
        user: makeCompactionUser("upward-hard-limit-hard-trigger"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 1_000,
      })

      expect(hardLimitResult.success).toBe(true)
      expect(hardLimitResult.rounds).toBe(1)
      expect(sweepModes).toEqual(["normal", "normal"])
    } finally {
      ;(LcmContext as any).compactForcedRecursive = originalForcedRecursive
      ;(LcmContext as any).isOverThreshold = originalIsOverThreshold
      ;(LcmContext as any).countRawTokensOutsideFreshTail = originalCountRawTokensOutsideFreshTail
      ;(LcmDb as any).getContextTokenCount = originalGetContextTokenCount
    }
  })

  test("hard-trigger upward sweep creates no archive stubs or ghost-cue artifacts", async () => {
    setLcmPolicyConfigForTesting(makeUpwardPolicyForHardTriggerParity())
    const conversationId = await createConversation("[Test] Upward hard-trigger no ghost cues")

    await seedTwoD2Summaries({ conversationId, tokenCount: 1_200 })
    const condenseStub = installCondenseStub()
    let ghostCuePromptLoads = 0
    LcmGhostCue.setGhostCuePromptLoaderForTesting(async () => {
      ghostCuePromptLoads += 1
      return "ghost cue prompt should not load in upward hard-trigger flow"
    })

    try {
      const result = await LcmContext.compactForcedRecursive({
        conversationId,
        sessionID: "upward-hard-trigger-no-ghost",
        user: makeCompactionUser("upward-hard-trigger-no-ghost"),
        model: makeCompactionModel(),
        overhead: 0,
        reserve: 0,
        contextWindow: 300_000,
        sweepMode: "hard-trigger",
      })

      expect(result.actionTaken).toBe(true)
      expect(result.condensed).toBe(true)
      expect(ghostCuePromptLoads).toBe(0)

      const conn = LcmDb.getConnection()
      const archiveStubCount = await conn<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM summaries
        WHERE conversation_id = ${conversationId}
          AND summary_type = 'archive_stub'
      `
      expect(archiveStubCount[0]?.count ?? 0).toBe(0)
    } finally {
      condenseStub.restore()
    }
  })
})
