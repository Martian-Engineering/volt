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
