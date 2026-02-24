import { afterEach, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import {
  getActiveLcmRuntimeStrategy,
  isThresholdCompactionInFlight,
  scheduleThresholdCompaction,
  setLcmRuntimeStrategyFactoriesForTesting,
  type LcmRuntimeStrategy,
} from "../../../src/session/lcm/strategy"

const basePolicy = parseLcmPolicyConfig({})

function makePolicy(mode: string) {
  return {
    ...basePolicy,
    mode,
  } as any
}

function makeStubStrategy(input: {
  name: "dolt" | "upward"
  compactOnThreshold?: LcmRuntimeStrategy["compactOnThreshold"]
}): LcmRuntimeStrategy {
  return {
    name: input.name,
    compactOnThreshold:
      input.compactOnThreshold ??
      (async () => ({
        actionTaken: false,
        condensed: false,
      })),
    compactManual: async () => ({
      actionTaken: false,
      condensed: false,
    }),
    assembleContext: async () => [],
    resolveRetrieval: async (request) => ({
      query: request.query,
      topK: request.topK ?? 3,
      minScore: request.minScore ?? 0.3,
      maxDistance: request.maxDistance,
      candidatesConsidered: 0,
      hits: [],
    }),
  }
}

afterEach(() => {
  setLcmRuntimeStrategyFactoriesForTesting(null)
  setLcmPolicyConfigForTesting(null)
})

describe("LCM runtime strategy", () => {
  test("dispatches dolt mode to dolt strategy", async () => {
    let doltCalls = 0
    let upwardCalls = 0

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactOnThreshold: async () => {
            doltCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
      upward: () =>
        makeStubStrategy({
          name: "upward",
          compactOnThreshold: async () => {
            upwardCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("dolt"))

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("dolt")

    await strategy.compactOnThreshold({} as any)
    expect(doltCalls).toBe(1)
    expect(upwardCalls).toBe(0)
  })

  test("dispatches upward mode to upward strategy", async () => {
    let doltCalls = 0
    let upwardCalls = 0

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactOnThreshold: async () => {
            doltCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
      upward: () =>
        makeStubStrategy({
          name: "upward",
          compactOnThreshold: async () => {
            upwardCalls += 1
            return { actionTaken: true, condensed: false }
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("upward"))

    const strategy = getActiveLcmRuntimeStrategy()
    expect(strategy.name).toBe("upward")

    await strategy.compactOnThreshold({} as any)
    expect(upwardCalls).toBe(1)
    expect(doltCalls).toBe(0)
  })

  test("fails fast on unsupported mode", () => {
    setLcmPolicyConfigForTesting(makePolicy("legacy"))
    expect(() => getActiveLcmRuntimeStrategy()).toThrow("Unsupported LCM runtime mode")
  })

  test("de-duplicates in-flight threshold compaction per conversation", async () => {
    let resolveCompaction!: (value: { actionTaken: boolean; condensed: boolean }) => void

    setLcmRuntimeStrategyFactoriesForTesting({
      dolt: () =>
        makeStubStrategy({
          name: "dolt",
          compactOnThreshold: async () => {
            return await new Promise<{ actionTaken: boolean; condensed: boolean }>((resolve) => {
              resolveCompaction = resolve
            })
          },
        }),
    })
    setLcmPolicyConfigForTesting(makePolicy("dolt"))

    const first = scheduleThresholdCompaction({ conversationId: 42 } as any)
    expect(first).not.toBeNull()
    expect(isThresholdCompactionInFlight(42)).toBe(true)

    const second = scheduleThresholdCompaction({ conversationId: 42 } as any)
    expect(second).toBeNull()

    resolveCompaction({ actionTaken: false, condensed: false })
    await first

    expect(isThresholdCompactionInFlight(42)).toBe(false)
  })
})
