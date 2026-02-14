import type postgres from "postgres"
import { Log } from "../util/log"

const log = Log.create({ service: "rate-limiter" })

/**
 * Rate limiter for job scheduling that tracks in-flight jobs per backend.
 * Enforces maximum concurrent job limits to prevent overwhelming providers.
 */
export class RateLimiter {
  private readonly limits: Record<string, number>
  private readonly inFlight: Record<string, number> = {}

  constructor(limits: Record<string, number>) {
    this.limits = limits
    // Initialize all backends with 0 in-flight count
    for (const backend of Object.keys(limits)) {
      this.inFlight[backend] = 0
    }
  }

  /**
   * Check if a new job can be enqueued for the given backend.
   * Returns true if the current in-flight count is below the limit.
   */
  canEnqueue(backend: string): boolean {
    const limit = this.limits[backend]
    if (limit === undefined) {
      log.warn("no limit configured for backend, allowing", { backend })
      return true
    }

    const current = this.inFlight[backend] ?? 0
    const allowed = current < limit

    if (!allowed) {
      log.debug("rate limit reached", { backend, current, limit })
    }

    return allowed
  }

  /**
   * Increment the in-flight count for a backend when a job is enqueued.
   */
  trackEnqueued(backend: string): void {
    const current = this.inFlight[backend] ?? 0
    const next = current + 1
    this.inFlight[backend] = next
    log.debug("tracked enqueued job", { backend, inFlight: next })
  }

  /**
   * Decrement the in-flight count for a backend when a job completes.
   */
  trackCompleted(backend: string): void {
    const current = this.inFlight[backend] ?? 0
    const next = Math.max(0, current - 1)
    this.inFlight[backend] = next
    log.debug("tracked completed job", { backend, inFlight: next })
  }

  /**
   * Get the current in-flight count for a backend.
   */
  getInFlight(backend: string): number {
    return this.inFlight[backend] ?? 0
  }

  /**
   * Set the in-flight count for a backend directly.
   * Used for syncing state from database.
   */
  setInFlight(backend: string, count: number): void {
    this.inFlight[backend] = count
  }

  /**
   * Get all backends and their current in-flight counts.
   */
  getAllInFlight(): Record<string, number> {
    return { ...this.inFlight }
  }

  /**
   * Get the configured limit for a backend.
   */
  getLimit(backend: string): number | undefined {
    return this.limits[backend]
  }
}

/**
 * Create a new rate limiter with the specified per-backend limits.
 *
 * @param limits - Map of backend names to their maximum concurrent job counts
 * @returns A configured RateLimiter instance
 *
 * @example
 * const limiter = createRateLimiter({
 *   openai: 150,
 *   anthropic: 200,
 *   moonshot: 100,
 *   glm: 80,
 * })
 */
export function createRateLimiter(limits: Record<string, number>): RateLimiter {
  log.info("creating rate limiter", { backends: Object.keys(limits), limits })
  return new RateLimiter(limits)
}

/**
 * Sync the rate limiter's in-flight counts with the actual state in the database.
 * Queries runs with status='running', groups by backend, and updates the limiter.
 *
 * @param dbClient - Postgres client for database queries
 * @param rateLimiter - The rate limiter instance to sync
 */
export async function syncInFlightFromDb(dbClient: postgres.Sql, rateLimiter: RateLimiter): Promise<void> {
  log.info("syncing in-flight counts from database")

  const rows = await dbClient<{ backend: string; count: string }[]>`
    SELECT backend, COUNT(*) as count
    FROM runs
    WHERE status = 'running'
    GROUP BY backend
  `

  // Reset all backends to 0 first
  const allInFlight = rateLimiter.getAllInFlight()
  for (const backend of Object.keys(allInFlight)) {
    rateLimiter.setInFlight(backend, 0)
  }

  // Update with actual counts from database
  for (const row of rows) {
    const count = parseInt(row.count, 10)
    rateLimiter.setInFlight(row.backend, count)
    log.debug("synced backend count", { backend: row.backend, count })
  }

  log.info("sync complete", { counts: rateLimiter.getAllInFlight() })
}
