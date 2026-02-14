import type { Argv } from "yargs"
import { cmd } from "../cli/cmd/cmd"
import { Log } from "../util/log"
import { type JobParams, buildJobMessage, getQueueUrlForBackend, enqueueJob } from "./job-enqueue"

export interface SchedulerConfig {
  contextLengths: number[]
  backends: string[]
  backendMix: Record<string, number>
  totalRuns: number
  seedStart: number
  /** Per-backend variant overrides (e.g., {"openai": "xhigh"}) */
  backendVariants?: Record<string, string>
  /** Use random context length assignment instead of round-robin */
  randomContext?: boolean
}

export interface RateLimiter {
  canEnqueue(backend: string): boolean
  trackEnqueued(backend: string): void
}

const log = Log.create({ service: "scheduler" })

/**
 * Generate jobs for all context lengths × backends × seeds,
 * respecting backend mix ratios.
 */
/**
 * Seeded pseudo-random number generator (mulberry32).
 * Produces deterministic values for reproducible job assignment.
 */
function seededRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function* generateJobs(config: SchedulerConfig): Generator<JobParams> {
  const { contextLengths, backends, backendMix, totalRuns, seedStart } = config

  // Calculate runs per backend based on mix ratios using largest remainder method
  // to ensure exact allocation (sum equals totalRuns exactly)
  const totalMix = Object.values(backendMix).reduce((sum, v) => sum + v, 0)
  const runsPerBackend: Record<string, number> = {}

  // First pass: calculate exact quotas and floor values
  const quotas: Array<{ backend: string; quota: number; remainder: number }> = []
  let allocatedSum = 0

  for (const backend of backends) {
    const prefix = backend.split(":")[0]?.toLowerCase()
    if (!prefix) continue
    const ratio = backendMix[prefix] ?? 0
    const exactQuota = (ratio / totalMix) * totalRuns
    const floored = Math.floor(exactQuota)
    runsPerBackend[backend] = floored
    allocatedSum += floored
    quotas.push({ backend, quota: exactQuota, remainder: exactQuota - floored })
  }

  // Second pass: distribute remaining runs to backends with largest remainders
  const remaining = totalRuns - allocatedSum
  quotas.sort((a, b) => b.remainder - a.remainder)
  for (let i = 0; i < remaining && i < quotas.length; i++) {
    runsPerBackend[quotas[i]!.backend]!++
  }

  // Track how many jobs we've yielded per backend
  const yieldedPerBackend: Record<string, number> = {}
  for (const backend of backends) {
    yieldedPerBackend[backend] = 0
  }

  let seed = seedStart
  let totalYielded = 0

  // Create seeded RNG for random context length assignment
  const rng = config.randomContext ? seededRng(seedStart) : undefined

  // Resolve variant per backend prefix
  const getVariant = (backend: string): string | undefined => {
    if (!config.backendVariants) return undefined
    const prefix = backend.split(":")[0]?.toLowerCase()
    return prefix ? config.backendVariants[prefix] : undefined
  }

  // Round-robin (or random) across context lengths and backends
  while (totalYielded < totalRuns) {
    for (const contextLength of contextLengths) {
      for (const backend of backends) {
        if (totalYielded >= totalRuns) break
        if (yieldedPerBackend[backend]! >= runsPerBackend[backend]!) continue

        // Pick context length: random or round-robin
        const cl = rng ? contextLengths[Math.floor(rng() * contextLengths.length)]! : contextLength

        const variant = getVariant(backend)

        yield {
          context_length: cl,
          context_window_id: totalYielded,
          backend,
          seed,
          timeout_minutes: Math.max(30, Math.ceil(cl / 10000) * 5), // Min 30min, scale with context
          ...(variant ? { variant } : {}),
        }

        yieldedPerBackend[backend]!++
        totalYielded++
        seed++
      }
    }
  }
}

/**
 * Run the scheduler main loop.
 * Generates jobs, checks rate limits, enqueues when capacity available.
 */
export async function runScheduler(
  config: SchedulerConfig,
  rateLimiter: RateLimiter,
  queueUrls: Record<string, string>,
): Promise<void> {
  const jobs = generateJobs(config)
  let enqueuedCount = 0
  let pendingJob: JobParams | null = null

  log.info("scheduler_started", {
    totalRuns: config.totalRuns,
    backends: config.backends,
    contextLengths: config.contextLengths,
  })

  for (const job of jobs) {
    pendingJob = job

    // Wait until we can enqueue
    while (!rateLimiter.canEnqueue(pendingJob.backend)) {
      await sleep(1000)
    }

    // Build and enqueue the job
    const queueUrl = getQueueUrlForBackend(pendingJob.backend, queueUrls)
    const message = buildJobMessage(pendingJob)

    await enqueueJob(queueUrl, message)
    rateLimiter.trackEnqueued(pendingJob.backend)

    enqueuedCount++
    pendingJob = null

    // Log progress every 100 jobs
    if (enqueuedCount % 100 === 0) {
      log.info("scheduler_progress", {
        enqueuedCount,
        totalRuns: config.totalRuns,
        percentComplete: ((enqueuedCount / config.totalRuns) * 100).toFixed(1),
      })
    }
  }

  log.info("scheduler_completed", {
    totalEnqueued: enqueuedCount,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse a comma-separated list of numbers
 */
function parseNumberList(input: string): number[] {
  return input.split(",").map((s) => {
    const n = parseInt(s.trim(), 10)
    if (isNaN(n)) throw new Error(`Invalid number: ${s}`)
    return n
  })
}

/**
 * Parse a comma-separated list of strings
 */
function parseStringList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Parse backend mix from string format: "anthropic:0.4,moonshot:0.6"
 */
function parseBackendMix(input: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const pair of input.split(",")) {
    const [key, value] = pair.split(":")
    if (!key || !value) throw new Error(`Invalid backend mix format: ${pair}`)
    const num = parseFloat(value.trim())
    if (isNaN(num)) throw new Error(`Invalid mix ratio: ${value}`)
    result[key.trim().toLowerCase()] = num
  }
  return result
}

export const SchedulerCommand = cmd({
  command: "scheduler",
  describe: "run the control plane job scheduler",
  builder: (yargs: Argv) => {
    return yargs
      .option("total-runs", {
        type: "number",
        describe: "total number of runs to schedule",
        demandOption: true,
      })
      .option("backends", {
        type: "string",
        describe: "comma-separated list of backends (e.g., anthropic:claude-opus-4.5,moonshot:kimi-k2.5)",
        demandOption: true,
      })
      .option("context-lengths", {
        type: "string",
        describe: "comma-separated list of context lengths (e.g., 128000,256000,512000)",
        demandOption: true,
      })
      .option("backend-mix", {
        type: "string",
        describe: "backend mix ratios (e.g., anthropic:0.4,moonshot:0.6)",
        default: "",
      })
      .option("seed-start", {
        type: "number",
        describe: "starting seed value",
        default: 1,
      })
      .option("queue-urls", {
        type: "string",
        describe: 'queue URLs as JSON (e.g., \'{"anthropic":"https://...","moonshot":"https://..."}\')',
        demandOption: true,
      })
      .option("backend-variants", {
        type: "string",
        describe: 'per-backend variant overrides as JSON (e.g., \'{"openai":"xhigh"}\')',
        default: "",
      })
      .option("random-context", {
        type: "boolean",
        describe: "randomly assign context lengths instead of round-robin",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "print jobs without enqueuing",
        default: false,
      })
  },
  handler: async (args) => {
    const backends = parseStringList(args.backends as string)
    const contextLengths = parseNumberList(args["context-lengths"] as string)

    // Default backend mix: equal distribution
    const backendMix = args["backend-mix"]
      ? parseBackendMix(args["backend-mix"] as string)
      : backends.reduce(
          (acc, b) => {
            const prefix = b.split(":")[0]?.toLowerCase()
            if (prefix) acc[prefix] = 1
            return acc
          },
          {} as Record<string, number>,
        )

    const backendVariants = args["backend-variants"]
      ? (JSON.parse(args["backend-variants"] as string) as Record<string, string>)
      : undefined

    const config: SchedulerConfig = {
      totalRuns: args["total-runs"] as number,
      backends,
      contextLengths,
      backendMix,
      seedStart: args["seed-start"] as number,
      backendVariants,
      randomContext: args["random-context"] as boolean,
    }

    if (args["dry-run"]) {
      log.info("dry_run_mode")
      let count = 0
      for (const job of generateJobs(config)) {
        console.log(JSON.stringify(job))
        count++
        if (count % 100 === 0) {
          log.info("generated", { count })
        }
      }
      log.info("dry_run_completed", { totalJobs: count })
      return
    }

    const queueUrls = JSON.parse(args["queue-urls"] as string) as Record<string, string>

    // Simple in-memory rate limiter for CLI usage
    // In production, this would be replaced with a distributed rate limiter
    const inFlightPerBackend: Record<string, number> = {}
    const maxConcurrentPerBackend = 10

    const rateLimiter: RateLimiter = {
      canEnqueue(backend: string): boolean {
        const prefix = backend.split(":")[0]?.toLowerCase() ?? ""
        const current = inFlightPerBackend[prefix] ?? 0
        return current < maxConcurrentPerBackend
      },
      trackEnqueued(backend: string): void {
        const prefix = backend.split(":")[0]?.toLowerCase() ?? ""
        inFlightPerBackend[prefix] = (inFlightPerBackend[prefix] ?? 0) + 1
        // Simulate completion after a delay (in production, this would be event-driven)
        setTimeout(() => {
          inFlightPerBackend[prefix] = Math.max(0, (inFlightPerBackend[prefix] ?? 1) - 1)
        }, 5000)
      },
    }

    await runScheduler(config, rateLimiter, queueUrls)
  },
})
