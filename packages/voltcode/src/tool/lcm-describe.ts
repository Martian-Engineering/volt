import z from "zod"
import { Tool } from "./tool"
import { LcmDb } from "../session/lcm/db"
import { SessionPrompt } from "../session/prompt"
import { Log } from "../util/log"
import DESCRIPTION from "./lcm-describe.txt"

const log = Log.create({ service: "tool.lcm_describe" })

const parameters = z.object({
  id: z.string().describe("The LCM ID to look up (file_xxx for files, sum_xxx for summaries)"),
})

interface LcmDescribeMetadata {
  id: string
  type: "file" | "summary" | "unknown"
  found: boolean
  summaryKind?: LcmDb.SummaryKind
  summaryLevel?: LcmDb.SummaryLevel
  condensationOrder?: number
  summaryType?: LcmDb.SummaryType
  isOffContext?: boolean
  archivedPointer?: boolean
  parentSummaryCount?: number
  pointerSummaryCount?: number
  lineageSummaryCount?: number
}

export const LcmDescribeTool = Tool.define<typeof parameters, LcmDescribeMetadata>("lcm_describe", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const id = params.id.trim()

    // Determine type from ID prefix
    if (id.startsWith("file_")) {
      return await describeFile(id, ctx.sessionID)
    } else if (id.startsWith("sum_")) {
      return await describeSummary(id, ctx.sessionID)
    } else {
      return {
        title: `LCM describe: ${id}`,
        metadata: {
          id,
          type: "unknown" as const,
          found: false,
        },
        output: `Unknown LCM ID format: "${id}". Expected file_xxx or sum_xxx.`,
      }
    }
  },
})

function formatStorageKind(storageKind: "path" | "inline_text" | "inline_binary"): string {
  if (storageKind === "path") return "path-backed file (on disk)"
  if (storageKind === "inline_text") return "inline text payload (in LCM DB)"
  return "inline binary payload (in LCM DB)"
}

async function describeFile(fileId: string, sessionID: string) {
  // Get conversation ID for this session to enable ancestor lookup
  const conversationId = await SessionPrompt.getLcmConversationId(sessionID)

  // Look up file, checking this conversation and all ancestors
  const file = await LcmDb.getLargeFile(fileId, conversationId ?? undefined)

  if (!file) {
    return {
      title: `LCM file: ${fileId}`,
      metadata: {
        id: fileId,
        type: "file" as const,
        found: false,
      },
      output: `File not found: ${fileId}\n\nThis file ID does not exist in the current conversation or its ancestors.`,
    }
  }

  log.info("describing LCM file", { fileId, storageKind: file.storage_kind, originalPath: file.original_path })

  const lines: string[] = []
  lines.push(`## LCM File: ${fileId}`)
  lines.push("")
  lines.push(`**Storage:** ${formatStorageKind(file.storage_kind)}`)
  lines.push(
    `**Path:** ${file.storage_kind === "path" ? (file.original_path ?? "(missing path)") : "(inline payload — not on disk)"}`,
  )
  lines.push(`**Type:** ${file.mime_type}`)
  lines.push(`**Tokens:** ~${file.token_count.toLocaleString()}`)
  lines.push(`**Created:** ${file.created_at.toISOString()}`)

  if (file.explorer_used) {
    lines.push(`**Explorer:** ${file.explorer_used}`)
  }

  if (file.exploration_summary) {
    lines.push("")
    lines.push("## Exploration Summary")
    lines.push("")
    lines.push(file.exploration_summary)
  } else {
    lines.push("")
    lines.push("*No exploration summary available for this file.*")
  }

  return {
    title: `LCM file: ${fileId}`,
    metadata: {
      id: fileId,
      type: "file" as const,
      found: true,
    },
    output: lines.join("\n"),
  }
}

async function describeSummary(summaryId: string, sessionID: string) {
  // Get conversation ID for this session to enable ancestor lookup
  const conversationId = await SessionPrompt.getLcmConversationId(sessionID)

  // Look up summary, checking this conversation and all ancestors
  const summary = await LcmDb.getSummaryById(summaryId, conversationId ?? undefined)

  if (!summary) {
    return {
      title: `LCM summary: ${summaryId}`,
      metadata: {
        id: summaryId,
        type: "summary" as const,
        found: false,
      },
      output: `Summary not found: ${summaryId}\n\nThis summary ID does not exist in the current conversation or its ancestors.`,
    }
  }

  log.info("describing LCM summary", { summaryId, kind: summary.kind })

  const [parentIds, lineagePointers, lineageSummaryIds] = await Promise.all([
    LcmDb.getSummaryParentIds(summaryId),
    LcmDb.getSummaryLineagePointers(summaryId),
    LcmDb.getSummaryLineageIds(summaryId),
  ])
  const pointerSummaryIds = Array.from(new Set(lineagePointers.map((pointer) => pointer.points_to_summary_id))).sort()
  const lineageIds = Array.from(new Set(lineageSummaryIds)).sort()
  const archivePointerIds = Array.from(
    new Set(
      lineagePointers
        .filter((pointer) => pointer.pointer_kind === "archive_stub")
        .map((pointer) => pointer.points_to_summary_id),
    ),
  ).sort()
  const archiveFullIds = Array.from(
    new Set(
      lineagePointers
        .filter((pointer) => pointer.pointer_kind === "archive_full")
        .map((pointer) => pointer.points_to_summary_id),
    ),
  ).sort()
  const lineageParentIds = Array.from(
    new Set(
      lineagePointers
        .filter((pointer) => pointer.pointer_kind === "lineage_parent")
        .map((pointer) => pointer.points_to_summary_id),
    ),
  ).sort()
  const isArchiveStub = summary.summary_type === "archive_stub"

  const lines: string[] = []
  lines.push(`## LCM Summary: ${summaryId}`)
  lines.push("")
  lines.push(`**Kind:** ${summary.kind}`)
  lines.push(`**Level:** ${summary.summary_level}`)
  lines.push(`**Condensation Order:** ${summary.condensation_order}`)
  lines.push(`**Canonical Level:** ${LcmDb.condensationOrderToCanonicalLevel(summary.condensation_order)}`)
  lines.push(`**Type:** ${summary.summary_type}`)
  lines.push(`**Off-context:** ${summary.is_off_context}`)
  lines.push(`**Archived Pointer:** ${isArchiveStub}`)
  lines.push(`**Tokens:** ~${summary.token_count.toLocaleString()}`)
  lines.push(`**Created:** ${summary.created_at.toISOString()}`)
  if (summary.qmd_doc_id) {
    lines.push(`**QMD Doc ID:** ${summary.qmd_doc_id}`)
  }
  if (summary.qmd_doc_version != null) {
    lines.push(`**QMD Doc Version:** ${summary.qmd_doc_version}`)
  }

  lines.push("")
  lines.push("## Dolt Lineage Metadata")
  lines.push("")
  lines.push(`**Parent Summaries:** ${parentIds.length > 0 ? parentIds.join(", ") : "-"}`)
  lines.push(`**Lineage Pointer Targets:** ${pointerSummaryIds.length > 0 ? pointerSummaryIds.join(", ") : "-"}`)
  lines.push(`**Lineage Closure IDs:** ${lineageIds.length > 0 ? lineageIds.join(", ") : "-"}`)
  lines.push(`**Archive Stub Targets:** ${archivePointerIds.length > 0 ? archivePointerIds.join(", ") : "-"}`)
  lines.push(`**Archive Full Targets:** ${archiveFullIds.length > 0 ? archiveFullIds.join(", ") : "-"}`)
  lines.push(`**Lineage Parent Targets:** ${lineageParentIds.length > 0 ? lineageParentIds.join(", ") : "-"}`)
  if (isArchiveStub) {
    lines.push(
      "**Archived Note:** This summary is an archive stub pointer. Expand this summary to traverse into archived bindle content.",
    )
  }

  lines.push("")
  lines.push("## Summary Content")
  lines.push("")
  lines.push(summary.content)

  return {
    title: `LCM summary: ${summaryId}`,
    metadata: {
      id: summaryId,
      type: "summary" as const,
      found: true,
      summaryKind: summary.kind,
      summaryLevel: summary.summary_level,
      condensationOrder: summary.condensation_order,
      summaryType: summary.summary_type,
      isOffContext: summary.is_off_context,
      archivedPointer: isArchiveStub,
      parentSummaryCount: parentIds.length,
      pointerSummaryCount: pointerSummaryIds.length,
      lineageSummaryCount: lineageIds.length,
    },
    output: lines.join("\n"),
  }
}
