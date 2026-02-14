import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"

// AWS SDK is mocked in test/preload.ts

import { RateLimiter } from "../../src/control-plane/rate-limiter"
import {
  generateJobs,
  runScheduler,
  type SchedulerConfig,
  type RateLimiter as SchedulerRateLimiterInterface,
} from "../../src/control-plane/scheduler"
import {
  buildJobMessage,
  getQueueUrlForBackend,
  type JobParams,
  type JobMessage,
} from "../../src/control-plane/job-enqueue"

// Track enqueued jobs per queue
interface EnqueuedJob {
  queueUrl: string
  message: JobMessage
}

let enqueuedJobs: EnqueuedJob[] = []

// Mock enqueueJob function
const mockEnqueueJob = mock(async (queueUrl: string, job: JobMessage): Promise<void> => {
  enqueuedJobs.push({ queueUrl, message: job })
})

// Module-level mock for enqueueJob
mock.module("../../src/control-plane/job-enqueue", () => ({
  buildJobMessage,
  getQueueUrlForBackend,
  enqueueJob: mockEnqueueJob,
}))

describe("Scheduler Integration", () => {
  beforeEach(() => {
    enqueuedJobs = []
    mockEnqueueJob.mockClear()
  })

  describe("generateJobs", () => {
    test("respects backend mix ratios with equal distribution", () => {
      const config: SchedulerConfig = {
        contextLengths: [128000],
        backends: ["anthropic:claude-opus-4.5", "moonshot:kimi-k2.5"],
        backendMix: { anthropic: 0.5, moonshot: 0.5 },
        totalRuns: 10,
        seedStart: 1,
      }

      const jobs = Array.from(generateJobs(config))

      expect(jobs.length).toBe(10)

      const anthropicJobs = jobs.filter((j) => j.backend.startsWith("anthropic"))
      const moonshotJobs = jobs.filter((j) => j.backend.startsWith("moonshot"))

      expect(anthropicJobs.length).toBe(5)
      expect(moonshotJobs.length).toBe(5)
    })

    test("respects backend mix ratios with unequal distribution", () => {
      const config: SchedulerConfig = {
        contextLengths: [128000],
        backends: ["anthropic:claude-opus-4.5", "moonshot:kimi-k2.5"],
        backendMix: { anthropic: 0.7, moonshot: 0.3 },
        totalRuns: 10,
        seedStart: 1,
      }

      const jobs = Array.from(generateJobs(config))

      expect(jobs.length).toBe(10)

      const anthropicJobs = jobs.filter((j) => j.backend.startsWith("anthropic"))
      const moonshotJobs = jobs.filter((j) => j.backend.startsWith("moonshot"))

      expect(anthropicJobs.length).toBe(7)
      expect(moonshotJobs.length).toBe(3)
    })

    test("respects backend mix ratios with three backends", () => {
      const config: SchedulerConfig = {
        contextLengths: [128000],
        backends: ["anthropic:claude-opus-4.5", "moonshot:kimi-k2.5", "openai:gpt-4.5"],
        backendMix: { anthropic: 0.4, moonshot: 0.4, openai: 0.2 },
        totalRuns: 100,
        seedStart: 1,
      }

      const jobs = Array.from(generateJobs(config))

      expect(jobs.length).toBe(100)

      const anthropicJobs = jobs.filter((j) => j.backend.startsWith("anthropic"))
      const moonshotJobs = jobs.filter((j) => j.backend.startsWith("moonshot"))
      const openaiJobs = jobs.filter((j) => j.backend.startsWith("openai"))

      expect(anthropicJobs.length).toBe(40)
      expect(moonshotJobs.length).toBe(40)
      expect(openaiJobs.length).toBe(20)
    })

    test("generates jobs across multiple context lengths", () => {
      const config: SchedulerConfig = {
        contextLengths: [128000, 256000, 512000],
        backends: ["anthropic:claude-opus-4.5"],
        backendMix: { anthropic: 1.0 },
        totalRuns: 9,
        seedStart: 1,
      }

      const jobs = Array.from(generateJobs(config))

      expect(jobs.length).toBe(9)

      const jobsByContextLength: Record<number, number> = {}
      for (const job of jobs) {
        jobsByContextLength[job.context_length] = (jobsByContextLength[job.context_length] ?? 0) + 1
      }

      // Round-robin across context lengths
      expect(jobsByContextLength[128000]).toBe(3)
      expect(jobsByContextLength[256000]).toBe(3)
      expect(jobsByContextLength[512000]).toBe(3)
    })

    test("assigns unique seeds to each job", () => {
      const config: SchedulerConfig = {
        contextLengths: [128000],
        backends: ["anthropic:claude-opus-4.5", "moonshot:kimi-k2.5"],
        backendMix: { anthropic: 0.5, moonshot: 0.5 },
        totalRuns: 10,
        seedStart: 100,
      }

      const jobs = Array.from(generateJobs(config))
      const seeds = jobs.map((j) => j.seed)
      const uniqueSeeds = new Set(seeds)

      expect(uniqueSeeds.size).toBe(10)
      expect(Math.min(...seeds)).toBeGreaterThanOrEqual(100)
    })

    test("calculates timeout based on context length", () => {
      const config: SchedulerConfig = {
        contextLengths: [10000, 100000, 500000],
        backends: ["anthropic:claude-opus-4.5"],
        backendMix: { anthropic: 1.0 },
        totalRuns: 3,
        seedStart: 1,
      }

      const jobs = Array.from(generateJobs(config))

      // Timeout formula: Math.ceil(contextLength / 10000) * 5
      const job10k = jobs.find((j) => j.context_length === 10000)
      const job100k = jobs.find((j) => j.context_length === 100000)
      const job500k = jobs.find((j) => j.context_length === 500000)

      expect(job10k?.timeout_minutes).toBe(5) // ceil(1) * 5
      expect(job100k?.timeout_minutes).toBe(50) // ceil(10) * 5
      expect(job500k?.timeout_minutes).toBe(250) // ceil(50) * 5
    })
  })

  describe("RateLimiter blocking", () => {
    test("blocks enqueueing when at capacity", () => {
      const limiter = new RateLimiter({ anthropic: 3 })

      expect(limiter.canEnqueue("anthropic")).toBe(true)
      limiter.trackEnqueued("anthropic")
      expect(limiter.canEnqueue("anthropic")).toBe(true)
      limiter.trackEnqueued("anthropic")
      expect(limiter.canEnqueue("anthropic")).toBe(true)
      limiter.trackEnqueued("anthropic")
      expect(limiter.canEnqueue("anthropic")).toBe(false)
    })

    test("allows enqueueing again after completion", () => {
      const limiter = new RateLimiter({ anthropic: 2 })

      limiter.trackEnqueued("anthropic")
      limiter.trackEnqueued("anthropic")
      expect(limiter.canEnqueue("anthropic")).toBe(false)

      limiter.trackCompleted("anthropic")
      expect(limiter.canEnqueue("anthropic")).toBe(true)
    })

    test("tracks multiple backends independently", () => {
      const limiter = new RateLimiter({
        anthropic: 2,
        moonshot: 3,
        openai: 1,
      })

      // Fill anthropic
      limiter.trackEnqueued("anthropic")
      limiter.trackEnqueued("anthropic")
      expect(limiter.canEnqueue("anthropic")).toBe(false)

      // moonshot still has capacity
      expect(limiter.canEnqueue("moonshot")).toBe(true)
      limiter.trackEnqueued("moonshot")
      limiter.trackEnqueued("moonshot")
      limiter.trackEnqueued("moonshot")
      expect(limiter.canEnqueue("moonshot")).toBe(false)

      // openai still has capacity (1 slot)
      expect(limiter.canEnqueue("openai")).toBe(true)
      limiter.trackEnqueued("openai")
      expect(limiter.canEnqueue("openai")).toBe(false)

      // Verify in-flight counts
      expect(limiter.getInFlight("anthropic")).toBe(2)
      expect(limiter.getInFlight("moonshot")).toBe(3)
      expect(limiter.getInFlight("openai")).toBe(1)
    })
  })

  describe("Job distribution to backend queues", () => {
    test("distributes jobs to correct backend queues", () => {
      // getQueueUrlForBackend splits on ":", so backend "anthropic:claude-opus-4.5"
      // gives prefix "anthropic" which must match a queueUrls key
      const queueUrls: Record<string, string> = {
        anthropic: "https://sqs.us-west-2.amazonaws.com/123/anthropic-queue",
        moonshot: "https://sqs.us-west-2.amazonaws.com/123/moonshot-queue",
        openai: "https://sqs.us-west-2.amazonaws.com/123/openai-queue",
      }

      // Use colon-separated backend names (provider:model format)
      const anthropicJob: JobParams = {
        context_length: 128000,
        context_window_id: 0,
        backend: "anthropic:claude-opus-4.5",
        seed: 1,
        timeout_minutes: 65,
      }

      const moonshotJob: JobParams = {
        context_length: 256000,
        context_window_id: 1,
        backend: "moonshot:kimi-k2.5",
        seed: 2,
        timeout_minutes: 130,
      }

      const openaiJob: JobParams = {
        context_length: 512000,
        context_window_id: 2,
        backend: "openai:gpt-4.5",
        seed: 3,
        timeout_minutes: 260,
      }

      expect(getQueueUrlForBackend(anthropicJob.backend, queueUrls)).toBe(queueUrls.anthropic)
      expect(getQueueUrlForBackend(moonshotJob.backend, queueUrls)).toBe(queueUrls.moonshot)
      expect(getQueueUrlForBackend(openaiJob.backend, queueUrls)).toBe(queueUrls.openai)
    })

    test("throws error for unknown backend", () => {
      const queueUrls: Record<string, string> = {
        anthropic: "https://sqs.us-west-2.amazonaws.com/123/anthropic-queue",
      }

      // "unknown:model" splits to prefix "unknown" which isn't in queueUrls
      expect(() => getQueueUrlForBackend("unknown:model", queueUrls)).toThrow()
    })
  })

  describe("buildJobMessage", () => {
    test("creates job message with correct fields", () => {
      const params: JobParams = {
        context_length: 128000,
        context_window_id: 42,
        backend: "anthropic:claude-opus-4.5",
        seed: 42,
        timeout_minutes: 65,
      }

      const message = buildJobMessage(params)

      expect(message.context_length).toBe(128000)
      expect(message.context_window_id).toBe(42)
      expect(message.backend).toBe("anthropic:claude-opus-4.5")
      expect(message.seed).toBe(42)
      expect(message.timeout_minutes).toBe(65)
      expect(message.retry_count).toBe(0)
      expect(message.run_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(message.output_prefix).toBe(`runs/${message.run_id}`)
    })

    test("generates unique run_id for each message", () => {
      const params: JobParams = {
        context_length: 128000,
        context_window_id: 0,
        backend: "anthropic:claude-opus-4.5",
        seed: 1,
        timeout_minutes: 65,
      }

      const message1 = buildJobMessage(params)
      const message2 = buildJobMessage(params)
      const message3 = buildJobMessage(params)

      expect(message1.run_id).not.toBe(message2.run_id)
      expect(message2.run_id).not.toBe(message3.run_id)
      expect(message1.run_id).not.toBe(message3.run_id)
    })
  })

  describe("runScheduler waiting behavior", () => {
    test("waits when all backends at capacity", async () => {
      // Backend format is "provider:model", prefix is extracted by splitting on ":"
      const config: SchedulerConfig = {
        contextLengths: [128000],
        backends: ["anthropic:claude-opus-4.5"],
        backendMix: { anthropic: 1.0 }, // Keyed by provider prefix
        totalRuns: 3,
        seedStart: 1,
      }

      const queueUrls: Record<string, string> = {
        anthropic: "https://sqs.us-west-2.amazonaws.com/123/anthropic-queue",
      }

      // Track timing
      let canEnqueueCallCount = 0
      let schedulerStartTime = 0
      let schedulerEndTime = 0

      // Rate limiter that blocks after first job, then allows after delay
      const rateLimiter: SchedulerRateLimiterInterface = {
        canEnqueue(backend: string): boolean {
          canEnqueueCallCount++
          // Allow first job immediately, then block for a bit
          if (canEnqueueCallCount <= 1) return true
          // After some retries, allow more
          if (canEnqueueCallCount > 5) return true
          return false
        },
        trackEnqueued(_backend: string): void {
          // no-op for test
        },
      }

      schedulerStartTime = Date.now()

      // Run scheduler with a short timeout to avoid hanging
      const schedulerPromise = runScheduler(config, rateLimiter, queueUrls)

      // Add a timeout to prevent test from hanging
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Scheduler timeout")), 5000)
      })

      await Promise.race([schedulerPromise, timeoutPromise])

      schedulerEndTime = Date.now()

      // Verify scheduler waited (should have called canEnqueue multiple times)
      expect(canEnqueueCallCount).toBeGreaterThan(3)

      // Verify some time passed due to waiting (sleep(1000) in scheduler)
      const elapsed = schedulerEndTime - schedulerStartTime
      expect(elapsed).toBeGreaterThan(500) // At least some waiting occurred
    })

    test("processes jobs immediately when capacity available", async () => {
      // Backend format is "provider:model", prefix is extracted by splitting on ":"
      const config: SchedulerConfig = {
        contextLengths: [128000],
        backends: ["anthropic:claude-opus-4.5"],
        backendMix: { anthropic: 1.0 }, // Keyed by provider prefix
        totalRuns: 5,
        seedStart: 1,
      }

      const queueUrls: Record<string, string> = {
        anthropic: "https://sqs.us-west-2.amazonaws.com/123/anthropic-queue",
      }

      // Rate limiter that always allows
      const rateLimiter: SchedulerRateLimiterInterface = {
        canEnqueue(_backend: string): boolean {
          return true
        },
        trackEnqueued(_backend: string): void {
          // no-op for test
        },
      }

      const startTime = Date.now()
      await runScheduler(config, rateLimiter, queueUrls)
      const elapsed = Date.now() - startTime

      // Should complete quickly without waiting (well under 1 second)
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe("end-to-end job generation and distribution", () => {
    test("generates and routes jobs correctly", () => {
      // Backend format is "provider:model", prefix is extracted by splitting on ":"
      const config: SchedulerConfig = {
        contextLengths: [128000, 256000],
        backends: ["anthropic:claude-opus-4.5", "moonshot:kimi-k2.5"],
        backendMix: { anthropic: 0.6, moonshot: 0.4 }, // Keyed by provider prefix
        totalRuns: 10,
        seedStart: 1,
      }

      const queueUrls: Record<string, string> = {
        anthropic: "https://sqs.us-west-2.amazonaws.com/123/anthropic-queue",
        moonshot: "https://sqs.us-west-2.amazonaws.com/123/moonshot-queue",
      }

      const jobs = Array.from(generateJobs(config))

      // Verify job count and distribution
      expect(jobs.length).toBe(10)

      const anthropicJobs = jobs.filter((j) => j.backend.startsWith("anthropic"))
      const moonshotJobs = jobs.filter((j) => j.backend.startsWith("moonshot"))

      expect(anthropicJobs.length).toBe(6)
      expect(moonshotJobs.length).toBe(4)

      // Verify each job routes to correct queue
      for (const job of jobs) {
        const queueUrl = getQueueUrlForBackend(job.backend, queueUrls)
        if (job.backend.startsWith("anthropic")) {
          expect(queueUrl).toBe(queueUrls.anthropic)
        } else if (job.backend.startsWith("moonshot")) {
          expect(queueUrl).toBe(queueUrls.moonshot)
        }
      }

      // Verify context length distribution
      const contextLengthCounts: Record<number, number> = {}
      for (const job of jobs) {
        contextLengthCounts[job.context_length] = (contextLengthCounts[job.context_length] ?? 0) + 1
      }

      // Should have jobs for both context lengths
      expect(contextLengthCounts[128000]).toBeGreaterThan(0)
      expect(contextLengthCounts[256000]).toBeGreaterThan(0)
    })
  })
})
