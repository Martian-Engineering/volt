/**
 * Worker module index
 *
 * Exports all worker components for queue-based job processing:
 * - Configuration loading (CLI args + env vars)
 * - Secret management (AWS Secrets Manager)
 * - SQS queue polling
 * - Concurrency pool management
 * - Job parsing and environment setup
 * - VoltCode subprocess execution
 * - Result parsing and token extraction
 * - Message visibility management
 * - Retry logic with exponential backoff
 * - S3 artifact uploads
 * - Database status tracking
 * - Heartbeat reporting
 * - Graceful shutdown and signal handling
 * - Idle tracking and self-termination
 */

// config.ts
export { loadWorkerConfig, loadControlPlaneConfig, WorkerConfigSchema, ControlPlaneConfigSchema } from "./config"
export type { WorkerConfig, ControlPlaneConfig } from "./config"

// secrets.ts
export { fetchSecrets } from "./secrets"
export type { WorkerSecrets } from "./secrets"

// sqs-poller.ts
export { pollQueue } from "./sqs-poller"
export type { JobMessage as SqsJobMessage } from "./sqs-poller"

// pool.ts
export { WorkerPool } from "./pool"

// job.ts
export { parseJobMessage, getEnvForBackend, JobMessage, WorkerSecrets as WorkerSecretsSchema } from "./job"

// executor.ts
export { runVoltCode } from "./executor"
export type { JobMessage as ExecutorJobMessage, ExecutionResult } from "./executor"

// results.ts
export { parseResult, extractTokens } from "./results"
export type { RunResult, TokenUsage } from "./results"

// visibility.ts
export { extendVisibility, deleteMessage, createVisibilityExtender } from "./visibility"

// retry.ts
export { getBackoffDelay, requeueWithBackoff, sendToDLQ, shouldRetry, getDLQUrl } from "./retry"

// s3-upload.ts
export { uploadArtifacts, uploadFile } from "./s3-upload"

// db.ts
export { createDbClient, writeRunMetadata } from "./db"
export type { RunMetadata } from "./db"

// heartbeat.ts
export { sendHeartbeat, getSystemStats, createHeartbeatSender } from "./heartbeat"
export type { HeartbeatPayload } from "./heartbeat"

// shutdown.ts
export { setupSignalHandlers, setupSpotInterruptionHandler, createGracefulShutdown } from "./shutdown"

// idle.ts
export { createIdleTracker, getInstanceId, terminateSelf } from "./idle"
export type { IdleTracker } from "./idle"

// main.ts
export { main } from "./main"
