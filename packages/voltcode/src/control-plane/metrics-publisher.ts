import type postgres from "postgres"
import { Log } from "../util/log"
import { publishRunMetrics } from "./metrics"
import { publishQueueMetrics, publishWorkerMetrics } from "./queue-metrics"

const log = Log.create({ service: "metrics-publisher" })

const DEFAULT_INTERVAL_MS = 60000

/**
 * Configuration for the metrics publisher.
 */
export interface MetricsConfig {
  /** Postgres client for database operations */
  dbClient: postgres.Sql
  /** Array of main SQS queue URLs to monitor */
  queueUrls: string[]
  /** Array of dead letter queue URLs to monitor */
  dlqUrls: string[]
  /** CloudWatch namespace for all metrics */
  namespace: string
  /** Interval between metric publications in milliseconds (default: 60000) */
  intervalMs?: number
}

/**
 * Create a periodic metrics publisher that publishes all metrics to CloudWatch.
 *
 * Publishes the following metrics at the configured interval:
 * - Run metrics (completed, failed, in-flight runs)
 * - Queue metrics (SQS depth, DLQ depth)
 * - Worker metrics (healthy/unhealthy worker counts)
 *
 * @param config - Configuration for the metrics publisher
 * @returns Object with start() and stop() methods to control the publisher
 */
export function createMetricsPublisher(config: MetricsConfig): { start: () => void; stop: () => void } {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | null = null

  const publishAll = async () => {
    log.info("publishing all metrics", { namespace: config.namespace })

    // Publish run metrics
    await publishRunMetrics(config.dbClient, config.namespace).catch((err) => {
      log.error("failed to publish run metrics", {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    // Publish queue metrics
    await publishQueueMetrics(config.queueUrls, config.dlqUrls, config.namespace).catch((err) => {
      log.error("failed to publish queue metrics", {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    // Publish worker metrics
    await publishWorkerMetrics(config.dbClient, config.namespace).catch((err) => {
      log.error("failed to publish worker metrics", {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    log.info("completed publishing all metrics")
  }

  return {
    start: () => {
      if (timer) return
      log.info("starting metrics publisher", { intervalMs, namespace: config.namespace })
      publishAll()
      timer = setInterval(publishAll, intervalMs)
    },
    stop: () => {
      if (timer) {
        log.info("stopping metrics publisher")
        clearInterval(timer)
        timer = null
      }
    },
  }
}
