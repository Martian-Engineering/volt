import os from "node:os"

export interface HeartbeatPayload {
  instance_id: string
  timestamp: string
  in_flight_jobs: number
  completed_since_last: number
  failed_since_last: number
  cpu_percent: number
  mem_percent: number
}

export function getSystemStats(): { cpu_percent: number; mem_percent: number } {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const mem_percent = ((totalMem - freeMem) / totalMem) * 100

  const cpus = os.cpus()
  let totalIdle = 0
  let totalTick = 0
  for (const cpu of cpus) {
    totalIdle += cpu.times.idle
    totalTick += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  const startIdle = totalIdle
  const startTotal = totalTick

  const cpus2 = os.cpus()
  let endIdle = 0
  let endTotal = 0
  for (const cpu of cpus2) {
    endIdle += cpu.times.idle
    endTotal += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  const idleDiff = endIdle - startIdle
  const totalDiff = endTotal - startTotal
  const cpu_percent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0

  return { cpu_percent, mem_percent }
}

async function getSystemStatsWithDelay(): Promise<{ cpu_percent: number; mem_percent: number }> {
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const mem_percent = ((totalMem - freeMem) / totalMem) * 100

  const cpus1 = os.cpus()
  let startIdle = 0
  let startTotal = 0
  for (const cpu of cpus1) {
    startIdle += cpu.times.idle
    startTotal += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  await new Promise((resolve) => setTimeout(resolve, 100))

  const cpus2 = os.cpus()
  let endIdle = 0
  let endTotal = 0
  for (const cpu of cpus2) {
    endIdle += cpu.times.idle
    endTotal += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  const idleDiff = endIdle - startIdle
  const totalDiff = endTotal - startTotal
  const cpu_percent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0

  return { cpu_percent, mem_percent }
}

export async function sendHeartbeat(controlPlaneUrl: string, payload: HeartbeatPayload): Promise<void> {
  const url = `${controlPlaneUrl}/heartbeat`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Heartbeat failed: ${response.status} ${response.statusText}`)
  }
}

async function getInstanceId(): Promise<string> {
  const response = await fetch("http://169.254.169.254/latest/meta-data/instance-id", {
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) {
    throw new Error(`Failed to get instance ID: ${response.status}`)
  }
  return response.text()
}

export function createHeartbeatSender(
  controlPlaneUrl: string,
  getInFlightCount: () => number,
  intervalMs: number = 60000,
): { start: () => void; stop: () => void; recordCompleted: () => void; recordFailed: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let instanceId: string | null = null
  let completedSinceLast = 0
  let failedSinceLast = 0

  const sendBeat = async () => {
    if (!instanceId) {
      instanceId = await getInstanceId().catch(() => "unknown")
    }

    const stats = await getSystemStatsWithDelay()

    const payload: HeartbeatPayload = {
      instance_id: instanceId,
      timestamp: new Date().toISOString(),
      in_flight_jobs: getInFlightCount(),
      completed_since_last: completedSinceLast,
      failed_since_last: failedSinceLast,
      cpu_percent: stats.cpu_percent,
      mem_percent: stats.mem_percent,
    }

    await sendHeartbeat(controlPlaneUrl, payload).catch((e) => {
      console.debug("heartbeat failed", e instanceof Error ? e.message : String(e))
    })

    completedSinceLast = 0
    failedSinceLast = 0
  }

  return {
    start: () => {
      if (timer) return
      sendBeat()
      timer = setInterval(sendBeat, intervalMs)
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    recordCompleted: () => {
      completedSinceLast++
    },
    recordFailed: () => {
      failedSinceLast++
    },
  }
}
