import { afterEach, describe, expect, test } from "bun:test"
import { TokenBudget } from "../../src/session/token-budget"

const DOLT_POLICY_ENV_KEYS = [
  "VOLTCODE_LCM_DOLT_TURNS_CAP",
  "VOLTCODE_LCM_DOLT_TURNS_SOFT",
  "VOLTCODE_LCM_DOLT_TURNS_DELTA",
  "VOLTCODE_LCM_DOLT_TURNS_TARGET",
  "VOLTCODE_LCM_DOLT_TURNS_FRESH_TAIL_FLOOR",
  "VOLTCODE_LCM_DOLT_LEAVES_SOFT",
  "VOLTCODE_LCM_DOLT_LEAVES_DELTA",
  "VOLTCODE_LCM_DOLT_LEAVES_TARGET",
  "VOLTCODE_LCM_DOLT_BINDLES_SOFT",
  "VOLTCODE_LCM_DOLT_BINDLES_DELTA",
  "VOLTCODE_LCM_DOLT_BINDLES_TARGET",
  "VOLTCODE_LCM_DOLT_HARD_LIMIT_RISK_BUFFER",
] as const

const originalEnv = new Map<string, string | undefined>()
for (const key of DOLT_POLICY_ENV_KEYS) {
  originalEnv.set(key, process.env[key])
}

afterEach(() => {
  for (const key of DOLT_POLICY_ENV_KEYS) {
    const original = originalEnv.get(key)
    if (original === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = original
  }
})

describe("TokenBudget.computeDoltLanePolicy", () => {
  test("uses explicit Dolt defaults for turns and pagedrop defaults for bindles/leaves", () => {
    const policy = TokenBudget.computeDoltLanePolicy({ hardLimit: 120000 })

    expect(policy.bindles).toEqual({ soft: 10000, delta: 1000, target: 9000 })
    expect(policy.leaves).toEqual({ soft: 20000, delta: 2000, target: 18000 })
    expect(policy.turns.cap).toBe(30000)
    expect(policy.turns.soft).toBe(30000)
    expect(policy.turns.delta).toBe(0)
    expect(policy.turns.target).toBe(30000)
    expect(policy.turns.freshTailFloor).toBe(4)
  })

  test("clamps explicit turns defaults to hard limit", () => {
    const policy = TokenBudget.computeDoltLanePolicy({ hardLimit: 25000 })

    expect(policy.turns.cap).toBe(25000)
    expect(policy.turns.soft).toBe(25000)
    expect(policy.turns.target).toBe(25000)
  })

  test("supports env overrides and clamps turns to cap", () => {
    process.env.VOLTCODE_LCM_DOLT_TURNS_CAP = "45000"
    process.env.VOLTCODE_LCM_DOLT_TURNS_SOFT = "50000"
    process.env.VOLTCODE_LCM_DOLT_TURNS_TARGET = "60000"
    process.env.VOLTCODE_LCM_DOLT_TURNS_DELTA = "1200"
    process.env.VOLTCODE_LCM_DOLT_TURNS_FRESH_TAIL_FLOOR = "6"
    process.env.VOLTCODE_LCM_DOLT_LEAVES_SOFT = "25000"
    process.env.VOLTCODE_LCM_DOLT_LEAVES_DELTA = "3000"
    process.env.VOLTCODE_LCM_DOLT_LEAVES_TARGET = "22000"
    process.env.VOLTCODE_LCM_DOLT_BINDLES_SOFT = "14000"
    process.env.VOLTCODE_LCM_DOLT_BINDLES_DELTA = "1500"
    process.env.VOLTCODE_LCM_DOLT_BINDLES_TARGET = "12000"
    process.env.VOLTCODE_LCM_DOLT_HARD_LIMIT_RISK_BUFFER = "500"

    const policy = TokenBudget.computeDoltLanePolicy({ hardLimit: 90000 })

    expect(policy.turns.cap).toBe(45000)
    expect(policy.turns.soft).toBe(45000)
    expect(policy.turns.target).toBe(45000)
    expect(policy.turns.delta).toBe(1200)
    expect(policy.turns.freshTailFloor).toBe(6)
    expect(policy.leaves).toEqual({ soft: 25000, delta: 3000, target: 22000 })
    expect(policy.bindles).toEqual({ soft: 14000, delta: 1500, target: 12000 })
    expect(policy.hardLimitRiskBuffer).toBe(500)
  })
})

describe("TokenBudget.evaluateDoltLaneDecisions", () => {
  const policy: TokenBudget.DoltLanePolicy = {
    turns: { cap: 1000, soft: 800, delta: 100, target: 780, freshTailFloor: 4 },
    leaves: { soft: 200, delta: 20, target: 180 },
    bindles: { soft: 100, delta: 10, target: 90 },
    hardLimitRiskBuffer: 0,
  }

  test("no-ops at soft + delta boundary", () => {
    const decisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { turns: 900, leaves: 220, bindles: 110, total: 900 },
      policy,
      hardLimit: 1000,
    })

    expect(decisions.turns.overUpperBand).toBe(false)
    expect(decisions.turns.shouldCompact).toBe(false)
    expect(decisions.leaves.overUpperBand).toBe(false)
    expect(decisions.leaves.shouldCompact).toBe(false)
    expect(decisions.bindles.overUpperBand).toBe(false)
    expect(decisions.bindles.shouldCompact).toBe(false)
  })

  test("compacts when lane tokens exceed upper band", () => {
    const decisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { turns: 901, leaves: 221, bindles: 111, total: 901 },
      policy,
      hardLimit: 1000,
    })

    expect(decisions.turns.overUpperBand).toBe(true)
    expect(decisions.turns.shouldCompact).toBe(true)
    expect(decisions.leaves.overUpperBand).toBe(true)
    expect(decisions.leaves.shouldCompact).toBe(true)
    expect(decisions.bindles.overUpperBand).toBe(true)
    expect(decisions.bindles.shouldCompact).toBe(true)
    expect(decisions.compactAny).toBe(true)
  })

  test("bypasses hysteresis under hard-limit risk when lane is above target", () => {
    const decisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { turns: 850, leaves: 190, bindles: 95, total: 950 },
      policy: {
        ...policy,
        hardLimitRiskBuffer: 100,
      },
      hardLimit: 1000,
    })

    expect(decisions.hardLimitRisk).toBe(true)
    expect(decisions.turns.overUpperBand).toBe(false)
    expect(decisions.turns.overTarget).toBe(true)
    expect(decisions.turns.bypassedHysteresis).toBe(true)
    expect(decisions.turns.shouldCompact).toBe(true)
  })

  test("continues compaction between target and upper band when latched", () => {
    const decisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { turns: 850, leaves: 180, bindles: 90, total: 850 },
      policy,
      hardLimit: 1000,
      currentlyCompacting: { turns: true },
    })

    expect(decisions.hardLimitRisk).toBe(false)
    expect(decisions.turns.overUpperBand).toBe(false)
    expect(decisions.turns.overTarget).toBe(true)
    expect(decisions.turns.bypassedHysteresis).toBe(false)
    expect(decisions.turns.shouldCompact).toBe(true)
    expect(decisions.nextCompacting.turns).toBe(true)
  })

  test("does not continue compaction between target and upper band when not latched", () => {
    const decisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { turns: 850, leaves: 180, bindles: 90, total: 850 },
      policy,
      hardLimit: 1000,
    })

    expect(decisions.turns.overUpperBand).toBe(false)
    expect(decisions.turns.overTarget).toBe(true)
    expect(decisions.turns.shouldCompact).toBe(false)
    expect(decisions.nextCompacting.turns).toBe(false)
  })

  test("does not compact when lane is at target without hard-limit risk", () => {
    const decisions = TokenBudget.evaluateDoltLaneDecisions({
      laneTokens: { turns: 780, leaves: 180, bindles: 90, total: 780 },
      policy,
      hardLimit: 1000,
      currentlyCompacting: { turns: true, leaves: true, bindles: true },
    })

    expect(decisions.turns.overTarget).toBe(false)
    expect(decisions.turns.shouldCompact).toBe(false)
    expect(decisions.leaves.overTarget).toBe(false)
    expect(decisions.leaves.shouldCompact).toBe(false)
    expect(decisions.bindles.overTarget).toBe(false)
    expect(decisions.bindles.shouldCompact).toBe(false)
    expect(decisions.nextCompacting.turns).toBe(false)
    expect(decisions.compactAny).toBe(false)
  })
})
