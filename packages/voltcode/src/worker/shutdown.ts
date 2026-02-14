import { Log } from "@/util/log"
import type { WorkerPool } from "./pool"

const log = Log.create({ service: "shutdown" })

const SPOT_METADATA_URL = "http://169.254.169.254/latest/meta-data/spot/instance-action"
const SPOT_POLL_INTERVAL_MS = 5000

export function setupSignalHandlers(onShutdown: () => Promise<void>): void {
  const handler = async (signal: string) => {
    log.info("Received signal, initiating shutdown", { signal })
    try {
      await onShutdown()
      log.info("Shutdown complete")
      process.exit(0)
    } catch (error) {
      log.error("Shutdown failed", { error })
      process.exit(1)
    }
  }

  process.on("SIGTERM", () => handler("SIGTERM"))
  process.on("SIGINT", () => handler("SIGINT"))
}

export function setupSpotInterruptionHandler(onInterruption: () => Promise<void>): void {
  let interrupted = false

  const poll = async () => {
    if (interrupted) return

    try {
      const response = await fetch(SPOT_METADATA_URL, {
        signal: AbortSignal.timeout(2000),
      })

      if (response.ok) {
        const data = await response.json()
        log.warn("Spot interruption notice received", { action: data })
        interrupted = true
        await onInterruption()
      }
    } catch {
      // 404 means no interruption scheduled - this is normal
      // Network errors are also expected on non-EC2 environments
    }

    if (!interrupted) {
      setTimeout(poll, SPOT_POLL_INTERVAL_MS)
    }
  }

  poll()
}

export function createGracefulShutdown(pool: WorkerPool, cleanup: () => Promise<void>): () => Promise<void> {
  let shuttingDown = false

  return async () => {
    if (shuttingDown) {
      log.warn("Shutdown already in progress")
      return
    }
    shuttingDown = true

    log.info("Stopping acceptance of new jobs")
    log.info("Waiting for running jobs to complete", { running: pool.runningCount })

    await pool.waitForAll()
    log.info("All jobs completed")

    log.info("Running cleanup")
    await cleanup()
    log.info("Cleanup complete")

    process.exit(0)
  }
}
