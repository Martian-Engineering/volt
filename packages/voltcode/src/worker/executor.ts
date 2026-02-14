import { Log } from "../util/log"
import fs from "fs/promises"
import path from "path"

const log = Log.create({ service: "executor" })

/**
 * Job message received from the queue
 */
export interface JobMessage {
  runId: string
  contextLength: number
  contextWindowId: number
  backend: string
  timeoutMinutes: number
  variant?: string
}

/**
 * Result of executing a VoltCode process
 */
export interface ExecutionResult {
  exitCode: number
  durationMs: number
  outputDir: string
  timedOut: boolean
}

/**
 * Spawn VoltCode as a child process with stdout/stderr capture and timeout.
 *
 * Command: bun run packages/voltcode/evals/cli.ts oolong \
 *   --context-len X \
 *   --backend Z \
 *   --runId R \
 *   --output /tmp/voltcode/R
 *
 * Note: contextWindowId is passed in the job but the CLI doesn't support filtering
 * by context window. The oolong benchmark has only 2 context windows (IDs 0 and 1),
 * each used by 25 tasks. For now, contextWindowId is logged but not used for filtering.
 *
 * @param job - Job parameters from the queue
 * @param env - Environment variables to pass to the child process
 * @returns Execution result with exit code, duration, output directory, and timeout status
 */
export async function runVoltCode(job: JobMessage, env: Record<string, string>): Promise<ExecutionResult> {
  const outputDir = `/tmp/voltcode/${job.runId}`
  const startTime = Date.now()
  // Enforce minimum 60-minute timeout — oolong runs 20 tasks serially,
  // and the first task's cache build alone can take 15+ minutes.
  const timeoutMs = Math.max(job.timeoutMinutes, 60) * 60 * 1000

  log.info("starting voltcode execution", {
    runId: job.runId,
    contextLength: job.contextLength,
    contextWindowId: job.contextWindowId,
    backend: job.backend,
    variant: job.variant,
    timeoutMinutes: job.timeoutMinutes,
    outputDir,
  })

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true })

  const stdoutPath = path.join(outputDir, "stdout.log")
  const stderrPath = path.join(outputDir, "stderr.log")

  // Open file handles for stdout/stderr capture
  const stdoutFile = Bun.file(stdoutPath)
  const stderrFile = Bun.file(stderrPath)
  const stdoutWriter = stdoutFile.writer()
  const stderrWriter = stderrFile.writer()

  const cmd = [
    "bun",
    "run",
    "packages/voltcode/evals/cli.ts",
    "oolong",
    "--context-len",
    String(job.contextLength),
    "--backend",
    job.backend,
    "--runId",
    job.runId,
    "--output",
    outputDir,
    ...(job.variant ? ["--variant", job.variant] : []),
  ]

  log.info("spawning process", { cmd: cmd.join(" ") })

  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
    },
  })

  let timedOut = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  // Set up timeout handler
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      log.warn("process timed out, killing", {
        runId: job.runId,
        timeoutMs,
        elapsedMs: Date.now() - startTime,
      })
      proc.kill("SIGTERM")
      // Give process 5 seconds to terminate gracefully, then SIGKILL
      setTimeout(() => {
        if (!proc.killed) {
          log.warn("process did not terminate, sending SIGKILL", { runId: job.runId })
          proc.kill("SIGKILL")
        }
      }, 5000)
      resolve()
    }, timeoutMs)
  })

  // Stream stdout to file
  const stdoutPipe = (async () => {
    if (!proc.stdout) return
    const reader = proc.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          stdoutWriter.write(value)
        }
      }
    } finally {
      reader.releaseLock()
      await stdoutWriter.end()
    }
  })()

  // Stream stderr to file
  const stderrPipe = (async () => {
    if (!proc.stderr) return
    const reader = proc.stderr.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          stderrWriter.write(value)
        }
      }
    } finally {
      reader.releaseLock()
      await stderrWriter.end()
    }
  })()

  // Wait for process to exit or timeout
  const exitCode = await Promise.race([proc.exited, timeoutPromise.then(() => proc.exited)])

  // Clear timeout if process exited before timeout
  if (timeoutId) {
    clearTimeout(timeoutId)
  }

  // Wait for streams to finish writing
  await Promise.all([stdoutPipe, stderrPipe])

  const durationMs = Date.now() - startTime

  log.info("voltcode execution completed", {
    runId: job.runId,
    exitCode,
    durationMs,
    timedOut,
    outputDir,
  })

  // Clean up on timeout (remove partial output)
  if (timedOut) {
    log.info("cleaning up after timeout", { runId: job.runId, outputDir })
    // Keep logs for debugging, but mark the run as timed out
    const timeoutMarker = path.join(outputDir, "TIMED_OUT")
    await fs.writeFile(timeoutMarker, `Timed out after ${job.timeoutMinutes} minutes`)
  }

  return {
    exitCode: typeof exitCode === "number" ? exitCode : -1,
    durationMs,
    outputDir,
    timedOut,
  }
}
