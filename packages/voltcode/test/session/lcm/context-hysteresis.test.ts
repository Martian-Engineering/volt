import { afterEach, describe, expect, test } from "bun:test"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmDb } from "../../../src/session/lcm/db"
import type { TokenBudget } from "../../../src/session/token-budget"

afterEach(() => {
  setLcmPolicyConfigForTesting(null)
  LcmContext.clearLaneCompactionStateForTesting()
})

describe("LcmContext hysteresis continuation wiring", () => {
  test("continues compaction between upper band and target when lane was already compacting", async () => {
    const conversationId = 4242
    setLcmPolicyConfigForTesting(
      parseLcmPolicyConfig({
        VOLTCODE_LCM_MODE: "dolt",
        VOLTCODE_LCM_DOLT_LEAVES_SOFT: "800",
        VOLTCODE_LCM_DOLT_LEAVES_DELTA: "100",
        VOLTCODE_LCM_DOLT_LEAVES_TARGET: "780",
        VOLTCODE_LCM_DOLT_LEAVES_CAP: "1000",
        VOLTCODE_LCM_DOLT_SPRIGS_SOFT: "200",
        VOLTCODE_LCM_DOLT_SPRIGS_DELTA: "20",
        VOLTCODE_LCM_DOLT_SPRIGS_TARGET: "180",
        VOLTCODE_LCM_DOLT_BINDLES_SOFT: "100",
        VOLTCODE_LCM_DOLT_BINDLES_DELTA: "10",
        VOLTCODE_LCM_DOLT_BINDLES_TARGET: "90",
        VOLTCODE_LCM_DOLT_HARD_LIMIT_RISK_BUFFER: "0",
      }),
    )

    let laneTokens: TokenBudget.LaneTokenCounts = {
      leaves: 901,
      sprigs: 0,
      bindles: 0,
      total: 901,
    }

    const originalGetContextTokenCount = LcmDb.getContextTokenCount
    const originalGetContextLaneTokenCounts = LcmDb.getContextLaneTokenCounts
    ;(LcmDb as any).getContextTokenCount = async () => laneTokens.total
    ;(LcmDb as any).getContextLaneTokenCounts = async () => laneTokens

    try {
      const first = await LcmContext.isOverThreshold({
        conversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: 1000,
      })
      expect(first.laneDecisions.leaves.overUpperBand).toBe(true)
      expect(first.laneDecisions.leaves.shouldCompact).toBe(true)

      laneTokens = {
        leaves: 850,
        sprigs: 0,
        bindles: 0,
        total: 850,
      }
      const second = await LcmContext.isOverThreshold({
        conversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: 1000,
      })
      expect(second.laneDecisions.leaves.overUpperBand).toBe(false)
      expect(second.laneDecisions.leaves.overTarget).toBe(true)
      expect(second.laneDecisions.currentlyCompacting.leaves).toBe(true)
      expect(second.laneDecisions.leaves.shouldCompact).toBe(true)

      laneTokens = {
        leaves: 780,
        sprigs: 0,
        bindles: 0,
        total: 780,
      }
      const third = await LcmContext.isOverThreshold({
        conversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: 1000,
      })
      expect(third.laneDecisions.leaves.overTarget).toBe(false)
      expect(third.laneDecisions.leaves.shouldCompact).toBe(false)

      laneTokens = {
        leaves: 850,
        sprigs: 0,
        bindles: 0,
        total: 850,
      }
      const fourth = await LcmContext.isOverThreshold({
        conversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: 1000,
      })
      expect(fourth.laneDecisions.currentlyCompacting.leaves).toBe(false)
      expect(fourth.laneDecisions.leaves.overUpperBand).toBe(false)
      expect(fourth.laneDecisions.leaves.overTarget).toBe(true)
      expect(fourth.laneDecisions.leaves.shouldCompact).toBe(false)
    } finally {
      ;(LcmDb as any).getContextTokenCount = originalGetContextTokenCount
      ;(LcmDb as any).getContextLaneTokenCounts = originalGetContextLaneTokenCounts
    }
  })
})
