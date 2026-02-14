import { EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2"

const DEFAULT_TIMEOUT_MS = 600000 // 10 minutes

export interface IdleTracker {
  markActive(): void
  markIdle(): void
  isIdleTimeout(): boolean
}

export function createIdleTracker(timeoutMs: number = DEFAULT_TIMEOUT_MS): IdleTracker {
  let idleStartTime: number | null = null

  return {
    markActive() {
      idleStartTime = null
    },
    markIdle() {
      if (idleStartTime === null) {
        idleStartTime = Date.now()
      }
    },
    isIdleTimeout() {
      if (idleStartTime === null) return false
      return Date.now() - idleStartTime > timeoutMs
    },
  }
}

let cachedInstanceId: string | null = null

export async function getInstanceId(): Promise<string> {
  if (cachedInstanceId !== null) {
    return cachedInstanceId
  }

  const response = await fetch("http://169.254.169.254/latest/meta-data/instance-id", {
    signal: AbortSignal.timeout(2000),
  })

  if (!response.ok) {
    throw new Error(`Failed to get instance ID: ${response.status}`)
  }

  cachedInstanceId = await response.text()
  return cachedInstanceId
}

export async function terminateSelf(region: string): Promise<void> {
  const instanceId = await getInstanceId()
  const client = new EC2Client({ region })
  const command = new TerminateInstancesCommand({
    InstanceIds: [instanceId],
  })
  await client.send(command)
}
