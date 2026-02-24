import fs from "fs/promises"
import path from "path"
import { LCM_CONTEXT_SNAPSHOT_PATH } from "./config"
import { LcmDb } from "./db"

export namespace LcmContextSnapshot {
  export interface LaneTokenCounts {
    leaves: number
    sprigs: number
    bindles: number
    total: number
  }

  export interface LaneItemCounts {
    leaves: number
    sprigs: number
    bindles: number
    total: number
  }

  export interface Snapshot {
    version: 1
    writtenAt: string
    reason: string
    sessionID: string
    conversationId: number
    triggerMessageId?: number
    laneTokenCounts: LaneTokenCounts
    laneItemCounts: LaneItemCounts
    contextItemCount: number
    orderInvariant: "bindles_sprigs_leaves"
    references: {
      tables: {
        conversations: "conversations"
        contextItems: "context_items"
        messages: "messages"
        summaries: "summaries"
      }
      conversationId: number
    }
  }

  export async function write(input: {
    conversationId: number
    sessionID: string
    reason: string
    triggerMessageId?: number
    filepath?: string
  }): Promise<Snapshot> {
    await LcmDb.normalizeContextLaneOrder(input.conversationId)
    const contextRows = await LcmDb.getCurrentContextWithRefs(input.conversationId)
    const laneTokens = await LcmDb.getContextLaneTokenCounts(input.conversationId)
    const totalTokens = await LcmDb.getContextTokenCount(input.conversationId)

    let leaves = 0
    let sprigs = 0
    let bindles = 0
    for (const row of contextRows) {
      if (row.item_type === "message") {
        leaves++
        continue
      }
      const lane = LcmDb.classifySummaryForDoltLane({
        condensationOrder: row.condensation_order,
        summaryLevel: row.summary_level,
        summaryType: row.summary_type,
        kind: null,
      })
      if (lane === "sprig") {
        sprigs++
        continue
      }
      if (lane === "bindle") {
        bindles++
      }
    }

    const snapshot: Snapshot = {
      version: 1,
      writtenAt: new Date().toISOString(),
      reason: input.reason,
      sessionID: input.sessionID,
      conversationId: input.conversationId,
      triggerMessageId: input.triggerMessageId,
      laneTokenCounts: {
        leaves: laneTokens.leaves,
        sprigs: laneTokens.sprigs,
        bindles: laneTokens.bindles,
        total: totalTokens,
      },
      laneItemCounts: {
        leaves,
        sprigs,
        bindles,
        total: contextRows.length,
      },
      contextItemCount: contextRows.length,
      orderInvariant: "bindles_sprigs_leaves",
      references: {
        tables: {
          conversations: "conversations",
          contextItems: "context_items",
          messages: "messages",
          summaries: "summaries",
        },
        conversationId: input.conversationId,
      },
    }

    const filepath = input.filepath ?? LCM_CONTEXT_SNAPSHOT_PATH
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await Bun.write(filepath, JSON.stringify(snapshot, null, 2))
    return snapshot
  }

  export async function read(filepath = LCM_CONTEXT_SNAPSHOT_PATH): Promise<Snapshot | null> {
    try {
      const file = Bun.file(filepath)
      if (!(await file.exists())) return null
      const value = await file.json()
      return value as Snapshot
    } catch {
      return null
    }
  }
}
