import { describe, expect, test, beforeEach } from "bun:test"

/**
 * Tests for SQS polling functions.
 *
 * AWS SDK is mocked in test/preload.ts and uses globalThis.__awsMockState
 */

// Access the global mock state set up in preload.ts
function getAwsMockState() {
  return (globalThis as any).__awsMockState as {
    sqsMessages: Map<string, { body: string; receiptHandle: string }>
    deletedMessages: string[]
    visibilityExtensions: Array<{ receiptHandle: string; timeout: number }>
    dlqMessages: Array<{ body: string; timestamp: string }>
  }
}

function resetMockState() {
  const state = getAwsMockState()
  state.sqsMessages.clear()
  state.deletedMessages.length = 0
  state.visibilityExtensions.length = 0
  state.dlqMessages.length = 0
}

// Import after preload sets up mocks
const { pollQueue } = await import("../../src/worker/sqs-poller")

describe("pollQueue", () => {
  const testQueueUrl = "https://sqs.us-west-2.amazonaws.com/123456789/test-queue"

  beforeEach(() => {
    resetMockState()
  })

  describe("successful message receive", () => {
    test("returns parsed message and receipt handle on success", async () => {
      const mockState = getAwsMockState()
      const jobMessage = {
        run_id: "run-123",
        context_length: 4096,
        context_window_id: 456,
        backend: "openai",
        seed: 42,
        timeout_minutes: 30,
        retry_count: 0,
        output_prefix: "s3://bucket/output",
      }

      mockState.sqsMessages.set(jobMessage.run_id, {
        body: JSON.stringify(jobMessage),
        receiptHandle: "receipt-handle-abc",
      })

      const result = await pollQueue(testQueueUrl)

      expect(result).not.toBeNull()
      expect(result!.message).toEqual(jobMessage)
      expect(result!.receiptHandle).toBe("receipt-handle-abc")
    })

    test("parses all job message fields correctly", async () => {
      const mockState = getAwsMockState()
      const jobMessage = {
        run_id: "run-xyz",
        context_length: 8192,
        context_window_id: 789,
        backend: "anthropic",
        seed: 123,
        timeout_minutes: 60,
        retry_count: 2,
        output_prefix: "s3://other-bucket/prefix",
      }

      mockState.sqsMessages.set(jobMessage.run_id, {
        body: JSON.stringify(jobMessage),
        receiptHandle: "handle-xyz",
      })

      const result = await pollQueue(testQueueUrl)

      expect(result!.message.run_id).toBe("run-xyz")
      expect(result!.message.context_length).toBe(8192)
      expect(result!.message.context_window_id).toBe(789)
      expect(result!.message.backend).toBe("anthropic")
      expect(result!.message.seed).toBe(123)
      expect(result!.message.timeout_minutes).toBe(60)
      expect(result!.message.retry_count).toBe(2)
      expect(result!.message.output_prefix).toBe("s3://other-bucket/prefix")
    })
  })

  describe("empty queue handling", () => {
    test("returns null when no messages available", async () => {
      // Queue is already empty from resetMockState
      const result = await pollQueue(testQueueUrl)

      expect(result).toBeNull()
    })
  })

  describe("edge cases", () => {
    test("handles multiple messages by taking only the first", async () => {
      const mockState = getAwsMockState()

      const job1 = {
        run_id: "first",
        context_length: 1024,
        context_window_id: 1,
        backend: "test",
        seed: 1,
        timeout_minutes: 10,
        retry_count: 0,
        output_prefix: "s3://test",
      }
      const job2 = {
        run_id: "second",
        context_length: 2048,
        context_window_id: 2,
        backend: "test",
        seed: 2,
        timeout_minutes: 20,
        retry_count: 1,
        output_prefix: "s3://test2",
      }

      mockState.sqsMessages.set(job1.run_id, {
        body: JSON.stringify(job1),
        receiptHandle: "handle-1",
      })
      mockState.sqsMessages.set(job2.run_id, {
        body: JSON.stringify(job2),
        receiptHandle: "handle-2",
      })

      const result = await pollQueue(testQueueUrl)

      // Should get one of the messages (order may vary)
      expect(result).not.toBeNull()
      expect(["first", "second"]).toContain(result!.message.run_id)
    })

    test("handles special characters in message body", async () => {
      const mockState = getAwsMockState()
      const jobMessage = {
        run_id: "run-with-special-chars-!@#$%",
        context_length: 4096,
        context_window_id: 12345,
        backend: "openai",
        seed: 42,
        timeout_minutes: 30,
        retry_count: 0,
        output_prefix: "s3://bucket/path with spaces/output",
      }

      mockState.sqsMessages.set(jobMessage.run_id, {
        body: JSON.stringify(jobMessage),
        receiptHandle: "handle",
      })

      const result = await pollQueue(testQueueUrl)

      expect(result!.message.run_id).toBe("run-with-special-chars-!@#$%")
      expect(result!.message.context_window_id).toBe(12345)
      expect(result!.message.output_prefix).toBe("s3://bucket/path with spaces/output")
    })
  })
})
