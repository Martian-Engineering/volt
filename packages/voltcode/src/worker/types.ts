export interface WorkerSecrets {
  dbUrl: string
  openaiKey: string
  anthropicKey: string
  moonshotKey: string
  glmKey: string
}

export interface JobMessage {
  run_id: string
  context_length: number
  context_window_id: string
  backend: string
  seed: number
  timeout_minutes: number
  retry_count: number
  output_prefix: string
}

export interface ExecutionResult {
  exitCode: number
  durationMs: number
  outputDir: string
  timedOut: boolean
}

export interface RunResult {
  success: boolean
  score?: number
  error?: string
}

export interface TokenUsage {
  tokens_in: number
  tokens_out: number
  tokens_cached?: number
}

export interface RunMetadata {
  run_id: string
  backend: string
  context_length: number
  context_window_id?: string
  seed?: number
  status: "pending" | "running" | "completed" | "failed"
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

export interface HeartbeatPayload {
  instance_id: string
  timestamp: string
  in_flight_jobs: number
  completed_since_last: number
  failed_since_last: number
  cpu_percent: number
  mem_percent: number
}

export interface IdleTracker {
  markActive(): void
  markIdle(): void
  isIdleTimeout(): boolean
}

export interface WorkerConfig {
  queueUrl: string
  controlPlaneUrl: string
  s3Bucket: string
  maxConcurrency: number
  region: string
}
