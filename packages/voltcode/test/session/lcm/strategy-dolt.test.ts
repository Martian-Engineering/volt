import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmDb } from "../../../src/session/lcm/db"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import {
  getActiveLcmRuntimeStrategy,
  setLcmRuntimeStrategyFactoriesForTesting,
} from "../../../src/session/lcm/strategy"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

function makeDoltPolicyForAdapterTests() {
  return parseLcmPolicyConfig({
    VOLTCODE_LCM_MODE: "dolt",
    VOLTCODE_LCM_DOLT_BINDLES_SOFT: "15",
    VOLTCODE_LCM_DOLT_BINDLES_DELTA: "1",
    VOLTCODE_LCM_DOLT_BINDLES_TARGET: "12",
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

function classifyLane(
  entry: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>[number],
): "bindle" | "sprig" | "other" {
  return LcmDb.classifySummaryForDoltLane({
    condensationOrder: entry.condensation_order,
    summaryLevel: entry.summary_level,
    summaryType: entry.summary_type as any,
    kind: null,
  })
}

function assertLaneOrder(entries: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>) {
  let currentPhase: "bindles" | "sprigs" | "leaves" = "bindles"

  for (const entry of entries) {
    if (entry.item_type === "message") {
      currentPhase = "leaves"
      continue
    }

    const lane = classifyLane(entry)
    if (lane === "other") {
      throw new Error(`Unexpected non-Dolt summary lane in active context: ${entry.summary_id ?? "unknown"}`)
    }

    if (lane === "bindle") {
      expect(currentPhase).toBe("bindles")
      continue
    }

    expect(currentPhase).not.toBe("leaves")
    currentPhase = "sprigs"
  }
}

function contextShape(entries: Awaited<ReturnType<typeof LcmDb.getCurrentContextWithRefs>>) {
  return entries.map((entry) => {
    if (entry.item_type === "message") {
      return `leaf:${entry.token_count}`
    }
    return `${classifyLane(entry)}:${entry.token_count}`
  })
}

async function appendBindleToContext(input: { conversationId: number; label: string }): Promise<string> {
  const leaf1 = nextSummaryId()
  const leaf2 = nextSummaryId()
  const bindleId = nextSummaryId()

  await LcmDb.insertSprigSummary({
    summaryId: leaf1,
    conversationId: input.conversationId,
    content: `${input.label} sprig 1`,
    tokenCount: 4,
    messageIds: [],
  })
  await LcmDb.insertSprigSummary({
    summaryId: leaf2,
    conversationId: input.conversationId,
    content: `${input.label} sprig 2`,
    tokenCount: 4,
    messageIds: [],
  })
  await LcmDb.insertBindleSummary({
    summaryId: bindleId,
    conversationId: input.conversationId,
    content: `${input.label} bindle payload for adapter parity`,
    tokenCount: 12,
    parentSummaryIds: [leaf1, leaf2],
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

async function seedBindleOverflowFixture(input: { conversationId: number; bindleCount: number }) {
  const bindleIds: string[] = []
  for (let i = 0; i < input.bindleCount; i++) {
    bindleIds.push(
      await appendBindleToContext({
        conversationId: input.conversationId,
        label: `seed-${i + 1}`,
      }),
    )
  }

  await LcmDb.appendMessage({
    conversationId: input.conversationId,
    role: "assistant",
    content: "tail leaf message that should stay in active context",
    tokenCount: 2,
  })

  return { bindleIds }
}

describe("session.lcm.strategy.dolt-adapter", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping Dolt strategy adapter tests", () => {})
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

  test("matches threshold compaction outcome from active Dolt path on seeded fixtures", async () => {
    setLcmPolicyConfigForTesting(makeDoltPolicyForAdapterTests())

    const baselineConversationId = await createConversation("[Test] Dolt adapter threshold baseline")
    const strategyConversationId = await createConversation("[Test] Dolt adapter threshold strategy")
    const baselineFixture = await seedBindleOverflowFixture({ conversationId: baselineConversationId, bindleCount: 2 })
    const strategyFixture = await seedBindleOverflowFixture({ conversationId: strategyConversationId, bindleCount: 2 })

    const baselineResult = await LcmContext.onContextThresholdReached({
      conversationId: baselineConversationId,
      sessionID: "threshold-baseline",
      user: makeCompactionUser("threshold-baseline"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("dolt")
    const strategyResult = await strategy.compactOnThreshold({
      conversationId: strategyConversationId,
      sessionID: "threshold-strategy",
      user: makeCompactionUser("threshold-strategy"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })

    expect(baselineResult.actionTaken).toBe(true)
    expect(strategyResult.actionTaken).toBe(baselineResult.actionTaken)
    expect(strategyResult.condensed).toBe(baselineResult.condensed)
    expect(strategyResult.messagesSummarized ?? 0).toBe(baselineResult.messagesSummarized ?? 0)
    expect(baselineResult.evictedBindleIds).toEqual([baselineFixture.bindleIds[0]])
    expect(strategyResult.evictedBindleIds).toEqual([strategyFixture.bindleIds[0]])
    expect(strategyResult.archiveStubIds?.length).toBe(baselineResult.archiveStubIds?.length)

    const baselineContext = await LcmDb.getCurrentContextWithRefs(baselineConversationId)
    const strategyContext = await LcmDb.getCurrentContextWithRefs(strategyConversationId)
    expect(contextShape(strategyContext)).toEqual(contextShape(baselineContext))
    assertLaneOrder(baselineContext)
    assertLaneOrder(strategyContext)
  })

  test("matches manual /compact outcome and preserves lane ordering", async () => {
    setLcmPolicyConfigForTesting(makeDoltPolicyForAdapterTests())

    const baselineConversationId = await createConversation("[Test] Dolt adapter manual baseline")
    const strategyConversationId = await createConversation("[Test] Dolt adapter manual strategy")
    const baselineFixture = await seedBindleOverflowFixture({ conversationId: baselineConversationId, bindleCount: 3 })
    const strategyFixture = await seedBindleOverflowFixture({ conversationId: strategyConversationId, bindleCount: 3 })

    const baselineResult = await LcmContext.compactShortBindle({
      conversationId: baselineConversationId,
      sessionID: "manual-baseline",
      user: makeCompactionUser("manual-baseline"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("dolt")
    const strategyResult = await strategy.compactManual({
      conversationId: strategyConversationId,
      sessionID: "manual-strategy",
      user: makeCompactionUser("manual-strategy"),
      model: makeCompactionModel(),
      overhead: 0,
      reserve: 0,
      contextWindow: 1000,
    })

    expect(baselineResult.actionTaken).toBe(true)
    expect(strategyResult.actionTaken).toBe(baselineResult.actionTaken)
    expect(strategyResult.condensed).toBe(baselineResult.condensed)
    expect(strategyResult.messagesSummarized ?? 0).toBe(baselineResult.messagesSummarized ?? 0)
    expect(baselineResult.evictedBindleIds).toEqual([baselineFixture.bindleIds[0]])
    expect(strategyResult.evictedBindleIds).toEqual([strategyFixture.bindleIds[0]])
    expect(strategyResult.noOpReasons).toEqual(baselineResult.noOpReasons)

    const baselineContext = await LcmDb.getCurrentContextWithRefs(baselineConversationId)
    const strategyContext = await LcmDb.getCurrentContextWithRefs(strategyConversationId)
    expect(contextShape(strategyContext)).toEqual(contextShape(baselineContext))
    assertLaneOrder(baselineContext)
    assertLaneOrder(strategyContext)
  })
})
