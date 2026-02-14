import type { Client } from "pg"

export interface SchedulerConfig {
  contextLengths: number[]
  backends: string[]
  backendMix: Record<string, number>
  totalRuns: number
  seedStart: number
  timeoutMinutes: number
}

export interface JobParams {
  context_length: number
  context_window_id: string
  backend: string
  seed: number
  timeout_minutes: number
}

export interface MetricsConfig {
  dbClient: Client
  queueUrls: string[]
  dlqUrls: string[]
  namespace: string
  intervalMs?: number
}

export interface ControlPlaneConfig {
  port: number
  dbUrl: string
  queueUrls: Record<string, string>
  dlqUrls: Record<string, string>
  region: string
}

export interface RunStats {
  completed: number
  failed: number
  in_flight: number
}

export interface WorkerHealthCounts {
  healthy: number
  unhealthy: number
}

export interface BackendLimits {
  openai: number
  anthropic: number
  moonshot: number
  glm: number
}
