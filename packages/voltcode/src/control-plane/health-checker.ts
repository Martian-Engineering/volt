import type postgres from "postgres"
import { Log } from "../util/log"

const log = Log.create({ service: "health-checker" })

const DEFAULT_STALE_THRESHOLD_MINUTES = 3
const DEFAULT_CHECK_INTERVAL_MS = 60000

/**
 * Get list of worker instance IDs that are considered unhealthy (stale heartbeat).
 *
 * @param dbClient - Postgres client for database operations
 * @param staleThresholdMinutes - Minutes since last heartbeat to consider worker stale (default: 3)
 * @returns List of instance_ids for unhealthy workers
 */
export async function getUnhealthyWorkers(
  dbClient: postgres.Sql,
  staleThresholdMinutes: number = DEFAULT_STALE_THRESHOLD_MINUTES,
): Promise<string[]> {
  const rows = await dbClient<{ instance_id: string }[]>`
    SELECT instance_id
    FROM worker_heartbeats
    WHERE last_heartbeat < NOW() - make_interval(mins => ${staleThresholdMinutes})
  `

  const instanceIds = rows.map((r) => r.instance_id)

  if (instanceIds.length > 0) {
    log.info("found unhealthy workers", {
      count: instanceIds.length,
      instanceIds,
      staleThresholdMinutes,
    })
  }

  return instanceIds
}

/**
 * Update the healthy status of all workers based on their last heartbeat.
 *
 * Sets healthy = true for workers with recent heartbeats (within 3 minutes),
 * and healthy = false for workers with stale heartbeats.
 *
 * @param dbClient - Postgres client for database operations
 */
export async function markWorkersHealthy(dbClient: postgres.Sql): Promise<void> {
  // Update workers with recent heartbeats to healthy
  const healthyResult = await dbClient`
    UPDATE worker_heartbeats
    SET healthy = true
    WHERE last_heartbeat > NOW() - INTERVAL '3 minutes'
      AND (healthy IS NULL OR healthy = false)
  `

  // Update workers with stale heartbeats to unhealthy
  const unhealthyResult = await dbClient`
    UPDATE worker_heartbeats
    SET healthy = false
    WHERE last_heartbeat <= NOW() - INTERVAL '3 minutes'
      AND (healthy IS NULL OR healthy = true)
  `

  const healthyCount = healthyResult.count
  const unhealthyCount = unhealthyResult.count

  if (healthyCount > 0 || unhealthyCount > 0) {
    log.info("updated worker health status", {
      markedHealthy: healthyCount,
      markedUnhealthy: unhealthyCount,
    })
  }
}

/**
 * Create a periodic health checker that runs markWorkersHealthy at the specified interval.
 *
 * @param dbClient - Postgres client for database operations
 * @param intervalMs - Interval between health checks in milliseconds (default: 60000)
 * @returns Object with start() and stop() methods to control the checker
 */
export function createHealthChecker(
  dbClient: postgres.Sql,
  intervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null

  const runCheck = async () => {
    await markWorkersHealthy(dbClient).catch((err) => {
      log.error("health check failed", { error: err instanceof Error ? err.message : String(err) })
    })
  }

  return {
    start: () => {
      if (timer) return
      log.info("starting health checker", { intervalMs })
      runCheck()
      timer = setInterval(runCheck, intervalMs)
    },
    stop: () => {
      if (timer) {
        log.info("stopping health checker")
        clearInterval(timer)
        timer = null
      }
    },
  }
}
