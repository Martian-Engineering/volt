import z from "zod"
import { Log } from "@/util/log"
import { LcmDb } from "./db"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"

/**
 * LCM Migration Module
 *
 * Provides utilities to migrate existing VoltCode session data from file-based
 * storage to the new PostgreSQL-based LCM storage.
 *
 * This is a one-way migration - data flows from file storage to PostgreSQL.
 * The migration preserves message order and handles errors gracefully.
 */
export namespace LcmMigration {
  const log = Log.create({ service: "lcm.migration" })

  export const MigrationResult = z.object({
    success: z.boolean(),
    sessionID: z.string(),
    conversationId: z.number().optional(),
    messageCount: z.number(),
    error: z.string().optional(),
  })
  export type MigrationResult = z.infer<typeof MigrationResult>

  export const MigrationSummary = z.object({
    total: z.number(),
    successful: z.number(),
    failed: z.number(),
    results: MigrationResult.array(),
  })
  export type MigrationSummary = z.infer<typeof MigrationSummary>

  /**
   * Map VoltCode message role to LCM message role.
   * VoltCode uses "user" and "assistant" roles, while LCM supports
   * "system", "user", "assistant", and "tool".
   */
  function mapRole(role: "user" | "assistant"): LcmDb.MessageRole {
    return role
  }

  /**
   * Convert MessageV2 parts to a single content string for LCM storage.
   * This flattens the rich part structure into a text representation.
   * Only includes actual conversation content (text, reasoning, tool results).
   * Patch, file, subtask, compaction, and other metadata parts are stored
   * exclusively in the message_parts table.
   *
   * @internal Exported for testing
   */
  export function partsToContent(msg: MessageV2.WithParts): string {
    const parts: string[] = []

    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          if (part.text && !part.ignored) {
            parts.push(part.text)
          }
          break
        case "reasoning":
          if (part.text) {
            parts.push(`<reasoning>\n${part.text}\n</reasoning>`)
          }
          break
        case "tool":
          if (part.state.status === "completed") {
            // Ensure output is always a string - handle non-string types safely
            const rawOutput = part.state.output
            const safeOutput =
              typeof rawOutput === "string" ? rawOutput : rawOutput == null ? "" : JSON.stringify(rawOutput)
            parts.push(
              `<tool name="${part.tool}">\nInput: ${JSON.stringify(part.state.input)}\nOutput: ${safeOutput}\n</tool>`,
            )
          } else if (part.state.status === "error") {
            parts.push(
              `<tool name="${part.tool}">\nInput: ${JSON.stringify(part.state.input)}\nError: ${part.state.error}\n</tool>`,
            )
          }
          break
        // Skip patch, file, subtask, compaction, step-start, step-finish,
        // snapshot, agent, retry parts - these are metadata stored in message_parts
      }
    }

    return parts.join("\n\n")
  }

  /**
   * Convert MessageV2 parts to structured LcmDb.MessagePartInput rows.
   * Maps each part type to its corresponding columns in the message_parts table.
   *
   * @internal Exported for testing
   */
  export function partsToMessagePartInputs(parts: MessageV2.Part[]): LcmDb.MessagePartInput[] {
    return parts.map((part, index): LcmDb.MessagePartInput => {
      const base: Pick<LcmDb.MessagePartInput, "partId" | "sessionId" | "ordinal"> = {
        partId: part.id,
        sessionId: part.sessionID,
        ordinal: index,
      }

      switch (part.type) {
        case "text":
          return {
            ...base,
            partType: "text",
            textContent: part.text,
            isIgnored: part.ignored ?? null,
            isSynthetic: part.synthetic ?? null,
            metadata: part.metadata ?? null,
          }
        case "reasoning":
          return {
            ...base,
            partType: "reasoning",
            textContent: part.text,
            metadata: part.metadata ?? null,
          }
        case "tool": {
          let metadata: Record<string, any> | null = part.metadata ?? null
          const stateMetadata = "metadata" in part.state ? part.state.metadata : undefined
          if (stateMetadata) {
            metadata = metadata ? { ...metadata, ...stateMetadata } : stateMetadata
          }
          const result: LcmDb.MessagePartInput = {
            ...base,
            partType: "tool",
            toolCallId: part.callID,
            toolName: part.tool,
            toolStatus: part.state.status,
            toolInput: part.state.input,
            metadata,
          }
          if (part.state.status === "completed") {
            result.toolOutput =
              typeof part.state.output === "string"
                ? part.state.output
                : part.state.output == null
                  ? ""
                  : JSON.stringify(part.state.output)
            result.toolTitle = part.state.title
          } else if (part.state.status === "error") {
            result.toolError = part.state.error
          }
          return result
        }
        case "patch":
          return {
            ...base,
            partType: "patch",
            patchHash: part.hash,
            patchFiles: part.files,
          }
        case "file":
          return {
            ...base,
            partType: "file",
            fileMime: part.mime,
            fileName: part.filename ?? null,
            fileUrl: part.url,
          }
        case "subtask":
          return {
            ...base,
            partType: "subtask",
            subtaskPrompt: part.prompt,
            subtaskDesc: part.description,
            subtaskAgent: part.agent,
          }
        case "compaction":
          return {
            ...base,
            partType: "compaction",
            compactionAuto: part.auto,
          }
        case "step-start":
          return {
            ...base,
            partType: "step_start",
            snapshotHash: part.snapshot ?? null,
          }
        case "step-finish":
          return {
            ...base,
            partType: "step_finish",
            stepReason: part.reason,
            snapshotHash: part.snapshot ?? null,
            stepCost: part.cost,
            stepTokensIn: part.tokens.input,
            stepTokensOut: part.tokens.output,
          }
        case "snapshot":
          return {
            ...base,
            partType: "snapshot",
            snapshotHash: part.snapshot,
          }
        case "agent":
          return {
            ...base,
            partType: "agent",
            subtaskAgent: part.name,
            metadata: part.source ? { source: part.source } : null,
          }
        case "retry":
          return {
            ...base,
            partType: "retry",
            metadata: {
              attempt: part.attempt,
              error: part.error,
              time: part.time,
            },
          }
      }
    })
  }

  /**
   * Simple token count estimation.
   * Uses a rough approximation of 4 characters per token.
   */
  function estimateTokenCount(content: string): number {
    return Math.ceil(content.length / 4)
  }

  /**
   * Check if a session has already been migrated to PostgreSQL.
   * Currently checks by title matching - a more robust approach would be
   * to store a mapping of sessionID to conversationId.
   */
  async function isAlreadyMigrated(sessionID: string): Promise<boolean> {
    try {
      const conn = LcmDb.getConnection()
      const titlePattern = `[Migrated]%(${sessionID})`
      const rows = await conn<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1
          FROM conversations
          WHERE title IS NOT NULL
            AND title LIKE ${titlePattern}
        ) AS exists
      `
      return rows[0]?.exists ?? false
    } catch (e) {
      log.warn("failed to check migration status; assuming not migrated", { sessionID, error: e })
      return false
    }
  }

  /**
   * Migrate a single session from file storage to PostgreSQL.
   *
   * @param input - Configuration for the migration
   * @returns MigrationResult indicating success/failure and details
   */
  export async function migrateSession(input: {
    sessionID: string
    modelName: string
    maxTokens: number
  }): Promise<MigrationResult> {
    const { sessionID, modelName, maxTokens } = input
    log.info("starting session migration", { sessionID })

    try {
      // Check if already migrated
      if (await isAlreadyMigrated(sessionID)) {
        log.info("session already migrated, skipping", { sessionID })
        return {
          success: true,
          sessionID,
          messageCount: 0,
          error: "Session already migrated",
        }
      }

      // Get session info
      const sessionInfo = await Session.get(sessionID).catch(() => null)
      if (!sessionInfo) {
        return {
          success: false,
          sessionID,
          messageCount: 0,
          error: "Session not found",
        }
      }

      // Get all messages for the session
      const messages = await Session.messages({ sessionID })
      if (messages.length === 0) {
        log.info("session has no messages, skipping", { sessionID })
        return {
          success: true,
          sessionID,
          messageCount: 0,
        }
      }

      // Create a new LCM conversation
      const title = `[Migrated] ${sessionInfo.title} (${sessionID})`
      const conversationId = await LcmDb.createConversation({
        title,
        modelName,
        modelCtxMaxTokens: maxTokens,
      })
      log.info("created LCM conversation", { conversationId, sessionID })

      // Migrate each message
      let messageCount = 0
      for (const msg of messages) {
        const content = partsToContent(msg)
        if (!content.trim()) {
          log.debug("skipping empty message", { messageID: msg.info.id })
          continue
        }

        const tokenCount = estimateTokenCount(content)
        const role = mapRole(msg.info.role)

        const messageId = await LcmDb.appendMessage({
          conversationId,
          role,
          content,
          tokenCount,
        })

        // Write structured parts to the message_parts table
        const partInputs = partsToMessagePartInputs(msg.parts)
        if (partInputs.length > 0) {
          await LcmDb.insertMessageParts(messageId, partInputs)
        }

        messageCount++
      }

      log.info("completed session migration", { sessionID, conversationId, messageCount })
      return {
        success: true,
        sessionID,
        conversationId,
        messageCount,
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      log.error("failed to migrate session", { sessionID, error: e })
      return {
        success: false,
        sessionID,
        messageCount: 0,
        error,
      }
    }
  }

  /**
   * Migrate all sessions in the storage directory to PostgreSQL.
   *
   * @param input - Configuration for the migration
   * @returns MigrationSummary with overall results
   */
  export async function migrateAllSessions(input: { modelName: string; maxTokens: number }): Promise<MigrationSummary> {
    const { modelName, maxTokens } = input
    log.info("starting migration of all sessions")

    const results: MigrationResult[] = []
    let successful = 0
    let failed = 0

    // Iterate through all sessions
    for await (const sessionInfo of Session.list()) {
      if (!sessionInfo) continue

      const result = await migrateSession({
        sessionID: sessionInfo.id,
        modelName,
        maxTokens,
      })

      results.push(result)
      if (result.success) {
        successful++
      } else {
        failed++
      }

      // Log progress periodically
      if ((successful + failed) % 10 === 0) {
        log.info("migration progress", { successful, failed, total: successful + failed })
      }
    }

    const summary: MigrationSummary = {
      total: results.length,
      successful,
      failed,
      results,
    }

    log.info("completed migration of all sessions", {
      total: summary.total,
      successful: summary.successful,
      failed: summary.failed,
    })

    return summary
  }
}
