import { SQSClient, ReceiveMessageCommand, type ReceiveMessageCommandOutput } from "@aws-sdk/client-sqs"
import { Log } from "@/util/log"

const log = Log.create({ service: "sqs-poller" })

export interface JobMessage {
  run_id: string
  context_length: number
  context_window_id: number
  backend: string
  seed: number
  timeout_minutes: number
  retry_count: number
  output_prefix: string
  variant?: string
}

interface PollResult {
  message: JobMessage
  receiptHandle: string
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

const client = new SQSClient({})

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function pollQueue(queueUrl: string): Promise<PollResult | null> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const command = new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
      })

      const response: ReceiveMessageCommandOutput = await client.send(command)

      if (!response.Messages || response.Messages.length === 0) {
        log.debug("No messages available")
        return null
      }

      const sqsMessage = response.Messages[0]
      if (!sqsMessage.Body || !sqsMessage.ReceiptHandle) {
        log.warn("Received message without body or receipt handle")
        return null
      }

      const jobMessage = JSON.parse(sqsMessage.Body) as JobMessage
      log.info("Received job message", { run_id: jobMessage.run_id })

      return {
        message: jobMessage,
        receiptHandle: sqsMessage.ReceiptHandle,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      log.warn("SQS poll attempt failed", {
        attempt,
        error: lastError,
        queueUrl,
      })

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt)
      }
    }
  }

  log.error("SQS poll failed after retries", {
    attempts: MAX_RETRIES,
    error: lastError,
    queueUrl,
  })
  throw lastError
}
