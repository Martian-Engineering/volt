import { describe, expect, test, beforeEach } from "bun:test"

/**
 * Tests for secrets fetching from AWS Secrets Manager.
 *
 * AWS SDK is mocked in test/preload.ts and uses globalThis.__awsMockState
 */

// Access the global mock state set up in preload.ts
function getAwsMockState() {
  return (globalThis as any).__awsMockState as {
    secretsCache: Map<string, string>
  }
}

function resetMockState() {
  const state = getAwsMockState()
  state.secretsCache.clear()
}

function setMockSecrets(secrets: Record<string, string>) {
  const state = getAwsMockState()
  state.secretsCache.clear()
  for (const [key, value] of Object.entries(secrets)) {
    state.secretsCache.set(key, value)
  }
}

// Import after preload sets up mocks
import { fetchSecrets, resetSecretsCache } from "../../src/worker/secrets"

describe("worker/secrets", () => {
  beforeEach(() => {
    resetMockState()
    resetSecretsCache() // Reset module-level cache
  })

  describe("fetchSecrets", () => {
    test("successfully fetches all secrets", async () => {
      // Set up mock responses
      setMockSecrets({
        "voltcode/db-url": "postgresql://localhost:5432/voltcode",
        "voltcode/openai-key": "sk-openai-test-key",
        "voltcode/anthropic-key": "sk-ant-test-key",
        "voltcode/moonshot-key": "sk-moonshot-test-key",
        "voltcode/glm-key": "glm-test-key",
      })

      const secrets = await fetchSecrets()

      expect(secrets.dbUrl).toBe("postgresql://localhost:5432/voltcode")
      expect(secrets.openaiKey).toBe("sk-openai-test-key")
      expect(secrets.anthropicKey).toBe("sk-ant-test-key")
      expect(secrets.moonshotKey).toBe("sk-moonshot-test-key")
      expect(secrets.glmKey).toBe("glm-test-key")
    })

    test("fetches all five expected secrets", async () => {
      setMockSecrets({
        "voltcode/db-url": "db-url-value",
        "voltcode/openai-key": "openai-key-value",
        "voltcode/anthropic-key": "anthropic-key-value",
        "voltcode/moonshot-key": "moonshot-key-value",
        "voltcode/glm-key": "glm-key-value",
      })

      const secrets = await fetchSecrets()

      // Verify all five secrets were returned
      expect(Object.keys(secrets).length).toBe(5)
      expect(secrets.dbUrl).toBeDefined()
      expect(secrets.openaiKey).toBeDefined()
      expect(secrets.anthropicKey).toBeDefined()
      expect(secrets.moonshotKey).toBeDefined()
      expect(secrets.glmKey).toBeDefined()
    })

    test("caches secrets after first fetch", async () => {
      setMockSecrets({
        "voltcode/db-url": "cached-db-url",
        "voltcode/openai-key": "cached-openai-key",
        "voltcode/anthropic-key": "cached-anthropic-key",
        "voltcode/moonshot-key": "cached-moonshot-key",
        "voltcode/glm-key": "cached-glm-key",
      })

      // First fetch
      const firstResult = await fetchSecrets()
      expect(firstResult.dbUrl).toBe("cached-db-url")

      // Clear the mock to verify caching works
      resetMockState()

      // Second fetch should return cached value (not hit the mock)
      const secondResult = await fetchSecrets()
      expect(secondResult.dbUrl).toBe("cached-db-url")
      expect(secondResult).toBe(firstResult) // Same object reference
    })

    test("throws when db-url secret is missing", async () => {
      setMockSecrets({
        // Missing db-url
        "voltcode/openai-key": "openai-key-value",
        "voltcode/anthropic-key": "anthropic-key-value",
        "voltcode/moonshot-key": "moonshot-key-value",
        "voltcode/glm-key": "glm-key-value",
      })

      await expect(fetchSecrets()).rejects.toThrow("Failed to fetch secrets")
    })

    test("throws when API keys are missing", async () => {
      setMockSecrets({
        "voltcode/db-url": "db-url-value",
        // Missing all API keys
      })

      await expect(fetchSecrets()).rejects.toThrow("Failed to fetch secrets")
    })
  })

  describe("secret names", () => {
    test("uses correct secret names", async () => {
      // Set all expected secret names
      setMockSecrets({
        "voltcode/db-url": "db",
        "voltcode/openai-key": "openai",
        "voltcode/anthropic-key": "anthropic",
        "voltcode/moonshot-key": "moonshot",
        "voltcode/glm-key": "glm",
      })

      const secrets = await fetchSecrets()

      // Verify we got values back (which means the secret names were correct)
      expect(secrets.dbUrl).toBe("db")
      expect(secrets.openaiKey).toBe("openai")
      expect(secrets.anthropicKey).toBe("anthropic")
      expect(secrets.moonshotKey).toBe("moonshot")
      expect(secrets.glmKey).toBe("glm")
    })
  })

  describe("error handling", () => {
    test("throws aggregated error when multiple secrets fail", async () => {
      // Only set some secrets, leaving others to fail
      setMockSecrets({
        "voltcode/db-url": "db-url-value",
        // Missing other secrets
      })

      await expect(fetchSecrets()).rejects.toThrow("Failed to fetch secrets")
    })

    test("throws when all secrets are missing", async () => {
      // Empty mock - all secrets will fail
      resetMockState()

      await expect(fetchSecrets()).rejects.toThrow("Failed to fetch secrets")
    })
  })

  describe("return value structure", () => {
    test("returns WorkerSecrets interface", async () => {
      setMockSecrets({
        "voltcode/db-url": "test-db-url",
        "voltcode/openai-key": "test-openai-key",
        "voltcode/anthropic-key": "test-anthropic-key",
        "voltcode/moonshot-key": "test-moonshot-key",
        "voltcode/glm-key": "test-glm-key",
      })

      const secrets = await fetchSecrets()

      // TypeScript ensures these properties exist, runtime test verifies values
      expect(typeof secrets.dbUrl).toBe("string")
      expect(typeof secrets.openaiKey).toBe("string")
      expect(typeof secrets.anthropicKey).toBe("string")
      expect(typeof secrets.moonshotKey).toBe("string")
      expect(typeof secrets.glmKey).toBe("string")
    })
  })
})
