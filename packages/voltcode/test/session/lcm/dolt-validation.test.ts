import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SessionPrompt } from "../../../src/session/prompt"
import { TokenBudget } from "../../../src/session/token-budget"
import { LcmDb } from "../../../src/session/lcm/db"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmRetrieval } from "../../../src/session/lcm/retrieval"
import { Summary } from "../../../src/session/lcm/summary"

function sid(hex: string): string {
  return `sum_${hex.padStart(16, "0")}`
}

function makeSummary(input: {
  summaryId: string
  summaryLevel?: LcmDb.SummaryLevel
  condensationOrder?: number
  summaryType?: LcmDb.SummaryType
  isOffContext?: boolean
}): LcmDb.Summary {
  const condensationOrder =
    input.condensationOrder ??
    (input.summaryLevel === "sprig"
      ? 1
      : input.summaryLevel === "bindle"
        ? 2
        : input.summaryLevel?.startsWith("d")
          ? Number.parseInt(input.summaryLevel.slice(1), 10)
          : 2)
  const summaryLevel =
    input.summaryLevel ?? (condensationOrder === 1 ? "sprig" : condensationOrder === 2 ? "bindle" : (`d${condensationOrder}` as LcmDb.SummaryLevel))
  return {
    summary_id: input.summaryId,
    conversation_id: 1001,
    kind: condensationOrder === 1 ? "sprig" : "bindle",
    summary_level: summaryLevel,
    condensation_order: condensationOrder,
    summary_type: input.summaryType ?? "bindle",
    content: `summary content for ${input.summaryId}`,
    token_count: 12,
    file_ids: [],
    qmd_doc_id: null,
    qmd_doc_version: null,
    is_off_context: input.isOffContext ?? true,
    created_at: new Date("2026-02-18T00:00:00.000Z"),
  }
}

describe("dolt v1 validation suite", () => {
  test("preserves level/type invariants for sprig, bindle, and archive-stub summaries", () => {
    const sprig = Summary.createSprig({
      content: "sprig body",
      tokenCount: 10,
      conversationId: "conv-1",
      messageIds: ["m1", "m2"],
    })
    const bindle = Summary.createBindle({
      content: "bindle body",
      tokenCount: 8,
      conversationId: "conv-1",
      parents: [sprig.summaryId],
    })
    const stub = Summary.createArchiveStub({
      archivedSummaryId: bindle.summaryId,
      archivedSummaryContent: "A long bindle body that becomes a short retrieval cue.",
      conversationId: "conv-1",
    })

    expect(sprig.level).toBe("sprig")
    expect(sprig.summaryType).toBe("sprig")
    expect(bindle.level).toBe("bindle")
    expect(bindle.summaryType).toBe("bindle")
    expect(stub.level).toBe("bindle")
    expect(stub.summaryType).toBe("archive_stub")
  })

  test("fails fast when unknown level labels reach Dolt lane classification", () => {
    expect(() =>
      LcmDb.classifySummaryForDoltLane({
        condensationOrder: null,
        summaryLevel: "mystery",
        summaryType: "bindle",
        kind: "bindle",
      }),
    ).toThrow("LcmDbInvariantError")
    expect(() =>
      LcmDb.classifySummaryForDoltLane({
        condensationOrder: null,
        summaryLevel: "mystery",
        summaryType: "bindle",
        kind: "bindle",
      }),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({
          message: expect.stringContaining("Unknown summary level label"),
        }),
      }),
    )
  })

  test("applies hysteresis bands (no-op at boundary, compacts above upper band)", () => {
    const policy: TokenBudget.DoltLanePolicy = {
      leaves: { cap: 1000, soft: 800, delta: 100, target: 780, minFanout: 2, freshTailFloor: 4 },
      sprigs: { soft: 200, delta: 20, target: 180, minFanout: 2 },
      bindles: { soft: 100, delta: 10, target: 90, minFanout: 2 },
      hardLimitRiskBuffer: 0,
    }

    const atBoundary = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { leaves: 900, sprigs: 220, bindles: 110, total: 900 },
      policy,
      hardLimit: 1000,
    })
    expect(atBoundary.compactAny).toBe(false)

    const aboveUpperBand = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { leaves: 901, sprigs: 221, bindles: 111, total: 901 },
      policy,
      hardLimit: 1000,
    })
    expect(aboveUpperBand.leaves.shouldCompact).toBe(true)
    expect(aboveUpperBand.sprigs.shouldCompact).toBe(true)
    expect(aboveUpperBand.bindles.shouldCompact).toBe(true)
  })

  test("keeps fresh tail leaves live during L0->L1 selection", () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      position: index,
      messageId: index + 1,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn-${index}`,
      tokenCount: 100,
    }))

    const selection = LcmContext.selectLeavesForSprigCompaction({
      messages,
      tokenBudget: 10_000,
      protectedTailCount: 2,
    })

    expect(selection.selectedMessages.map((msg) => msg.position)).toEqual([0, 1, 2, 3, 4])
    expect(selection.protectedTailMessages.map((msg) => msg.position)).toEqual([5, 6])
  })

  test("excludes active summaries from pre-response cue injection", () => {
    const cueBlock = SessionPrompt.formatPreResponseMemoryCueBlock({
      activeSummaryIds: [sid("aa")],
      hits: [
        {
          summaryId: sid("aa"),
          summaryType: "bindle",
          cueText: "active cue",
          score: 0.95,
          distance: 0.05,
          qmdDocId: "#active",
          pointerSummaryIds: [],
          lineageSummaryIds: [],
        },
        {
          summaryId: sid("bb"),
          summaryType: "archive_stub",
          cueText: "off-context cue",
          score: 0.9,
          distance: 0.1,
          qmdDocId: "#bb",
          pointerSummaryIds: [sid("cc")],
          lineageSummaryIds: [sid("bb"), sid("cc")],
        },
      ],
      topK: 3,
    })

    expect(cueBlock).toBeTruthy()
    expect(cueBlock).not.toContain(sid("aa"))
    expect(cueBlock).toContain(sid("bb"))
  })

  test("retrieval stays on bindle lane, filters off-context candidates, and orders deterministic top-K", async () => {
    const bindleA = sid("11")
    const bindleB = sid("12")
    const bindleLive = sid("13")
    const leafOffContext = sid("14")
    const summaries = [
      makeSummary({ summaryId: bindleA, summaryLevel: "bindle", summaryType: "bindle", isOffContext: true }),
      makeSummary({ summaryId: bindleB, summaryLevel: "bindle", summaryType: "bindle", isOffContext: true }),
      makeSummary({ summaryId: bindleLive, summaryLevel: "bindle", summaryType: "bindle", isOffContext: false }),
      makeSummary({ summaryId: leafOffContext, summaryLevel: "sprig", summaryType: "sprig", isOffContext: true }),
    ]

    let requestedSummaryLevel: LcmDb.SummaryLevel | undefined
    const db: LcmRetrieval.RetrievalDb = {
      async getActiveContextSummaryIds() {
        return []
      },
      async getOffContextSummaries(input) {
        requestedSummaryLevel = input.summaryLevel
        return summaries.filter(
          (summary) =>
            summary.is_off_context &&
            (input.summaryLevel == null || input.summaryLevel === summary.summary_level),
        )
      },
      async getSummaryParentIds() {
        return []
      },
      async getSummaryLineagePointers() {
        return []
      },
      async getSummaryLineageIds(summaryId) {
        return [summaryId]
      },
      async setSummaryQmdDocMapping() {},
    }

    const qmdClient: LcmRetrieval.QmdClient = {
      async ensureCollection() {},
      async updateIndex() {},
      async embedIndex() {},
      async vectorSearch() {
        return [
          { docid: "#b", score: 0.8, file: "qmd://off-context-bindles/b.md", title: bindleB },
          { docid: "#a", score: 0.8, file: "qmd://off-context-bindles/a.md", title: bindleA },
          { docid: "#sprig", score: 0.99, file: "qmd://off-context-bindles/sprig.md", title: leafOffContext },
          { docid: "#live", score: 0.95, file: "qmd://off-context-bindles/live.md", title: bindleLive },
        ]
      },
    }

    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dolt-validation-"))
    try {
      const result = await LcmRetrieval.queryOffContextBindles({
        conversationId: 1001,
        query: "dolt retrieval check",
        topK: 2,
        minScore: 0.75,
        db,
        qmdClient,
        artifactsRoot,
      })

      expect(requestedSummaryLevel).toBe("bindle")
      expect(result.candidatesConsidered).toBe(2)
      expect(result.hits.map((hit) => hit.summaryId)).toEqual([bindleA, bindleB])
      expect(result.hits.every((hit) => hit.summaryType === "bindle")).toBe(true)
    } finally {
      await fs.rm(artifactsRoot, { recursive: true, force: true })
    }
  })
})
