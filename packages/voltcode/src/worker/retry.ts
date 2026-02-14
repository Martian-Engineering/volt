import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs"
import type { JobMessage } from "./sqs-poller"

const MAX_RETRIES = 3

const BACKOFF_DELAYS: Record<number, number> = {
  1: 30,
  2: 120,
  3: 600,
}

const sqsClient = new SQSClient({})

export function getBackoffDelay(retryCount: number): number {
  return BACKOFF_DELAYS[retryCount] ?? 600
}

export function shouldRetry(retryCount: number): boolean {
  return retryCount < MAX_RETRIES
}

export function getDLQUrl(queueUrl: string): string {
  return `${queueUrl}-dlq`
}

export async function requeueWithBackoff(queueUrl: string, job: JobMessage): Promise<void> {
  const updatedJob: JobMessage = {
    ...job,
    retry_count: job.retry_count + 1,
  }

  const delaySeconds = getBackoffDelay(updatedJob.retry_count)

  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(updatedJob),
    DelaySeconds: delaySeconds,
  })

  await sqsClient.send(command)
}

export async function sendToDLQ(dlqUrl: string, job: JobMessage, errorMessage: string): Promise<void> {
  const dlqPayload = {
    ...job,
    error: errorMessage,
    failed_at: new Date().toISOString(),
  }

  const command = new SendMessageCommand({
    QueueUrl: dlqUrl,
    MessageBody: JSON.stringify(dlqPayload),
  })

  await sqsClient.send(command)
}
