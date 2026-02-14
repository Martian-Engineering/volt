import { describe, expect, test, beforeEach } from "bun:test"

/**
 * Tests for retry/backoff logic and DLQ routing.
 *
 * AWS SDK is mocked in test/preload.ts and uses globalThis.__awsMockState
 */

// Inline type to avoid import
interface JobMessage {
  run_id: string
  context_length: number
  context_window_id: number
  backend: string
  seed: number
  timeout_minutes: number
  retry_count: number
  output_prefix: string
}

function createTestJobMessage(overrides: Partial<JobMessage> = {}): JobMessage {
  return {
    run_id: "job-123",
    context_length: 4096,
    context_window_id: 1,
    backend: "openai:gpt-4",
    seed: 42,
    timeout_minutes: 30,
    retry_count: 0,
    output_prefix: "test-output",
    ...overrides,
  }
}

// Access the global mock state set up in preload.ts
function getAwsMockState() {
  return (globalThis as any).__awsMockState as {
    sqsMessages: Map<string, { body: string; receiptHandle: string }>
    dlqMessages: Array<{ body: string; timestamp: string }>
  }
}

function resetMockState() {
  const state = getAwsMockState()
  state.sqsMessages.clear()
  state.dlqMessages.length = 0
}

// Import after preload sets up mocks
import { getBackoffDelay, getDLQUrl, requeueWithBackoff, sendToDLQ, shouldRetry } from "../../src/worker/retry"

describe("getBackoffDelay", () => {
  test("returns 30 seconds for retry count 1", () => {
    expect(getBackoffDelay(1)).toBe(30)
  })

  test("returns 120 seconds for retry count 2", () => {
    expect(getBackoffDelay(2)).toBe(120)
  })

  test("returns 600 seconds for retry count 3", () => {
    expect(getBackoffDelay(3)).toBe(600)
  })

  test("returns 600 seconds for retry count beyond 3", () => {
    expect(getBackoffDelay(4)).toBe(600)
    expect(getBackoffDelay(10)).toBe(600)
  })

  test("returns 600 seconds for retry count 0", () => {
    expect(getBackoffDelay(0)).toBe(600)
  })
})

describe("shouldRetry", () => {
  test("returns true for count 0", () => {
    expect(shouldRetry(0)).toBe(true)
  })

  test("returns true for count 1", () => {
    expect(shouldRetry(1)).toBe(true)
  })

  test("returns true for count 2", () => {
    expect(shouldRetry(2)).toBe(true)
  })

  test("returns false for count 3", () => {
    expect(shouldRetry(3)).toBe(false)
  })

  test("returns false for count greater than 3", () => {
    expect(shouldRetry(4)).toBe(false)
    expect(shouldRetry(10)).toBe(false)
  })
})

describe("getDLQUrl", () => {
  test("appends -dlq suffix to queue URL", () => {
    expect(getDLQUrl("https://sqs.us-east-1.amazonaws.com/123456789/my-queue")).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789/my-queue-dlq",
    )
  })

  test("handles simple queue names", () => {
    expect(getDLQUrl("my-queue")).toBe("my-queue-dlq")
  })

  test("handles empty string", () => {
    expect(getDLQUrl("")).toBe("-dlq")
  })
})

describe("requeueWithBackoff", () => {
  beforeEach(() => {
    resetMockState()
  })

  test("sends message with incremented retry count", async () => {
    const mockState = getAwsMockState()
    const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
    const job = createTestJobMessage({ run_id: "job-123", retry_count: 0 })

    await requeueWithBackoff(queueUrl, job)

    // The message should be in the queue with retry_count incremented
    expect(mockState.sqsMessages.size).toBeGreaterThan(0)
    const messages = Array.from(mockState.sqsMessages.values())
    const requeuedBody = JSON.parse(messages[0].body)
    expect(requeuedBody.run_id).toBe("job-123")
    expect(requeuedBody.retry_count).toBe(1)
  })

  test("increments retry count from 1 to 2", async () => {
    const mockState = getAwsMockState()
    const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
    const job = createTestJobMessage({ run_id: "job-456", retry_count: 1 })

    await requeueWithBackoff(queueUrl, job)

    const messages = Array.from(mockState.sqsMessages.values())
    const requeuedBody = JSON.parse(messages[0].body)
    expect(requeuedBody.retry_count).toBe(2)
  })

  test("increments retry count from 2 to 3", async () => {
    const mockState = getAwsMockState()
    const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
    const job = createTestJobMessage({ run_id: "job-789", retry_count: 2 })

    await requeueWithBackoff(queueUrl, job)

    const messages = Array.from(mockState.sqsMessages.values())
    const requeuedBody = JSON.parse(messages[0].body)
    expect(requeuedBody.retry_count).toBe(3)
  })
})

describe("sendToDLQ", () => {
  beforeEach(() => {
    resetMockState()
  })

  test("sends message to DLQ with job fields and error", async () => {
    const mockState = getAwsMockState()
    const dlqUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue-dlq"
    const job = createTestJobMessage({ run_id: "job-123", retry_count: 3 })
    const errorMessage = "Max retries exceeded"

    await sendToDLQ(dlqUrl, job, errorMessage)

    expect(mockState.dlqMessages.length).toBe(1)
    const dlqBody = JSON.parse(mockState.dlqMessages[0].body)
    expect(dlqBody.run_id).toBe("job-123")
    expect(dlqBody.retry_count).toBe(3)
    expect(dlqBody.error).toBe(errorMessage)
    expect(dlqBody.failed_at).toBeDefined()
  })

  test("includes ISO timestamp in failed_at field", async () => {
    const mockState = getAwsMockState()
    const dlqUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue-dlq"
    const job = createTestJobMessage({ run_id: "job-456" })

    const beforeTime = new Date().toISOString()
    await sendToDLQ(dlqUrl, job, "test error")
    const afterTime = new Date().toISOString()

    const dlqBody = JSON.parse(mockState.dlqMessages[0].body)
    expect(dlqBody.failed_at >= beforeTime).toBe(true)
    expect(dlqBody.failed_at <= afterTime).toBe(true)
  })
})
