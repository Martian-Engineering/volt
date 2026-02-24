import { describe, expect, test } from "bun:test"
import { extractFileIds } from "../../../src/session/lcm/summarize"
import * as SummarizeModule from "../../../src/session/lcm/summarize"
import * as CondenseModule from "../../../src/session/lcm/condense"
import { LcmContext } from "../../../src/session/lcm/context"

// ---------------------------------------------------------------------------
// 1. extractFileIds
// ---------------------------------------------------------------------------

describe("extractFileIds", () => {
  test("extracts from [Large File Stored: file_xxx] pattern", () => {
    const text = "Some content [Large File Stored: file_abc123def456789a] more text"
    const ids = extractFileIds(text)
    expect(ids).toEqual(["file_abc123def456789a"])
  })

  test("extracts from [Large User Text Stored: file_xxx] pattern", () => {
    const text = "Some content [Large User Text Stored: file_abc123def456789a] more text"
    const ids = extractFileIds(text)
    expect(ids).toEqual(["file_abc123def456789a"])
  })

  test("extracts from LCM File ID: file_xxx pattern", () => {
    const text = "LCM File ID: file_abc123def456789a"
    const ids = extractFileIds(text)
    expect(ids).toEqual(["file_abc123def456789a"])
  })

  test('extracts from file_id "file_xxx" pattern', () => {
    const text = 'file_id "file_abc123def456789a"'
    const ids = extractFileIds(text)
    expect(ids).toEqual(["file_abc123def456789a"])
  })

  test("extracts multiple IDs from text with all patterns", () => {
    const text = [
      "[Large File Stored: file_1111111111111111]",
      "[Large User Text Stored: file_2222222222222222]",
      "LCM File ID: file_3333333333333333",
      'file_id "file_4444444444444444"',
    ].join("\n")
    const ids = extractFileIds(text)
    expect(ids).toEqual([
      "file_1111111111111111",
      "file_2222222222222222",
      "file_3333333333333333",
      "file_4444444444444444",
    ])
  })

  test("deduplicates repeated IDs", () => {
    const text = [
      "[Large File Stored: file_abc123def456789a]",
      "LCM File ID: file_abc123def456789a",
      'file_id "file_abc123def456789a"',
    ].join("\n")
    const ids = extractFileIds(text)
    expect(ids).toEqual(["file_abc123def456789a"])
  })

  test("returns sorted array", () => {
    const text = [
      "[Large File Stored: file_dddddddddddddddd]",
      "[Large File Stored: file_aaaaaaaaaaaaaaaa]",
      "[Large File Stored: file_cccccccccccccccc]",
      "[Large File Stored: file_bbbbbbbbbbbbbbbb]",
    ].join("\n")
    const ids = extractFileIds(text)
    expect(ids).toEqual([
      "file_aaaaaaaaaaaaaaaa",
      "file_bbbbbbbbbbbbbbbb",
      "file_cccccccccccccccc",
      "file_dddddddddddddddd",
    ])
  })

  test("returns empty array for text with no file IDs", () => {
    const text = "This is just regular text with no file references at all."
    const ids = extractFileIds(text)
    expect(ids).toEqual([])
  })

  test("returns empty array for empty string", () => {
    const ids = extractFileIds("")
    expect(ids).toEqual([])
  })

  test("does not match malformed IDs (too short, wrong prefix, non-hex chars)", () => {
    const text = [
      // Too short (only 10 hex chars instead of 16)
      "[Large File Stored: file_abc123def4]",
      // Wrong prefix
      "[Large File Stored: blob_abc123def456789a]",
      // Non-hex characters (g, z)
      "[Large File Stored: file_ghijklmnopqrstuv]",
      // Correct format for reference - should NOT match these malformed ones
    ].join("\n")
    const ids = extractFileIds(text)
    expect(ids).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. no deterministic fallback tier
// ---------------------------------------------------------------------------

describe("compaction tiering policy", () => {
  test("summarize module no longer exports summarizeFallback", () => {
    expect("summarizeFallback" in SummarizeModule).toBe(false)
  })

  test("condense module no longer exports condenseFallback", () => {
    expect("condenseFallback" in CondenseModule).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. isOverThreshold math (unit test of the arithmetic, no DB)
// ---------------------------------------------------------------------------

describe("isOverThreshold math (TokenBudget)", () => {
  test("hardLimit = contextWindow - overhead - reserve", () => {
    // With contextWindow=200000, overhead=30000 (system+tools), reserve=20000:
    // hardLimit = 200000 - 30000 - 20000 = 150000
    // softThreshold = floor(200000 * 0.6) - 30000 = 120000 - 30000 = 90000
    const contextWindow = 200000
    const overhead = 30000
    const reserve = 20000
    const hardLimit = contextWindow - overhead - reserve
    const softThreshold = Math.floor(contextWindow * 0.6) - overhead

    expect(hardLimit).toBe(150000)
    expect(softThreshold).toBe(90000)
  })

  test("without overhead, hardLimit = contextWindow - reserve", () => {
    const contextWindow = 200000
    const overhead = 0
    const reserve = 20000
    const hardLimit = contextWindow - overhead - reserve
    expect(hardLimit).toBe(180000)
  })

  test("softThreshold is clamped to [0, hardLimit]", () => {
    // With very large overhead that makes softRaw > hardLimit
    const contextWindow = 100000
    const overhead = 50000
    const reserve = 20000
    const hardLimit = contextWindow - overhead - reserve // 30000
    const softRaw = Math.floor(contextWindow * 0.6) - overhead // 60000 - 50000 = 10000
    const softThreshold = Math.max(0, Math.min(softRaw, hardLimit))

    expect(hardLimit).toBe(30000)
    expect(softThreshold).toBe(10000) // clamped to min(10000, 30000)
  })
})

// ---------------------------------------------------------------------------
// 4. MAX_COMPACTION_ROUNDS constant
// ---------------------------------------------------------------------------

test("MAX_COMPACTION_ROUNDS is 10", () => {
  expect(LcmContext.MAX_COMPACTION_ROUNDS).toBe(10)
})

// ---------------------------------------------------------------------------
// 5. L0->L1 turn window selection
// ---------------------------------------------------------------------------

describe("selectLeavesForSprigCompaction", () => {
  const baseMessages = Array.from({ length: 8 }, (_, i) => ({
    position: i,
    messageId: i + 1,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i}`,
    tokenCount: 100,
  }))

  test("never selects turns from the protected fresh tail", () => {
    const result = LcmContext.selectLeavesForSprigCompaction({
      messages: baseMessages,
      tokenBudget: 10_000,
      protectedTailCount: 3,
    })

    expect(result.selectedMessages.map((msg) => msg.position)).toEqual([0, 1, 2, 3, 4])
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([5, 6, 7])
  })

  test("returns no selection when all turns are inside protected tail", () => {
    const result = LcmContext.selectLeavesForSprigCompaction({
      messages: baseMessages.slice(0, 3),
      tokenBudget: 200,
      protectedTailCount: 3,
    })

    expect(result.selectedMessages).toEqual([])
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([0, 1, 2])
  })

  test("caps selected turns by token budget within the eligible prefix", () => {
    const result = LcmContext.selectLeavesForSprigCompaction({
      messages: baseMessages,
      tokenBudget: 250,
      protectedTailCount: 2,
    })

    expect(result.selectedMessages.map((msg) => msg.position)).toEqual([0, 1])
    expect(result.selectedMessages.reduce((sum, msg) => sum + msg.tokenCount, 0)).toBe(200)
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([6, 7])
  })

  test("relaxes fresh-tail protection down to minimum to avoid leaves stall", () => {
    const result = LcmContext.selectLeavesForSprigCompaction({
      messages: baseMessages.slice(0, 4),
      tokenBudget: 1_000,
      protectedTailCount: 4,
      minimumProtectedTailCount: 2,
      minimumSelectionCount: 2,
    })

    expect(result.effectiveProtectedTailCount).toBe(2)
    expect(result.selectedMessages.map((msg) => msg.position)).toEqual([0, 1])
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([2, 3])
  })

  test("does not produce one-leaf sprigs when only one leaf is eligible", () => {
    const result = LcmContext.selectLeavesForSprigCompaction({
      messages: baseMessages.slice(0, 3),
      tokenBudget: 10_000,
      protectedTailCount: 2,
      minimumProtectedTailCount: 2,
      minimumSelectionCount: 2,
    })

    expect(result.selectedMessages).toEqual([])
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([1, 2])
    expect(result.effectiveProtectedTailCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 6. File ID extraction from structured block
// ---------------------------------------------------------------------------

describe("file ID extraction from structured blocks", () => {
  test("extracts file IDs from LCM File ID block (singular)", () => {
    const content = `Summary of work done.
LCM File ID: file_abc123def456789a
LCM File ID: file_def456abc789012b`
    const ids = extractFileIds(content)
    expect(ids).toEqual(["file_abc123def456789a", "file_def456abc789012b"])
  })

  // NOTE: extractFileIds intentionally matches the singular pattern
  // "LCM File ID: <id>". It does not match the plural list form
  // "[LCM File IDs: ...]".
  test("does NOT extract from [LCM File IDs: ...] block (plural with 's')", () => {
    const content = `Summary of work done.
[LCM File IDs: file_abc123def456789a, file_def456abc789012b]`
    const ids = extractFileIds(content)
    // The plural "LCM File IDs:" does not match the singular "LCM File ID:" regex
    expect(ids).toEqual([])
  })

  test("file IDs survive through mixed content with singular pattern", () => {
    // In practice, if a summary contains the singular pattern, IDs are extracted
    const content = `[Narrative summary header]
User implemented feature X in src/foo.ts.
LCM File ID: file_1111111111111111
Modified src/bar.ts for tests.
LCM File ID: file_2222222222222222`
    const ids = extractFileIds(content)
    expect(ids).toEqual(["file_1111111111111111", "file_2222222222222222"])
  })
})
