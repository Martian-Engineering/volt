/**
 * Utility functions for evaluation benchmarks
 */

/**
 * Run a shell command with timeout using Bun.spawn
 */
export async function exec(
  cmd: string[],
  options: {
    cwd?: string
    timeout?: number
    quiet?: boolean
    env?: Record<string, string | undefined>
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { cwd, timeout = 120_000, quiet = false, env } = options

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  })

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill()
      reject(new Error(`Command timed out after ${timeout}ms: ${cmd.join(" ")}`))
    }, timeout)
  })

  // Wait for process with timeout
  const [exitCode, stdoutBuf, stderrBuf] = await Promise.race([
    Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
    timeoutPromise,
  ])

  const stdout = stdoutBuf
  const stderr = stderrBuf

  if (!quiet && exitCode !== 0) {
    console.error(`Command failed (${exitCode}): ${cmd.join(" ")}`)
    if (stderr) console.error(stderr)
  }

  return { stdout, stderr, exitCode }
}

/**
 * Run a shell command string with timeout
 */
export async function execShell(
  command: string,
  options: {
    cwd?: string
    timeout?: number
    quiet?: boolean
    env?: Record<string, string | undefined>
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { cwd, timeout, quiet, env } = options
  return exec(["sh", "-c", command], { cwd, timeout, quiet, env })
}

/**
 * Check if a command exists
 */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const result = await exec(["which", cmd], { quiet: true })
    return result.exitCode === 0
  } catch {
    return false
  }
}

/**
 * Check if a file/directory exists
 */
export async function pathExists(filepath: string): Promise<boolean> {
  try {
    await Bun.file(filepath).exists()
    return true
  } catch {
    return false
  }
}
