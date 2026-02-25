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

export type LcmMode = "dolt" | "upward"

export interface LcmCondensationLanePolicy {
  soft: number
  delta: number
  target: number
  minFanout: number
}

export interface LcmLeavesLanePolicy extends LcmCondensationLanePolicy {
  cap: number
  freshTailFloor: number
}

export interface LcmModePolicy {
  leaves: LcmLeavesLanePolicy
  sprigs: LcmCondensationLanePolicy
  bindles: LcmCondensationLanePolicy
  hardLimitRiskBuffer: number
  ghostCueArchiveEnabled: boolean
}

export interface LcmRuntimePolicy {
  defaultCtxCutoffThreshold: number
  targetFreePercentage: number
  minMessagesToSummarize: number
  minProtectedTailLeaves: number
  criticalThresholdMultiplier: number
  maxCompactionRounds: number
  summaryMaxOutputTokens: number
  condenseMaxOutputTokens: number
}

export interface LcmUpwardPolicy {
  leafChunkTokens: number
  leafMinFanout: number
  condensedMinFanout: number
  condensedMinFanoutHard: number
  condensedTargetTokens: number
}

export interface LcmPolicyConfig {
  mode: LcmMode
  runtime: LcmRuntimePolicy
  strategies: Record<LcmMode, LcmModePolicy>
  upward: LcmUpwardPolicy
}

const DEFAULT_LCM_MODE: LcmMode = "dolt"
const DEFAULT_CTX_CUTOFF_THRESHOLD = 0.6
const DEFAULT_TARGET_FREE_PERCENTAGE = 0.25
const DEFAULT_MIN_MESSAGES_TO_SUMMARIZE = 3
const DEFAULT_MIN_LEAVES_PER_SPRIG = 2
const DEFAULT_MIN_PROTECTED_TAIL_LEAVES = 2
const DEFAULT_CRITICAL_THRESHOLD_MULTIPLIER = 1.2
const DEFAULT_MAX_COMPACTION_ROUNDS = 10
const DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS = 2200
const DEFAULT_CONDENSE_MAX_OUTPUT_TOKENS = 2200

const DEFAULT_DOLT_BINDLES_SOFT = 10_000
const DEFAULT_DOLT_BINDLES_DELTA = 2_000
const DEFAULT_DOLT_BINDLES_TARGET = 10_000
const DEFAULT_DOLT_SPRIGS_SOFT = 10_000
const DEFAULT_DOLT_SPRIGS_DELTA = 2_000
const DEFAULT_DOLT_SPRIGS_TARGET = 10_000
const DEFAULT_DOLT_LEAVES_CAP = 50_000
const DEFAULT_DOLT_LEAVES_SOFT = 50_000
const DEFAULT_DOLT_LEAVES_DELTA = 5_000
const DEFAULT_DOLT_LEAVES_TARGET = 50_000
const DEFAULT_DOLT_LEAVES_FRESH_TAIL_FLOOR = 4
const DEFAULT_DOLT_HARD_LIMIT_RISK_BUFFER = 0
const DEFAULT_DOLT_GHOST_CUE_ARCHIVE_ENABLED = true
const DEFAULT_UPWARD_GHOST_CUE_ARCHIVE_ENABLED = false
const DEFAULT_UPWARD_LEAF_CHUNK_TOKENS = 20_000
const DEFAULT_UPWARD_LEAF_MIN_FANOUT = 8
const DEFAULT_UPWARD_CONDENSED_MIN_FANOUT = 4
const DEFAULT_UPWARD_CONDENSED_MIN_FANOUT_HARD = 2
const DEFAULT_UPWARD_CONDENSED_TARGET_TOKENS = 2_000
const UPWARD_CONDENSED_MIN_INPUT_RATIO = 0.1

/**
 * Parse LCM policy settings from env vars.
 * This is intentionally strict and throws on invalid policy inputs.
 */
export function parseLcmPolicyConfig(env: Record<string, string | undefined>): LcmPolicyConfig {
  const mode = parseMode(env, "VOLTCODE_LCM_MODE", DEFAULT_LCM_MODE)
  const runtime: LcmRuntimePolicy = {
    defaultCtxCutoffThreshold: readEnvUnitFloat(
      env,
      "VOLTCODE_LCM_DEFAULT_CTX_CUTOFF_THRESHOLD",
      DEFAULT_CTX_CUTOFF_THRESHOLD,
    ),
    targetFreePercentage: readEnvUnitFloat(
      env,
      "VOLTCODE_LCM_TARGET_FREE_PERCENTAGE",
      DEFAULT_TARGET_FREE_PERCENTAGE,
    ),
    minMessagesToSummarize: readEnvIntegerAtLeast(
      env,
      "VOLTCODE_LCM_MIN_MESSAGES_TO_SUMMARIZE",
      DEFAULT_MIN_MESSAGES_TO_SUMMARIZE,
      1,
    ),
    minProtectedTailLeaves: readEnvIntegerAtLeast(
      env,
      "VOLTCODE_LCM_MIN_PROTECTED_TAIL_LEAVES",
      DEFAULT_MIN_PROTECTED_TAIL_LEAVES,
      1,
    ),
    criticalThresholdMultiplier: readEnvPositiveFloat(
      env,
      "VOLTCODE_LCM_CRITICAL_THRESHOLD_MULTIPLIER",
      DEFAULT_CRITICAL_THRESHOLD_MULTIPLIER,
    ),
    maxCompactionRounds: readEnvIntegerAtLeast(
      env,
      "VOLTCODE_LCM_MAX_COMPACTION_ROUNDS",
      DEFAULT_MAX_COMPACTION_ROUNDS,
      1,
    ),
    summaryMaxOutputTokens: readEnvIntegerAtLeast(
      env,
      "VOLTCODE_LCM_SUMMARY_MAX_OUTPUT_TOKENS",
      DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
      1,
    ),
    condenseMaxOutputTokens: readEnvIntegerAtLeast(
      env,
      "VOLTCODE_LCM_CONDENSE_MAX_OUTPUT_TOKENS",
      DEFAULT_CONDENSE_MAX_OUTPUT_TOKENS,
      1,
    ),
  }

  const upward: LcmUpwardPolicy = {
    leafChunkTokens: readEnvPositiveInteger(
      env,
      "VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS",
      DEFAULT_UPWARD_LEAF_CHUNK_TOKENS,
    ),
    leafMinFanout: readEnvPositiveInteger(
      env,
      "VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT",
      DEFAULT_UPWARD_LEAF_MIN_FANOUT,
    ),
    condensedMinFanout: readEnvPositiveInteger(
      env,
      "VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT",
      DEFAULT_UPWARD_CONDENSED_MIN_FANOUT,
    ),
    condensedMinFanoutHard: readEnvPositiveInteger(
      env,
      "VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT_HARD",
      DEFAULT_UPWARD_CONDENSED_MIN_FANOUT_HARD,
    ),
    condensedTargetTokens: readEnvPositiveInteger(
      env,
      "VOLTCODE_LCM_UPWARD_CONDENSED_TARGET_TOKENS",
      DEFAULT_UPWARD_CONDENSED_TARGET_TOKENS,
    ),
  }

  const doltDefaults: LcmModePolicy = {
    leaves: {
      soft: DEFAULT_DOLT_LEAVES_SOFT,
      delta: DEFAULT_DOLT_LEAVES_DELTA,
      target: DEFAULT_DOLT_LEAVES_TARGET,
      minFanout: DEFAULT_MIN_LEAVES_PER_SPRIG,
      cap: DEFAULT_DOLT_LEAVES_CAP,
      freshTailFloor: DEFAULT_DOLT_LEAVES_FRESH_TAIL_FLOOR,
    },
    sprigs: {
      soft: DEFAULT_DOLT_SPRIGS_SOFT,
      delta: DEFAULT_DOLT_SPRIGS_DELTA,
      target: DEFAULT_DOLT_SPRIGS_TARGET,
      minFanout: 2,
    },
    bindles: {
      soft: DEFAULT_DOLT_BINDLES_SOFT,
      delta: DEFAULT_DOLT_BINDLES_DELTA,
      target: DEFAULT_DOLT_BINDLES_TARGET,
      minFanout: 2,
    },
    hardLimitRiskBuffer: DEFAULT_DOLT_HARD_LIMIT_RISK_BUFFER,
    ghostCueArchiveEnabled: DEFAULT_DOLT_GHOST_CUE_ARCHIVE_ENABLED,
  }

  const dolt = parseModePolicy(env, "DOLT", doltDefaults)
  const upwardModePolicy = parseModePolicy(env, "UPWARD", {
    ...dolt,
    ghostCueArchiveEnabled: DEFAULT_UPWARD_GHOST_CUE_ARCHIVE_ENABLED,
  })

  return {
    mode,
    runtime,
    strategies: {
      dolt,
      upward: upwardModePolicy,
    },
    upward,
  }
}

let lcmPolicyConfigOverride: LcmPolicyConfig | null = null
const lcmPolicyConfigStartup = parseLcmPolicyConfig(process.env)

/**
 * Return the typed LCM policy configuration.
 */
export function getLcmPolicyConfig(): LcmPolicyConfig {
  return lcmPolicyConfigOverride ?? lcmPolicyConfigStartup
}

/**
 * Test-only helper for overriding startup-parsed policy.
 */
export function setLcmPolicyConfigForTesting(policy: LcmPolicyConfig | null): void {
  lcmPolicyConfigOverride = policy
}

/**
 * Resolve the minimum summary-token floor for upward condensed passes.
 *
 * lossless-claw parity:
 * minChunkTokens = max(condensedTargetTokens, floor(leafChunkTokens * 0.1))
 */
export function resolveUpwardCondensedMinChunkTokens(upward: LcmUpwardPolicy): number {
  const ratioFloor = Math.floor(upward.leafChunkTokens * UPWARD_CONDENSED_MIN_INPUT_RATIO)
  return Math.max(upward.condensedTargetTokens, ratioFloor)
}

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

function parseModePolicy(
  env: Record<string, string | undefined>,
  modePrefix: "DOLT" | "UPWARD",
  defaults: LcmModePolicy,
): LcmModePolicy {
  const ghostCueArchiveEnabled =
    modePrefix === "UPWARD"
      ? DEFAULT_UPWARD_GHOST_CUE_ARCHIVE_ENABLED
      : readEnvBoolean(
          env,
          `VOLTCODE_LCM_${modePrefix}_GHOST_CUE_ARCHIVE_ENABLED`,
          defaults.ghostCueArchiveEnabled,
        )

  return {
    leaves: {
      soft: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_LEAVES_SOFT`, defaults.leaves.soft),
      delta: readEnvPositiveInteger(env, `VOLTCODE_LCM_${modePrefix}_LEAVES_DELTA`, defaults.leaves.delta),
      target: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_LEAVES_TARGET`, defaults.leaves.target),
      minFanout: readFanout(env, `VOLTCODE_LCM_${modePrefix}_LEAVES_MIN_FANOUT`, defaults.leaves.minFanout),
      cap: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_LEAVES_CAP`, defaults.leaves.cap),
      freshTailFloor: readEnvIntegerAtLeast(
        env,
        `VOLTCODE_LCM_${modePrefix}_LEAVES_FRESH_TAIL_FLOOR`,
        defaults.leaves.freshTailFloor,
        1,
      ),
    },
    sprigs: {
      soft: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_SPRIGS_SOFT`, defaults.sprigs.soft),
      delta: readEnvPositiveInteger(env, `VOLTCODE_LCM_${modePrefix}_SPRIGS_DELTA`, defaults.sprigs.delta),
      target: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_SPRIGS_TARGET`, defaults.sprigs.target),
      minFanout: readFanout(env, `VOLTCODE_LCM_${modePrefix}_SPRIGS_MIN_FANOUT`, defaults.sprigs.minFanout),
    },
    bindles: {
      soft: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_BINDLES_SOFT`, defaults.bindles.soft),
      delta: readEnvPositiveInteger(env, `VOLTCODE_LCM_${modePrefix}_BINDLES_DELTA`, defaults.bindles.delta),
      target: readEnvNonNegativeInteger(env, `VOLTCODE_LCM_${modePrefix}_BINDLES_TARGET`, defaults.bindles.target),
      minFanout: readFanout(env, `VOLTCODE_LCM_${modePrefix}_BINDLES_MIN_FANOUT`, defaults.bindles.minFanout),
    },
    hardLimitRiskBuffer: readEnvNonNegativeInteger(
      env,
      `VOLTCODE_LCM_${modePrefix}_HARD_LIMIT_RISK_BUFFER`,
      defaults.hardLimitRiskBuffer,
    ),
    ghostCueArchiveEnabled,
  }
}

function parseMode(env: Record<string, string | undefined>, key: string, fallback: LcmMode): LcmMode {
  const raw = env[key]
  if (!raw) return fallback
  if (raw === "dolt" || raw === "upward") return raw
  throw new Error(`${key} must be one of: dolt, upward (received: ${raw})`)
}

function readFanout(env: Record<string, string | undefined>, key: string, fallback: number): number {
  return readEnvIntegerAtLeast(env, key, fallback, 2)
}

function readEnvUnitFloat(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${key} must be a finite number in [0, 1] (received: ${raw})`)
  }
  return parsed
}

function readEnvPositiveFloat(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a finite number > 0 (received: ${raw})`)
  }
  return parsed
}

function readEnvPositiveInteger(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be an integer > 0 (received: ${raw})`)
  }
  return parsed
}

function readEnvIntegerAtLeast(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${key} must be an integer >= ${minimum} (received: ${raw})`)
  }
  return parsed
}

function readEnvNonNegativeInteger(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer (received: ${raw})`)
  }
  return parsed
}

function readEnvBoolean(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (!raw) return fallback
  if (raw === "true") return true
  if (raw === "false") return false
  throw new Error(`${key} must be one of: true, false (received: ${raw})`)
}
