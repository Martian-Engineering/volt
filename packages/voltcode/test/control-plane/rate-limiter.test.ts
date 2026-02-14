import { describe, expect, test } from "bun:test"
import { RateLimiter } from "../../src/control-plane/rate-limiter"

describe("RateLimiter", () => {
  describe("canEnqueue", () => {
    test("returns true when under limit", () => {
      const limiter = new RateLimiter({ openai: 5 })
      expect(limiter.canEnqueue("openai")).toBe(true)
    })

    test("returns false when at limit", () => {
      const limiter = new RateLimiter({ openai: 2 })
      limiter.trackEnqueued("openai")
      limiter.trackEnqueued("openai")
      expect(limiter.canEnqueue("openai")).toBe(false)
    })

    test("returns true for unknown backend (no limit configured)", () => {
      const limiter = new RateLimiter({ openai: 5 })
      expect(limiter.canEnqueue("unknown")).toBe(true)
    })
  })

  describe("trackEnqueued", () => {
    test("increments count", () => {
      const limiter = new RateLimiter({ openai: 10 })
      expect(limiter.getInFlight("openai")).toBe(0)
      limiter.trackEnqueued("openai")
      expect(limiter.getInFlight("openai")).toBe(1)
      limiter.trackEnqueued("openai")
      expect(limiter.getInFlight("openai")).toBe(2)
    })
  })

  describe("trackCompleted", () => {
    test("decrements count", () => {
      const limiter = new RateLimiter({ openai: 10 })
      limiter.trackEnqueued("openai")
      limiter.trackEnqueued("openai")
      expect(limiter.getInFlight("openai")).toBe(2)
      limiter.trackCompleted("openai")
      expect(limiter.getInFlight("openai")).toBe(1)
    })

    test("does not go below zero", () => {
      const limiter = new RateLimiter({ openai: 10 })
      limiter.trackCompleted("openai")
      expect(limiter.getInFlight("openai")).toBe(0)
    })
  })

  describe("multiple backends", () => {
    test("tracks independently", () => {
      const limiter = new RateLimiter({
        openai: 5,
        anthropic: 3,
        moonshot: 2,
      })

      limiter.trackEnqueued("openai")
      limiter.trackEnqueued("openai")
      limiter.trackEnqueued("anthropic")

      expect(limiter.getInFlight("openai")).toBe(2)
      expect(limiter.getInFlight("anthropic")).toBe(1)
      expect(limiter.getInFlight("moonshot")).toBe(0)

      expect(limiter.canEnqueue("openai")).toBe(true)
      expect(limiter.canEnqueue("anthropic")).toBe(true)
      expect(limiter.canEnqueue("moonshot")).toBe(true)

      limiter.trackEnqueued("moonshot")
      limiter.trackEnqueued("moonshot")
      expect(limiter.canEnqueue("moonshot")).toBe(false)
      expect(limiter.canEnqueue("openai")).toBe(true)
    })
  })

  describe("getInFlight", () => {
    test("returns correct count", () => {
      const limiter = new RateLimiter({ openai: 10, anthropic: 10 })

      expect(limiter.getInFlight("openai")).toBe(0)
      expect(limiter.getInFlight("anthropic")).toBe(0)

      limiter.trackEnqueued("openai")
      limiter.trackEnqueued("openai")
      limiter.trackEnqueued("openai")

      expect(limiter.getInFlight("openai")).toBe(3)
      expect(limiter.getInFlight("anthropic")).toBe(0)
    })

    test("returns 0 for unknown backend", () => {
      const limiter = new RateLimiter({ openai: 10 })
      expect(limiter.getInFlight("unknown")).toBe(0)
    })
  })
})
