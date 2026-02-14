import { Log } from "@/util/log"
import { LcmDb } from "./db"
import { Token } from "@/util/token"

const log = Log.create({ service: "lcm.integrity" })

export namespace LcmIntegrity {
  export interface Issue {
    severity: "error" | "warning"
    check: string
    message: string
    details?: Record<string, unknown>
  }

  export interface Report {
    conversationId: number
    healthy: boolean
    issues: Issue[]
    stats: {
      contextItems: number
      messages: number
      summaries: number
      largeFiles: number
      contextTokens: number
      maxTokens: number
      threshold: number
    }
  }

  export async function check(conversationId: number): Promise<Report> {
    const issues: Issue[] = []
    const conn = LcmDb.getConnection()

    // Load conversation metadata
    const conversation = await LcmDb.getConversation(conversationId)
    if (!conversation) {
      return {
        conversationId,
        healthy: false,
        issues: [
          { severity: "error", check: "conversation_exists", message: `Conversation ${conversationId} not found` },
        ],
        stats: {
          contextItems: 0,
          messages: 0,
          summaries: 0,
          largeFiles: 0,
          contextTokens: 0,
          maxTokens: 0,
          threshold: 0,
        },
      }
    }

    const maxTokens = conversation.model_ctx_max_tokens
    const threshold = parseFloat(conversation.ctx_cutoff_threshold)
    const contextTokens = await LcmDb.getContextTokenCount(conversationId)

    // 1. Context item position contiguity
    const positions = await conn<{ position: number }[]>`
      SELECT position FROM context_items
      WHERE conversation_id = ${conversationId}
      ORDER BY position
    `
    for (let i = 0; i < positions.length; i++) {
      if (positions[i].position !== i) {
        issues.push({
          severity: "error",
          check: "position_contiguity",
          message: `Gap in context_items positions: expected ${i}, got ${positions[i].position}`,
          details: { expected: i, actual: positions[i].position },
        })
        break
      }
    }

    // 2. Context items referencing missing messages
    const orphanedMsgRefs = await conn<{ position: number; message_id: number }[]>`
      SELECT ci.position, ci.message_id
      FROM context_items ci
      LEFT JOIN messages m ON ci.message_id = m.message_id AND ci.conversation_id = m.conversation_id
      WHERE ci.conversation_id = ${conversationId}
        AND ci.item_type = 'message'
        AND m.message_id IS NULL
    `
    for (const ref of orphanedMsgRefs) {
      issues.push({
        severity: "error",
        check: "context_message_ref",
        message: `Context item at position ${ref.position} references missing message ${ref.message_id}`,
        details: { position: ref.position, messageId: ref.message_id },
      })
    }

    // 3. Context items referencing missing summaries
    const orphanedSumRefs = await conn<{ position: number; summary_id: string }[]>`
      SELECT ci.position, ci.summary_id
      FROM context_items ci
      LEFT JOIN summaries s ON ci.summary_id = s.summary_id AND ci.conversation_id = s.conversation_id
      WHERE ci.conversation_id = ${conversationId}
        AND ci.item_type = 'summary'
        AND s.summary_id IS NULL
    `
    for (const ref of orphanedSumRefs) {
      issues.push({
        severity: "error",
        check: "context_summary_ref",
        message: `Context item at position ${ref.position} references missing summary ${ref.summary_id}`,
        details: { position: ref.position, summaryId: ref.summary_id },
      })
    }

    // 4. Orphaned summaries (not in context and not a parent of any other summary)
    const orphanedSummaries = await conn<{ summary_id: string; kind: string }[]>`
      SELECT s.summary_id, s.kind
      FROM summaries s
      LEFT JOIN context_items ci ON s.summary_id = ci.summary_id AND s.conversation_id = ci.conversation_id
      LEFT JOIN summary_parents sp ON s.summary_id = sp.parent_summary_id
      WHERE s.conversation_id = ${conversationId}
        AND ci.summary_id IS NULL
        AND sp.parent_summary_id IS NULL
    `
    for (const s of orphanedSummaries) {
      issues.push({
        severity: "warning",
        check: "orphaned_summary",
        message: `Summary ${s.summary_id} (${s.kind}) is not in context and not referenced by any other summary`,
        details: { summaryId: s.summary_id, kind: s.kind },
      })
    }

    // 5. Condensed summaries with broken parent references
    const brokenParents = await conn<{ summary_id: string; parent_summary_id: string }[]>`
      SELECT sp.summary_id, sp.parent_summary_id
      FROM summary_parents sp
      JOIN summaries s ON sp.summary_id = s.summary_id AND s.conversation_id = ${conversationId}
      LEFT JOIN summaries ps ON sp.parent_summary_id = ps.summary_id
      WHERE ps.summary_id IS NULL
    `
    for (const bp of brokenParents) {
      issues.push({
        severity: "error",
        check: "broken_parent_ref",
        message: `Condensed summary ${bp.summary_id} references non-existent parent ${bp.parent_summary_id}`,
        details: { summaryId: bp.summary_id, parentId: bp.parent_summary_id },
      })
    }

    // 6. summary_messages referencing missing messages
    const brokenSummaryMsgs = await conn<{ summary_id: string; message_id: number }[]>`
      SELECT sm.summary_id, sm.message_id
      FROM summary_messages sm
      JOIN summaries s ON sm.summary_id = s.summary_id AND s.conversation_id = ${conversationId}
      LEFT JOIN messages m ON sm.message_id = m.message_id AND m.conversation_id = ${conversationId}
      WHERE m.message_id IS NULL
    `
    for (const bm of brokenSummaryMsgs) {
      issues.push({
        severity: "error",
        check: "broken_summary_message_ref",
        message: `Summary ${bm.summary_id} references non-existent message ${bm.message_id}`,
        details: { summaryId: bm.summary_id, messageId: bm.message_id },
      })
    }

    // 7. Token count drift — compare stored context token sum with recomputed estimate
    const contextEntries = await conn<{ item_type: string; token_count: number; content: string }[]>`
      SELECT ci.item_type,
        COALESCE(m.token_count, s.token_count) AS token_count,
        COALESCE(m.content, s.content) AS content
      FROM context_items ci
      LEFT JOIN messages m ON m.message_id = ci.message_id
      LEFT JOIN summaries s ON s.summary_id = ci.summary_id
      WHERE ci.conversation_id = ${conversationId}
      ORDER BY ci.position
    `
    let storedSum = 0
    let estimatedSum = 0
    for (const entry of contextEntries) {
      storedSum += entry.token_count ?? 0
      estimatedSum += Token.estimate(entry.content ?? "")
    }
    const drift = Math.abs(storedSum - estimatedSum)
    const driftPct = storedSum > 0 ? (drift / storedSum) * 100 : 0
    if (driftPct > 20) {
      issues.push({
        severity: "warning",
        check: "token_count_drift",
        message: `Token count drift: stored=${storedSum}, estimated=${estimatedSum} (${driftPct.toFixed(1)}% difference)`,
        details: { storedSum, estimatedSum, drift, driftPct },
      })
    }

    // 8. Circular parent references in summary DAG
    const cycles = await conn<{ summary_id: string }[]>`
      WITH RECURSIVE walk(summary_id, path, has_cycle) AS (
        SELECT sp.summary_id, ARRAY[sp.summary_id], false
        FROM summary_parents sp
        JOIN summaries s ON sp.summary_id = s.summary_id AND s.conversation_id = ${conversationId}
        UNION ALL
        SELECT sp.parent_summary_id, w.path || sp.parent_summary_id, sp.parent_summary_id = ANY(w.path)
        FROM summary_parents sp
        JOIN walk w ON sp.summary_id = w.summary_id
        WHERE NOT w.has_cycle
      )
      SELECT DISTINCT summary_id FROM walk WHERE has_cycle
    `
    for (const c of cycles) {
      issues.push({
        severity: "error",
        check: "summary_cycle",
        message: `Circular reference detected in summary DAG involving ${c.summary_id}`,
        details: { summaryId: c.summary_id },
      })
    }

    // Gather stats
    const [msgCount] = await conn<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM messages WHERE conversation_id = ${conversationId}
    `
    const [sumCount] = await conn<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM summaries WHERE conversation_id = ${conversationId}
    `
    const [fileCount] = await conn<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM large_files WHERE conversation_id = ${conversationId}
    `

    const report: Report = {
      conversationId,
      healthy: issues.filter((i) => i.severity === "error").length === 0,
      issues,
      stats: {
        contextItems: positions.length,
        messages: msgCount.count,
        summaries: sumCount.count,
        largeFiles: fileCount.count,
        contextTokens,
        maxTokens,
        threshold,
      },
    }

    log.info("integrity check complete", {
      conversationId,
      healthy: report.healthy,
      issueCount: issues.length,
      errorCount: issues.filter((i) => i.severity === "error").length,
    })

    return report
  }
}
