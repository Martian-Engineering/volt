import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting, type LcmMode } from "../../../src/session/lcm/config"
import { Condense } from "../../../src/session/lcm/condense"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { getActiveLcmRuntimeStrategy, setLcmRuntimeStrategyFactoriesForTesting } from "../../../src/session/lcm/strategy"
import type { LcmRetrieval } from "../../../src/session/lcm/retrieval"
import { Summary } from "../../../src/session/lcm/summary"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

const MATRIX_BINDLE_SOFT = "15"
const MATRIX_BINDLE_DELTA = "1"
const MATRIX_BINDLE_TARGET = "12"

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

function makeMatrixPolicy(mode: LcmMode) {
  return parseLcmPolicyConfig({
    VOLTCODE_LCM_MODE: mode,
    VOLTCODE_LCM_DOLT_BINDLES_SOFT: MATRIX_BINDLE_SOFT,
    VOLTCODE_LCM_DOLT_BINDLES_DELTA: MATRIX_BINDLE_DELTA,
    VOLTCODE_LCM_DOLT_BINDLES_TARGET: MATRIX_BINDLE_TARGET,
    VOLTCODE_LCM_UPWARD_BINDLES_SOFT: MATRIX_BINDLE_SOFT,
    VOLTCODE_LCM_UPWARD_BINDLES_DELTA: MATRIX_BINDLE_DELTA,
    VOLTCODE_LCM_UPWARD_BINDLES_TARGET: MATRIX_BINDLE_TARGET,
  })
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

function classifyLane(entry: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>[number]): "bindle" | "sprig" | "other" {
  return LcmDb.classifySummaryForDoltLane({
    condensationOrder: entry.condensation_order,
    summaryLevel: entry.summary_level,
    summaryType: entry.summary_type as any,
    kind: null,
  })
}

function contextShape(entries: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>) {
  return entries.map((entry) => {
    if (entry.item_type === "message") {
      return `leaf:${entry.token_count}`
    }
    return `${classifyLane(entry)}:${entry.token_count}`
  })
}

function assertLaneOrder(entries: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>) {
  let currentPhase: "bindles" | "sprigs" | "leaves" = "bindles"

  for (const entry of entries) {
    if (entry.item_type === "message") {
      currentPhase = "leaves"
      continue
    }

    const lane =
      entry.summary_type === "bindle" ? "bindle" : entry.summary_type === "sprig" ? "sprig" : ("other" as const)
    if (lane === "other") {
      throw new Error(`Unexpected summary lane in active context: ${entry.summary_id ?? "unknown"}`)
    }

    if (lane === "bindle") {
      expect(currentPhase).toBe("bindles")
      continue
    }

    expect(currentPhase).not.toBe("leaves")
    currentPhase = "sprigs"
  }
}

function assertLiveTailPreserved(entries: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>) {
  const leaves = entries.filter((entry) => entry.item_type === "message")
  const leafContents = leaves.map((entry) => entry.content)
  expect(leafContents).toContain("tail live leaf A")
  expect(leafContents).toContain("tail live leaf B")
}

async function appendBindleToContext(input: { conversationId: number; label: string }): Promise<string> {
  const sprigA = nextSummaryId()
  const sprigB = nextSummaryId()
  const bindleId = nextSummaryId()

  await LcmDb.insertSprigSummary({
    summaryId: sprigA,
    conversationId: input.conversationId,
    content: `${input.label} sprig A`,
    tokenCount: 4,
    messageIds: [],
  })
  await LcmDb.insertSprigSummary({
    summaryId: sprigB,
    conversationId: input.conversationId,
    content: `${input.label} sprig B`,
    tokenCount: 4,
    messageIds: [],
  })
  await LcmDb.insertBindleSummary({
    summaryId: bindleId,
    conversationId: input.conversationId,
    content: `${input.label} bindle payload for deterministic matrix fixture`,
    tokenCount: 12,
    parentSummaryIds: [sprigA, sprigB],
  })

  await LcmDb.appendMessage({
    conversationId: input.conversationId,
    role: "user",
    content: `placeholder for ${bindleId}`,
    tokenCount: 1,
  })

  const contextBeforeReplacement = await LcmDb.getCurrentContext(input.conversationId)
  const insertedMessagePosition = contextBeforeReplacement.length - 1
  await LcmDb.replaceContextWithSummary({
    conversationId: input.conversationId,
    startPosition: insertedMessagePosition,
    endPosition: insertedMessagePosition,
    summaryId: bindleId,
  })

  return bindleId
}

async function seedComparableFixture(input: { conversationId: number; bindleCount: number }) {
  const bindleIds: string[] = []
  for (let i = 0; i < input.bindleCount; i++) {
    bindleIds.push(
      await appendBindleToContext({
        conversationId: input.conversationId,
        label: `fixture-${i + 1}`,
      }),
    )
  }

  await LcmDb.appendMessage({
    conversationId: input.conversationId,
    role: "user",
    content: "tail live leaf A",
    tokenCount: 2,
  })
  await LcmDb.appendMessage({
    conversationId: input.conversationId,
    role: "assistant",
    content: "tail live leaf B",
    tokenCount: 2,
  })

  return { bindleIds }
}

describe("session.lcm.cross-mode-matrix", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping cross-mode matrix tests", () => {})
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
    setLcmRuntimeStrategyFactoriesForTesting(null)
  })

  test("fails fast on invalid mode configuration", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_MODE: "legacy",
      }),
    ).toThrow("VOLTCODE_LCM_MODE")
  })

  test("deterministic seeded fixtures produce comparable starting context shape", async () => {
    const doltConversationId = await createConversation("[Test] Matrix seed Dolt")
    const upwardConversationId = await createConversation("[Test] Matrix seed Upward")
    await seedComparableFixture({ conversationId: doltConversationId, bindleCount: 3 })
    await seedComparableFixture({ conversationId: upwardConversationId, bindleCount: 3 })

    const doltShape = contextShape(await LcmDb.getCurrentContextWithRefs(doltConversationId))
    const upwardShape = contextShape(await LcmDb.getCurrentContextWithRefs(upwardConversationId))

    expect(doltShape).toEqual(["bindle:12", "bindle:12", "bindle:12", "leaf:2", "leaf:2"])
    expect(upwardShape).toEqual(doltShape)
  })

  test("pressure-triggered compaction enforces ordering/live-tail and mode-specific ghost cue behavior", async () => {
    const originalCondense = Condense.condenseSummaries
    let syntheticCounter = 0
    ;(Condense as any).condenseSummaries = async (input: any) => {
      syntheticCounter += 1
      const inputTokens = input.summaries.reduce((sum: number, summary: any) => sum + summary.tokenCount, 0)
      const summary = Summary.createBindle(
        {
          content: `matrix synthetic d${input.condensationOrder} #${syntheticCounter}`,
          tokenCount: Math.max(1, Math.floor(inputTokens / 2)),
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
      for (const mode of ["dolt", "upward"] as const) {
        setLcmPolicyConfigForTesting(makeMatrixPolicy(mode))
        const conversationId = await createConversation(`[Test] Matrix threshold ${mode}`)
        const seeded = await seedComparableFixture({ conversationId, bindleCount: 3 })

        const strategy = getActiveLcmRuntimeStrategy()
        expect(strategy.name).toBe(mode)

        const result = await strategy.compactOnThreshold({
          conversationId,
          sessionID: `matrix-threshold-${mode}`,
          user: makeCompactionUser(`matrix-threshold-${mode}`),
          model: makeCompactionModel(),
          overhead: 0,
          reserve: 0,
          contextWindow: 1000,
        })

        expect(result.actionTaken).toBe(true)
        const context = await LcmDb.getCurrentContextWithRefs(conversationId)
        assertLaneOrder(context)
        assertLiveTailPreserved(context)

        const conn = LcmDb.getConnection()
        const archiveStubCount = await conn<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM summaries
          WHERE conversation_id = ${conversationId}
            AND summary_type = 'archive_stub'
        `

        if (mode === "dolt") {
          expect((result.evictedBindleIds ?? []).length).toBeGreaterThan(0)
          expect(result.evictedBindleIds ?? []).toContain(seeded.bindleIds[0])
          expect((result.archiveStubIds ?? []).length).toBeGreaterThan(0)
          expect(archiveStubCount[0]?.count ?? 0).toBeGreaterThan(0)
        } else {
          expect((result.archiveStubIds ?? []).length).toBe(0)
          expect(archiveStubCount[0]?.count ?? 0).toBe(0)
        }
      }
    } finally {
      ;(Condense as any).condenseSummaries = originalCondense
    }
  })

  test("manual compact dispatch is mode-aware (dolt executes, upward reports explicit no-op when no legal group)", async () => {
    setLcmPolicyConfigForTesting(makeMatrixPolicy("dolt"))
    const doltConversationId = await createConversation("[Test] Matrix manual Dolt")
    await seedComparableFixture({ conversationId: doltConversationId, bindleCount: 3 })
    const doltStrategy = getActiveLcmRuntimeStrategy()
    const doltResult = await doltStrategy.compactManual({
      conversationId: doltConversationId,
      sessionID: "matrix-manual-dolt",
      user: makeCompactionUser("matrix-manual-dolt"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })
    expect(doltStrategy.name).toBe("dolt")
    expect(doltResult.actionTaken).toBe(true)

    setLcmPolicyConfigForTesting(makeMatrixPolicy("upward"))
    const upwardConversationId = await createConversation("[Test] Matrix manual Upward no-op")
    await LcmDb.appendMessage({
      conversationId: upwardConversationId,
      role: "user",
      content: "single leaf; no legal manual group",
      tokenCount: 2,
    })
    const upwardStrategy = getActiveLcmRuntimeStrategy()
    const upwardResult = await upwardStrategy.compactManual({
      conversationId: upwardConversationId,
      sessionID: "matrix-manual-upward",
      user: makeCompactionUser("matrix-manual-upward"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })
    expect(upwardStrategy.name).toBe("upward")
    expect(upwardResult.actionTaken).toBe(false)
    expect(upwardResult.noOpReasons).toContain("no_legal_compaction_group")
  })

  test("retrieval contract stays stable across modes with mode-specific behavior", async () => {
    setLcmPolicyConfigForTesting(makeMatrixPolicy("dolt"))
    const doltStrategy = getActiveLcmRuntimeStrategy()
    const summaryId = "sum_00000000000000aa"
    const db: LcmRetrieval.RetrievalDb = {
      async getActiveContextSummaryIds() {
        return []
      },
      async getOffContextSummaries() {
        return [
          {
            summary_id: summaryId,
            conversation_id: 501,
            kind: "bindle",
            summary_level: "bindle",
            condensation_order: 2,
            summary_type: "bindle",
            content: "archived memory payload",
            token_count: 12,
            file_ids: [],
            qmd_doc_id: null,
            qmd_doc_version: null,
            is_off_context: true,
            created_at: new Date("2026-02-24T00:00:00.000Z"),
          } as any,
        ]
      },
      async getSummaryParentIds() {
        return []
      },
      async getSummaryLineagePointers() {
        return []
      },
      async getSummaryLineageIds() {
        return [summaryId]
      },
      async getLeafMessagesForSummary() {
        return [
          {
            message_id: 8101,
            conversation_id: 501,
            seq: 1,
            role: "user",
            content: "leaf memory for cross-mode matrix retrieval test",
            token_count: 8,
            created_at: new Date("2026-02-24T00:00:00.000Z"),
          },
        ]
      },
      async setSummaryQmdDocMapping() {},
    }

    const doltResult = await doltStrategy.resolveRetrieval({
      conversationId: 501,
      query: "archived memory",
      topK: 3,
      db,
      qmdClient: {
        async ensureCollection() {},
        async updateIndex() {},
        async embedIndex() {},
        async vectorSearch() {
          return [{ docid: "#a1", score: 0.93, file: "qmd://off-context-bindles/a1.md", title: summaryId }]
        },
      },
    })
    expect(doltResult.hits.map((hit) => hit.summaryId)).toEqual([summaryId])
    expect(doltResult.diagnostics).toEqual([])

    setLcmPolicyConfigForTesting(makeMatrixPolicy("upward"))
    const upwardStrategy = getActiveLcmRuntimeStrategy()
    const upwardResult = await upwardStrategy.resolveRetrieval({
      conversationId: 777,
      query: "old archived memory",
    })
    expect(upwardResult.hits).toEqual([])
    expect(upwardResult.candidatesConsidered).toBe(0)
    expect(upwardResult.diagnostics).toEqual([
      expect.objectContaining({
        code: "off_context_unavailable",
      }),
    ])
  })
})
