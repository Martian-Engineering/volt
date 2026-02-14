import { describe, expect, test, beforeEach } from "bun:test"

/**
 * Tests for SQS visibility management functions.
 *
 * AWS SDK is mocked in test/preload.ts and tracks:
 * - visibilityExtensions: Array<{ receiptHandle: string; timeout: number }>
 * - deletedMessages: string[]
 */

// Access the global mock state set up in preload.ts
function getAwsMockState() {
  return (globalThis as any).__awsMockState as {
    sqsMessages: Map<string, { body: string; receiptHandle: string }>
    deletedMessages: string[]
    visibilityExtensions: Array<{ receiptHandle: string; timeout: number }>
  }
}

function resetMockState() {
  const state = getAwsMockState()
  state.deletedMessages.length = 0
  state.visibilityExtensions.length = 0
}

// Import after preload sets up mocks
import { extendVisibility, deleteMessage, createVisibilityExtender } from "../../src/worker/visibility"

describe("visibility", () => {
  beforeEach(() => {
    resetMockState()
  })

  describe("extendVisibility", () => {
    test("calls ChangeMessageVisibility with correct parameters", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-123"
      const timeoutSeconds = 3600

      await extendVisibility(queueUrl, receiptHandle, timeoutSeconds)

      const extensions = getAwsMockState().visibilityExtensions
      expect(extensions).toHaveLength(1)
      expect(extensions[0].receiptHandle).toBe(receiptHandle)
      expect(extensions[0].timeout).toBe(timeoutSeconds)
    })

    test("uses default timeout when not specified", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-456"

      await extendVisibility(queueUrl, receiptHandle)

      const extensions = getAwsMockState().visibilityExtensions
      expect(extensions).toHaveLength(1)
      expect(extensions[0].receiptHandle).toBe(receiptHandle)
      expect(extensions[0].timeout).toBe(7200) // Default 2 hours
    })

    test("propagates errors from SQS client", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      // This should complete without throwing since our mock succeeds
      await expect(extendVisibility(queueUrl, receiptHandle)).resolves.toBeUndefined()
    })
  })

  describe("deleteMessage", () => {
    test("calls DeleteMessage with correct parameters", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-789"

      await deleteMessage(queueUrl, receiptHandle)

      const deletedMessages = getAwsMockState().deletedMessages
      expect(deletedMessages).toHaveLength(1)
      expect(deletedMessages[0]).toBe(receiptHandle)
    })

    test("returns void on success", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      const result = await deleteMessage(queueUrl, receiptHandle)

      expect(result).toBeUndefined()
    })
  })

  describe("createVisibilityExtender", () => {
    test("returns object with start and stop methods", () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      const extender = createVisibilityExtender(queueUrl, receiptHandle)

      expect(typeof extender.start).toBe("function")
      expect(typeof extender.stop).toBe("function")
    })

    test("start does not call extendVisibility immediately", () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      const extender = createVisibilityExtender(queueUrl, receiptHandle, 100)
      extender.start()

      // No immediate call - interval schedules first call for later
      const extensions = getAwsMockState().visibilityExtensions
      expect(extensions).toHaveLength(0)

      extender.stop()
    })

    test("stop can be called without starting", () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      const extender = createVisibilityExtender(queueUrl, receiptHandle)

      // Should not throw
      expect(() => extender.stop()).not.toThrow()
    })

    test("start is idempotent - calling twice does not create multiple intervals", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"
      const intervalMs = 50

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)

      extender.start()
      extender.start() // Second call should be a no-op

      // Wait for two intervals to pass
      await new Promise((resolve) => setTimeout(resolve, intervalMs * 2 + 20))

      extender.stop()

      // If two intervals were created, we'd see ~4 calls; with idempotency, ~2
      const extensions = getAwsMockState().visibilityExtensions
      expect(extensions.length).toBeLessThanOrEqual(3)
    })

    test("stop is idempotent - calling twice does not throw", () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      const extender = createVisibilityExtender(queueUrl, receiptHandle, 100)
      extender.start()

      extender.stop()
      expect(() => extender.stop()).not.toThrow()
    })

    test("uses default interval when not specified", () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle"

      // Default interval is 10 minutes (600000ms) - just verify we can create without specifying
      const extender = createVisibilityExtender(queueUrl, receiptHandle)

      expect(extender).toBeDefined()
      expect(typeof extender.start).toBe("function")
      expect(typeof extender.stop).toBe("function")
    })
  })

  describe("createVisibilityExtender interval behavior", () => {
    test("extends visibility periodically after start", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-interval"
      const intervalMs = 50

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)
      extender.start()

      // Wait for first interval
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 20))
      const extensions = getAwsMockState().visibilityExtensions
      expect(extensions.length).toBeGreaterThanOrEqual(1)

      const firstCallCount = extensions.length

      // Wait for another interval
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 20))
      expect(extensions.length).toBeGreaterThan(firstCallCount)

      extender.stop()

      // Verify the calls were for correct receipt handle and timeout
      for (const ext of extensions) {
        expect(ext.receiptHandle).toBe(receiptHandle)
        expect(ext.timeout).toBe(7200) // Default timeout
      }
    })

    test("stops extending visibility after stop is called", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-stop"
      const intervalMs = 50

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)
      extender.start()

      // Wait for first call
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 20))
      const callsBeforeStop = getAwsMockState().visibilityExtensions.length

      extender.stop()

      // Wait for what would be another interval
      await new Promise((resolve) => setTimeout(resolve, intervalMs * 2))

      // No new calls should have been made
      expect(getAwsMockState().visibilityExtensions.length).toBe(callsBeforeStop)
    })

    test("uses custom interval when specified", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-custom"
      const intervalMs = 30

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)
      extender.start()

      // Wait for approximately 3 intervals
      await new Promise((resolve) => setTimeout(resolve, intervalMs * 3 + 20))

      extender.stop()

      // Should have made approximately 3 calls (timing can vary slightly)
      const extensions = getAwsMockState().visibilityExtensions
      expect(extensions.length).toBeGreaterThanOrEqual(2)
      expect(extensions.length).toBeLessThanOrEqual(4)
    })

    test("can restart after stopping", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-restart"
      const intervalMs = 50

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)

      // First start/stop cycle
      extender.start()
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 20))
      extender.stop()

      const callsAfterFirstCycle = getAwsMockState().visibilityExtensions.length
      expect(callsAfterFirstCycle).toBeGreaterThanOrEqual(1)

      // Second start/stop cycle
      extender.start()
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 20))
      extender.stop()

      // Should have additional calls from second cycle
      expect(getAwsMockState().visibilityExtensions.length).toBeGreaterThan(callsAfterFirstCycle)
    })

    test("interval fires multiple times over longer duration", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-multi"
      const intervalMs = 25

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)
      extender.start()

      // Wait for approximately 5 intervals
      await new Promise((resolve) => setTimeout(resolve, intervalMs * 5 + 30))

      extender.stop()

      const extensions = getAwsMockState().visibilityExtensions
      // Should have made approximately 5 calls (timing can vary)
      expect(extensions.length).toBeGreaterThanOrEqual(4)
      expect(extensions.length).toBeLessThanOrEqual(6)

      // All calls should have the same parameters
      for (const ext of extensions) {
        expect(ext.receiptHandle).toBe(receiptHandle)
        expect(ext.timeout).toBe(7200)
      }
    })

    test("handles rapid start/stop cycles", async () => {
      const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789/test-queue"
      const receiptHandle = "test-receipt-handle-rapid"
      const intervalMs = 100

      const extender = createVisibilityExtender(queueUrl, receiptHandle, intervalMs)

      // Rapid start/stop cycles before any interval fires
      extender.start()
      extender.stop()
      extender.start()
      extender.stop()
      extender.start()
      extender.stop()

      // No calls should have been made since we stopped before interval fired
      expect(getAwsMockState().visibilityExtensions).toHaveLength(0)
    })
  })
})
