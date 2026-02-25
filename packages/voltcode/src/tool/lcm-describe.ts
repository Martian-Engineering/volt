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

  log.info("describing LCM file", { fileId, originalPath: file.original_path })

  const lines: string[] = []
  lines.push(`## LCM File: ${fileId}`)
  lines.push("")
  lines.push(`**Path:** ${file.original_path ?? "(inline content — stored in LCM database, not on disk)"}`)
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

  const lines: string[] = []
  lines.push(`## LCM Summary: ${summaryId}`)
  lines.push("")
  lines.push(`**Kind:** ${summary.kind}`)
  lines.push(`**Tokens:** ~${summary.token_count.toLocaleString()}`)
  lines.push(`**Created:** ${summary.created_at.toISOString()}`)

  // Get parent summaries if this is a condensed summary
  if (summary.kind === "condensed") {
    const parentIds = await LcmDb.getSummaryParentIds(summaryId)
    if (parentIds.length > 0) {
      lines.push(`**Parents:** ${parentIds.join(", ")}`)
    }
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
    },
    output: lines.join("\n"),
  }
}
