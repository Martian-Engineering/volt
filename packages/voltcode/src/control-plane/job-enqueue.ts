import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs"

export interface JobParams {
  context_length: number
  context_window_id: number
  backend: string
  seed: number
  timeout_minutes: number
  variant?: string
}

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

export function buildJobMessage(params: JobParams): JobMessage {
  const run_id = crypto.randomUUID()
  return {
    run_id,
    context_length: params.context_length,
    context_window_id: params.context_window_id,
    backend: params.backend,
    seed: params.seed,
    timeout_minutes: params.timeout_minutes,
    retry_count: 0,
    output_prefix: `runs/${run_id}`,
    ...(params.variant ? { variant: params.variant } : {}),
  }
}

export function getQueueUrlForBackend(backend: string, queueUrls: Record<string, string>): string {
  const prefix = backend.split(":")[0]?.toLowerCase()
  if (!prefix) {
    throw new Error(`Invalid backend format: ${backend}`)
  }

  const queueUrl = queueUrls[prefix]
  if (!queueUrl) {
    const availableBackends = Object.keys(queueUrls).join(", ")
    throw new Error(`No queue URL configured for backend prefix: ${prefix}. Available: ${availableBackends}`)
  }

  return queueUrl
}

const sqsClient = new SQSClient({})

export async function enqueueJob(queueUrl: string, job: JobMessage): Promise<void> {
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(job),
  })

  await sqsClient.send(command)
}
