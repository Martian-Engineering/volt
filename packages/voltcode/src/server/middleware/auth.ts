import type { Context, Next } from "hono"
import { Log } from "@/util/log"
import { setCurrentUser } from "@/session/lcm/user-context"
import { LCM_EXTERNAL_DATABASE } from "@/session/lcm/config"

const log = Log.create({ service: "auth.middleware" })

/**
 * Configuration for Cognito JWT authentication.
 */
export interface CognitoConfig {
  userPoolId: string
  clientId: string
  region: string
}

// Cache for JWKS keys
let jwksCache: { keys: JWK[] } | null = null
let jwksCacheTime = 0
const JWKS_CACHE_TTL = 3600000 // 1 hour

interface JWK {
  kid: string
  kty: string
  alg: string
  use: string
  n: string
  e: string
}

/**
 * Fetch JWKS from Cognito.
 */
async function getJwks(config: CognitoConfig): Promise<{ keys: JWK[] }> {
  const now = Date.now()
  if (jwksCache && now - jwksCacheTime < JWKS_CACHE_TTL) {
    return jwksCache
  }

  const jwksUrl = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}/.well-known/jwks.json`
  const response = await fetch(jwksUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status}`)
  }

  jwksCache = await response.json()
  jwksCacheTime = now
  return jwksCache!
}

/**
 * Decode a JWT token without verification (for extracting header/payload).
 */
function decodeJwt(token: string): { header: any; payload: any } {
  const parts = token.split(".")
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format")
  }

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())

  return { header, payload }
}

/**
 * Extract user ID from Authorization header (Cognito JWT).
 *
 * For the MVP, we do basic JWT decoding without full cryptographic verification.
 * The ALB has already validated the token if it's coming through CloudFront.
 *
 * TODO: Add full JWT verification with JWKS for direct API access.
 */
export function extractUserFromJwt(authHeader: string | undefined): string | null {
  if (!authHeader) return null

  // Extract bearer token
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return null

  const token = match[1]

  try {
    const { payload } = decodeJwt(token)

    // Cognito puts the user's sub (unique ID) in the 'sub' claim
    // and username in 'cognito:username' or 'username'
    const userId = payload.sub || payload["cognito:username"] || payload.username

    if (!userId) {
      log.warn("JWT missing user identifier", { claims: Object.keys(payload) })
      return null
    }

    return userId
  } catch (err) {
    log.warn("failed to decode JWT", { error: err })
    return null
  }
}

/**
 * Middleware to extract user identity and set LCM user context.
 *
 * This middleware:
 * 1. Extracts the user ID from the Authorization header (Cognito JWT)
 * 2. Sets the user context for LCM database operations
 *
 * In single-tenant mode (local development), this is a no-op.
 */
export function userContextMiddleware() {
  return async (c: Context, next: Next) => {
    // Skip user context in single-tenant mode
    if (!LCM_EXTERNAL_DATABASE) {
      return next()
    }

    const authHeader = c.req.header("Authorization")
    const userId = extractUserFromJwt(authHeader)

    if (userId) {
      log.debug("extracted user from JWT", { userId })
      setCurrentUser(userId)
    } else {
      // Allow unauthenticated requests for health checks, etc.
      // Session routes should require authentication
      setCurrentUser(null)
    }

    try {
      await next()
    } finally {
      // Clear user context after request
      setCurrentUser(null)
    }
  }
}

/**
 * Middleware to require authentication.
 * Returns 401 if no valid user context is set.
 */
export function requireAuth() {
  return async (c: Context, next: Next) => {
    // Skip auth requirement in single-tenant mode
    if (!LCM_EXTERNAL_DATABASE) {
      return next()
    }

    const authHeader = c.req.header("Authorization")
    const userId = extractUserFromJwt(authHeader)

    if (!userId) {
      return c.json({ error: "Unauthorized", message: "Valid authentication token required" }, 401)
    }

    return next()
  }
}
