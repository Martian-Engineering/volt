import { Tool } from "./tool"
import DESCRIPTION from "./agentic-map.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import { LcmDb } from "../session/lcm/db"
import { Log } from "../util/log"
import type postgres from "postgres"
import {
  stableStringify,
  buildUserMessage,
  parseJsonlFile,
  preflightSchema,
  checkPathPermissions,
  registerFileInLcm,
  resolvePath,
  formatValidationErrors,
} from "./map-shared"

// Re-export for tests
export { stableStringify, buildUserMessage } from "./map-shared"

const log = Log.create({ service: "tool.agentic_map" })

const parameters = z.object({
  input_path: z.string().describe("File path to JSONL input"),
  output_path: z.string().describe("File path where JSONL output will be written"),
  prompt: z.string().describe("Base instruction text for sub-agents"),
  output_schema: z.record(z.string(), z.any()).describe("JSON Schema (as JSON object) for sub-agent output validation"),
  read_only: z.boolean().describe("If true, sub-agent write operations are disabled"),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Wall-clock timeout in seconds per item (e.g., 300 for 5 minutes). Default: 900"),
  max_attempts: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max attempts per item, including initial (default: 3)"),
})

type Params = z.infer<typeof parameters>

export function buildSystemMessage(readOnly: boolean): string {
  const lines = [
    "You are operating on one item from a parallel agentic map.",
    "",
    "You must output exactly one JSON value as your final answer:",
    "- No surrounding prose, explanations, or commentary.",
    "- No markdown fences (no ```json blocks).",
    "- No trailing text after the JSON.",
    "",
    "Your JSON output must validate against the schema provided in <map-details-json>.",
    "If the system reports a JSON parsing or schema validation error, respond with corrected JSON only.",
  ]
  if (readOnly) {
    lines.push("")
    lines.push("Write operations (edit, write, bash) are disabled for this task.")
  }
  return lines.join("\n")
}

export const AgenticMapTool = Tool.define("agentic_map", {
  description: DESCRIPTION,
  parameters,
  async execute(params: Params, ctx) {
    const concurrency = 16
    const timeoutSeconds = params.timeout_seconds ?? 900
    const maxAttempts = params.max_attempts ?? 3

    // --- Step 1: Resolve paths ---
    const resolvedInputPath = resolvePath(params.input_path)
    const resolvedOutputPath = resolvePath(params.output_path)

    // --- Step 2: Permission checks (before any file read or DB writes) ---
    await checkPathPermissions(ctx, resolvedInputPath, resolvedOutputPath)

    // --- Step 3: JSON Schema preflight (Draft 2020-12) ---
    const validate = preflightSchema(params.output_schema)

    // --- Step 4: Parse input JSONL ---
    const items = await parseJsonlFile(resolvedInputPath)

    // Task permission: spawning sub-agents (after we know item count)
    await ctx.ask({
      permission: "task",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        description: `agentic_map: ${items.length} items`,
        subagent_type: "agentic_map",
      },
    })

    // --- Step 5: Get model info for LCM ---
    const parentMsg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    if (parentMsg.info.role !== "assistant") throw new Error("Not an assistant message")
    const parentProviderID = parentMsg.info.providerID
    const parentModelID = parentMsg.info.modelID
    const model = await Provider.getModel(parentProviderID, parentModelID)

    // --- Step 6: Register input in LCM ---
    const conversationId = await SessionPrompt.getOrCreateLcmConversation(ctx.sessionID, model)
    if (conversationId === null) {
      throw new Error("LCM database is not available")
    }

    const inputLcmId = await registerFileInLcm(conversationId, resolvedInputPath, model, ctx.abort)

    // --- Step 7: Resolve parent permissions for read_only=false inheritance ---
    const parentSession = await Session.get(ctx.sessionID)
    const parentPermissions = parentSession.permission ?? []

    // --- Step 8: Create map run in Postgres (multi-tenant aware) ---
    const runStartedAt = new Date()

    return LcmDb.withUserContext(async (conn) => {
      const [runRow] = await conn<{ map_id: string; run_started_at: Date }[]>`
      INSERT INTO agentic_map_runs (
        run_started_at, status, input_path, input_lcm_id, output_path, prompt,
        output_schema, read_only, concurrency, timeout_seconds, max_attempts
      )
      VALUES (
        ${runStartedAt}, 'RUNNING', ${resolvedInputPath}, ${inputLcmId},
        ${resolvedOutputPath}, ${params.prompt}, ${conn.json(params.output_schema as postgres.JSONValue)},
        ${params.read_only}, ${concurrency}, ${timeoutSeconds}, ${maxAttempts}
      )
      RETURNING map_id, run_started_at
    `
      const mapId = runRow.map_id
      const runStartedAtISO = runRow.run_started_at.toISOString()

      // Bulk insert item rows
      for (let i = 0; i < items.length; i++) {
        await conn`
        INSERT INTO agentic_map_items (map_id, item_index, item, status, attempts_used)
        VALUES (${mapId}, ${i}, ${conn.json(items[i] as postgres.JSONValue)}, 'PENDING', 0)
      `
      }

      log.info("map run created", { mapId, totalItems: items.length, concurrency })

      // --- Run worker pool ---
      const systemMessage = buildSystemMessage(params.read_only)
      let succeededCount = 0
      let failedCount = 0
      let runningCount = 0

      function updateProgress() {
        ctx.metadata({
          title: `agentic_map: ${succeededCount + failedCount}/${items.length} items`,
          metadata: {
            map_id: mapId,
            total_items: items.length,
            succeeded: succeededCount,
            failed: failedCount,
            running: runningCount,
          },
        })
      }

      async function claimItem(): Promise<{ item_index: number; item: unknown } | null> {
        return conn.begin(async (tx) => {
          const rows = await tx<{ item_index: number; item: unknown }[]>`
          SELECT item_index, item
          FROM agentic_map_items
          WHERE map_id = ${mapId} AND status = 'PENDING'
          ORDER BY item_index
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
          if (rows.length === 0) return null

          const row = rows[0]
          await tx`
          UPDATE agentic_map_items
          SET status = 'RUNNING', started_at = now(), attempts_used = 1
          WHERE map_id = ${mapId} AND item_index = ${row.item_index}
        `
          return { item_index: row.item_index, item: row.item }
        })
      }

      async function processItem(itemIndex: number, item: unknown): Promise<void> {
        const itemStartTime = Date.now()

        const session = await Session.create({
          parentID: ctx.sessionID,
          title: `agentic_map item ${itemIndex} (map ${mapId.slice(0, 8)})`,
          permission: params.read_only
            ? [
                { permission: "edit" as const, pattern: "*" as const, action: "deny" as const },
                { permission: "write" as const, pattern: "*" as const, action: "deny" as const },
                { permission: "bash" as const, pattern: "*" as const, action: "deny" as const },
                { permission: "task" as const, pattern: "*" as const, action: "deny" as const },
                { permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const },
              ]
            : parentPermissions,
        })

        const userMessageText = buildUserMessage(
          params.prompt,
          mapId,
          runStartedAtISO,
          inputLcmId,
          itemIndex,
          item,
          params.output_schema,
        )

        const timeoutHandle = setTimeout(() => {
          SessionPrompt.cancel(session.id)
        }, timeoutSeconds * 1000)

        let attemptsUsed = 0
        let lastError = ""

        try {
          attemptsUsed = 1
          let result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { modelID: parentModelID, providerID: parentProviderID },
            agent: ctx.agent,
            tools: params.read_only ? { edit: false, write: false, bash: false } : {},
            parts: [{ type: "text", text: userMessageText }],
            system: systemMessage,
          })

          while (true) {
            const finalAnswer = result.parts.findLast((p) => p.type === "text")
            const answerText = finalAnswer && "text" in finalAnswer ? finalAnswer.text : ""

            let parsed: unknown
            let parseError: string | undefined
            try {
              parsed = JSON.parse(answerText)
            } catch (e) {
              parseError = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
            }

            if (parseError === undefined) {
              const valid = validate(parsed)
              if (valid) {
                await conn`
                UPDATE agentic_map_items
                SET status = 'DONE', result = ${conn.json(parsed as postgres.JSONValue)},
                    attempts_used = ${attemptsUsed}, finished_at = now()
                WHERE map_id = ${mapId} AND item_index = ${itemIndex}
              `
                succeededCount++
                return
              }
              lastError = formatValidationErrors(validate.errors ?? [])
            } else {
              lastError = parseError
            }

            const elapsed = Date.now() - itemStartTime
            if (attemptsUsed >= maxAttempts || elapsed >= timeoutSeconds * 1000) {
              break
            }

            attemptsUsed++
            await conn`
            UPDATE agentic_map_items
            SET attempts_used = ${attemptsUsed}
            WHERE map_id = ${mapId} AND item_index = ${itemIndex}
          `

            result = await SessionPrompt.prompt({
              sessionID: session.id,
              model: { modelID: parentModelID, providerID: parentProviderID },
              agent: ctx.agent,
              tools: params.read_only ? { edit: false, write: false, bash: false } : {},
              parts: [
                {
                  type: "text",
                  text: `Validation failed: ${lastError}\nRespond with JSON only that conforms to the schema.`,
                },
              ],
              system: systemMessage,
            })
          }

          // Terminal failure
          const elapsed = Date.now() - itemStartTime
          const terminalError = elapsed >= timeoutSeconds * 1000 ? `timeout after ${timeoutSeconds}s` : lastError
          await conn`
          UPDATE agentic_map_items
          SET status = 'FAILED', error = ${terminalError},
              attempts_used = ${attemptsUsed}, finished_at = now()
          WHERE map_id = ${mapId} AND item_index = ${itemIndex}
        `
          failedCount++
        } catch (e) {
          const elapsed = Date.now() - itemStartTime
          const errorMsg =
            elapsed >= timeoutSeconds * 1000
              ? `timeout after ${timeoutSeconds}s`
              : e instanceof Error
                ? e.message
                : String(e)

          await conn`
          UPDATE agentic_map_items
          SET status = 'FAILED', error = ${errorMsg},
              attempts_used = ${Math.max(attemptsUsed, 1)}, finished_at = now()
          WHERE map_id = ${mapId} AND item_index = ${itemIndex}
        `.catch((dbErr) => log.error("failed to record item failure", { itemIndex, dbErr }))
          failedCount++
        } finally {
          clearTimeout(timeoutHandle)
        }
      }

      async function runWorker(): Promise<void> {
        while (true) {
          const claimed = await claimItem()
          if (!claimed) break

          runningCount++
          updateProgress()

          await processItem(claimed.item_index, claimed.item)

          runningCount--
          updateProgress()
        }
      }

      // Launch worker pool
      updateProgress()
      const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
      await Promise.all(workers)

      // --- Write output JSONL ---
      const allItems = await conn<{ item_index: number; status: string; result: unknown; error: string | null }[]>`
      SELECT item_index, status, result, error
      FROM agentic_map_items
      WHERE map_id = ${mapId}
      ORDER BY item_index
    `

      const outputLines = allItems.map((row) => {
        if (row.status === "DONE") {
          return JSON.stringify({ item_index: row.item_index, ok: true, result: row.result })
        }
        return JSON.stringify({ item_index: row.item_index, ok: false, error: row.error ?? "unknown error" })
      })

      await Bun.write(resolvedOutputPath, outputLines.join("\n") + "\n")

      // --- Register output in LCM ---
      const outputLcmId = await registerFileInLcm(conversationId, resolvedOutputPath, model, ctx.abort)

      // Update map run to DONE
      await conn`
      UPDATE agentic_map_runs
      SET status = 'DONE', output_lcm_id = ${outputLcmId}
      WHERE map_id = ${mapId}
    `

      log.info("map run completed", { mapId, succeeded: succeededCount, failed: failedCount })

      return {
        title: `agentic_map: ${succeededCount}/${items.length} succeeded`,
        metadata: { truncated: false },
        output: JSON.stringify({
          map_id: mapId,
          run_started_at: runStartedAtISO,
          input_lcm_id: inputLcmId,
          output_lcm_id: outputLcmId,
          total_items: items.length,
          succeeded: succeededCount,
          failed: failedCount,
        }),
      }
    }) // end withUserContext
  },
})
