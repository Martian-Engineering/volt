import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { LcmDb } from "../../../src/session/lcm/db"
import { LcmRetrieval } from "../../../src/session/lcm/retrieval"

function sid(hex: string): string {
  return `sum_${hex.padStart(16, "0")}`
}

function makeSummary(input: {
  summaryId: string
  summaryType?: LcmDb.SummaryType
  summaryLevel?: LcmDb.SummaryLevel
  isOffContext?: boolean
  content?: string
}): LcmDb.Summary {
  return {
    summary_id: input.summaryId,
    conversation_id: 101,
    kind: input.summaryLevel === "leaf" ? "leaf" : "condensed",
    summary_level: input.summaryLevel ?? "bindle",
    summary_type: input.summaryType ?? "bindle",
    content: input.content ?? `content for ${input.summaryId}`,
    token_count: 10,
    file_ids: [],
    qmd_doc_id: null,
    qmd_doc_version: null,
    is_off_context: input.isOffContext ?? true,
    created_at: new Date("2026-02-18T00:00:00.000Z"),
  }
}

function makeFakeDb(input: {
  summaries: LcmDb.Summary[]
  activeSummaryIds?: string[]
  parentsBySummaryId?: Record<string, string[]>
  pointersBySummaryId?: Record<string, LcmDb.SummaryLineagePointer[]>
  lineageBySummaryId?: Record<string, string[]>
}): LcmRetrieval.RetrievalDb & { mappings: Map<string, { qmdDocId: string | null; qmdDocVersion: number | null }> } {
  const summaries = new Map(input.summaries.map((summary) => [summary.summary_id, { ...summary }]))
  const activeSummaryIds = new Set(input.activeSummaryIds ?? [])
  const parentsBySummaryId = input.parentsBySummaryId ?? {}
  const pointersBySummaryId = input.pointersBySummaryId ?? {}
  const lineageBySummaryId = input.lineageBySummaryId ?? {}
  const mappings = new Map<string, { qmdDocId: string | null; qmdDocVersion: number | null }>()

  return {
    mappings,
    async getActiveContextSummaryIds() {
      return Array.from(activeSummaryIds)
    },
    async getOffContextSummaries(query) {
      return Array.from(summaries.values()).filter(
        (summary) =>
          summary.is_off_context &&
          (!query.summaryLevel || query.summaryLevel === summary.summary_level),
      )
    },
    async getSummaryParentIds(summaryId) {
      return [...(parentsBySummaryId[summaryId] ?? [])]
    },
    async getSummaryLineagePointers(summaryId) {
      return [...(pointersBySummaryId[summaryId] ?? [])]
    },
    async getSummaryLineageIds(summaryId) {
      return [...(lineageBySummaryId[summaryId] ?? [summaryId])]
    },
    async setSummaryQmdDocMapping(input) {
      const summary = summaries.get(input.summaryId)
      if (summary) {
        summary.qmd_doc_id = input.qmdDocId
        summary.qmd_doc_version = input.qmdDocVersion ?? null
      }
      mappings.set(input.summaryId, {
        qmdDocId: input.qmdDocId,
        qmdDocVersion: input.qmdDocVersion ?? null,
      })
    },
  }
}

function makeFakeQmdClient(hits: Array<{ docid: string; score: number; file: string; title: string }>): LcmRetrieval.QmdClient {
  return {
    async ensureCollection() {},
    async updateIndex() {},
    async embedIndex() {},
    async vectorSearch() {
      return hits
    },
  }
}

describe("session.lcm.retrieval", () => {
  test("returns deterministic default top-3 off-context bindles with lineage pointers and active exclusion", async () => {
    const leaf1 = sid("a1")
    const leaf2 = sid("a2")
    const bindleA = sid("b1")
    const bindleB = sid("b2")
    const bindleC = sid("b3")
    const activeBindle = sid("b4")
    const offContextLeaf = sid("l1")

    const db = makeFakeDb({
      summaries: [
        makeSummary({ summaryId: bindleA, summaryType: "bindle", summaryLevel: "bindle", isOffContext: true }),
        makeSummary({ summaryId: bindleB, summaryType: "bindle", summaryLevel: "bindle", isOffContext: true }),
        makeSummary({ summaryId: bindleC, summaryType: "archive_stub", summaryLevel: "bindle", isOffContext: true }),
        makeSummary({ summaryId: activeBindle, summaryType: "bindle", summaryLevel: "bindle", isOffContext: true }),
        makeSummary({ summaryId: offContextLeaf, summaryType: "leaf", summaryLevel: "leaf", isOffContext: true }),
      ],
      activeSummaryIds: [activeBindle],
      parentsBySummaryId: {
        [bindleA]: [leaf1, leaf2],
      },
      lineageBySummaryId: {
        [bindleA]: [bindleA, leaf1, leaf2],
        [bindleB]: [bindleB],
        [bindleC]: [bindleC, bindleA],
      },
    })

    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcm-retrieval-"))
    try {
      const result = await LcmRetrieval.queryOffContextBindles({
        conversationId: 101,
        query: "memory about bindles",
        db,
        artifactsRoot,
        qmdClient: makeFakeQmdClient([
          { docid: "#active", score: 0.99, file: "qmd://off-context-bindles/active.md", title: activeBindle },
          { docid: "#a1", score: 0.94, file: "qmd://off-context-bindles/a.md", title: bindleA },
          { docid: "#b1", score: 0.92, file: "qmd://off-context-bindles/b.md", title: bindleB },
          { docid: "#c1", score: 0.91, file: "qmd://off-context-bindles/c.md", title: bindleC },
        ]),
      })

      expect(result.hits.length).toBe(3)
      expect(result.hits.map((hit) => hit.summaryId)).toEqual([bindleA, bindleB, bindleC])
      expect(result.hits.find((hit) => hit.summaryId === activeBindle)).toBeUndefined()
      expect(result.hits.every((hit) => hit.summaryId !== offContextLeaf)).toBe(true)

      const first = result.hits[0]
      expect(first.score).toBe(0.94)
      expect(first.distance).toBeGreaterThan(0)
      expect(first.qmdDocId).toBe("#a1")
      expect(first.pointerSummaryIds).toEqual([leaf1, leaf2])
      expect(first.lineageSummaryIds).toEqual([leaf1, leaf2, bindleA])

      expect(db.mappings.get(bindleA)).toEqual({ qmdDocId: "#a1", qmdDocVersion: 1 })
      expect(db.mappings.get(bindleB)).toEqual({ qmdDocId: "#b1", qmdDocVersion: 1 })
      expect(db.mappings.get(bindleC)).toEqual({ qmdDocId: "#c1", qmdDocVersion: 1 })
    } finally {
      await fs.rm(artifactsRoot, { recursive: true, force: true })
    }
  })

  test("applies score and distance thresholds and breaks score ties by summary ID", async () => {
    const bindle1 = sid("10")
    const bindle2 = sid("11")
    const bindle3 = sid("12")
    const db = makeFakeDb({
      summaries: [
        makeSummary({ summaryId: bindle1, isOffContext: true }),
        makeSummary({ summaryId: bindle2, isOffContext: true }),
        makeSummary({ summaryId: bindle3, isOffContext: true }),
      ],
    })

    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcm-retrieval-"))
    try {
      const result = await LcmRetrieval.queryOffContextBindles({
        conversationId: 101,
        query: "tie and threshold test",
        topK: 5,
        minScore: 0.75,
        maxDistance: 0.3,
        db,
        artifactsRoot,
        qmdClient: makeFakeQmdClient([
          { docid: "#x2", score: 0.8, file: "qmd://off-context-bindles/x2.md", title: bindle2 },
          { docid: "#x1", score: 0.8, file: "qmd://off-context-bindles/x1.md", title: bindle1 },
          { docid: "#x3", score: 0.76, file: "qmd://off-context-bindles/x3.md", title: bindle3 },
        ]),
      })

      expect(result.hits.length).toBe(2)
      expect(result.hits.map((hit) => hit.summaryId)).toEqual([bindle1, bindle2])
      expect(result.hits.every((hit) => hit.score >= 0.75)).toBe(true)
      expect(result.hits.every((hit) => hit.distance <= 0.3)).toBe(true)
    } finally {
      await fs.rm(artifactsRoot, { recursive: true, force: true })
    }
  })
})
