import { describe, expect, test, mock, beforeEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

/**
 * Integration tests for the worker end-to-end flow.
 *
 * Tests the full job processing pipeline:
 * 1. Receive job from SQS queue
 * 2. Execute (mock) VoltCode
 * 3. Upload artifacts to S3
 * 4. Write metadata to DB
 * 5. Delete message from queue
 *
 * Also tests failure handling, retry logic, and DLQ routing.
 *
 * Note: AWS SDK mocks are set up in test/preload.ts and use globalThis.__awsMockState
 */

// Access the global mock state set up in preload.ts
function getAwsMockState() {
  return (globalThis as any).__awsMockState as {
    sqsMessages: Map<string, { body: string; receiptHandle: string }>
    s3Objects: Map<string, Uint8Array>
    secretsCache: Map<string, string>
    deletedMessages: string[]
    visibilityExtensions: Array<{ receiptHandle: string; timeout: number }>
    dlqMessages: Array<{ body: string; timestamp: string }>
  }
}

function resetAwsMockState() {
  const state = getAwsMockState()
  state.sqsMessages.clear()
  state.s3Objects.clear()
  state.deletedMessages.length = 0
  state.visibilityExtensions.length = 0
  state.dlqMessages.length = 0
  // Reset secrets to defaults
  state.secretsCache.clear()
  state.secretsCache.set("voltcode/db-url", "postgres://localhost:5432/test")
  state.secretsCache.set("voltcode/openai-key", "sk-test-openai-key")
  state.secretsCache.set("voltcode/anthropic-key", "sk-test-anthropic-key")
  state.secretsCache.set("voltcode/moonshot-key", "sk-test-moonshot-key")
  state.secretsCache.set("voltcode/glm-key", "sk-test-glm-key")
}

// --- Mock postgres (pg) ---

const mockDbQuery = mock(async (_query: string, _values?: unknown[]) => {
  return { rows: [], rowCount: 1 }
})

mock.module("postgres", () => {
  return (_connectionString: string) => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("$")
      return mockDbQuery(query, values)
    }
    sql.end = mock(() => Promise.resolve())
    return sql
  }
})

mock.module("pg", () => ({
  Client: class MockClient {
    connectionString: string
    constructor(opts: { connectionString: string }) {
      this.connectionString = opts.connectionString
    }
    connect = mock(() => Promise.resolve())
    query = mockDbQuery
    end = mock(() => Promise.resolve())
  },
}))

// --- Import modules after mocking ---

const { pollQueue } = await import("../../src/worker/sqs-poller")
const { uploadArtifacts } = await import("../../src/worker/s3-upload")
const { parseResult, extractTokens } = await import("../../src/worker/results")
const { fetchSecrets, resetSecretsCache } = await import("../../src/worker/secrets")
const { requeueWithBackoff, shouldRetry, getDLQUrl, sendToDLQ } = await import("../../src/worker/retry")
const { deleteMessage, createVisibilityExtender } = await import("../../src/worker/visibility")
const { createDbClient, writeRunMetadata } = await import("../../src/worker/db")

// --- Test Helpers ---

function createTestJob(
  overrides: Partial<{
    run_id: string
    context_length: number
    context_window_id: number
    backend: string
    seed: number
    timeout_minutes: number
    retry_count: number
    output_prefix: string
  }> = {},
) {
  return {
    run_id: `run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    context_length: 4096,
    context_window_id: 123,
    backend: "openai:gpt-4",
    seed: 42,
    timeout_minutes: 30,
    retry_count: 0,
    output_prefix: "runs/test-run",
    ...overrides,
  }
}

async function createTestOutputDir(
  runId: string,
  result: { success: boolean; score?: number; error?: string } | null = null,
) {
  const outputDir = path.join(os.tmpdir(), `voltcode-test-${runId}`)
  await fs.mkdir(outputDir, { recursive: true })

  // Create result.json
  if (result) {
    await fs.writeFile(path.join(outputDir, "result.json"), JSON.stringify(result))
  }

  // Create trace.jsonl with token usage
  const trace = [
    { usage: { input_tokens: 100, output_tokens: 50 } },
    { usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 50 } },
  ]
  await fs.writeFile(path.join(outputDir, "trace.jsonl"), trace.map((t) => JSON.stringify(t)).join("\n"))

  // Create log files
  await fs.writeFile(path.join(outputDir, "stdout.log"), "Test stdout output")
  await fs.writeFile(path.join(outputDir, "stderr.log"), "Test stderr output")
  await fs.writeFile(path.join(outputDir, "meta.json"), JSON.stringify({ version: "1.0.0" }))

  return outputDir
}

async function cleanupTestOutputDir(runId: string) {
  const outputDir = path.join(os.tmpdir(), `voltcode-test-${runId}`)
  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {})
}

// --- Integration Tests ---

describe("Worker Integration Tests", () => {
  beforeEach(() => {
    resetAwsMockState()
    resetSecretsCache() // Reset module-level cache to ensure tests are isolated
    mockDbQuery.mockClear()
  })

  describe("Full Job Processing Flow", () => {
    test("successfully processes job end-to-end", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob()
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"
      const s3Bucket = "test-bucket"

      // Add job to mock queue
      mockState.sqsMessages.set(job.run_id, {
        body: JSON.stringify(job),
        receiptHandle: `receipt-${job.run_id}`,
      })

      // Create test output directory with successful result
      const outputDir = await createTestOutputDir(job.run_id, { success: true, score: 0.95 })

      try {
        // 1. Fetch secrets
        const secrets = await fetchSecrets()
        expect(secrets.dbUrl).toBe("postgres://localhost:5432/test")
        expect(secrets.openaiKey).toBe("sk-test-openai-key")

        // 2. Poll queue for job
        const pollResult = await pollQueue(queueUrl)
        expect(pollResult).not.toBeNull()
        expect(pollResult!.message.run_id).toBe(job.run_id)
        expect(pollResult!.receiptHandle).toBe(`receipt-${job.run_id}`)

        // 3. Parse result and extract tokens
        const result = await parseResult(outputDir)
        expect(result).not.toBeNull()
        expect(result!.success).toBe(true)
        expect(result!.score).toBe(0.95)

        const tokens = await extractTokens(outputDir)
        expect(tokens.tokens_in).toBe(300)
        expect(tokens.tokens_out).toBe(150)
        expect(tokens.tokens_cached).toBe(50)

        // 4. Upload artifacts to S3
        await uploadArtifacts(s3Bucket, job.output_prefix, outputDir)

        // Verify S3 uploads
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/result.json`)).toBe(true)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/trace.jsonl`)).toBe(true)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/stdout.log`)).toBe(true)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/stderr.log`)).toBe(true)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/meta.json`)).toBe(true)

        // 5. Delete message from queue
        await deleteMessage(queueUrl, pollResult!.receiptHandle)
        expect(mockState.deletedMessages).toContain(pollResult!.receiptHandle)
        expect(mockState.sqsMessages.has(job.run_id)).toBe(false)
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("visibility extender can be created and controlled", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob()
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"
      const receiptHandle = `receipt-${job.run_id}`

      mockState.sqsMessages.set(job.run_id, {
        body: JSON.stringify(job),
        receiptHandle,
      })

      // Create visibility extender
      const extender = createVisibilityExtender(queueUrl, receiptHandle)

      // Verify extender has correct interface
      expect(typeof extender.start).toBe("function")
      expect(typeof extender.stop).toBe("function")

      // Start should be idempotent (no exception on double-start)
      extender.start()
      extender.start()

      // Stop should be safe to call multiple times
      extender.stop()
      extender.stop()
    })

    test("writes metadata to database", async () => {
      const job = createTestJob()
      const dbClient = createDbClient("postgres://localhost:5432/test")
      await dbClient.connect()

      const metadata = {
        run_id: job.run_id,
        backend: job.backend,
        context_length: job.context_length,
        context_window_id: job.context_window_id,
        seed: job.seed,
        status: "completed" as const,
        start_ts: new Date(),
        end_ts: new Date(),
        duration_s: 120,
        tokens_in: 300,
        tokens_out: 150,
        success: true,
        score: 0.95,
        retry_count: 0,
        s3_prefix: job.output_prefix,
      }

      await writeRunMetadata(dbClient, metadata)

      // Verify DB write was called
      expect(mockDbQuery).toHaveBeenCalled()
    })
  })

  describe("Failure Handling", () => {
    test("requeues job on transient failure within retry limit", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob({ retry_count: 0 })
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"

      // Verify retry is allowed
      expect(shouldRetry(0)).toBe(true)
      expect(shouldRetry(1)).toBe(true)
      expect(shouldRetry(2)).toBe(true)

      // Requeue with backoff
      await requeueWithBackoff(queueUrl, job)

      // Verify message was requeued
      expect(mockState.sqsMessages.size).toBeGreaterThan(0)
      const requeuedEntry = Array.from(mockState.sqsMessages.values())[0]
      const parsed = JSON.parse(requeuedEntry.body)
      expect(parsed.retry_count).toBe(1)
    })

    test("handles multiple retries with increasing backoff", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob({ retry_count: 0 })
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"

      // Simulate 3 retries
      for (let i = 0; i < 3; i++) {
        expect(shouldRetry(i)).toBe(true)

        const jobWithRetryCount = { ...job, retry_count: i }
        mockState.sqsMessages.clear() // Clear before requeue
        await requeueWithBackoff(queueUrl, jobWithRetryCount)

        const requeuedEntry = Array.from(mockState.sqsMessages.values())[0]
        const parsed = JSON.parse(requeuedEntry.body)
        expect(parsed.retry_count).toBe(i + 1)
      }

      // After 3 retries, should not retry anymore
      expect(shouldRetry(3)).toBe(false)
    })

    test("processes job with failed result", async () => {
      const job = createTestJob()
      const outputDir = await createTestOutputDir(job.run_id, {
        success: false,
        error: "Task failed due to validation error",
      })

      try {
        const result = await parseResult(outputDir)
        expect(result).not.toBeNull()
        expect(result!.success).toBe(false)
        expect(result!.error).toBe("Task failed due to validation error")
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("handles missing result.json gracefully", async () => {
      const job = createTestJob()
      const outputDir = path.join(os.tmpdir(), `voltcode-test-${job.run_id}`)
      await fs.mkdir(outputDir, { recursive: true })

      try {
        const result = await parseResult(outputDir)
        expect(result).toBeNull()
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("handles missing trace.jsonl gracefully", async () => {
      const job = createTestJob()
      const outputDir = path.join(os.tmpdir(), `voltcode-test-${job.run_id}`)
      await fs.mkdir(outputDir, { recursive: true })

      try {
        const tokens = await extractTokens(outputDir)
        expect(tokens.tokens_in).toBe(0)
        expect(tokens.tokens_out).toBe(0)
        expect(tokens.tokens_cached).toBe(0)
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })
  })

  describe("DLQ Routing", () => {
    test("sends to DLQ after max retries exceeded", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob({ retry_count: 3 })
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"
      const dlqUrl = getDLQUrl(queueUrl)
      const errorMessage = "Max retries exceeded: Persistent failure"

      // Verify retry is not allowed
      expect(shouldRetry(3)).toBe(false)

      // Send to DLQ
      const jobWithRetryCount = { ...job, retry_count: 3 }
      await sendToDLQ(dlqUrl, jobWithRetryCount, errorMessage)

      // Verify message was sent to DLQ
      expect(mockState.dlqMessages.length).toBe(1)
      const dlqMessage = JSON.parse(mockState.dlqMessages[0].body)
      expect(dlqMessage.run_id).toBe(job.run_id)
      expect(dlqMessage.error).toBe(errorMessage)
      expect(dlqMessage.failed_at).toBeDefined()
    })

    test("DLQ URL is correctly derived from queue URL", () => {
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/eval-queue"
      const dlqUrl = getDLQUrl(queueUrl)
      expect(dlqUrl).toBe("https://sqs.us-west-2.amazonaws.com/123456789/eval-queue-dlq")
    })

    test("DLQ preserves original job payload", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob({
        run_id: "unique-run-123",
        backend: "anthropic:claude-3",
        context_length: 8192,
        seed: 999,
      })
      const dlqUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue-dlq"

      const jobWithRetryCount = { ...job, retry_count: 3 }
      await sendToDLQ(dlqUrl, jobWithRetryCount, "Test error")

      const dlqMessage = JSON.parse(mockState.dlqMessages[0].body)
      expect(dlqMessage.backend).toBe("anthropic:claude-3")
      expect(dlqMessage.context_length).toBe(8192)
      expect(dlqMessage.seed).toBe(999)
    })
  })

  describe("Secrets Management", () => {
    test("fetches all required secrets", async () => {
      const secrets = await fetchSecrets()

      expect(secrets.dbUrl).toBe("postgres://localhost:5432/test")
      expect(secrets.openaiKey).toBe("sk-test-openai-key")
      expect(secrets.anthropicKey).toBe("sk-test-anthropic-key")
      expect(secrets.moonshotKey).toBe("sk-test-moonshot-key")
      expect(secrets.glmKey).toBe("sk-test-glm-key")
    })
  })

  describe("S3 Artifact Upload", () => {
    test("uploads all artifact files", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob()
      const s3Bucket = "artifacts-bucket"
      const outputDir = await createTestOutputDir(job.run_id, { success: true })

      try {
        await uploadArtifacts(s3Bucket, job.output_prefix, outputDir)

        // Verify all expected files were uploaded
        const expectedFiles = ["result.json", "trace.jsonl", "stdout.log", "stderr.log", "meta.json"]
        for (const file of expectedFiles) {
          const key = `${s3Bucket}/${job.output_prefix}/${file}`
          expect(mockState.s3Objects.has(key)).toBe(true)
        }
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("handles partial artifact upload (missing files)", async () => {
      const mockState = getAwsMockState()
      const job = createTestJob()
      const s3Bucket = "artifacts-bucket"
      const outputDir = path.join(os.tmpdir(), `voltcode-test-${job.run_id}`)
      await fs.mkdir(outputDir, { recursive: true })

      // Only create some files
      await fs.writeFile(path.join(outputDir, "result.json"), JSON.stringify({ success: true }))
      await fs.writeFile(path.join(outputDir, "stdout.log"), "Output")

      try {
        await uploadArtifacts(s3Bucket, job.output_prefix, outputDir)

        // Only existing files should be uploaded
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/result.json`)).toBe(true)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/stdout.log`)).toBe(true)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/trace.jsonl`)).toBe(false)
        expect(mockState.s3Objects.has(`${s3Bucket}/${job.output_prefix}/stderr.log`)).toBe(false)
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })
  })

  describe("Queue Operations", () => {
    test("polls empty queue and returns null", async () => {
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/empty-queue"

      const result = await pollQueue(queueUrl)
      expect(result).toBeNull()
    })

    test("processes multiple jobs sequentially", async () => {
      const mockState = getAwsMockState()
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"
      const jobs = [createTestJob(), createTestJob(), createTestJob()]

      // Add all jobs to queue
      for (const job of jobs) {
        mockState.sqsMessages.set(job.run_id, {
          body: JSON.stringify(job),
          receiptHandle: `receipt-${job.run_id}`,
        })
      }

      // Process each job
      for (const _job of jobs) {
        const result = await pollQueue(queueUrl)
        expect(result).not.toBeNull()

        await deleteMessage(queueUrl, result!.receiptHandle)
      }

      // All jobs should be processed
      expect(mockState.sqsMessages.size).toBe(0)
      expect(mockState.deletedMessages.length).toBe(3)
    })

    test("handles job with different backends", async () => {
      const mockState = getAwsMockState()
      const backends = ["openai:gpt-4", "anthropic:claude-3", "moonshot:v1", "glm:chatglm-4"]
      const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"

      for (const backend of backends) {
        const job = createTestJob({ backend })
        mockState.sqsMessages.set(job.run_id, {
          body: JSON.stringify(job),
          receiptHandle: `receipt-${job.run_id}`,
        })

        const result = await pollQueue(queueUrl)
        expect(result).not.toBeNull()
        expect(result!.message.backend).toBe(backend)

        await deleteMessage(queueUrl, result!.receiptHandle)
      }
    })
  })

  describe("Token Extraction", () => {
    test("sums tokens from multiple trace entries", async () => {
      const job = createTestJob()
      const outputDir = path.join(os.tmpdir(), `voltcode-test-${job.run_id}`)
      await fs.mkdir(outputDir, { recursive: true })

      // Create trace with multiple entries
      const trace = [
        { usage: { input_tokens: 100, output_tokens: 50 } },
        { usage: { input_tokens: 200, output_tokens: 100 } },
        { usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 30 } },
      ]
      await fs.writeFile(path.join(outputDir, "trace.jsonl"), trace.map((t) => JSON.stringify(t)).join("\n"))

      try {
        const tokens = await extractTokens(outputDir)
        expect(tokens.tokens_in).toBe(450) // 100 + 200 + 150
        expect(tokens.tokens_out).toBe(225) // 50 + 100 + 75
        expect(tokens.tokens_cached).toBe(30)
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("handles malformed trace lines gracefully", async () => {
      const job = createTestJob()
      const outputDir = path.join(os.tmpdir(), `voltcode-test-${job.run_id}`)
      await fs.mkdir(outputDir, { recursive: true })

      // Create trace with some invalid lines
      const traceContent = [
        JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }),
        "invalid json line",
        JSON.stringify({ usage: { input_tokens: 200, output_tokens: 100 } }),
        "another invalid line",
        JSON.stringify({ no_usage_field: true }),
      ].join("\n")

      await fs.writeFile(path.join(outputDir, "trace.jsonl"), traceContent)

      try {
        const tokens = await extractTokens(outputDir)
        // Should only count valid entries
        expect(tokens.tokens_in).toBe(300) // 100 + 200
        expect(tokens.tokens_out).toBe(150) // 50 + 100
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })
  })

  describe("Result Parsing", () => {
    test("parses successful result with score", async () => {
      const job = createTestJob()
      const outputDir = await createTestOutputDir(job.run_id, { success: true, score: 0.87 })

      try {
        const result = await parseResult(outputDir)
        expect(result).not.toBeNull()
        expect(result!.success).toBe(true)
        expect(result!.score).toBe(0.87)
        expect(result!.error).toBeUndefined()
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("parses failed result with error message", async () => {
      const job = createTestJob()
      const outputDir = await createTestOutputDir(job.run_id, {
        success: false,
        error: "Validation failed: missing required field",
      })

      try {
        const result = await parseResult(outputDir)
        expect(result).not.toBeNull()
        expect(result!.success).toBe(false)
        expect(result!.error).toBe("Validation failed: missing required field")
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })

    test("handles malformed result.json", async () => {
      const job = createTestJob()
      const outputDir = path.join(os.tmpdir(), `voltcode-test-${job.run_id}`)
      await fs.mkdir(outputDir, { recursive: true })
      await fs.writeFile(path.join(outputDir, "result.json"), "not valid json")

      try {
        const result = await parseResult(outputDir)
        expect(result).toBeNull()
      } finally {
        await cleanupTestOutputDir(job.run_id)
      }
    })
  })
})
