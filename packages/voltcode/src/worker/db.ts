import { Client } from "pg"
import { Log } from "@/util/log"

const log = Log.create({ service: "worker.db" })

export interface RunMetadata {
  run_id: string
  backend: string
  context_length: number
  context_window_id?: number
  seed?: number
  status: "running" | "completed" | "failed"
  start_ts?: Date
  end_ts?: Date
  duration_s?: number
  tokens_in?: number
  tokens_out?: number
  success?: boolean
  score?: number
  retry_count: number
  error_message?: string
  s3_prefix: string
}

/**
 * Create a pg Client connected to the given connection string.
 */
export function createDbClient(connectionString: string): Client {
  return new Client({ connectionString })
}

/**
 * Insert or update a run metadata record.
 * Uses UPSERT (ON CONFLICT run_id DO UPDATE) so we can update status from running -> completed/failed.
 */
export async function writeRunMetadata(client: Client, metadata: RunMetadata): Promise<void> {
  const query = `
    INSERT INTO runs (
      run_id,
      backend,
      context_length,
      context_window_id,
      seed,
      status,
      start_ts,
      end_ts,
      duration_s,
      tokens_in,
      tokens_out,
      success,
      score,
      retry_count,
      error_message,
      s3_prefix
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
    )
    ON CONFLICT (run_id) DO UPDATE SET
      backend = EXCLUDED.backend,
      context_length = EXCLUDED.context_length,
      context_window_id = EXCLUDED.context_window_id,
      seed = EXCLUDED.seed,
      status = EXCLUDED.status,
      start_ts = EXCLUDED.start_ts,
      end_ts = EXCLUDED.end_ts,
      duration_s = EXCLUDED.duration_s,
      tokens_in = EXCLUDED.tokens_in,
      tokens_out = EXCLUDED.tokens_out,
      success = EXCLUDED.success,
      score = EXCLUDED.score,
      retry_count = EXCLUDED.retry_count,
      error_message = EXCLUDED.error_message,
      s3_prefix = EXCLUDED.s3_prefix
  `

  const values = [
    metadata.run_id,
    metadata.backend,
    metadata.context_length,
    metadata.context_window_id ?? null,
    metadata.seed ?? null,
    metadata.status,
    metadata.start_ts ?? null,
    metadata.end_ts ?? null,
    metadata.duration_s ?? null,
    metadata.tokens_in ?? null,
    metadata.tokens_out ?? null,
    metadata.success ?? null,
    metadata.score ?? null,
    metadata.retry_count,
    metadata.error_message ?? null,
    metadata.s3_prefix,
  ]

  await client.query(query, values)
  log.debug("wrote run metadata", { runId: metadata.run_id, status: metadata.status })
}
