/**
 * OOLONG dataset loader
 *
 * Fetches the trec_coarse split from oolongbench/oolong-synth on HuggingFace.
 * Uses the datasets-server REST API to paginate through the validation split.
 * Caches results locally (~15MB for 50 tasks at 131K tokens).
 *
 * NOTE: The trec_coarse data at context_len=131072 is in the VALIDATION split
 * (not test). Each row contains ~317K chars of context_window_text, so the API
 * may fail with large page sizes. We use small pages (5 rows) to avoid timeouts.
 *
 * For initial population, use the companion Python script (fetch_oolong.py)
 * which downloads parquet files with column projection for efficiency.
 */
import path from "path"
import fs from "fs/promises"
import { EvalLog } from "../log"

export interface OolongTask {
  id: number
  contextLen: number
  dataset: string
  contextWindowText: string
  question: string
  answer: string
  answerType: string
  taskGroup: string
  task: string
  contextWindowId: number
  numLabels: number
  inputSubset: string
}

const HF_API_BASE = "https://datasets-server.huggingface.co"
const DATASET_NAME = "oolongbench/oolong-synth"

function getCacheDir(): string {
  const cacheBase = process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache")
  return path.join(cacheBase, "voltcode", "evals", "oolong")
}

function getCachePath(contextLen: number): string {
  return path.join(getCacheDir(), `trec_coarse_${contextLen}.json`)
}

/**
 * Fetch rows from HuggingFace datasets-server API.
 * Uses small page sizes since rows with 131K-token contexts are very large.
 */
async function fetchFromHF(
  split: string,
  offset: number,
  length: number,
): Promise<{ rows: Array<{ row: Record<string, unknown> }>; num_rows_total: number }> {
  const url = `${HF_API_BASE}/rows?dataset=${encodeURIComponent(DATASET_NAME)}&config=default&split=${split}&offset=${offset}&length=${length}`
  for (let attempt = 0; attempt < 20; attempt++) {
    EvalLog.trace("oolong.dataset.fetch.start", { split, offset, length, attempt: attempt + 1 })
    const response = await fetch(url)
    if (response.status === 429) {
      const baseWait = Math.min(5_000 * Math.pow(1.5, attempt), 120_000)
      const jitter = Math.random() * baseWait * 0.5
      const wait = baseWait + jitter
      EvalLog.warn("oolong.dataset.fetch.rate_limited", {
        split,
        offset,
        length,
        attempt: attempt + 1,
        waitMs: Math.round(wait),
      })
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!response.ok) {
      EvalLog.error("oolong.dataset.fetch.http_error", {
        split,
        offset,
        length,
        status: response.status,
        statusText: response.statusText,
      })
      throw new Error(`HuggingFace API error: ${response.status} ${response.statusText} for ${url}`)
    }
    EvalLog.trace("oolong.dataset.fetch.success", { split, offset, length })
    return response.json() as Promise<{ rows: Array<{ row: Record<string, unknown> }>; num_rows_total: number }>
  }
  EvalLog.error("oolong.dataset.fetch.retry_exhausted", { split, offset, length })
  throw new Error(`HuggingFace API: exceeded retries due to rate limiting for ${url}`)
}

/**
 * Search through HuggingFace dataset for trec_coarse rows at the specified context length.
 * The datasets-server API doesn't support filtering, so we paginate and filter client-side.
 * Uses small page sizes (5) because the 131K-token context windows are ~317K chars each.
 */
async function fetchTrecCoarseRows(contextLen: number): Promise<OolongTask[]> {
  const tasks: OolongTask[] = []
  // Small page size to handle large context_window_text fields
  const pageSize = 5
  let offset = 0

  // The trec_coarse tasks at 131K are in the validation split
  const split = "validation"

  const initial = await fetchFromHF(split, 0, 1)
  const totalRows = initial.num_rows_total
  EvalLog.info("oolong.dataset.scan.start", { split, totalRows, contextLen })

  while (offset < totalRows) {
    const batchSize = Math.min(pageSize, totalRows - offset)
    EvalLog.trace("oolong.dataset.scan.batch", { split, offset, batchSize, contextLen })

    try {
      const batch = await fetchFromHF(split, offset, batchSize)

      for (const { row } of batch.rows) {
        if (row.dataset === "trec_coarse" && row.context_len === contextLen) {
          tasks.push({
            id: row.id as number,
            contextLen: row.context_len as number,
            dataset: row.dataset as string,
            contextWindowText: row.context_window_text as string,
            question: row.question as string,
            answer: row.answer as string,
            answerType: row.answer_type as string,
            taskGroup: row.task_group as string,
            task: row.task as string,
            contextWindowId: row.context_window_id as number,
            numLabels: row.num_labels as number,
            inputSubset: row.input_subset as string,
          })
        }
      }
    } catch (error) {
      // Retry with page size of 1 if batch fails (likely due to large rows)
      EvalLog.warn("oolong.dataset.scan.batch_failed", {
        split,
        offset,
        batchSize,
        error: error instanceof Error ? error.message : String(error),
      })
      for (let i = 0; i < batchSize; i++) {
        try {
          const single = await fetchFromHF(split, offset + i, 1)
          for (const { row } of single.rows) {
            if (row.dataset === "trec_coarse" && row.context_len === contextLen) {
              tasks.push({
                id: row.id as number,
                contextLen: row.context_len as number,
                dataset: row.dataset as string,
                contextWindowText: row.context_window_text as string,
                question: row.question as string,
                answer: row.answer as string,
                answerType: row.answer_type as string,
                taskGroup: row.task_group as string,
                task: row.task as string,
                contextWindowId: row.context_window_id as number,
                numLabels: row.num_labels as number,
                inputSubset: row.input_subset as string,
              })
            }
          }
        } catch {
          EvalLog.warn("oolong.dataset.scan.row_skipped", { split, row: offset + i })
        }
      }
    }

    offset += batchSize

    // Early exit if we've found enough (2 context windows × 25 questions = 50)
    if (tasks.length >= 50) {
      EvalLog.info("oolong.dataset.scan.early_exit", { contextLen, tasks: tasks.length })
      break
    }
  }

  EvalLog.info("oolong.dataset.scan.complete", { contextLen, tasks: tasks.length })

  return tasks
}

/**
 * Load OOLONG trec_coarse tasks at the specified context length.
 * Uses local cache if available, otherwise fetches from HuggingFace.
 */
export async function loadTrecCoarse(contextLen: number = 131072): Promise<OolongTask[]> {
  const cachePath = getCachePath(contextLen)

  // Check cache
  try {
    const cached = await fs.readFile(cachePath, "utf-8")
    const tasks = JSON.parse(cached) as OolongTask[]
    EvalLog.info("oolong.dataset.cache.hit", { cachePath, contextLen, tasks: tasks.length })
    return tasks
  } catch {
    // Cache miss, fetch from HF
    EvalLog.trace("oolong.dataset.cache.miss", { cachePath, contextLen })
  }

  EvalLog.info("oolong.dataset.fetch_all.start", { contextLen })
  const tasks = await fetchTrecCoarseRows(contextLen)

  if (tasks.length === 0) {
    EvalLog.error("oolong.dataset.empty", { contextLen })
    throw new Error(`No trec_coarse tasks found at context_len=${contextLen}. Check if the dataset is accessible.`)
  }

  // Cache results
  await fs.mkdir(getCacheDir(), { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(tasks, null, 2))
  EvalLog.info("oolong.dataset.cache.write", { cachePath, contextLen, tasks: tasks.length })

  return tasks
}
