import { Log } from "@/util/log"
import { getLcmPolicyConfig, type LcmMode } from "./config"
import { LcmDb } from "./db"
import { LcmRetrieval } from "./retrieval"

const log = Log.create({ service: "lcm.retrieval-facade" })
const DEFAULT_EXPAND_QUERY_LIMIT = 24

type SummaryCandidate = {
  summaryId: string
  conversationId: number
}

export namespace LcmRetrievalFacade {
  export interface CandidateResolutionInput {
    explicitSummaryIds: string[]
    query?: string
    requestedConversationId?: number
    sessionConversationId: number | null
    mode?: LcmMode
    queryLimit?: number
    db?: CandidateResolutionDb
  }

  export interface CandidateResolutionResult {
    conversationId: number
    summaryIds: string[]
    diagnostics: LcmRetrieval.QueryDiagnostic[]
  }

  export interface CandidateResolutionDb {
    getSummaryById(summaryId: string, conversationId?: number): Promise<LcmDb.Summary | null>
    searchSummariesInLineage(
      conversationId: number,
      query: string,
      limit?: number,
    ): Promise<LcmDb.SummaryLineageSearchResult[]>
    getActiveContextSummaryIds(conversationId: number): Promise<string[]>
  }

  /**
   * Resolve off-context retrieval against the active mode contract.
   */
  export async function resolveOffContextRetrieval(
    input: LcmRetrieval.QueryInput,
    mode = getLcmPolicyConfig().mode,
  ): Promise<LcmRetrieval.QueryResult> {
    if (mode === "dolt") {
      return LcmRetrieval.queryOffContextBindles(input)
    }

    const result = LcmRetrieval.offContextUnavailableResult(
      input,
      "Upward mode does not support off-context retrieval. Only active condensation DAG summaries are searchable.",
    )

    log.debug("upward mode returned no off-context retrieval result", {
      conversationId: input.conversationId,
      query: input.query.trim(),
    })

    return result
  }

  /**
   * Resolve lcm_expand_query summary candidates against the active mode.
   */
  export async function resolveExpandQueryCandidates(
    input: CandidateResolutionInput,
  ): Promise<CandidateResolutionResult> {
    const db = input.db ?? LcmDb
    const mode = input.mode ?? getLcmPolicyConfig().mode
    const query = input.query?.trim()
    const queryLimit = input.queryLimit ?? DEFAULT_EXPAND_QUERY_LIMIT
    const candidates = new Map<string, SummaryCandidate>()
    const diagnostics: LcmRetrieval.QueryDiagnostic[] = []
    const excludedSummaryIds = new Set<string>()
    const discoveredConversationIds = new Set<number>()

    const scopedConversationId = input.requestedConversationId ?? input.sessionConversationId ?? undefined
    const activeSummaryIds =
      mode === "upward" && scopedConversationId != null
        ? new Set(await db.getActiveContextSummaryIds(scopedConversationId))
        : null

    // Keep one candidate inclusion gate so explicit IDs and query matches follow
    // identical active-DAG filtering rules in Upward mode.
    const includeCandidate = (candidate: SummaryCandidate): void => {
      discoveredConversationIds.add(candidate.conversationId)
      if (mode !== "upward" || !activeSummaryIds) {
        candidates.set(candidate.summaryId, candidate)
        return
      }

      if (activeSummaryIds.has(candidate.summaryId)) {
        candidates.set(candidate.summaryId, candidate)
        return
      }

      excludedSummaryIds.add(candidate.summaryId)
    }

    // Resolve explicit summary IDs first so caller intent is preserved even when
    // query search contributes additional candidates.
    if (input.requestedConversationId != null) {
      for (const summaryId of input.explicitSummaryIds) {
        const summary = await db.getSummaryById(summaryId, input.requestedConversationId)
        if (!summary) {
          throw new Error(
            `Summary "${summaryId}" was not found in conversation ${input.requestedConversationId} or its ancestors.`,
          )
        }
        includeCandidate({
          summaryId: summary.summary_id,
          conversationId: summary.conversation_id,
        })
      }
    } else {
      for (const summaryId of input.explicitSummaryIds) {
        const summary = await db.getSummaryById(summaryId)
        if (!summary) {
          throw new Error(`Summary "${summaryId}" was not found.`)
        }
        includeCandidate({
          summaryId: summary.summary_id,
          conversationId: summary.conversation_id,
        })
      }
    }

    // Query expansion is always scoped to a concrete conversation so lineage
    // traversal remains deterministic.
    if (query) {
      if (scopedConversationId == null) {
        throw new Error(
          "A conversation scope is required for query-based expansion. Provide conversation_id or run this from a conversation session.",
        )
      }

      const queryResults = await db.searchSummariesInLineage(scopedConversationId, query, queryLimit)
      for (const match of queryResults) {
        includeCandidate({
          summaryId: match.summary_id,
          conversationId: match.conversation_id,
        })
      }
    }

    if (mode === "upward" && excludedSummaryIds.size > 0) {
      const excluded = Array.from(excludedSummaryIds).sort((a, b) => a.localeCompare(b))
      diagnostics.push({
        code: "off_context_unavailable",
        message: `Upward mode skipped ${excluded.length} off-context summaries. Only active condensation DAG summaries are eligible for expansion/search.`,
        summaryIds: excluded,
      })
    }

    if (mode === "upward" && query && candidates.size === 0 && excludedSummaryIds.size > 0) {
      diagnostics.push({
        code: "active_context_only",
        message: "No active condensation DAG summaries matched this query in Upward mode.",
      })
    }

    const sortedCandidateIds = Array.from(candidates.values())
      .map((candidate) => candidate.summaryId)
      .sort((a, b) => a.localeCompare(b))

    if (input.requestedConversationId != null) {
      return {
        conversationId: input.requestedConversationId,
        summaryIds: sortedCandidateIds,
        diagnostics,
      }
    }

    if (sortedCandidateIds.length === 0) {
      const fallbackConversationId = resolveFallbackConversationId({
        sessionConversationId: input.sessionConversationId,
        discoveredConversationIds,
      })
      return {
        conversationId: fallbackConversationId,
        summaryIds: [],
        diagnostics,
      }
    }

    const candidateConversationIds = Array.from(
      new Set(Array.from(candidates.values()).map((candidate) => candidate.conversationId)),
    )
    if (candidateConversationIds.length !== 1) {
      throw new Error(
        "Matched summaries span multiple conversations. Provide conversation_id to disambiguate expansion scope.",
      )
    }

    return {
      conversationId: candidateConversationIds[0],
      summaryIds: sortedCandidateIds,
      diagnostics,
    }
  }

  function resolveFallbackConversationId(input: {
    sessionConversationId: number | null
    discoveredConversationIds: Set<number>
  }): number {
    if (input.sessionConversationId != null) return input.sessionConversationId

    const discovered = Array.from(input.discoveredConversationIds)
    if (discovered.length === 1) return discovered[0]

    throw new Error("Unable to resolve conversation scope for summary expansion.")
  }
}
