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
  messageCount: number
  conversationId?: number
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
          output: `ERROR: lcm_expand cannot be called on an LCM file ID. "${params.summary_id}" is a stored file, not a conversation summary.\n\nTo work with this file:\n- Call lcm_describe with ID "${params.summary_id}" for metadata and exploration summary\n- Spawn a Task sub-agent with lcm_read to retrieve the full stored content`,
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

    // Expand the summary to its original messages
    const messages = await LcmDb.expandSummaryToMessages(params.summary_id)

    if (messages.length === 0) {
      return {
        title: `Expand summary: ${params.summary_id}`,
        metadata: {
          summaryId: params.summary_id,
          summaryKind: summary.kind,
          messageCount: 0,
          conversationId: summary.conversation_id,
        },
        output: `Summary found but no underlying messages were linked.\n\nSummary content:\n${summary.content}`,
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
        messageCount: messages.length,
        conversationId: messages[0].conversationId,
      },
      output: `Expanded summary "${params.summary_id}" (${summary.kind}) to ${messages.length} original messages:\n\n${output}`,
    }
  },
})
