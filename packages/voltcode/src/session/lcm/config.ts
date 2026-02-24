import path from "path"
import { Global } from "@/global"

export const LCM_POSTGRES_VERSION = "17.7"
export const LCM_POSTGRES_BUILD = "1"
export const LCM_POSTGRES_HOST = "127.0.0.1"
export const LCM_POSTGRES_PORT = 54329
export const LCM_DATABASE_NAME = "voltcode_lcm"
export const LCM_DATABASE_USER = "voltcode"

// Allow external database URL via environment variable for cloud deployments
// Format: postgres://user:password@host:port/database
// When set, embedded Postgres is not used
//
// Can also be constructed from RDS_* environment variables (AWS deployment):
// - RDS_ENDPOINT: Aurora cluster endpoint
// - RDS_PORT: Database port (default 5432)
// - RDS_USERNAME: Database username
// - RDS_PASSWORD: Database password
// - RDS_DATABASE: Database name (default voltcode_lcm)
function buildDatabaseUrl(): string {
  // Explicit URL takes precedence
  if (process.env.LCM_DATABASE_URL) {
    return process.env.LCM_DATABASE_URL
  }

  // Build from RDS environment variables (AWS deployment)
  const rdsEndpoint = process.env.RDS_ENDPOINT
  const rdsUsername = process.env.RDS_USERNAME
  const rdsPassword = process.env.RDS_PASSWORD

  if (rdsEndpoint && rdsUsername && rdsPassword) {
    const port = process.env.RDS_PORT ?? "5432"
    const database = process.env.RDS_DATABASE ?? "voltcode_lcm"
    // URL-encode password in case it contains special characters
    const encodedPassword = encodeURIComponent(rdsPassword)
    return `postgres://${rdsUsername}:${encodedPassword}@${rdsEndpoint}:${port}/${database}`
  }

  // Default: embedded postgres
  return `postgres://${LCM_DATABASE_USER}@${LCM_POSTGRES_HOST}:${LCM_POSTGRES_PORT}/${LCM_DATABASE_NAME}`
}

const DEFAULT_DATABASE_URL = `postgres://${LCM_DATABASE_USER}@${LCM_POSTGRES_HOST}:${LCM_POSTGRES_PORT}/${LCM_DATABASE_NAME}`
export const LCM_DATABASE_URL = buildDatabaseUrl()

// Whether we're using an external database (cloud deployment)
export const LCM_EXTERNAL_DATABASE = !!(process.env.LCM_DATABASE_URL || process.env.RDS_ENDPOINT)

export const LCM_POSTGRES_ROOT = path.join(Global.Path.data, "postgres", LCM_POSTGRES_VERSION)
export const LCM_POSTGRES_BIN = path.join(LCM_POSTGRES_ROOT, "bin")
export const LCM_POSTGRES_DATA = path.join(LCM_POSTGRES_ROOT, "data")
export const LCM_POSTGRES_LOG = path.join(Global.Path.log, "postgres.log")
export const LCM_POSTGRES_LOCK = path.join(LCM_POSTGRES_ROOT, "install.lock")

const DEFAULT_RETRIEVAL_TOP_K = 3
const DEFAULT_RETRIEVAL_MIN_SCORE = 0.3
const DEFAULT_RETRIEVAL_QMD_INDEX_PREFIX = "voltcode-lcm-retrieval"
const DEFAULT_RETRIEVAL_COLLECTION_NAME = "off-context-bindles"
const DEFAULT_PRE_RESPONSE_HOOK_TOP_K = 3

/**
 * qmd index namespace for Dolt retrieval artifacts.
 * Runtime uses a per-conversation suffix to keep recall spaces isolated.
 */
export const LCM_RETRIEVAL_QMD_INDEX_PREFIX =
  process.env.VOLTCODE_LCM_RETRIEVAL_QMD_INDEX_PREFIX ?? DEFAULT_RETRIEVAL_QMD_INDEX_PREFIX

/**
 * qmd collection name used for bindle/off-context recall artifacts.
 */
export const LCM_RETRIEVAL_QMD_COLLECTION_NAME =
  process.env.VOLTCODE_LCM_RETRIEVAL_QMD_COLLECTION_NAME ?? DEFAULT_RETRIEVAL_COLLECTION_NAME

/**
 * Default top-K for off-context bindle recall.
 */
export const LCM_RETRIEVAL_TOP_K = readPositiveInt("VOLTCODE_LCM_RETRIEVAL_TOP_K", DEFAULT_RETRIEVAL_TOP_K)

/**
 * Minimum score threshold for retrieval results.
 * Values outside [0, 1] fall back to default.
 */
export const LCM_RETRIEVAL_MIN_SCORE = readUnitFloat("VOLTCODE_LCM_RETRIEVAL_MIN_SCORE", DEFAULT_RETRIEVAL_MIN_SCORE)

/**
 * Optional max distance threshold (derived from qmd score).
 * Unset or invalid values disable distance filtering.
 */
export const LCM_RETRIEVAL_MAX_DISTANCE = readNonNegativeFloatOrUndefined("VOLTCODE_LCM_RETRIEVAL_MAX_DISTANCE")

/**
 * Filesystem root for generated qmd recall artifacts.
 */
export const LCM_RETRIEVAL_ROOT = path.join(Global.Path.data, "lcm", "retrieval")
export const LCM_CONTEXT_SNAPSHOT_PATH = path.join(Global.Path.data, "lcm", "context.json")

/**
 * Top-K injected pre-response memory cues from off-context retrieval.
 */
export const LCM_PRE_RESPONSE_HOOK_TOP_K = readPositiveInt(
  "VOLTCODE_LCM_PRE_RESPONSE_HOOK_TOP_K",
  DEFAULT_PRE_RESPONSE_HOOK_TOP_K,
)

/**
 * Minimum retrieval score threshold for injected pre-response memory cues.
 */
export const LCM_PRE_RESPONSE_HOOK_MIN_SCORE = readUnitFloat(
  "VOLTCODE_LCM_PRE_RESPONSE_HOOK_MIN_SCORE",
  LCM_RETRIEVAL_MIN_SCORE,
)

/**
 * Optional distance threshold for injected pre-response memory cues.
 */
export const LCM_PRE_RESPONSE_HOOK_MAX_DISTANCE = readNonNegativeFloatOrUndefined(
  "VOLTCODE_LCM_PRE_RESPONSE_HOOK_MAX_DISTANCE",
)

function readPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

function readUnitFloat(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback
  return parsed
}

function readNonNegativeFloatOrUndefined(key: string): number | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}
