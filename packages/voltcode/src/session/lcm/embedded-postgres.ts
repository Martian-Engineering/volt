import fs from "fs/promises"
import os from "os"
import path from "path"
import postgres from "postgres"
import { $ } from "bun"
import { Log } from "@/util/log"
import { Archive } from "@/util/archive"
import {
  LCM_DATABASE_URL,
  LCM_DATABASE_USER,
  LCM_POSTGRES_BIN,
  LCM_POSTGRES_BUILD,
  LCM_POSTGRES_DATA,
  LCM_POSTGRES_HOST,
  LCM_POSTGRES_LOCK,
  LCM_POSTGRES_LOG,
  LCM_POSTGRES_PORT,
  LCM_POSTGRES_ROOT,
  LCM_POSTGRES_VERSION,
} from "./config"

const log = Log.create({ service: "lcm.postgres" })

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"])
const SUPPORTED_ARCHES = new Set(["x64", "arm64"])
const REQUIRED_BINARIES = ["postgres", "initdb", "pg_ctl"] as const
const REQUIRED_LINUX_LIB_PREFIXES = ["libicuuc.so", "libicudata.so", "libicui18n.so"] as const
const REQUIRED_LINUX_LIB_EXACT = ["libpq.so.5"] as const
const SHARED_LIBRARY_ERROR_PATTERNS = [
  "error while loading shared libraries",
  "cannot open shared object file",
  "dyld: library not loaded",
  "image not found",
]

type ArchiveType = "zip" | "targz"
type InstallValidation = { valid: true } | { valid: false; reason: string }

export function isEmbeddedPostgresSupported() {
  return SUPPORTED_PLATFORMS.has(process.platform) && SUPPORTED_ARCHES.has(process.arch)
}

export async function ensureEmbeddedPostgresRunning(): Promise<boolean> {
  if (!isEmbeddedPostgresSupported()) {
    log.warn("embedded postgres unsupported on platform", { platform: process.platform, arch: process.arch })
    return false
  }

  await ensureBinaries()
  await ensureClusterInitialized()

  const adminUrl = buildAdminUrl()
  if (await canConnect(adminUrl)) {
    await reloadConfig()
    return true
  }

  // Try to start postgres. If pg_ctl fails, another instance may have started it concurrently.
  try {
    await startPostgres()
  } catch (e) {
    if (await waitForReady(adminUrl)) {
      log.info("postgres started by another instance")
      return true
    }
    throw e
  }
  const ready = await waitForReady(adminUrl)
  if (!ready) {
    log.error("embedded postgres failed to become ready")
  }
  return ready
}

function postgresBinary(name: string) {
  return path.join(LCM_POSTGRES_BIN, name + (process.platform === "win32" ? ".exe" : ""))
}

function postgresEnv() {
  const libPath = path.join(LCM_POSTGRES_ROOT, "lib")
  const env: Record<string, string> = {
    ...process.env,
    PGDATA: LCM_POSTGRES_DATA,
    PATH: [LCM_POSTGRES_BIN, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  }
  if (process.platform === "linux") {
    env.LD_LIBRARY_PATH = [libPath, process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(path.delimiter)
  }
  if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = [libPath, process.env.DYLD_LIBRARY_PATH ?? ""].filter(Boolean).join(path.delimiter)
  }
  return env
}

/**
 * Downloads postgres binaries if not already present.
 * Safe to call multiple times - will skip if binaries exist.
 * This is called early in startup to ensure postgres is ready before LCM is needed.
 */
export async function ensurePostgresBinaries() {
  if (!isEmbeddedPostgresSupported()) return
  await ensureBinaries()
}

/**
 * Checks if postgres binaries need to be downloaded.
 */
export async function needsPostgresDownload(): Promise<boolean> {
  if (!isEmbeddedPostgresSupported()) return false
  const validation = await validatePostgresInstall()
  return !validation.valid
}

/**
 * Downloads postgres binaries with progress reporting.
 * @param onProgress - Callback with progress percentage (0-100)
 */
export async function downloadPostgresWithProgress(onProgress?: (percent: number) => void): Promise<void> {
  if (!isEmbeddedPostgresSupported()) return
  await ensureBinaries(onProgress)
}

async function ensureBinaries(onProgress?: (percent: number) => void) {
  const validation = await validatePostgresInstall()
  if (validation.valid) return

  await fs.mkdir(LCM_POSTGRES_ROOT, { recursive: true })
  await withInstallLock(async () => {
    const lockValidation = await validatePostgresInstall()
    if (lockValidation.valid) return

    log.warn("embedded postgres install invalid, repairing", { reason: lockValidation.reason })
    await removeInvalidInstallArtifacts()

    const { url, archiveType } = await downloadSpec()
    log.info("downloading embedded postgres", { url })
    if (onProgress) {
      await downloadAndExtractWithProgress(url, archiveType, onProgress)
    } else {
      await downloadAndExtract(url, archiveType)
    }

    const repairedValidation = await validatePostgresInstall()
    if (!repairedValidation.valid) {
      throw new Error(
        [
          "embedded postgres install validation failed after download",
          repairedValidation.reason,
          `delete '${LCM_POSTGRES_ROOT}' and retry, or set LCM_DATABASE_URL to use an external Postgres database`,
        ].join(": "),
      )
    }
  })
}

async function ensureClusterInitialized() {
  await fs.mkdir(LCM_POSTGRES_ROOT, { recursive: true })
  await fs.mkdir(path.dirname(LCM_POSTGRES_LOG), { recursive: true })

  const versionFile = path.join(LCM_POSTGRES_DATA, "PG_VERSION")
  if (await exists(versionFile)) {
    await configureCluster()
    return
  }

  await withInstallLock(async () => {
    if (await exists(versionFile)) {
      await configureCluster()
      return
    }

    await fs.mkdir(LCM_POSTGRES_DATA, { recursive: true })
    const initdb = postgresBinary("initdb")
    const env = postgresEnv()
    log.info("initializing postgres data directory", { dataDir: LCM_POSTGRES_DATA })
    const proc = Bun.spawn({
      cmd: [
        initdb,
        "-D",
        LCM_POSTGRES_DATA,
        "--username",
        LCM_DATABASE_USER,
        "--auth-local",
        "trust",
        "--auth-host",
        "trust",
        "--encoding",
        "UTF8",
      ],
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      log.error("initdb failed", { exitCode, stdout, stderr })
      throw new Error(formatInitdbFailure(stderr || stdout))
    }

    await configureCluster()
  })
}

async function configureCluster() {
  await configurePostgresConf()
  await configurePgHba()
}

async function configurePostgresConf() {
  const confPath = path.join(LCM_POSTGRES_DATA, "postgresql.conf")
  const block = [
    "# voltcode begin",
    `listen_addresses = '${LCM_POSTGRES_HOST}'`,
    `port = ${LCM_POSTGRES_PORT}`,
    "# voltcode end",
    "",
  ].join("\n")

  const content = await fs.readFile(confPath, "utf8").catch(() => "")
  const updated = upsertBlock(content, block)
  if (updated !== content) {
    await fs.writeFile(confPath, updated)
  }
}

async function configurePgHba() {
  const confPath = path.join(LCM_POSTGRES_DATA, "pg_hba.conf")
  const block = [
    "# voltcode begin",
    "local all all trust",
    "host all all 127.0.0.1/32 trust",
    "host all all ::1/128 trust",
    "# voltcode end",
    "",
  ].join("\n")

  const content = await fs.readFile(confPath, "utf8").catch(() => "")
  const updated = upsertBlock(content, block, { prepend: true })
  if (updated !== content) {
    await fs.writeFile(confPath, updated)
  }
}

function upsertBlock(content: string, block: string, opts?: { prepend?: boolean }) {
  const start = "# voltcode begin"
  const end = "# voltcode end"
  if (content.includes(start) && content.includes(end)) {
    const regex = new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "m")
    return content.replace(regex, block)
  }
  if (opts?.prepend) {
    return `${block}${content}`
  }
  return `${content.trimEnd()}\n${block}`
}

async function reloadConfig() {
  const pgCtl = postgresBinary("pg_ctl")
  if (!(await exists(pgCtl))) return
  const env = postgresEnv()
  await Bun.spawn({
    cmd: [pgCtl, "-D", LCM_POSTGRES_DATA, "reload"],
    env,
    stdout: "ignore",
    stderr: "ignore",
  }).exited
}

async function startPostgres() {
  const pgCtl = postgresBinary("pg_ctl")
  const env = postgresEnv()
  log.info("starting embedded postgres", { dataDir: LCM_POSTGRES_DATA })
  const proc = Bun.spawn({
    cmd: [
      pgCtl,
      "-D",
      LCM_POSTGRES_DATA,
      "-l",
      LCM_POSTGRES_LOG,
      "-o",
      `-p ${LCM_POSTGRES_PORT} -h ${LCM_POSTGRES_HOST}`,
      "start",
      "-w",
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    log.error("pg_ctl start failed", { exitCode, stdout, stderr })
    throw new Error(`pg_ctl start failed: ${stderr || stdout}`)
  }
}

async function canConnect(url: string) {
  const sql = postgres(url, { max: 1, connect_timeout: 2, idle_timeout: 2 })
  try {
    await sql`select 1`
    return true
  } catch {
    return false
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {})
  }
}

async function waitForReady(url: string) {
  const attempts = 20
  for (let i = 0; i < attempts; i++) {
    if (await canConnect(url)) return true
    await sleep(500)
  }
  return false
}

function buildAdminUrl() {
  const url = new URL(LCM_DATABASE_URL)
  url.pathname = "/postgres"
  return url.toString()
}

async function downloadSpec(): Promise<{ url: string; archiveType: ArchiveType }> {
  if (process.platform === "darwin") {
    return {
      url: `https://get.enterprisedb.com/postgresql/postgresql-${LCM_POSTGRES_VERSION}-${LCM_POSTGRES_BUILD}-osx-binaries.zip`,
      archiveType: "zip",
    }
  }

  if (process.platform === "linux") {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
    const ssl = await detectOpenSslVariant()
    const major = LCM_POSTGRES_VERSION.split(".")[0]
    return {
      url: `https://downloads.percona.com/downloads/postgresql-distribution-${major}/${LCM_POSTGRES_VERSION}/binary/tarball/percona-postgresql-${LCM_POSTGRES_VERSION}-${ssl}-linux-${arch}.tar.gz`,
      archiveType: "targz",
    }
  }

  throw new Error(`Unsupported platform: ${process.platform}`)
}

async function detectOpenSslVariant(): Promise<"ssl1.1" | "ssl3" | "ssl3.5"> {
  try {
    const proc = Bun.spawn({
      cmd: ["openssl", "version"],
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    if (output.includes("OpenSSL 1.1")) return "ssl1.1"
    if (output.includes("OpenSSL 3.5")) return "ssl3.5"
    if (output.includes("OpenSSL 3.")) return "ssl3"
  } catch {}
  return "ssl3"
}

async function downloadAndExtractWithProgress(
  url: string,
  archiveType: ArchiveType,
  onProgress?: (percent: number) => void,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "voltcode-postgres-"))
  const archivePath = path.join(tmpDir, `postgres.${archiveType === "zip" ? "zip" : "tar.gz"}`)
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`)
    }

    const contentLength = response.headers.get("content-length")
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0

    if (response.body) {
      // Stream download to avoid Bun.file(...).write(Response) hangs on large archives.
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let receivedBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        receivedBytes += value.length
        if (totalBytes > 0 && onProgress) {
          const percent = Math.round((receivedBytes / totalBytes) * 100)
          onProgress(percent)
        }
      }

      const allChunks = new Uint8Array(receivedBytes)
      let position = 0
      for (const chunk of chunks) {
        allChunks.set(chunk, position)
        position += chunk.length
      }
      await Bun.file(archivePath).write(allChunks)
      if (onProgress) {
        onProgress(100)
      }
    } else {
      // Defensive fallback for environments without streaming response bodies.
      const bytes = new Uint8Array(await response.arrayBuffer())
      await Bun.file(archivePath).write(bytes)
      if (onProgress) {
        onProgress(100)
      }
    }

    if (archiveType === "zip") {
      await Archive.extractZip(archivePath, tmpDir)
    } else {
      await $`tar -xzf ${archivePath} -C ${tmpDir}`.quiet()
    }

    const root = await findPostgresRoot(tmpDir)
    if (!root) {
      throw new Error("failed to locate postgres binary in archive")
    }

    await fs.mkdir(LCM_POSTGRES_ROOT, { recursive: true })
    const entries = await fs.readdir(root)
    for (const entry of entries) {
      const src = path.join(root, entry)
      const dest = path.join(LCM_POSTGRES_ROOT, entry)
      await copyInstallEntry(src, dest)
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function downloadAndExtract(url: string, archiveType: ArchiveType) {
  await downloadAndExtractWithProgress(url, archiveType)
}

async function findPostgresRoot(base: string) {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: base, depth: 0 }]
  const maxDepth = 4
  const binaryName = process.platform === "win32" ? "postgres.exe" : "postgres"

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    if (next.depth > maxDepth) continue
    const candidate = path.join(next.dir, "bin", binaryName)
    if (await exists(candidate)) {
      return next.dir
    }
    const entries = await fs.readdir(next.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      queue.push({ dir: path.join(next.dir, entry.name), depth: next.depth + 1 })
    }
  }
  return null
}

async function copyInstallEntry(src: string, dest: string) {
  await fs.rm(dest, { recursive: true, force: true })
  await copyEntryRecursive(src, dest)
}

async function copyEntryRecursive(src: string, dest: string) {
  const stat = await fs.lstat(src)
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(src)
    for (const entry of entries) {
      await copyEntryRecursive(path.join(src, entry), path.join(dest, entry))
    }
    return
  }

  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(src)
    await fs.symlink(linkTarget, dest)
    return
  }

  await fs.copyFile(src, dest)
  await fs.chmod(dest, stat.mode)
}

async function validatePostgresInstall(): Promise<InstallValidation> {
  for (const binary of REQUIRED_BINARIES) {
    const binaryPath = postgresBinary(binary)
    if (!(await exists(binaryPath))) {
      return { valid: false, reason: `missing required binary '${binaryPath}'` }
    }
  }

  if (process.platform === "linux") {
    const libDir = path.join(LCM_POSTGRES_ROOT, "lib")
    const entries = await fs.readdir(libDir).catch(() => null)
    if (!entries) {
      return { valid: false, reason: `missing required library directory '${libDir}'` }
    }

    for (const exactName of REQUIRED_LINUX_LIB_EXACT) {
      if (!(await hasResolvableSharedLibrary(libDir, entries, exactName, { exact: true }))) {
        return { valid: false, reason: `missing required shared library '${exactName}' in '${libDir}'` }
      }
    }

    for (const prefix of REQUIRED_LINUX_LIB_PREFIXES) {
      if (!(await hasResolvableSharedLibrary(libDir, entries, prefix))) {
        return { valid: false, reason: `missing required shared library '${prefix}*' in '${libDir}'` }
      }
    }
  }

  const probe = await probeInitdbVersion()
  if (!probe.ok) {
    return { valid: false, reason: `initdb probe failed: ${probe.output}` }
  }

  return { valid: true }
}

async function hasResolvableSharedLibrary(
  libDir: string,
  entries: string[],
  name: string,
  opts?: { exact?: boolean },
) {
  const candidates = opts?.exact
    ? entries.filter((entry) => entry === name)
    : entries.filter((entry) => entry === name || entry.startsWith(`${name}.`))
  if (candidates.length === 0) return false

  for (const entry of candidates) {
    const candidatePath = path.join(libDir, entry)
    if (await isResolvablePath(candidatePath)) {
      return true
    }
  }
  return false
}

async function isResolvablePath(filepath: string) {
  try {
    const stats = await fs.lstat(filepath)
    if (stats.isSymbolicLink()) {
      const resolvedPath = await fs.realpath(filepath)
      await fs.access(resolvedPath)
    }
    return true
  } catch {
    return false
  }
}

async function probeInitdbVersion(): Promise<{ ok: true; output: string } | { ok: false; output: string }> {
  const initdb = postgresBinary("initdb")
  const proc = Bun.spawn({
    cmd: [initdb, "--version"],
    env: postgresEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode === 0) {
    return { ok: true, output: stdout.trim() }
  }
  return { ok: false, output: (stderr || stdout || `exit code ${exitCode}`).trim() }
}

async function removeInvalidInstallArtifacts() {
  const entries = await fs.readdir(LCM_POSTGRES_ROOT).catch(() => [])
  const preserve = new Set(["data", path.basename(LCM_POSTGRES_LOCK)])
  for (const entry of entries) {
    if (preserve.has(entry)) continue
    await fs.rm(path.join(LCM_POSTGRES_ROOT, entry), { recursive: true, force: true })
  }
}

function formatInitdbFailure(output: string) {
  const detail = output.trim()
  if (!isSharedLibraryLoadError(detail)) {
    return `initdb failed: ${detail}`
  }

  return [
    "initdb failed because embedded Postgres libraries could not be loaded.",
    `details: ${detail}`,
    `delete '${LCM_POSTGRES_ROOT}' to force a clean download, or set LCM_DATABASE_URL to use an external Postgres database.`,
  ].join(" ")
}

function isSharedLibraryLoadError(output: string) {
  const normalized = output.toLowerCase()
  return SHARED_LIBRARY_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))
}

async function withInstallLock<T>(fn: () => Promise<T>) {
  const start = Date.now()
  while (true) {
    const handle = await tryAcquireLock()
    if (handle) {
      try {
        return await fn()
      } finally {
        await handle.close().catch(() => {})
        await fs.rm(LCM_POSTGRES_LOCK, { force: true }).catch(() => {})
      }
    }

    if (Date.now() - start > 5 * 60 * 1000) {
      throw new Error("timed out waiting for postgres install lock")
    }
    await sleep(250)
  }
}

async function tryAcquireLock() {
  await fs.mkdir(path.dirname(LCM_POSTGRES_LOCK), { recursive: true })
  try {
    const handle = await fs.open(LCM_POSTGRES_LOCK, "wx")
    await handle.writeFile(String(process.pid))
    return handle
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e
    const pidText = await fs.readFile(LCM_POSTGRES_LOCK, "utf8").catch(() => "")
    const pid = Number(pidText.trim())
    if (pid && !isProcessRunning(pid)) {
      await fs.rm(LCM_POSTGRES_LOCK, { force: true }).catch(() => {})
      return null
    }
  }
  return null
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exists(filepath: string) {
  try {
    await fs.access(filepath)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
