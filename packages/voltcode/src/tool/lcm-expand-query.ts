import z from "zod"
import { Tool } from "./tool"
import { LcmRetrievalFacade } from "../session/lcm/retrieval-facade"
import type { LcmRetrieval } from "../session/lcm/retrieval"
import { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { executeTask } from "./task"
import DESCRIPTION from "./lcm-expand-query.txt"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.lcm_expand_query" })

const DEFAULT_MAX_ANSWER_TOKENS = 2_000
const DEFAULT_QUERY_LIMIT = 24

const parameters = z.object({
  prompt: z.string().describe("Focused question to answer using expanded summary context"),
  summary_ids: z.array(z.string()).optional().describe("Optional list of summary IDs (sum_xxx) to expand"),
  query: z.string().optional().describe("Optional text query used to find candidate summaries before expansion"),
  conversation_id: z
    .number()
    .optional()
    .describe("Optional conversation scope. Defaults to current session conversation."),
  max_tokens: z.number().int().positive().optional().describe("Target maximum answer tokens (default: 2000)."),
})

interface LcmExpandQueryMetadata {
  prompt: string
  query?: string
  conversationId: number
  sourceSummaryCount: number
  sourceSummaryIds: string[]
  diagnostics: LcmRetrieval.QueryDiagnostic[]
  citedSummaryIds: string[]
  expandedSummaryCount: number
  truncated: boolean
}

interface ExpandQueryReply {
  answer: string
  citedSummaryIds: string[]
  expandedSummaryCount: number
  truncated: boolean
}

export const LcmExpandQueryTool = Tool.define<typeof parameters, LcmExpandQueryMetadata>("lcm_expand_query", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const prompt = params.prompt.trim()
    const query = params.query?.trim()
    const explicitSummaryIds = normalizeSummaryIds(params.summary_ids)
    const maxTokens = params.max_tokens ?? DEFAULT_MAX_ANSWER_TOKENS

    if (!prompt) {
      throw new Error("The lcm_expand_query tool requires a non-empty prompt.")
    }

    if (explicitSummaryIds.length === 0 && !query) {
      throw new Error("Provide summary_ids, query, or both when using lcm_expand_query.")
    }

    const sessionConversationId = await SessionPrompt.getLcmConversationId(ctx.sessionID)
    const requestedConversationId = params.conversation_id ?? sessionConversationId ?? undefined

    const resolved = await resolveSummaryCandidates({
      explicitSummaryIds,
      query,
      requestedConversationId,
      sessionConversationId,
    })

    if (resolved.summaryIds.length === 0) {
      return {
        title: "LCM expand query",
        metadata: {
          prompt,
          query,
          conversationId: resolved.conversationId,
          sourceSummaryCount: 0,
          sourceSummaryIds: [],
          diagnostics: resolved.diagnostics,
          citedSummaryIds: [],
          expandedSummaryCount: 0,
          truncated: false,
        },
        output: buildNoMatchOutput(resolved.diagnostics),
      }
    }

    log.info("delegating lcm expand query", {
      conversationId: resolved.conversationId,
      summaryCount: resolved.summaryIds.length,
      query,
    })

    const config = await Config.get()
    const taskResult = await executeTask(
      {
        description: "Expand query context",
        prompt: buildDelegatedPrompt({
          summaryIds: resolved.summaryIds,
          prompt,
          maxTokens,
        }),
        subagent_type: "explore",
        delegated_scope: "Expand selected summary IDs and answer the specific recall question",
        kept_work: "Resolve candidate summary scope and integrate returned answer",
      },
      ctx,
      config,
    )

    const parsed = parseDelegatedReply(taskResult.output, resolved.summaryIds)

    return {
      title: "LCM expand query",
      metadata: {
        prompt,
        query,
        conversationId: resolved.conversationId,
        sourceSummaryCount: resolved.summaryIds.length,
        sourceSummaryIds: resolved.summaryIds,
        diagnostics: resolved.diagnostics,
        citedSummaryIds: parsed.citedSummaryIds,
        expandedSummaryCount: parsed.expandedSummaryCount,
        truncated: parsed.truncated,
      },
      output: parsed.answer,
    }
  },
})

function normalizeSummaryIds(input: string[] | undefined): string[] {
  if (!input) return []
  const unique = new Set<string>()
  for (const id of input) {
    const trimmed = id.trim()
    if (!trimmed) continue
    unique.add(trimmed)
  }
  return Array.from(unique)
}

async function resolveSummaryCandidates(input: {
  explicitSummaryIds: string[]
  query?: string
  requestedConversationId?: number
  sessionConversationId: number | null
}): Promise<{
  conversationId: number
  summaryIds: string[]
  diagnostics: LcmRetrieval.QueryDiagnostic[]
}> {
  return LcmRetrievalFacade.resolveExpandQueryCandidates({
    ...input,
    queryLimit: DEFAULT_QUERY_LIMIT,
  })
}

function buildNoMatchOutput(diagnostics: LcmRetrieval.QueryDiagnostic[]): string {
  if (diagnostics.length === 0) return "No matching summaries were found for this query scope."

  return [
    "No matching summaries were found for this query scope.",
    "",
    "Diagnostics:",
    ...diagnostics.map((diagnostic) => `- [${diagnostic.code}] ${diagnostic.message}`),
  ].join("\n")
}

function buildDelegatedPrompt(input: { summaryIds: string[]; prompt: string; maxTokens: number }): string {
  return [
    "Use LCM summaries to answer the prompt by expanding each summary ID.",
    "",
    "Summary IDs:",
    ...input.summaryIds.map((summaryId) => `- ${summaryId}`),
    "",
    "For each summary ID listed above, call lcm_expand with exactly:",
    '{"summary_id":"sum_xxx"}',
    "",
    "After expansion, answer this prompt:",
    input.prompt,
    "",
    "Return ONLY valid JSON with this shape:",
    '{"answer":"string","cited_summary_ids":["sum_xxx"],"expanded_summary_count":0,"truncated":false}',
    "",
    "Rules:",
    `- Keep answer concise and narrative (target <= ${input.maxTokens} tokens).`,
    "- cited_summary_ids must be unique and contain only IDs from the Summary IDs list.",
    "- expanded_summary_count is the number of summary IDs you actually expanded.",
    "- truncated should be true only if needed details could not be fully inspected.",
  ].join("\n")
}

function parseDelegatedReply(raw: string, summaryIds: string[]): ExpandQueryReply {
  const cleaned = stripTaskMetadata(raw).trim()
  const fallback: ExpandQueryReply = {
    answer: cleaned,
    citedSummaryIds: [],
    expandedSummaryCount: summaryIds.length,
    truncated: false,
  }

  if (!cleaned) {
    return fallback
  }

  const candidates: string[] = [cleaned]
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown
        cited_summary_ids?: unknown
        expanded_summary_count?: unknown
        truncated?: unknown
      }

      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : fallback.answer
      const citedSummaryIds =
        Array.isArray(parsed.cited_summary_ids) && parsed.cited_summary_ids.length > 0
          ? normalizeSummaryIds(parsed.cited_summary_ids.filter((value): value is string => typeof value === "string"))
          : []
      const expandedSummaryCount =
        typeof parsed.expanded_summary_count === "number" && Number.isFinite(parsed.expanded_summary_count)
          ? Math.max(0, Math.floor(parsed.expanded_summary_count))
          : fallback.expandedSummaryCount
      const truncated = parsed.truncated === true

      return {
        answer,
        citedSummaryIds,
        expandedSummaryCount,
        truncated,
      }
    } catch {
      // Try next candidate.
    }
  }

  return fallback
}

function stripTaskMetadata(raw: string): string {
  return raw
    .replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, "")
    .replace(/<task_errors>[\s\S]*?<\/task_errors>/g, "")
    .trim()
}
