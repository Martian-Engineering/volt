import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { LcmDb } from "../../../src/session/lcm/db"
import { LcmRetrievalFacade } from "../../../src/session/lcm/retrieval-facade"
import type { LcmRetrieval } from "../../../src/session/lcm/retrieval"

function sid(hex: string): string {
  return `sum_${hex.padStart(16, "0")}`
}

function makeSummary(input: {
  summaryId: string
  conversationId?: number
  isOffContext?: boolean
  summaryType?: LcmDb.SummaryType
}): LcmDb.Summary {
  return {
    summary_id: input.summaryId,
    conversation_id: input.conversationId ?? 3001,
    kind: "bindle",
    summary_level: "bindle",
    condensation_order: 2,
    summary_type: input.summaryType ?? "bindle",
    content: `content for ${input.summaryId}`,
    token_count: 14,
    file_ids: [],
    qmd_doc_id: null,
    qmd_doc_version: null,
    is_off_context: input.isOffContext ?? true,
    created_at: new Date("2026-02-24T00:00:00.000Z"),
  }
}

describe("session.lcm.retrieval-facade", () => {
  test("resolves Dolt off-context retrieval with shared QueryResult shape", async () => {
    const summaryId = sid("aa")
    const db: LcmRetrieval.RetrievalDb = {
      async getActiveContextSummaryIds() {
        return []
      },
      async getOffContextSummaries() {
        return [makeSummary({ summaryId, isOffContext: true })]
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
            message_id: 7001,
            conversation_id: 3001,
            seq: 1,
            role: "user",
            content: "leaf memory for dolt retrieval facade",
            token_count: 8,
            created_at: new Date("2026-02-24T00:00:00.000Z"),
          },
        ]
      },
      async setSummaryQmdDocMapping() {},
    }

    const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcm-retrieval-facade-"))
    try {
      const result = await LcmRetrievalFacade.resolveOffContextRetrieval(
        {
          conversationId: 3001,
          query: "dolt recall",
          db,
          artifactsRoot,
          qmdClient: {
            async ensureCollection() {},
            async updateIndex() {},
            async embedIndex() {},
            async vectorSearch() {
              return [{ docid: "#aa", score: 0.92, file: "qmd://off-context-bindles/aa.md", title: summaryId }]
            },
          },
        },
        "dolt",
      )

      expect(result.hits.map((hit) => hit.summaryId)).toEqual([summaryId])
      expect(result.diagnostics).toEqual([])
    } finally {
      await fs.rm(artifactsRoot, { recursive: true, force: true })
    }
  })

  test("returns explicit no-result diagnostics for Upward off-context retrieval", async () => {
    const result = await LcmRetrievalFacade.resolveOffContextRetrieval(
      {
        conversationId: 3002,
        query: "upward recall",
      },
      "upward",
    )

    expect(result.hits).toEqual([])
    expect(result.candidatesConsidered).toBe(0)
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "off_context_unavailable",
      }),
    ])
  })

  test("filters query candidates to the active condensation DAG in Upward mode", async () => {
    const activeSummaryId = sid("10")
    const offContextSummaryId = sid("11")
    const db: LcmRetrievalFacade.CandidateResolutionDb = {
      async getSummaryById() {
        return null
      },
      async searchSummariesInLineage() {
        return [
          { summary_id: activeSummaryId, conversation_id: 401, kind: "bindle" },
          { summary_id: offContextSummaryId, conversation_id: 401, kind: "bindle" },
        ]
      },
      async getActiveContextSummaryIds() {
        return [activeSummaryId]
      },
    }

    const result = await LcmRetrievalFacade.resolveExpandQueryCandidates({
      explicitSummaryIds: [],
      query: "needle",
      requestedConversationId: 401,
      sessionConversationId: 401,
      mode: "upward",
      db,
    })

    expect(result.summaryIds).toEqual([activeSummaryId])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "off_context_unavailable",
        summaryIds: [offContextSummaryId],
      }),
    ])
  })

  test("returns explicit no-result diagnostics when Upward query matches only off-context summaries", async () => {
    const offContextSummaryId = sid("99")
    const db: LcmRetrievalFacade.CandidateResolutionDb = {
      async getSummaryById() {
        return null
      },
      async searchSummariesInLineage() {
        return [{ summary_id: offContextSummaryId, conversation_id: 777, kind: "bindle" }]
      },
      async getActiveContextSummaryIds() {
        return []
      },
    }

    const result = await LcmRetrievalFacade.resolveExpandQueryCandidates({
      explicitSummaryIds: [],
      query: "off-context-only",
      requestedConversationId: 777,
      sessionConversationId: 777,
      mode: "upward",
      db,
    })

    expect(result.summaryIds).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "off_context_unavailable" }),
      expect.objectContaining({ code: "active_context_only" }),
    ])
  })
})
