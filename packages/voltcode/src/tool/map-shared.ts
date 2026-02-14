import Ajv2020 from "ajv/dist/2020"
import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { LcmDb } from "../session/lcm/db"
import { ExploreDispatcher } from "../session/lcm/explore/dispatcher"
import { Log } from "../util/log"
import type { Provider } from "../provider/provider"
import { assertExternalDirectory } from "./external-directory"

const log = Log.create({ service: "tool.map" })

/** Deterministic JSON serialization with recursively sorted keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k]
      }
      return sorted
    }
    return val
  })
}

/** Build the user message with prompt + `<map-details-json>` block (shared by agentic_map and llm_map). */
export function buildUserMessage(
  promptText: string,
  mapId: string,
  runStartedAt: string,
  inputLcmId: string,
  itemIndex: number,
  item: unknown,
  outputSchema: Record<string, unknown>,
): string {
  const details: Record<string, unknown> = {
    input_lcm_id: inputLcmId,
    item,
    item_index: itemIndex,
    map_id: mapId,
    output_schema: outputSchema,
    run_started_at: runStartedAt,
  }
  return `${promptText}\n\n<map-details-json>\n${stableStringify(details)}\n</map-details-json>`
}

/** Parse a JSONL file into an array of JSON values. Handles trailing newlines. */
export async function parseJsonlFile(filePath: string): Promise<unknown[]> {
  const inputFile = Bun.file(filePath)
  const exists = await inputFile.exists()
  if (!exists) {
    throw new Error(`Input file not found: ${filePath}`)
  }
  const rawText = await inputFile.text()
  const rawLines = rawText.split("\n")
  const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines

  const items: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") {
      throw new Error(`Line ${i} (0-based) is empty. Every line in the input JSONL must be valid JSON.`)
    }
    try {
      items.push(JSON.parse(line))
    } catch (e) {
      throw new Error(`Line ${i} (0-based) is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return items
}

/** Compile output_schema as Draft 2020-12 JSON Schema. Returns the validator function. */
export function preflightSchema(outputSchema: Record<string, unknown>) {
  if (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema)) {
    throw new Error("output_schema must be a JSON object (not a boolean, array, or null)")
  }

  const ajv = new Ajv2020({ allErrors: true })
  try {
    return ajv.compile(outputSchema)
  } catch (e) {
    throw new Error(
      `output_schema is not a valid JSON Schema (Draft 2020-12): ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Check read/edit permissions and external directory for input/output paths. */
export async function checkPathPermissions(ctx: Tool.Context, resolvedInputPath: string, resolvedOutputPath: string) {
  await assertExternalDirectory(ctx, resolvedInputPath)
  await ctx.ask({
    permission: "read",
    patterns: [resolvedInputPath],
    always: ["*"],
    metadata: {},
  })
  await assertExternalDirectory(ctx, resolvedOutputPath)
  await ctx.ask({
    permission: "edit",
    patterns: [path.relative(Instance.worktree, resolvedOutputPath)],
    always: ["*"],
    metadata: {},
  })
}

/** Register a file into LCM with exploration. Returns the LCM file ID. */
export async function registerFileInLcm(
  conversationId: number,
  filePath: string,
  model: Provider.Model,
  abort: AbortSignal,
): Promise<string> {
  const { fileId } = await LcmDb.insertLargeFileFromPath({
    conversationId,
    filePath,
    mimeType: "application/x-ndjson",
  })

  const exploration = await ExploreDispatcher.explore({
    filePath,
    mimeType: "application/x-ndjson",
    model,
    abort,
  }).catch((e) => {
    log.warn("file exploration failed, continuing", { error: e })
    return { summary: "Exploration failed", explorerUsed: "none" }
  })

  await LcmDb.updateLargeFileExploration({
    fileId,
    explorationSummary: exploration.summary,
    explorerUsed: exploration.explorerUsed,
  })

  return fileId
}

/** Resolve an input path (absolute or relative to Instance.directory). */
export function resolvePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(Instance.directory, inputPath)
}

/** Format Ajv validation errors as a human-readable string. */
export function formatValidationErrors(errors: Array<{ instancePath?: string; message?: string }>): string {
  return errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ")
}
