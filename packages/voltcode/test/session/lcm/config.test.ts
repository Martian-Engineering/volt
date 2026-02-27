import { describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig } from "../../../src/session/lcm/config"

describe("parseLcmPolicyConfig", () => {
  test("parses defaults with upward mode and explicit upward controls", () => {
    const config = parseLcmPolicyConfig({})

    expect(config.mode).toBe("upward")
    expect(config.runtime.defaultCtxCutoffThreshold).toBe(0.6)
    expect(config.runtime.targetFreePercentage).toBe(0.25)
    expect(config.runtime.minMessagesToSummarize).toBe(3)
    expect(config.runtime.minProtectedTailLeaves).toBe(2)
    expect(config.runtime.criticalThresholdMultiplier).toBe(1.2)
    expect(config.runtime.maxCompactionRounds).toBe(10)
    expect(config.runtime.summaryMaxOutputTokens).toBe(2200)
    expect(config.runtime.condenseMaxOutputTokens).toBe(2200)

    expect(config.strategies.dolt.leaves).toEqual({
      soft: 50000,
      delta: 5000,
      target: 50000,
      minFanout: 2,
      cap: 50000,
      freshTailFloor: 4,
    })
    expect(config.strategies.dolt.sprigs).toEqual({
      soft: 10000,
      delta: 2000,
      target: 10000,
      minFanout: 2,
    })
    expect(config.strategies.dolt.bindles).toEqual({
      soft: 10000,
      delta: 2000,
      target: 10000,
      minFanout: 2,
    })
    expect(config.strategies.dolt.ghostCueArchiveEnabled).toBe(true)

    expect(config.strategies.upward).toEqual({
      ...config.strategies.dolt,
      leaves: {
        ...config.strategies.dolt.leaves,
        freshTailFloor: 32,
      },
      ghostCueArchiveEnabled: false,
    })
    expect(config.upward).toEqual({
      contextThreshold: 0.75,
      freshTailCount: 32,
      leafChunkTokens: 20000,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      condensedTargetTokens: 2000,
    })
  })

  test("supports mode, lane, and upward override keys with typed output shape", () => {
    const config = parseLcmPolicyConfig({
      VOLTCODE_LCM_MODE: "upward",
      VOLTCODE_LCM_DEFAULT_CTX_CUTOFF_THRESHOLD: "0.7",
      VOLTCODE_LCM_TARGET_FREE_PERCENTAGE: "0.3",
      VOLTCODE_LCM_DOLT_BINDLES_SOFT: "11000",
      VOLTCODE_LCM_UPWARD_BINDLES_SOFT: "14000",
      VOLTCODE_LCM_UPWARD_BINDLES_DELTA: "2500",
      VOLTCODE_LCM_UPWARD_BINDLES_TARGET: "12000",
      VOLTCODE_LCM_UPWARD_BINDLES_MIN_FANOUT: "3",
      VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS: "15000",
      VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT: "6",
      VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT: "5",
      VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT_HARD: "3",
      VOLTCODE_LCM_UPWARD_CONDENSED_TARGET_TOKENS: "2400",
      VOLTCODE_LCM_UPWARD_CONTEXT_THRESHOLD: "0.65",
      VOLTCODE_LCM_UPWARD_FRESH_TAIL_COUNT: "12",
    })

    expect(config.mode).toBe("upward")
    expect(config.runtime.defaultCtxCutoffThreshold).toBe(0.7)
    expect(config.runtime.targetFreePercentage).toBe(0.3)

    expect(config.strategies.dolt.bindles.soft).toBe(11000)
    expect(config.strategies.upward.bindles).toEqual({
      soft: 14000,
      delta: 2500,
      target: 12000,
      minFanout: 3,
    })
    expect(config.strategies.upward.ghostCueArchiveEnabled).toBe(false)
    expect(config.upward).toEqual({
      contextThreshold: 0.65,
      freshTailCount: 12,
      leafChunkTokens: 15000,
      leafMinFanout: 6,
      condensedMinFanout: 5,
      condensedMinFanoutHard: 3,
      condensedTargetTokens: 2400,
    })
  })

  test("supports dolt ghost cue toggle while keeping upward ghost cue archival disabled", () => {
    const config = parseLcmPolicyConfig({
      VOLTCODE_LCM_DOLT_GHOST_CUE_ARCHIVE_ENABLED: "false",
      VOLTCODE_LCM_UPWARD_GHOST_CUE_ARCHIVE_ENABLED: "true",
    })

    expect(config.strategies.dolt.ghostCueArchiveEnabled).toBe(false)
    expect(config.strategies.upward.ghostCueArchiveEnabled).toBe(false)
  })

  test("fails fast on invalid mode", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_MODE: "legacy",
      }),
    ).toThrow("VOLTCODE_LCM_MODE")
  })

  test("fails fast on negative thresholds", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_DOLT_LEAVES_SOFT: "-1",
      }),
    ).toThrow("VOLTCODE_LCM_DOLT_LEAVES_SOFT")
  })

  test("fails fast when lane delta is zero", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_DOLT_BINDLES_DELTA: "0",
      }),
    ).toThrow("VOLTCODE_LCM_DOLT_BINDLES_DELTA")
  })

  test("fails fast when lane min fanout is below 2", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_DOLT_SPRIGS_MIN_FANOUT: "1",
      }),
    ).toThrow("VOLTCODE_LCM_DOLT_SPRIGS_MIN_FANOUT")
  })

  test("fails fast on invalid ghost cue archive boolean", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_DOLT_GHOST_CUE_ARCHIVE_ENABLED: "maybe",
      }),
    ).toThrow("VOLTCODE_LCM_DOLT_GHOST_CUE_ARCHIVE_ENABLED")
  })

  test("fails fast on invalid upward control values", () => {
    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS: "0",
      }),
    ).toThrow("VOLTCODE_LCM_UPWARD_LEAF_CHUNK_TOKENS")

    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT: "-1",
      }),
    ).toThrow("VOLTCODE_LCM_UPWARD_LEAF_MIN_FANOUT")

    expect(() =>
      parseLcmPolicyConfig({
        VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT: "NaN",
      }),
    ).toThrow("VOLTCODE_LCM_UPWARD_CONDENSED_MIN_FANOUT")
  })
})
