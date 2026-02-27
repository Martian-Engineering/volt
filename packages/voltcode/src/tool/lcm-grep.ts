import z from "zod"
import { Tool } from "./tool"
import { LcmDb } from "../session/lcm/db"
import DESCRIPTION from "./lcm-grep.txt"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.lcm_grep" })

// ~10k tokens at ~4 chars/token
const MAX_BYTES_PER_PAGE = 40_000

const parameters = z.object({
  pattern: z.string().describe("The regular expression pattern to search for"),
  conversation_id: z.number().describe("The conversation ID to search within"),
  summary_id: z.string().optional().describe("Optional: limit search to messages within this summary's scope"),
  page: z.number().optional().describe("Page number for paginated results (1-indexed, default: 1)"),
})

interface LcmGrepMetadata {
  pattern: string
  conversationId: number
  summaryId?: string
  page: number
  matchCount: number
  hasMore: boolean
  archivedCoveringSummaryIds: string[]
}

export const LcmGrepTool = Tool.define<typeof parameters, LcmGrepMetadata>("lcm_grep", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const page = params.page ?? 1
    const offset = (page - 1) * 50 // 50 results per query

    log.info("searching conversation with regex", {
      conversationId: params.conversation_id,
      pattern: params.pattern,
      summaryId: params.summary_id,
      page,
    })

    // Fetch results
    const results = await LcmDb.regexSearchMessages(
      params.conversation_id,
      params.pattern,
      params.summary_id,
      51, // Get one extra to check if there are more
      offset,
    )

    const hasMore = results.length > 50
    const matches = results.slice(0, 50)

    const coveringSummaryIds = Array.from(
      new Set(
        matches.map((match) => match.coveringSummaryId).filter((summaryId): summaryId is string => Boolean(summaryId)),
      ),
    )
    const coveringSummaryMetadata = new Map<
      string,
      { summary: LcmDb.Summary | null; pointerSummaryIds: string[]; archivePointerSummaryIds: string[] }
    >()
    await Promise.all(
      coveringSummaryIds.map(async (summaryId) => {
        const summary = await LcmDb.getSummaryById(summaryId, params.conversation_id)
        if (!summary) {
          coveringSummaryMetadata.set(summaryId, {
            summary: null,
            pointerSummaryIds: [],
            archivePointerSummaryIds: [],
          })
          return
        }
        const lineagePointers = await LcmDb.getSummaryLineagePointers(summaryId)
        const pointerSummaryIds = Array.from(
          new Set(lineagePointers.map((pointer) => pointer.points_to_summary_id)),
        ).sort()
        const archivePointerSummaryIds = Array.from(
          new Set(
            lineagePointers
              .filter((pointer) => pointer.pointer_kind === "archive_stub")
              .map((pointer) => pointer.points_to_summary_id),
          ),
        ).sort()
        coveringSummaryMetadata.set(summaryId, {
          summary,
          pointerSummaryIds,
          archivePointerSummaryIds,
        })
      }),
    )
    const archivedCoveringSummaryIds = coveringSummaryIds
      .filter((summaryId) => coveringSummaryMetadata.get(summaryId)?.summary?.summary_type === "archive_stub")
      .sort()

    // Group results by covering summary
    const grouped = new Map<string, typeof matches>()
    for (const match of matches) {
      const key = match.coveringSummaryId ?? "(no summary)"
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(match)
    }

    // Build output, respecting MAX_BYTES_PER_PAGE
    const outputLines: string[] = []
    outputLines.push(`## Regex Search Results`)
    outputLines.push(`Pattern: \`${params.pattern}\``)
    outputLines.push(`Conversation ID: ${params.conversation_id}`)
    if (params.summary_id) outputLines.push(`Scoped to summary: ${params.summary_id}`)
    outputLines.push(`Page: ${page}`)
    outputLines.push("")

    let currentBytes = outputLines.join("\n").length
    let displayedCount = 0

    for (const [summaryId, groupMatches] of grouped) {
      const summaryMetadata = summaryId === "(no summary)" ? null : coveringSummaryMetadata.get(summaryId)
      const summary = summaryMetadata?.summary
      const isArchiveStub = summary?.summary_type === "archive_stub"
      const headerParts = [`### Covered by: ${summaryId}`]
      if (summary) {
        headerParts.push(
          `[type=${summary.summary_type} level=${summary.summary_level} order=${summary.condensation_order} canonical_level=${LcmDb.condensationOrderToCanonicalLevel(summary.condensation_order)} off_context=${summary.is_off_context} archived_pointer=${isArchiveStub}]`,
        )
      }
      const lineageLines: string[] = []
      if (summaryMetadata?.pointerSummaryIds.length) {
        lineageLines.push(`Lineage pointers: ${summaryMetadata.pointerSummaryIds.join(", ")}`)
      }
      if (summaryMetadata?.archivePointerSummaryIds.length) {
        lineageLines.push(`Archive targets: ${summaryMetadata.archivePointerSummaryIds.join(", ")}`)
      }
      const groupHeader = `${headerParts.join(" ")}\n${lineageLines.length > 0 ? `${lineageLines.join("\n")}\n` : ""}\n`
      if (currentBytes + groupHeader.length > MAX_BYTES_PER_PAGE) break
      outputLines.push(groupHeader)
      currentBytes += groupHeader.length

      for (const match of groupMatches) {
        const snippet = truncateContent(match.content, 200)
        const line = `- [seq=${match.seq}] (${match.role}): ${snippet}\n`
        if (currentBytes + line.length > MAX_BYTES_PER_PAGE) break
        outputLines.push(line)
        currentBytes += line.length
        displayedCount++
      }
      outputLines.push("")
    }

    if (matches.length === 0) {
      outputLines.push("No matches found for the given pattern.")
    } else if (hasMore || displayedCount < matches.length) {
      outputLines.push(`\n---\nMore results available. Use page=${page + 1} to see more.`)
    }

    return {
      title: `LCM grep: ${params.pattern}`,
      metadata: {
        pattern: params.pattern,
        conversationId: params.conversation_id,
        summaryId: params.summary_id,
        page,
        matchCount: displayedCount,
        hasMore: hasMore || displayedCount < matches.length,
        archivedCoveringSummaryIds,
      },
      output: outputLines.join("\n"),
    }
  },
})

function truncateContent(content: string, maxLength: number): string {
  const singleLine = content.replace(/\n/g, " ").trim()
  if (singleLine.length <= maxLength) return singleLine
  return singleLine.substring(0, maxLength - 3) + "..."
}
