import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from "@aws-sdk/client-cloudwatch"
import type postgres from "postgres"
import { Log } from "../util/log"

const log = Log.create({ service: "control-plane.metrics" })

const cloudWatchClient = new CloudWatchClient({})

/**
 * Publish a single metric to CloudWatch.
 *
 * @param namespace - The CloudWatch namespace (e.g., "voltcode")
 * @param metricName - The name of the metric
 * @param value - The metric value
 * @param dimensions - Optional key-value pairs for metric dimensions
 */
export async function publishMetric(
  namespace: string,
  metricName: string,
  value: number,
  dimensions?: Record<string, string>,
): Promise<void> {
  const metricDatum: MetricDatum = {
    MetricName: metricName,
    Value: value,
    Timestamp: new Date(),
    Unit: "Count",
  }

  if (dimensions) {
    metricDatum.Dimensions = Object.entries(dimensions).map(([Name, Value]) => ({
      Name,
      Value,
    }))
  }

  const command = new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: [metricDatum],
  })

  await cloudWatchClient.send(command)
  log.debug("published metric", { namespace, metricName, value, dimensions })
}

/**
 * Run statistics for completed, failed, and in-flight runs.
 */
export interface RunStats {
  completed: number
  failed: number
  in_flight: number
}

/**
 * Get run statistics from the runs table.
 *
 * @param dbClient - Postgres client
 * @returns Object with completed, failed, and in_flight counts
 */
export async function getRunStats(dbClient: postgres.Sql): Promise<RunStats> {
  const rows = await dbClient<{ completed: number; failed: number; in_flight: number }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN success = true THEN 1 ELSE 0 END), 0)::int AS completed,
      COALESCE(SUM(CASE WHEN success = false THEN 1 ELSE 0 END), 0)::int AS failed,
      COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0)::int AS in_flight
    FROM runs
  `

  const row = rows[0]
  return {
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    in_flight: row?.in_flight ?? 0,
  }
}

/**
 * Run statistics grouped by backend.
 */
export interface BackendRunStats {
  completed: number
  failed: number
}

/**
 * Get run statistics grouped by backend.
 *
 * @param dbClient - Postgres client
 * @returns Map of backend name to completed/failed counts
 */
export async function getRunStatsByBackend(dbClient: postgres.Sql): Promise<Map<string, BackendRunStats>> {
  const rows = await dbClient<{ backend: string; completed: number; failed: number }[]>`
    SELECT
      backend,
      COALESCE(SUM(CASE WHEN success = true THEN 1 ELSE 0 END), 0)::int AS completed,
      COALESCE(SUM(CASE WHEN success = false THEN 1 ELSE 0 END), 0)::int AS failed
    FROM runs
    GROUP BY backend
  `

  const result = new Map<string, BackendRunStats>()
  for (const row of rows) {
    result.set(row.backend, {
      completed: row.completed,
      failed: row.failed,
    })
  }
  return result
}

/**
 * Publish run metrics to CloudWatch.
 *
 * Publishes the following metrics:
 * - voltcode/runs_completed - Total completed runs
 * - voltcode/runs_failed - Total failed runs
 * - voltcode/runs_in_flight - Currently running runs
 *
 * Also publishes per-backend metrics with Backend dimension.
 *
 * @param dbClient - Postgres client
 * @param namespace - CloudWatch namespace (default: "voltcode")
 */
export async function publishRunMetrics(dbClient: postgres.Sql, namespace: string = "voltcode"): Promise<void> {
  // Get overall stats
  const stats = await getRunStats(dbClient)

  // Publish overall metrics
  const overallMetrics: MetricDatum[] = [
    {
      MetricName: "runs_completed",
      Value: stats.completed,
      Timestamp: new Date(),
      Unit: "Count",
    },
    {
      MetricName: "runs_failed",
      Value: stats.failed,
      Timestamp: new Date(),
      Unit: "Count",
    },
    {
      MetricName: "runs_in_flight",
      Value: stats.in_flight,
      Timestamp: new Date(),
      Unit: "Count",
    },
  ]

  const overallCommand = new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: overallMetrics,
  })
  await cloudWatchClient.send(overallCommand)
  log.info("published overall run metrics", { stats })

  // Get per-backend stats
  const backendStats = await getRunStatsByBackend(dbClient)

  // Publish per-backend metrics
  const backendMetrics: MetricDatum[] = []
  for (const [backend, backendStat] of backendStats) {
    backendMetrics.push({
      MetricName: "runs_completed",
      Value: backendStat.completed,
      Timestamp: new Date(),
      Unit: "Count",
      Dimensions: [{ Name: "Backend", Value: backend }],
    })
    backendMetrics.push({
      MetricName: "runs_failed",
      Value: backendStat.failed,
      Timestamp: new Date(),
      Unit: "Count",
      Dimensions: [{ Name: "Backend", Value: backend }],
    })
  }

  // CloudWatch allows max 1000 metrics per request, batch if needed
  const BATCH_SIZE = 1000
  for (let i = 0; i < backendMetrics.length; i += BATCH_SIZE) {
    const batch = backendMetrics.slice(i, i + BATCH_SIZE)
    const backendCommand = new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: batch,
    })
    await cloudWatchClient.send(backendCommand)
  }

  log.info("published per-backend run metrics", {
    backendCount: backendStats.size,
  })
}
