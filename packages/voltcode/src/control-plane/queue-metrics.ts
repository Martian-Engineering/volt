import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs"
import { CloudWatchClient, PutMetricDataCommand, type MetricDatum } from "@aws-sdk/client-cloudwatch"
import type postgres from "postgres"
import { Log } from "../util/log"

const log = Log.create({ service: "queue-metrics" })

const sqsClient = new SQSClient({})
const cloudwatchClient = new CloudWatchClient({})

/**
 * Get the approximate number of messages visible in an SQS queue.
 *
 * @param queueUrl - The URL of the SQS queue
 * @returns The approximate number of messages waiting to be processed
 */
export async function getSQSDepth(queueUrl: string): Promise<number> {
  const command = new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ["ApproximateNumberOfMessages"],
  })

  const response = await sqsClient.send(command)
  const depth = response.Attributes?.ApproximateNumberOfMessages

  return depth ? parseInt(depth, 10) : 0
}

/**
 * Get the approximate number of messages visible in a dead letter queue.
 *
 * @param dlqUrl - The URL of the dead letter queue
 * @returns The approximate number of messages in the DLQ
 */
export async function getDLQDepth(dlqUrl: string): Promise<number> {
  return getSQSDepth(dlqUrl)
}

/**
 * Worker health counts based on heartbeat recency.
 */
export interface WorkerHealthCounts {
  healthy: number
  unhealthy: number
}

/**
 * Get counts of healthy and unhealthy workers based on heartbeat timestamps.
 *
 * A worker is considered healthy if its last heartbeat was within the last 3 minutes.
 * A worker is considered unhealthy if its last heartbeat was more than 3 minutes ago.
 *
 * @param dbClient - Postgres client for database queries
 * @returns Object containing healthy and unhealthy worker counts
 */
export async function getWorkerHealthCounts(dbClient: postgres.Sql): Promise<WorkerHealthCounts> {
  const rows = await dbClient<{ healthy: number; unhealthy: number }[]>`
    SELECT
      COUNT(*) FILTER (WHERE last_heartbeat > NOW() - INTERVAL '3 minutes')::int AS healthy,
      COUNT(*) FILTER (WHERE last_heartbeat <= NOW() - INTERVAL '3 minutes')::int AS unhealthy
    FROM worker_heartbeats
  `

  const result = rows[0]
  return {
    healthy: result?.healthy ?? 0,
    unhealthy: result?.unhealthy ?? 0,
  }
}

/**
 * Publish SQS queue depth metrics to CloudWatch.
 *
 * Publishes:
 * - voltcode/sqs_depth for each main queue
 * - voltcode/dlq_depth for each dead letter queue
 *
 * @param queueUrls - Array of main queue URLs to monitor
 * @param dlqUrls - Array of DLQ URLs to monitor
 * @param namespace - CloudWatch namespace for the metrics
 */
export async function publishQueueMetrics(queueUrls: string[], dlqUrls: string[], namespace: string): Promise<void> {
  const metricData: MetricDatum[] = []

  // Collect SQS depth metrics
  for (const queueUrl of queueUrls) {
    const depth = await getSQSDepth(queueUrl).catch((err) => {
      log.error("failed to get SQS depth", { queueUrl, error: err })
      return null
    })

    if (depth !== null) {
      const queueName = extractQueueName(queueUrl)
      metricData.push({
        MetricName: "sqs_depth",
        Value: depth,
        Unit: "Count",
        Dimensions: [{ Name: "QueueName", Value: queueName }],
      })
      log.debug("collected sqs_depth", { queueName, depth })
    }
  }

  // Collect DLQ depth metrics
  for (const dlqUrl of dlqUrls) {
    const depth = await getDLQDepth(dlqUrl).catch((err) => {
      log.error("failed to get DLQ depth", { dlqUrl, error: err })
      return null
    })

    if (depth !== null) {
      const queueName = extractQueueName(dlqUrl)
      metricData.push({
        MetricName: "dlq_depth",
        Value: depth,
        Unit: "Count",
        Dimensions: [{ Name: "QueueName", Value: queueName }],
      })
      log.debug("collected dlq_depth", { queueName, depth })
    }
  }

  if (metricData.length === 0) {
    log.warn("no queue metrics to publish")
    return
  }

  const command = new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: metricData,
  })

  await cloudwatchClient.send(command)
  log.info("published queue metrics", { namespace, metricCount: metricData.length })
}

/**
 * Publish worker health metrics to CloudWatch.
 *
 * Publishes:
 * - voltcode/healthy_workers - count of workers with recent heartbeats
 * - voltcode/unhealthy_workers - count of workers with stale heartbeats
 *
 * @param dbClient - Postgres client for database queries
 * @param namespace - CloudWatch namespace for the metrics
 */
export async function publishWorkerMetrics(dbClient: postgres.Sql, namespace: string): Promise<void> {
  const counts = await getWorkerHealthCounts(dbClient)

  const command = new PutMetricDataCommand({
    Namespace: namespace,
    MetricData: [
      {
        MetricName: "healthy_workers",
        Value: counts.healthy,
        Unit: "Count",
      },
      {
        MetricName: "unhealthy_workers",
        Value: counts.unhealthy,
        Unit: "Count",
      },
    ],
  })

  await cloudwatchClient.send(command)
  log.info("published worker metrics", {
    namespace,
    healthy: counts.healthy,
    unhealthy: counts.unhealthy,
  })
}

/**
 * Extract the queue name from an SQS queue URL.
 *
 * @param queueUrl - Full SQS queue URL
 * @returns The queue name portion of the URL
 */
function extractQueueName(queueUrl: string): string {
  const parts = queueUrl.split("/")
  return parts[parts.length - 1] ?? queueUrl
}
