import { SQSClient, ChangeMessageVisibilityCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs"
import { Log } from "../util/log"

const log = Log.create({ service: "visibility" })

const client = new SQSClient({})

const DEFAULT_TIMEOUT_SECONDS = 7200 // 2 hours
const DEFAULT_INTERVAL_MS = 600000 // 10 minutes

export async function extendVisibility(
  queueUrl: string,
  receiptHandle: string,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
): Promise<void> {
  log.debug("extending visibility timeout", { queueUrl, timeoutSeconds })
  await client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: timeoutSeconds,
    }),
  )
  log.debug("visibility timeout extended", { queueUrl, timeoutSeconds })
}

export async function deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
  log.debug("deleting message", { queueUrl })
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    }),
  )
  log.debug("message deleted", { queueUrl })
}

export function createVisibilityExtender(
  queueUrl: string,
  receiptHandle: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): { start: () => void; stop: () => void } {
  let intervalId: ReturnType<typeof setInterval> | undefined

  return {
    start() {
      if (intervalId) return
      log.info("starting visibility extender", { queueUrl, intervalMs })
      intervalId = setInterval(() => {
        extendVisibility(queueUrl, receiptHandle).catch((err) => {
          log.error("failed to extend visibility", { error: err })
        })
      }, intervalMs)
    },
    stop() {
      if (!intervalId) return
      log.info("stopping visibility extender", { queueUrl })
      clearInterval(intervalId)
      intervalId = undefined
    },
  }
}
