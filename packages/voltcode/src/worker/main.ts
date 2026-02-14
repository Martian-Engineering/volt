#!/usr/bin/env bun
/**
 * Main worker entry point.
 *
 * Wires together all worker components:
 * - Queue polling (SQS)
 * - Job execution (VoltCode subprocess)
 * - Heartbeat reporting
 * - Idle tracking and self-termination
 * - Artifact upload (S3)
 * - Status reporting (PostgreSQL)
 * - Graceful shutdown
 */

import { parseArgs } from "util"
import { WorkerPool } from "./pool"
import { createHeartbeatSender } from "./heartbeat"
import { createIdleTracker, terminateSelf } from "./idle"
import { setupSignalHandlers, setupSpotInterruptionHandler, createGracefulShutdown } from "./shutdown"
import { pollQueue, type JobMessage } from "./sqs-poller"
import { createVisibilityExtender, deleteMessage } from "./visibility"
import { fetchSecrets, type WorkerSecrets } from "./secrets"
import { runVoltCode } from "./executor"
import { parseResult, extractTokens } from "./results"
import { uploadArtifacts } from "./s3-upload"
import { requeueWithBackoff, shouldRetry, getDLQUrl, sendToDLQ } from "./retry"
import postgres from "postgres"

// --- Structured JSON Logging ---

type LogLevel = "trace" | "debug" | "info" | "warn" | "error"

interface LogEntry {
  timestamp: string
  level: LogLevel
  service: string
  message: string
  [key: string]: unknown
}

function jsonLog(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: "worker-main",
    message,
    ...extra,
  }
  const line = JSON.stringify(entry)
  if (level === "error") {
    process.stderr.write(line + "\n")
  } else {
    process.stdout.write(line + "\n")
  }
}

const log = {
  trace: (msg: string, extra?: Record<string, unknown>) => jsonLog("trace", msg, extra),
  debug: (msg: string, extra?: Record<string, unknown>) => jsonLog("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => jsonLog("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => jsonLog("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => jsonLog("error", msg, extra),
}

// --- CLI Argument Parsing ---

interface WorkerConfig {
  /** JSON map of provider → SQS queue URL */
  queueUrls: Record<string, string>
  controlPlaneUrl: string
  s3Bucket: string
  maxConcurrency: number
  region: string
  idleTimeoutMs: number
  heartbeatIntervalMs: number
}

function parseCliArgs(): WorkerConfig {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "queue-urls": { type: "string" },
      "control-plane-url": { type: "string" },
      "s3-bucket": { type: "string" },
      "max-concurrency": { type: "string", default: "4" },
      region: { type: "string", default: "us-west-2" },
      "idle-timeout-ms": { type: "string", default: "600000" },
      "heartbeat-interval-ms": { type: "string", default: "60000" },
    },
    strict: true,
  })

  const queueUrlsRaw = values["queue-urls"]
  const controlPlaneUrl = values["control-plane-url"]
  const s3Bucket = values["s3-bucket"]

  if (!queueUrlsRaw) {
    log.error("Missing required argument: --queue-urls (JSON map of provider -> SQS URL)")
    process.exit(1)
  }
  if (!controlPlaneUrl) {
    log.error("Missing required argument: --control-plane-url")
    process.exit(1)
  }
  if (!s3Bucket) {
    log.error("Missing required argument: --s3-bucket")
    process.exit(1)
  }

  const queueUrls = JSON.parse(queueUrlsRaw) as Record<string, string>

  return {
    queueUrls,
    controlPlaneUrl,
    s3Bucket,
    maxConcurrency: parseInt(values["max-concurrency"] ?? "4", 10),
    region: values.region ?? "us-west-2",
    idleTimeoutMs: parseInt(values["idle-timeout-ms"] ?? "600000", 10),
    heartbeatIntervalMs: parseInt(values["heartbeat-interval-ms"] ?? "60000", 10),
  }
}

// --- Database Status ---

type RunStatus = "pending" | "running" | "completed" | "failed" | "timed_out"

interface StatusUpdate {
  runId: string
  status: RunStatus
  backend?: string
  contextLength?: number
  contextWindowId?: number
  seed?: number
  variant?: string
  s3Prefix?: string
  startTs?: Date
  endTs?: Date
  durationS?: number
  tokensIn?: number
  tokensOut?: number
  success?: boolean
  score?: number
  errorMessage?: string
}

async function writeStatus(sql: postgres.Sql, update: StatusUpdate): Promise<void> {
  const {
    runId,
    status,
    backend,
    contextLength,
    contextWindowId,
    seed,
    variant,
    s3Prefix,
    startTs,
    endTs,
    durationS,
    tokensIn,
    tokensOut,
    success,
    score,
    errorMessage,
  } = update

  log.debug("writing status to db", { runId, status })

  await sql`
    INSERT INTO runs (run_id, backend, context_length, context_window_id, seed, variant, s3_prefix, status, start_ts, end_ts, duration_s, tokens_in, tokens_out, success, score, error_message)
    VALUES (
      ${runId},
      ${backend ?? null},
      ${contextLength ?? null},
      ${contextWindowId ?? null},
      ${seed ?? null},
      ${variant ?? null},
      ${s3Prefix ?? null},
      ${status},
      ${startTs ?? null},
      ${endTs ?? null},
      ${durationS ?? null},
      ${tokensIn ?? null},
      ${tokensOut ?? null},
      ${success ?? null},
      ${score ?? null},
      ${errorMessage ?? null}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      status = EXCLUDED.status,
      start_ts = COALESCE(EXCLUDED.start_ts, runs.start_ts),
      end_ts = COALESCE(EXCLUDED.end_ts, runs.end_ts),
      duration_s = COALESCE(EXCLUDED.duration_s, runs.duration_s),
      tokens_in = COALESCE(EXCLUDED.tokens_in, runs.tokens_in),
      tokens_out = COALESCE(EXCLUDED.tokens_out, runs.tokens_out),
      success = COALESCE(EXCLUDED.success, runs.success),
      score = COALESCE(EXCLUDED.score, runs.score),
      error_message = COALESCE(EXCLUDED.error_message, runs.error_message)
  `

  log.info("status written", { runId, status })
}

// --- Job Processing ---

interface ProcessJobResult {
  success: boolean
  error?: string
}

async function processJob(
  config: WorkerConfig,
  queueUrl: string,
  sql: postgres.Sql,
  secrets: WorkerSecrets,
  job: JobMessage,
  receiptHandle: string,
): Promise<ProcessJobResult> {
  const runId = job.run_id
  log.info("processing job", { runId, backend: job.backend, contextLength: job.context_length, variant: job.variant })

  // Start visibility extender to keep message invisible while processing
  const visibilityExtender = createVisibilityExtender(queueUrl, receiptHandle)
  visibilityExtender.start()

  try {
    // Write 'running' status with job metadata (UPSERT)
    await writeStatus(sql, {
      runId,
      status: "running",
      backend: job.backend,
      contextLength: job.context_length,
      contextWindowId: job.context_window_id,
      seed: job.seed,
      variant: job.variant,
      s3Prefix: job.output_prefix,
      startTs: new Date(),
    })

    // Build environment with secrets for the backend
    const env: Record<string, string> = {
      // Point VoltCode's LCM storage at RDS so it skips embedded postgres
      LCM_DATABASE_URL: secrets.dbUrl,
      // Skip builtin plugin install (they don't exist on npm)
      VOLTCODE_DISABLE_DEFAULT_PLUGINS: "1",
    }
    if (job.backend.startsWith("openai:") && secrets.openaiKey) {
      env.OPENAI_API_KEY = secrets.openaiKey
    }
    if (job.backend.startsWith("anthropic:") && secrets.anthropicKey) {
      env.ANTHROPIC_API_KEY = secrets.anthropicKey
    }
    if (job.backend.startsWith("moonshot:") && secrets.moonshotKey) {
      env.MOONSHOT_API_KEY = secrets.moonshotKey
    }
    if (job.backend.startsWith("glm:") && secrets.glmKey) {
      env.GLM_API_KEY = secrets.glmKey
    }

    // Run VoltCode
    const result = await runVoltCode(
      {
        runId,
        contextLength: job.context_length,
        contextWindowId: job.context_window_id,
        backend: job.backend,
        timeoutMinutes: job.timeout_minutes,
        variant: job.variant,
      },
      env,
    )

    // Parse results
    const runResult = await parseResult(result.outputDir)
    const tokens = await extractTokens(result.outputDir)

    // Upload artifacts to S3
    await uploadArtifacts(config.s3Bucket, job.output_prefix, result.outputDir)

    // Determine final status
    // A run is "completed" if it has a valid score (even if some tasks failed).
    // The eval CLI exits with code 1 when not all tasks pass, but that's still a valid result.
    const finalStatus: RunStatus = result.timedOut
      ? "timed_out"
      : runResult?.score != null && runResult.score > 0
        ? "completed"
        : "failed"

    // Write final status to DB
    await writeStatus(sql, {
      runId,
      status: finalStatus,
      backend: job.backend,
      contextLength: job.context_length,
      contextWindowId: job.context_window_id,
      seed: job.seed,
      variant: job.variant,
      s3Prefix: job.output_prefix,
      endTs: new Date(),
      durationS: result.durationMs / 1000,
      tokensIn: tokens.tokens_in,
      tokensOut: tokens.tokens_out,
      success: finalStatus === "completed",
      score: runResult?.score,
      errorMessage:
        runResult?.error ?? (result.timedOut ? `Timed out after ${job.timeout_minutes} minutes` : undefined),
    })

    // Delete SQS message on success
    await deleteMessage(queueUrl, receiptHandle)
    log.info("job completed successfully", { runId, status: finalStatus })

    return { success: true }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error("job processing failed", { runId, error: errorMsg })

    // Determine if we should retry
    const retryCount = job.retry_count
    if (shouldRetry(retryCount)) {
      log.info("requeueing job with backoff", { runId, retryCount: retryCount + 1 })
      await requeueWithBackoff(queueUrl, job)
      // Delete original message after requeueing
      await deleteMessage(queueUrl, receiptHandle)
    } else {
      log.warn("max retries exceeded, sending to DLQ", { runId, retryCount })
      const dlqUrl = getDLQUrl(queueUrl)
      await sendToDLQ(dlqUrl, job, errorMsg)
      // Delete original message after sending to DLQ
      await deleteMessage(queueUrl, receiptHandle)

      // Write failed status to DB
      await writeStatus(sql, {
        runId,
        status: "failed",
        backend: job.backend,
        contextLength: job.context_length,
        contextWindowId: job.context_window_id,
        seed: job.seed,
        variant: job.variant,
        s3Prefix: job.output_prefix,
        endTs: new Date(),
        success: false,
        errorMessage: `Max retries exceeded: ${errorMsg}`,
      })
    }

    return { success: false, error: errorMsg }
  } finally {
    visibilityExtender.stop()
  }
}

// --- Main Loop ---

let running = true

async function mainLoop(
  config: WorkerConfig,
  sql: postgres.Sql,
  secrets: WorkerSecrets,
  pool: WorkerPool,
  idleTracker: ReturnType<typeof createIdleTracker>,
  heartbeat: ReturnType<typeof createHeartbeatSender>,
): Promise<void> {
  const queueEntries = Object.entries(config.queueUrls)
  log.info("starting main loop", {
    queues: Object.keys(config.queueUrls),
    queueCount: queueEntries.length,
    maxConcurrency: config.maxConcurrency,
    idleTimeoutMs: config.idleTimeoutMs,
  })

  let queueIdx = 0

  while (running) {
    try {
      // Round-robin across all provider queues
      const [provider, queueUrl] = queueEntries[queueIdx % queueEntries.length]!
      queueIdx++

      // Poll for a message
      const pollResult = await pollQueue(queueUrl)

      if (!pollResult) {
        // No message received
        idleTracker.markIdle()

        // Check idle timeout (only after cycling through all queues)
        if (queueIdx % queueEntries.length === 0 && idleTracker.isIdleTimeout()) {
          log.info("idle timeout reached, initiating self-termination", {
            idleTimeoutMs: config.idleTimeoutMs,
          })
          await terminateSelf(config.region)
          running = false
          break
        }

        continue
      }

      // Got a message, mark active
      idleTracker.markActive()

      const { message, receiptHandle } = pollResult

      // Acquire pool slot (blocks if at max concurrency)
      await pool.acquire()

      // Process job asynchronously (don't block the loop)
      processJob(config, queueUrl, sql, secrets, message, receiptHandle)
        .then((result) => {
          if (result.success) heartbeat.recordCompleted()
          else heartbeat.recordFailed()
        })
        .catch((error) => {
          heartbeat.recordFailed()
          log.error("unhandled error in job processing", {
            runId: message.run_id,
            provider,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          pool.release()
        })
    } catch (error) {
      log.error("error in main loop", {
        error: error instanceof Error ? error.message : String(error),
      })
      // Brief pause before retrying on loop error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  log.info("main loop exited")
}

// --- Entry Point ---

export async function main(): Promise<void> {
  log.info("worker starting")

  // Parse CLI arguments
  const config = parseCliArgs()
  log.info("configuration loaded", {
    queueUrls: config.queueUrls,
    controlPlaneUrl: config.controlPlaneUrl,
    s3Bucket: config.s3Bucket,
    maxConcurrency: config.maxConcurrency,
    region: config.region,
    idleTimeoutMs: config.idleTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  })

  // Fetch secrets
  log.info("fetching secrets")
  const secrets = await fetchSecrets()
  log.info("secrets fetched successfully")

  // Initialize database connection
  // Disable prepared statements for RDS Proxy compatibility
  log.info("connecting to database")
  const sql = postgres(secrets.dbUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  })
  // Warmup: verify DB connection works before starting job processing
  const warmup = await sql`SELECT current_database() as db, COUNT(*) as runs FROM runs`
  log.info("database connected", { database: warmup[0]?.db, existingRuns: warmup[0]?.runs })

  // Initialize components
  const pool = new WorkerPool(config.maxConcurrency)
  const idleTracker = createIdleTracker(config.idleTimeoutMs)
  const heartbeat = createHeartbeatSender(config.controlPlaneUrl, () => pool.runningCount, config.heartbeatIntervalMs)

  // Cleanup function for graceful shutdown
  const cleanup = async () => {
    log.info("running cleanup")
    heartbeat.stop()
    await sql.end()
    log.info("cleanup complete")
  }

  // Set up graceful shutdown
  const gracefulShutdown = createGracefulShutdown(pool, cleanup)

  // Set up signal handlers
  setupSignalHandlers(async () => {
    running = false
    await gracefulShutdown()
  })

  // Set up spot interruption handler
  setupSpotInterruptionHandler(async () => {
    log.warn("spot interruption detected, initiating shutdown")
    running = false
    await gracefulShutdown()
  })

  // Start heartbeat
  heartbeat.start()
  log.info("heartbeat started", { intervalMs: config.heartbeatIntervalMs })

  // Run main loop
  try {
    await mainLoop(config, sql, secrets, pool, idleTracker, heartbeat)
  } catch (error) {
    log.error("fatal error in main loop", {
      error: error instanceof Error ? error.message : String(error),
    })
    await cleanup()
    process.exit(1)
  }

  // Normal exit
  await cleanup()
  log.info("worker shutdown complete")
}

// Run if invoked directly
if (import.meta.main) {
  main().catch((error) => {
    log.error("unhandled error", {
      error: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  })
}
