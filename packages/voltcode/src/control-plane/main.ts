import postgres from "postgres"
import { createServer } from "./server"
import { Log } from "../util/log"

const log = Log.create({ service: "control-plane.main" })

/**
 * CLI arguments for the control plane
 */
export interface ControlPlaneArgs {
  port: number
  dbUrl: string
  queueUrls: string[]
  dlqUrls: string[]
}

/**
 * Parse CLI arguments for the control plane.
 *
 * @param args - Process argv (defaults to Bun.argv)
 * @returns Parsed arguments
 */
export function parseArgs(args: string[] = Bun.argv): ControlPlaneArgs {
  const argMap = new Map<string, string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=")
      if (eqIdx !== -1) {
        // --key=value format
        argMap.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1))
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        // --key value format
        argMap.set(arg.slice(2), args[i + 1])
        i++
      }
    }
  }

  // Parse port (default 8080)
  const portStr = argMap.get("port") ?? process.env.CONTROL_PLANE_PORT ?? "8080"
  const port = parseInt(portStr, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portStr}`)
  }

  // Parse database URL (required, from args or env)
  const dbUrl = argMap.get("db-url") ?? process.env.CONTROL_PLANE_DB_URL ?? process.env.DATABASE_URL
  if (!dbUrl) {
    throw new Error("Database URL is required. Use --db-url or set CONTROL_PLANE_DB_URL/DATABASE_URL")
  }

  // Parse queue URLs (comma-separated)
  const queueUrlsStr = argMap.get("queue-urls") ?? process.env.CONTROL_PLANE_QUEUE_URLS ?? ""
  const queueUrls = queueUrlsStr
    ? queueUrlsStr
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
    : []

  // Parse DLQ URLs (comma-separated)
  const dlqUrlsStr = argMap.get("dlq-urls") ?? process.env.CONTROL_PLANE_DLQ_URLS ?? ""
  const dlqUrls = dlqUrlsStr
    ? dlqUrlsStr
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
    : []

  return { port, dbUrl, queueUrls, dlqUrls }
}

/**
 * Services managed by the control plane
 */
interface ControlPlaneServices {
  dbClient: postgres.Sql
  server: ReturnType<typeof Bun.serve>
  healthChecker?: ReturnType<typeof setInterval>
  metricsPublisher?: ReturnType<typeof setInterval>
}

/**
 * Initialize the database client.
 */
function initDbClient(dbUrl: string): postgres.Sql {
  log.info("initializing database client")
  return postgres(dbUrl, {
    max: 10,
    idle_timeout: 0,
    connect_timeout: 10,
    max_lifetime: 60 * 30, // 30 minutes
    onnotice: () => {}, // Suppress NOTICE messages
  })
}

/**
 * Initialize and start the Hono HTTP server.
 */
function initServer(dbClient: postgres.Sql, port: number): ReturnType<typeof Bun.serve> {
  log.info("initializing HTTP server", { port })
  const app = createServer(dbClient)

  return Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 0,
  })
}

/**
 * Health checker that periodically checks worker health and cleans up stale entries.
 *
 * @param dbClient - Postgres client
 * @param intervalMs - Check interval in milliseconds (default: 30 seconds)
 * @returns Interval handle
 */
function startHealthChecker(dbClient: postgres.Sql, intervalMs = 30_000): ReturnType<typeof setInterval> {
  log.info("starting health checker", { intervalMs })

  const check = async () => {
    try {
      // Mark workers as unhealthy if no heartbeat in 60 seconds
      const staleThreshold = new Date(Date.now() - 60_000).toISOString()
      await dbClient`
        DELETE FROM worker_heartbeats
        WHERE last_heartbeat < ${staleThreshold}
      `
      log.debug("health check completed")
    } catch (err) {
      log.error("health check failed", { error: err })
    }
  }

  // Run immediately, then on interval
  check()
  return setInterval(check, intervalMs)
}

/**
 * Metrics publisher that periodically publishes metrics (e.g., to CloudWatch).
 *
 * @param dbClient - Postgres client for querying metrics
 * @param intervalMs - Publish interval in milliseconds (default: 60 seconds)
 * @returns Interval handle
 */
function startMetricsPublisher(dbClient: postgres.Sql, intervalMs = 60_000): ReturnType<typeof setInterval> {
  log.info("starting metrics publisher", { intervalMs })

  const publish = async () => {
    try {
      // Query current worker stats
      const stats = await dbClient<{ count: number; avg_cpu: number; avg_mem: number }[]>`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(AVG(cpu_percent), 0)::float AS avg_cpu,
          COALESCE(AVG(mem_percent), 0)::float AS avg_mem
        FROM worker_heartbeats
      `
      const workerCount = stats[0]?.count ?? 0
      const avgCpu = stats[0]?.avg_cpu ?? 0
      const avgMem = stats[0]?.avg_mem ?? 0

      log.info("metrics published", { workerCount, avgCpu, avgMem })
      // TODO: Push to CloudWatch or other metrics backend
    } catch (err) {
      log.error("metrics publish failed", { error: err })
    }
  }

  // Run immediately, then on interval
  publish()
  return setInterval(publish, intervalMs)
}

/**
 * Gracefully shutdown all services.
 */
async function shutdown(services: ControlPlaneServices): Promise<void> {
  log.info("shutting down control plane")

  // Stop periodic tasks
  if (services.healthChecker) {
    clearInterval(services.healthChecker)
    log.info("health checker stopped")
  }

  if (services.metricsPublisher) {
    clearInterval(services.metricsPublisher)
    log.info("metrics publisher stopped")
  }

  // Stop HTTP server
  services.server.stop()
  log.info("HTTP server stopped")

  // Close database connection
  await services.dbClient.end()
  log.info("database connection closed")

  log.info("control plane shutdown complete")
}

/**
 * Main entry point for the control plane.
 *
 * Initializes and starts all control plane components:
 * - Database client
 * - Hono HTTP server with heartbeat endpoint
 * - Health checker for monitoring workers
 * - Metrics publisher for observability
 *
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */
export async function main(): Promise<void> {
  log.info("starting control plane")

  // Parse CLI arguments
  const args = parseArgs()
  log.info("configuration loaded", {
    port: args.port,
    queueCount: args.queueUrls.length,
    dlqCount: args.dlqUrls.length,
  })

  // Initialize services
  const dbClient = initDbClient(args.dbUrl)
  const server = initServer(dbClient, args.port)
  const healthChecker = startHealthChecker(dbClient)
  const metricsPublisher = startMetricsPublisher(dbClient)

  const services: ControlPlaneServices = {
    dbClient,
    server,
    healthChecker,
    metricsPublisher,
  }

  log.info("control plane started", {
    port: server.port,
    hostname: server.hostname,
  })

  // Handle graceful shutdown
  let shuttingDown = false
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("received shutdown signal", { signal })
    await shutdown(services)
    process.exit(0)
  }

  process.on("SIGTERM", () => handleShutdown("SIGTERM"))
  process.on("SIGINT", () => handleShutdown("SIGINT"))

  // Keep the process running
  await new Promise(() => {})
}

// Run main when this file is executed directly
if (import.meta.main) {
  main().catch((err) => {
    log.error("control plane failed to start", { error: err })
    process.exit(1)
  })
}
