import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { LcmContext } from "../../../src/session/lcm/context"
import type { LcmDb } from "../../../src/session/lcm/db"
import type { LcmRetrieval } from "../../../src/session/lcm/retrieval"
import {
  getActiveLcmRuntimeStrategy,
  isThresholdCompactionInFlight,
  scheduleThresholdCompaction,
  setLcmRuntimeStrategyFactoriesForTesting,
  type LcmRuntimeStrategy,
} from "../../../src/session/lcm/strategy"

const basePolicy = parseLcmPolicyConfig({})

function makePolicy(mode: string) {
  return {
    ...basePolicy,
    mode,
  } as any
}

function makeStubStrategy(input: {
  name: "dolt" | "upward"
  compactOnThreshold?: LcmRuntimeStrategy["compactOnThreshold"]
  compactManual?: LcmRuntimeStrategy["compactManual"]
}): LcmRuntimeStrategy {
  return {
    name: input.name,
    compactOnThreshold:
      input.compactOnThreshold ??
      (async () => ({
        actionTaken: false,
        condensed: false,
      })),
    compactManual:
      input.compactManual ??
      (async () => ({
        actionTaken: false,
        condensed: false,
      })),
    assembleContext: async () => [],
    resolveRetrieval: async (request) => ({
      query: request.query,
      topK: request.topK ?? 3,
      minScore: request.minScore ?? 0.3,
      maxDistance: request.maxDistance,
      candidatesConsidered: 0,
      hits: [],
      diagnostics: [],
    }),
  }
}

afterEach(() => {
  setLcmRuntimeStrategyFactoriesForTesting(null)
  setLcmPolicyConfigForTesting(null)
})

describe("LCM runtime strategy", () => {
  test("dispatches dolt mode to dolt strategy", async () => {
    let doltCalls = 0
    let upwardCalls = 0

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactOnThreshold: async () => {
            doltCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
      upward: () =>
        makeStubStrategy({
          name: "upward",
          compactOnThreshold: async () => {
            upwardCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("dolt"))

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("dolt")

    await strategy.compactOnThreshold({} as any)
    expect(doltCalls).toBe(1)
    expect(upwardCalls).toBe(0)
  })

  test("dispatches upward mode to upward strategy", async () => {
    let doltCalls = 0
    let upwardCalls = 0

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactOnThreshold: async () => {
            doltCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
      upward: () =>
        makeStubStrategy({
          name: "upward",
          compactOnThreshold: async () => {
            upwardCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("upward"))

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("upward")

    await strategy.compactOnThreshold({} as any)
    expect(upwardCalls).toBe(1)
    expect(doltCalls).toBe(0)
  })

  test("dispatches upward manual compaction to upward strategy", async () => {
    let doltManualCalls = 0
    let upwardManualCalls = 0

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactManual: async () => {
            doltManualCalls += 1
            return { actionTaken: true, condensed: true }
          },
        }),
      upward: () =>
        makeStubStrategy({
          name: "upward",
          compactManual: async () => {
            upwardManualCalls += 1
            return { actionTaken: true, condensed: true }
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("upward"))

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("upward")

    await strategy.compactManual({} as any)
    expect(upwardManualCalls).toBe(1)
    expect(doltManualCalls).toBe(0)
  })

  test("routes upward threshold compaction through forced-recursive handler", async () => {
    setLcmRuntimeStrategyFactoriesForTesting(null)
    setLcmPolicyConfigForTesting(makePolicy("upward"))

    const originalIsOverThreshold = LcmContext.isOverThreshold
    const originalForcedRecursive = LcmContext.compactForcedRecursive
    const originalDoltThreshold = LcmContext.onContextThresholdReached
    let forcedRecursiveCalls = 0
    let doltThresholdCalls = 0

    ;(LcmContext as any).isOverThreshold = async () => ({
      overHard: false,
      overSoft: true,
      currentTokens: 1200,
      hardLimit: 1000,
      softThreshold: 600,
      lanePolicy: {} as any,
      laneTokens: {} as any,
      laneDecisions: {} as any,
    })
    ;(LcmContext as any).compactForcedRecursive = async () => {
      forcedRecursiveCalls += 1
      return { actionTaken: true, condensed: true }
    }
    ;(LcmContext as any).onContextThresholdReached = async () => {
      doltThresholdCalls += 1
      return { actionTaken: true, condensed: false }
    }

    try {
      const strategy = getActiveLcmRuntimeStrategy()
      const result = await strategy.compactOnThreshold({
        conversationId: 42,
        overhead: 0,
        reserve: 0,
        contextWindow: 1000,
      } as any)
      expect(strategy.name).toBe("upward")
      expect(result.condensed).toBe(true)
      expect(forcedRecursiveCalls).toBe(1)
      expect(doltThresholdCalls).toBe(0)
    } finally {
      ;(LcmContext as any).isOverThreshold = originalIsOverThreshold
      ;(LcmContext as any).compactForcedRecursive = originalForcedRecursive
      ;(LcmContext as any).onContextThresholdReached = originalDoltThreshold
    }
  })

  test("fails fast on unsupported mode", () => {
    setLcmPolicyConfigForTesting(makePolicy("legacy"))
    expect(() => getActiveLcmRuntimeStrategy()).toThrow("Unsupported LCM runtime mode")
  })

  test("de-duplicates in-flight threshold compaction per conversation", async () => {
    let resolveCompaction!: (value: { actionTaken: boolean; condensed: boolean }) => void

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactOnThreshold: async () => {
            return await new Promise<{ actionTaken: boolean; condensed: boolean }>((resolve) => {
              resolveCompaction = resolve
            })
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("dolt"))

    const first = scheduleThresholdCompaction({ conversationId: 42 } as any)
    expect(first).not.toBeNull()
    expect(isThresholdCompactionInFlight(42)).toBe(true)

    const second = scheduleThresholdCompaction({ conversationId: 42 } as any)
    expect(second).toBeNull()

    resolveCompaction({ actionTaken: false, condensed: false })
    await first

    expect(isThresholdCompactionInFlight(42)).toBe(false)
  })

  test("routes Dolt retrieval through the shared strategy entrypoint", async () => {
    setLcmPolicyConfigForTesting(makePolicy("dolt"))
    const strategy = getActiveLcmRuntimeStrategy()

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
          } satisfies LcmDb.Summary,
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
            message_id: 8001,
            conversation_id: 501,
            seq: 1,
            role: "user",
            content: "leaf memory for strategy retrieval test",
            token_count: 8,
            created_at: new Date("2026-02-24T00:00:00.000Z"),
          },
        ]
      },
      async setSummaryQmdDocMapping() {},
    }

    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcm-strategy-retrieval-"))
    try {
      const result = await strategy.resolveRetrieval({
        conversationId: 501,
        query: "archived memory",
        topK: 3,
        db,
        artifactsRoot,
        qmdClient: {
          async ensureCollection() {},
          async updateIndex() {},
          async embedIndex() {},
          async vectorSearch() {
            return [{ docid: "#a1", score: 0.93, file: "qmd://off-context-bindles/a1.md", title: summaryId }]
          },
        },
      })

      expect(result.hits.map((hit) => hit.summaryId)).toEqual([summaryId])
      expect(result.diagnostics).toEqual([])
    } finally {
      await fs.rm(artifactsRoot, { recursive: true, force: true })
    }
  })

  test("returns explicit no-result diagnostics for Upward off-context retrieval", async () => {
    setLcmPolicyConfigForTesting(makePolicy("upward"))
    const strategy = getActiveLcmRuntimeStrategy()

    const result = await strategy.resolveRetrieval({
      conversationId: 777,
      query: "old archived memory",
    })

    expect(result.hits).toEqual([])
    expect(result.candidatesConsidered).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "off_context_unavailable",
      }),
    ])
  })
})
