import z from "zod"
import { Tool } from "./tool"
import { LcmDb } from "../session/lcm/db"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Log } from "../util/log"
import DESCRIPTION from "./lcm-expand.txt"

const log = Log.create({ service: "tool.lcm_expand" })

const parameters = z.object({
  summary_id: z.string().describe("The ID of the summary to expand (sum_xxx format)"),
})

interface LcmExpandMetadata {
  summaryId: string
  summaryKind?: LcmDb.SummaryKind
  summaryLevel?: LcmDb.SummaryLevel
  condensationOrder?: number
  summaryType?: LcmDb.SummaryType
  isOffContext?: boolean
  messageCount: number
  conversationId?: number
  parentSummaryIds?: string[]
  pointerSummaryIds?: string[]
  lineageSummaryIds?: string[]
  archivePointerSummaryIds?: string[]
  archivedPointer?: boolean
}

export const LcmExpandTool = Tool.define<typeof parameters, LcmExpandMetadata>("lcm_expand", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    // Check if this is a sub-agent by looking at session parentID
    const session = await Session.get(ctx.sessionID)
    if (!session.parentID) {
      return {
        title: `Expand summary: ${params.summary_id}`,
        metadata: {
          summaryId: params.summary_id,
          messageCount: 0,
        },
        output: `ERROR: Only sub-agents can expand summaries.

The lcm_expand tool can only be called by sub-agents spawned via the Task tool.
This restriction protects the main context from uncontrolled expansion.

To analyze the content of summary "${params.summary_id}", spawn a Task sub-agent:
  Task(prompt="Use lcm_expand on ${params.summary_id} to find <your question>")

The sub-agent will be able to call lcm_expand to see the full content.`,
      }
    }

    // Get the conversation ID for this session to enable ancestor lookup
    const conversationId = await SessionPrompt.getLcmConversationId(ctx.sessionID)

    // Look up summary, checking this conversation and all ancestors
    const summary = await LcmDb.getSummaryById(params.summary_id, conversationId ?? undefined)
    if (!summary) {
      // Check if this is actually a file ID, not a summary ID
      const isFile = await LcmDb.largeFileExists(params.summary_id, conversationId ?? undefined)
      if (isFile) {
        return {
          title: `Cannot expand file: ${params.summary_id}`,
          metadata: {
            summaryId: params.summary_id,
            messageCount: 0,
          },
          output: `ERROR: lcm_expand cannot be called on an LCM file ID. "${params.summary_id}" is a stored file, not a conversation summary.\n\nTo work with this file:\n- Call lcm_describe with ID "${params.summary_id}" for metadata and exploration summary\n- Spawn an explore sub-agent to retrieve content: Task(subagent_type="explore", prompt="Use lcm_read on ${params.summary_id} to find <what you need>")`,
        }
      }
      throw new LcmDb.NotFoundError({
        entity: "summary",
        id: params.summary_id,
      })
    }

    log.info("expanding summary", {
      summaryId: params.summary_id,
      summaryKind: summary.kind,
      sessionId: ctx.sessionID,
    })

    const [parentSummaryIds, lineagePointers, lineageSummaryIds] = await Promise.all([
      LcmDb.getSummaryParentIds(summary.summary_id),
      LcmDb.getSummaryLineagePointers(summary.summary_id),
      LcmDb.getSummaryLineageIds(summary.summary_id),
    ])
    const pointerSummaryIds = Array.from(new Set(lineagePointers.map((pointer) => pointer.points_to_summary_id))).sort()
    const archivePointerSummaryIds = Array.from(
      new Set(
        lineagePointers
          .filter((pointer) => pointer.pointer_kind === "archive_stub")
          .map((pointer) => pointer.points_to_summary_id),
      ),
    ).sort()
    const lineageIds = Array.from(new Set(lineageSummaryIds)).sort()
    const isArchiveStub = summary.summary_type === "archive_stub"

    const metadataLines = [
      "Summary metadata:",
      `- kind: ${summary.kind}`,
      `- level: ${summary.summary_level}`,
      `- condensation_order: ${summary.condensation_order}`,
      `- canonical_level: ${LcmDb.condensationOrderToCanonicalLevel(summary.condensation_order)}`,
      `- type: ${summary.summary_type}`,
      `- off_context: ${summary.is_off_context}`,
      `- archived_pointer: ${isArchiveStub}`,
      `- parent_summary_ids: ${parentSummaryIds.length > 0 ? parentSummaryIds.join(", ") : "-"}`,
      `- pointer_summary_ids: ${pointerSummaryIds.length > 0 ? pointerSummaryIds.join(", ") : "-"}`,
      `- lineage_summary_ids: ${lineageIds.length > 0 ? lineageIds.join(", ") : "-"}`,
    ]
    if (archivePointerSummaryIds.length > 0) {
      metadataLines.push(`- archive_pointer_targets: ${archivePointerSummaryIds.join(", ")}`)
    }
    if (summary.qmd_doc_id) {
      metadataLines.push(`- qmd_doc_id: ${summary.qmd_doc_id}`)
    }
    if (summary.qmd_doc_version != null) {
      metadataLines.push(`- qmd_doc_version: ${summary.qmd_doc_version}`)
    }
    if (isArchiveStub) {
      metadataLines.push(
        "- archived_note: this summary is an archive stub; follow archive_pointer_targets with lcm_describe/lcm_expand for full lineage.",
      )
    }

    const metadataBlock = metadataLines.join("\n")

    // Expand the summary to its original messages
    const messages = await LcmDb.expandSummaryToMessages(params.summary_id)

    if (messages.length === 0) {
      return {
        title: `Expand summary: ${params.summary_id}`,
        metadata: {
          summaryId: params.summary_id,
          summaryKind: summary.kind,
          summaryLevel: summary.summary_level,
          condensationOrder: summary.condensation_order,
          summaryType: summary.summary_type,
          isOffContext: summary.is_off_context,
          messageCount: 0,
          conversationId: summary.conversation_id,
          parentSummaryIds,
          pointerSummaryIds,
          lineageSummaryIds: lineageIds,
          archivePointerSummaryIds,
          archivedPointer: isArchiveStub,
        },
        output: `${metadataBlock}\n\nSummary found but no underlying messages were linked.\n\nSummary content:\n${summary.content}`,
      }
    }

    // Format messages for output
    const output = messages
      .map((msg, idx) => {
        const header = `--- Message ${idx + 1} (seq: ${msg.seq}, role: ${msg.role}) ---`
        return `${header}\n${msg.content}`
      })
      .join("\n\n")

    return {
      title: `Expanded: ${params.summary_id} (${messages.length} messages)`,
      metadata: {
        summaryId: params.summary_id,
        summaryKind: summary.kind,
        summaryLevel: summary.summary_level,
        condensationOrder: summary.condensation_order,
        summaryType: summary.summary_type,
        isOffContext: summary.is_off_context,
        messageCount: messages.length,
        conversationId: messages[0].conversationId,
        parentSummaryIds,
        pointerSummaryIds,
        lineageSummaryIds: lineageIds,
        archivePointerSummaryIds,
        archivedPointer: isArchiveStub,
      },
      output: `${metadataBlock}\n\nExpanded summary "${params.summary_id}" (${summary.kind}) to ${messages.length} original messages:\n\n${output}`,
    }
  },
})
