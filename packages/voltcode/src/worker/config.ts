/**
 * Configuration loader for Worker and Control Plane.
 *
 * Supports:
 * - Environment variables (fallback)
 * - CLI argument overrides
 * - Validation of required fields
 * - Defaults for optional fields
 */

import { parseArgs } from "util"
import { z } from "zod"

// --- Worker Configuration ---

/**
 * Worker configuration schema with validation
 */
export const WorkerConfigSchema = z.object({
  /** SQS queue URL to poll for jobs */
  queueUrl: z.string().url(),
  /** Control plane URL for heartbeat/status reporting */
  controlPlaneUrl: z.string().url(),
  /** S3 bucket for artifact uploads */
  s3Bucket: z.string().min(1),
  /** AWS region */
  region: z.string().default("us-west-2"),
  /** Maximum concurrent jobs */
  maxConcurrency: z.number().int().positive().default(4),
  /** Idle timeout before self-termination (ms) */
  idleTimeoutMs: z.number().int().positive().default(600_000),
  /** Heartbeat interval (ms) */
  heartbeatIntervalMs: z.number().int().positive().default(60_000),
  /** Visibility extension interval (ms) */
  visibilityExtendIntervalMs: z.number().int().positive().default(600_000),
})

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>

/**
 * CLI options for worker configuration
 */
const workerCliOptions = {
  "queue-url": { type: "string" as const },
  "control-plane-url": { type: "string" as const },
  "s3-bucket": { type: "string" as const },
  region: { type: "string" as const },
  "max-concurrency": { type: "string" as const },
  "idle-timeout-ms": { type: "string" as const },
  "heartbeat-interval-ms": { type: "string" as const },
  "visibility-extend-interval-ms": { type: "string" as const },
}

/**
 * Load worker configuration from CLI arguments and environment variables.
 *
 * Priority: CLI args > environment variables > defaults
 *
 * Required (must be provided via CLI or env):
 * - SQS_QUEUE_URL or --queue-url
 * - CONTROL_PLANE_URL or --control-plane-url
 * - S3_BUCKET or --s3-bucket
 * - AWS_REGION or --region (defaults to us-west-2)
 *
 * Optional with defaults:
 * - MAX_CONCURRENCY (default 4)
 * - IDLE_TIMEOUT_MS (default 600000)
 * - HEARTBEAT_INTERVAL_MS (default 60000)
 * - VISIBILITY_EXTEND_INTERVAL_MS (default 600000)
 *
 * @param argv - CLI arguments (defaults to process.argv.slice(2))
 * @returns Validated worker configuration
 * @throws Error if required fields are missing or validation fails
 */
export function loadWorkerConfig(argv?: string[]): WorkerConfig {
  const args = argv ?? process.argv.slice(2)

  // Parse CLI arguments
  const { values } = parseArgs({
    args,
    options: workerCliOptions,
    strict: false, // Allow unknown options to pass through
  })

  // Build raw config from CLI args with env fallbacks
  const rawConfig = {
    queueUrl: asString(values["queue-url"]) ?? process.env.SQS_QUEUE_URL,
    controlPlaneUrl: asString(values["control-plane-url"]) ?? process.env.CONTROL_PLANE_URL,
    s3Bucket: asString(values["s3-bucket"]) ?? process.env.S3_BUCKET,
    region: asString(values.region) ?? process.env.AWS_REGION,
    maxConcurrency: parseIntOrUndefined(values["max-concurrency"]) ?? parseIntOrUndefined(process.env.MAX_CONCURRENCY),
    idleTimeoutMs: parseIntOrUndefined(values["idle-timeout-ms"]) ?? parseIntOrUndefined(process.env.IDLE_TIMEOUT_MS),
    heartbeatIntervalMs:
      parseIntOrUndefined(values["heartbeat-interval-ms"]) ?? parseIntOrUndefined(process.env.HEARTBEAT_INTERVAL_MS),
    visibilityExtendIntervalMs:
      parseIntOrUndefined(values["visibility-extend-interval-ms"]) ??
      parseIntOrUndefined(process.env.VISIBILITY_EXTEND_INTERVAL_MS),
  }

  // Validate required fields before Zod parsing for better error messages
  const missingFields: string[] = []
  if (!rawConfig.queueUrl) missingFields.push("SQS_QUEUE_URL or --queue-url")
  if (!rawConfig.controlPlaneUrl) missingFields.push("CONTROL_PLANE_URL or --control-plane-url")
  if (!rawConfig.s3Bucket) missingFields.push("S3_BUCKET or --s3-bucket")

  if (missingFields.length > 0) {
    throw new Error(`Missing required configuration: ${missingFields.join(", ")}`)
  }

  // Validate and apply defaults via Zod
  const result = WorkerConfigSchema.safeParse(rawConfig)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`Invalid worker configuration: ${issues}`)
  }

  return result.data
}

// --- Control Plane Configuration ---

/**
 * Control plane configuration schema with validation
 */
export const ControlPlaneConfigSchema = z.object({
  /** HTTP server port */
  port: z.number().int().min(1).max(65535).default(8080),
  /** Database connection URL */
  dbUrl: z.string().min(1),
  /** SQS queue URLs (keyed by priority/name) */
  queueUrls: z.record(z.string(), z.string().url()).default({}),
  /** Dead letter queue URLs (keyed by priority/name) */
  dlqUrls: z.record(z.string(), z.string().url()).default({}),
  /** AWS region */
  region: z.string().default("us-west-2"),
  /** Health check interval (ms) */
  healthCheckIntervalMs: z.number().int().positive().default(30_000),
  /** Metrics publish interval (ms) */
  metricsPublishIntervalMs: z.number().int().positive().default(60_000),
  /** Worker heartbeat timeout before marking unhealthy (ms) */
  workerTimeoutMs: z.number().int().positive().default(60_000),
})

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>

/**
 * CLI options for control plane configuration
 */
const controlPlaneCliOptions = {
  port: { type: "string" as const },
  "db-url": { type: "string" as const },
  "queue-urls": { type: "string" as const },
  "dlq-urls": { type: "string" as const },
  region: { type: "string" as const },
  "health-check-interval-ms": { type: "string" as const },
  "metrics-publish-interval-ms": { type: "string" as const },
  "worker-timeout-ms": { type: "string" as const },
}

/**
 * Load control plane configuration from CLI arguments and environment variables.
 *
 * Priority: CLI args > environment variables > defaults
 *
 * Required (must be provided via CLI or env):
 * - DATABASE_URL or CONTROL_PLANE_DB_URL or --db-url
 *
 * Optional with defaults:
 * - CONTROL_PLANE_PORT or --port (default 8080)
 * - CONTROL_PLANE_QUEUE_URLS or --queue-urls (JSON object or comma-separated "name=url" pairs)
 * - CONTROL_PLANE_DLQ_URLS or --dlq-urls (JSON object or comma-separated "name=url" pairs)
 * - AWS_REGION or --region (default us-west-2)
 * - HEALTH_CHECK_INTERVAL_MS (default 30000)
 * - METRICS_PUBLISH_INTERVAL_MS (default 60000)
 * - WORKER_TIMEOUT_MS (default 60000)
 *
 * @param argv - CLI arguments (defaults to process.argv.slice(2))
 * @returns Validated control plane configuration
 * @throws Error if required fields are missing or validation fails
 */
export function loadControlPlaneConfig(argv?: string[]): ControlPlaneConfig {
  const args = argv ?? process.argv.slice(2)

  // Parse CLI arguments
  const { values } = parseArgs({
    args,
    options: controlPlaneCliOptions,
    strict: false, // Allow unknown options to pass through
  })

  // Build raw config from CLI args with env fallbacks
  const rawConfig = {
    port: parseIntOrUndefined(values.port) ?? parseIntOrUndefined(process.env.CONTROL_PLANE_PORT),
    dbUrl: asString(values["db-url"]) ?? process.env.CONTROL_PLANE_DB_URL ?? process.env.DATABASE_URL,
    queueUrls: parseUrlRecord(asString(values["queue-urls"]) ?? process.env.CONTROL_PLANE_QUEUE_URLS),
    dlqUrls: parseUrlRecord(asString(values["dlq-urls"]) ?? process.env.CONTROL_PLANE_DLQ_URLS),
    region: asString(values.region) ?? process.env.AWS_REGION,
    healthCheckIntervalMs:
      parseIntOrUndefined(values["health-check-interval-ms"]) ??
      parseIntOrUndefined(process.env.HEALTH_CHECK_INTERVAL_MS),
    metricsPublishIntervalMs:
      parseIntOrUndefined(values["metrics-publish-interval-ms"]) ??
      parseIntOrUndefined(process.env.METRICS_PUBLISH_INTERVAL_MS),
    workerTimeoutMs:
      parseIntOrUndefined(values["worker-timeout-ms"]) ?? parseIntOrUndefined(process.env.WORKER_TIMEOUT_MS),
  }

  // Validate required fields before Zod parsing for better error messages
  if (!rawConfig.dbUrl) {
    throw new Error("Missing required configuration: DATABASE_URL, CONTROL_PLANE_DB_URL, or --db-url")
  }

  // Validate and apply defaults via Zod
  const result = ControlPlaneConfigSchema.safeParse(rawConfig)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`Invalid control plane configuration: ${issues}`)
  }

  return result.data
}

// --- Utility Functions ---

/**
 * Coerce a value from parseArgs to string | undefined
 * (parseArgs returns string | boolean | undefined, but we only use string options)
 */
function asString(value: string | boolean | undefined): string | undefined {
  if (typeof value === "string") return value
  return undefined
}

/**
 * Parse a string to integer, returning undefined if invalid
 */
function parseIntOrUndefined(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined
  const parsed = parseInt(value, 10)
  return isNaN(parsed) ? undefined : parsed
}

/**
 * Parse a URL record from either JSON or "key=value,key=value" format
 *
 * Supports:
 * - JSON object: '{"priority": "https://..."}'
 * - Key=value pairs: 'priority=https://...,normal=https://...'
 */
function parseUrlRecord(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined

  // Try JSON parse first
  if (value.startsWith("{")) {
    try {
      return JSON.parse(value)
    } catch {
      // Fall through to key=value parsing
    }
  }

  // Parse as comma-separated key=value pairs
  const result: Record<string, string> = {}
  const pairs = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)

  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=")
    if (eqIdx === -1) continue
    const key = pair.slice(0, eqIdx).trim()
    const url = pair.slice(eqIdx + 1).trim()
    if (key && url) {
      result[key] = url
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}
