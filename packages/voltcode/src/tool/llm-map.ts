import { Tool } from "./tool"
import DESCRIPTION from "./llm-map.txt"
import z from "zod"
import { generateText } from "ai"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import { ProviderTransform } from "../provider/transform"
import { LcmDb } from "../session/lcm/db"
import { Log } from "../util/log"
import type postgres from "postgres"
import {
  buildUserMessage,
  parseJsonlFile,
  preflightSchema,
  checkPathPermissions,
  registerFileInLcm,
  resolvePath,
  formatValidationErrors,
} from "./map-shared"

const log = Log.create({ service: "tool.llm_map" })

const parameters = z.object({
  input_path: z.string().describe("File path to JSONL input"),
  output_path: z.string().describe("File path where JSONL output will be written"),
  prompt: z.string().describe("Base instruction text sent to the LLM for each item"),
  output_schema: z.record(z.string(), z.any()).describe("JSON Schema (as JSON object) for LLM output validation"),
  model: z.string().optional().describe('Model: "small" (default), "default" for parent model, or "provider/model-id"'),
  concurrency: z.number().int().positive().optional().describe("Max parallel LLM requests (default: 16)"),
  timeout_seconds: z.number().int().positive().optional().describe("Max wall-clock seconds per item (default: 120)"),
  max_attempts: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max LLM calls per item, including initial (default: 3)"),
})

type Params = z.infer<typeof parameters>

const SYSTEM_MESSAGE = [
  "You are processing one item from a parallel LLM map.",
  "",
  "You must return exactly one JSON value as the entire response:",
  "- No surrounding prose, explanations, or commentary.",
  "- No markdown fences (no ```json blocks).",
  "- No trailing text after the JSON.",
  "",
  "Your JSON output must validate against the schema provided in <map-details-json>.",
  "If asked to retry due to an error, output corrected JSON only.",
  "",
  "No external tools exist and no actions can be taken beyond returning JSON text.",
].join("\n")

/** Build provider options that enable JSON response mode where supported. */
function buildJsonModeProviderOptions(model: Provider.Model): Record<string, Record<string, any>> {
  switch (model.api.npm) {
    case "@ai-sdk/openai":
    case "@ai-sdk/azure":
    case "@ai-sdk/github-copilot":
      return ProviderTransform.providerOptions(model, {
        response_format: { type: "json_object" },
      })
    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return ProviderTransform.providerOptions(model, {
        responseMimeType: "application/json",
      })
    default:
      return {}
  }
}

/** Shallow-merge two provider options objects (keyed by provider SDK key). */
function mergeProviderOptions(
  a: Record<string, Record<string, any>>,
  b: Record<string, Record<string, any>>,
): Record<string, Record<string, any>> {
  const result = { ...a }
  for (const [key, val] of Object.entries(b)) {
    result[key] = { ...(result[key] ?? {}), ...val }
  }
  return result
}

/** Resolve model parameter to a concrete provider/model tuple.
 *  - undefined or "small" → Provider.getSmallModel (fast/cheap)
 *  - "default" → parent session model
 *  - "provider/model-id" → explicit override */
async function resolveModel(
  modelParam: string | undefined,
  parentProviderID: string,
  parentModelID: string,
): Promise<{
  providerID: string
  modelID: string
  model: Provider.Model
}> {
  const value = modelParam ?? "small"

  if (value === "default") {
    const model = await Provider.getModel(parentProviderID, parentModelID)
    return { providerID: parentProviderID, modelID: parentModelID, model }
  }

  if (value === "small") {
    const smallModel = await Provider.getSmallModel(parentProviderID)
    if (!smallModel) {
      throw new Error(
        'No small model configured — set "small_model" in config, or pass model: "default" to use the parent model',
      )
    }
    return {
      providerID: smallModel.providerID,
      modelID: smallModel.id,
      model: smallModel,
    }
  }

  // Explicit "provider/model-id" override
  const parsed = Provider.parseModel(value)
  const model = await Provider.getModel(parsed.providerID, parsed.modelID)
  return { providerID: parsed.providerID, modelID: parsed.modelID, model }
}

/** Build the retry user message per spec: original message + error context + prior response. */
function buildRetryMessage(originalUserMessage: string, validationError: string, priorResponse: string): string {
  return [
    originalUserMessage,
    "",
    "The previous response did not parse as JSON and/or did not validate against the schema.",
    "Validation error:",
    validationError,
    "",
    "Previous response:",
    priorResponse,
    "",
    "Return corrected JSON only that conforms to output_schema.",
  ].join("\n")
}

export { buildJsonModeProviderOptions, mergeProviderOptions }

export const LlmMapTool = Tool.define("llm_map", {
  description: DESCRIPTION,
  parameters,
  async execute(params: Params, ctx) {
    const concurrency = params.concurrency ?? 16
    const timeoutSeconds = params.timeout_seconds ?? 120
    const maxAttempts = params.max_attempts ?? 3

    // --- Step 1: Resolve paths ---
    const resolvedInputPath = resolvePath(params.input_path)
    const resolvedOutputPath = resolvePath(params.output_path)

    // --- Step 2: Permission checks ---
    await checkPathPermissions(ctx, resolvedInputPath, resolvedOutputPath)

    // --- Step 3: JSON Schema preflight (Draft 2020-12) ---
    const validate = preflightSchema(params.output_schema)

    // --- Step 4: Parse input JSONL ---
    const items = await parseJsonlFile(resolvedInputPath)

    // --- Step 5: Get parent model info ---
    const parentMsg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    if (parentMsg.info.role !== "assistant") throw new Error("Not an assistant message")
    const parentProviderID = parentMsg.info.providerID
    const parentModelID = parentMsg.info.modelID

    // --- Step 6: Resolve model parameter to concrete model ---
    const resolved = await resolveModel(params.model, parentProviderID, parentModelID)
    const languageModel = await Provider.getLanguage(resolved.model)

    // Merge JSON mode provider options for providers that support it
    const jsonModeOpts = buildJsonModeProviderOptions(resolved.model)
    const providerOptions = jsonModeOpts

    const maxOutputTokens = ProviderTransform.maxOutputTokens(
      resolved.model.api.npm,
      providerOptions,
      resolved.model.limit.output,
      32_000,
    )

    log.info("resolved model", {
      model: params.model ?? "small",
      provider: resolved.providerID,
      modelID: resolved.modelID,
    })

    // --- Step 7: Get LCM model reference (use parent model for LCM) ---
    const lcmModel = await Provider.getModel(parentProviderID, parentModelID)
    const conversationId = await SessionPrompt.getOrCreateLcmConversation(ctx.sessionID, lcmModel)
    if (conversationId === null) {
      throw new Error("LCM database is not available")
    }

    // --- Step 8: Register input in LCM ---
    const inputLcmId = await registerFileInLcm(conversationId, resolvedInputPath, lcmModel, ctx.abort)

    // --- Step 9: Create map run in Postgres (multi-tenant aware) ---
    const runStartedAt = new Date()

    return LcmDb.withUserContext(async (conn) => {
      const [runRow] = await conn<{ map_id: string; run_started_at: Date }[]>`
      INSERT INTO llm_map_runs (
        run_started_at, status, input_path, input_lcm_id, output_path, prompt,
        output_schema, model, concurrency, timeout_seconds, max_attempts,
        resolved_provider, resolved_model, resolved_request_overrides
      )
      VALUES (
        ${runStartedAt}, 'RUNNING', ${resolvedInputPath}, ${inputLcmId},
        ${resolvedOutputPath}, ${params.prompt}, ${conn.json(params.output_schema as postgres.JSONValue)},
        ${params.model ?? "small"}, ${concurrency}, ${timeoutSeconds}, ${maxAttempts},
        ${resolved.providerID}, ${resolved.modelID},
        ${conn.json(providerOptions as postgres.JSONValue)}
      )
      RETURNING map_id, run_started_at
    `
      const mapId = runRow.map_id
      const runStartedAtISO = runRow.run_started_at.toISOString()

      // Bulk insert item rows
      for (let i = 0; i < items.length; i++) {
        await conn`
        INSERT INTO llm_map_items (map_id, item_index, item, status, attempts_used)
        VALUES (${mapId}, ${i}, ${conn.json(items[i] as postgres.JSONValue)}, 'PENDING', 0)
      `
      }

      log.info("llm_map run created", { mapId, totalItems: items.length, concurrency, model: params.model ?? "small" })

      // --- Step 10: Run worker pool ---
      let succeededCount = 0
      let failedCount = 0
      let runningCount = 0

      function updateProgress() {
        ctx.metadata({
          title: `llm_map: ${succeededCount + failedCount}/${items.length} items`,
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
          FROM llm_map_items
          WHERE map_id = ${mapId} AND status = 'PENDING'
          ORDER BY item_index
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
          if (rows.length === 0) return null

          const row = rows[0]
          await tx`
          UPDATE llm_map_items
          SET status = 'RUNNING', started_at = now(), attempts_used = 1
          WHERE map_id = ${mapId} AND item_index = ${row.item_index}
        `
          return { item_index: row.item_index, item: row.item }
        })
      }

      async function processItem(itemIndex: number, item: unknown): Promise<void> {
        const itemStartTime = Date.now()

        // Build the initial user message
        const userMessage = buildUserMessage(
          params.prompt,
          mapId,
          runStartedAtISO,
          inputLcmId,
          itemIndex,
          item,
          params.output_schema,
        )

        let attemptsUsed = 0
        let lastError = ""
        let lastResponse = ""

        try {
          // Initial LLM call
          attemptsUsed = 1
          const remainingMs = Math.max(1, timeoutSeconds * 1000 - (Date.now() - itemStartTime))
          const abortController = new AbortController()
          const timeoutId = setTimeout(() => abortController.abort(), remainingMs)

          let result: Awaited<ReturnType<typeof generateText>>
          try {
            result = await generateText({
              model: languageModel,
              system: SYSTEM_MESSAGE,
              messages: [{ role: "user", content: userMessage }],
              maxOutputTokens,
              providerOptions,
              headers: resolved.model.headers,
              abortSignal: abortController.signal,
            })
          } finally {
            clearTimeout(timeoutId)
          }
          lastResponse = result.text

          // Strip markdown code fences (```json ... ```) that some models wrap around JSON
          lastResponse = lastResponse
            .replace(/^```(?:json)?\s*\n?/i, "")
            .replace(/\n?```\s*$/i, "")
            .trim()

          // Validation loop
          while (true) {
            let parsed: unknown
            let parseError: string | undefined
            try {
              parsed = JSON.parse(lastResponse)
            } catch (e) {
              parseError = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`
            }

            if (parseError === undefined) {
              const valid = validate(parsed)
              if (valid) {
                // Success
                await conn`
                UPDATE llm_map_items
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

            // Check if we can retry
            const elapsed = Date.now() - itemStartTime
            if (attemptsUsed >= maxAttempts || elapsed >= timeoutSeconds * 1000) {
              break
            }

            // Retry with error context and prior response (fresh request per spec)
            attemptsUsed++
            await conn`
            UPDATE llm_map_items
            SET attempts_used = ${attemptsUsed}
            WHERE map_id = ${mapId} AND item_index = ${itemIndex}
          `

            const retryMessage = buildRetryMessage(userMessage, lastError, lastResponse)
            const retryRemainingMs = Math.max(1, timeoutSeconds * 1000 - (Date.now() - itemStartTime))
            const retryAbort = new AbortController()
            const retryTimeoutId = setTimeout(() => retryAbort.abort(), retryRemainingMs)

            let retryResult: Awaited<ReturnType<typeof generateText>>
            try {
              retryResult = await generateText({
                model: languageModel,
                system: SYSTEM_MESSAGE,
                messages: [{ role: "user", content: retryMessage }],
                maxOutputTokens,
                providerOptions,
                headers: resolved.model.headers,
                abortSignal: retryAbort.signal,
              })
            } finally {
              clearTimeout(retryTimeoutId)
            }
            lastResponse = retryResult.text
            lastResponse = lastResponse
              .replace(/^```(?:json)?\s*\n?/i, "")
              .replace(/\n?```\s*$/i, "")
              .trim()
          }

          // Terminal failure — include truncated last response for debugging
          const elapsed = Date.now() - itemStartTime
          const terminalError =
            elapsed >= timeoutSeconds * 1000
              ? `timeout after ${timeoutSeconds}s`
              : `${lastError}\n--- last response (truncated) ---\n${(lastResponse ?? "").slice(0, 500)}`
          await conn`
          UPDATE llm_map_items
          SET status = 'FAILED', error = ${terminalError},
              attempts_used = ${attemptsUsed}, finished_at = now()
          WHERE map_id = ${mapId} AND item_index = ${itemIndex}
        `
          failedCount++
        } catch (e) {
          const elapsed = Date.now() - itemStartTime
          const errorMsg =
            elapsed >= timeoutSeconds * 1000 || (e instanceof Error && e.name === "AbortError")
              ? `timeout after ${timeoutSeconds}s`
              : e instanceof Error
                ? e.message
                : String(e)

          await conn`
          UPDATE llm_map_items
          SET status = 'FAILED', error = ${errorMsg},
              attempts_used = ${Math.max(attemptsUsed, 1)}, finished_at = now()
          WHERE map_id = ${mapId} AND item_index = ${itemIndex}
        `.catch((dbErr) => log.error("failed to record item failure", { itemIndex, dbErr }))
          failedCount++
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
      const workerCount = items.length > 0 ? Math.min(concurrency, items.length) : 0
      const workers = Array.from({ length: workerCount }, () => runWorker())
      await Promise.all(workers)

      // --- Step 11: Write output JSONL ---
      const allItems = await conn<{ item_index: number; status: string; result: unknown; error: string | null }[]>`
      SELECT item_index, status, result, error
      FROM llm_map_items
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

      // --- Step 12: Register output in LCM ---
      const outputLcmId = await registerFileInLcm(conversationId, resolvedOutputPath, lcmModel, ctx.abort)

      // Update map run to DONE
      await conn`
      UPDATE llm_map_runs
      SET status = 'DONE', output_lcm_id = ${outputLcmId}
      WHERE map_id = ${mapId}
    `

      log.info("llm_map run completed", { mapId, succeeded: succeededCount, failed: failedCount })

      return {
        title: `llm_map: ${succeededCount}/${items.length} succeeded`,
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
