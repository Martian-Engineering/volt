import { describe, expect, test } from "bun:test"
import { extractFileIds } from "../../../src/session/lcm/summarize"
import { LcmSummarize } from "../../../src/session/lcm/summarize"
import { Token } from "../../../src/util/token"
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
// 2. summarizeFallback convergence
// ---------------------------------------------------------------------------

describe("summarizeFallback convergence", () => {
  // FALLBACK_MAX_TOKENS = 512, so maxChars = 512 * 4 = 2048
  const FALLBACK_MAX_CHARS = 2048

  test("fallback truncation produces fewer tokens than large input", () => {
    const largeText = "x".repeat(10000)
    const inputTokens = Token.estimate(largeText)

    // Simulate what summarizeFallback does: truncate to 2048 chars + metadata
    const truncated = largeText.slice(0, FALLBACK_MAX_CHARS)
    const metadata = "\n[LCM File IDs: file_abc123def456789a]\n[Truncated from 2500 tokens to 512 tokens]"
    const fallbackOutput = truncated + metadata
    const outputTokens = Token.estimate(fallbackOutput)

    expect(outputTokens).toBeLessThan(inputTokens)
  })

  test("fallback output is bounded regardless of input size", () => {
    // Even with enormous input, the output is capped
    const hugeText = "a".repeat(1_000_000)
    const inputTokens = Token.estimate(hugeText)

    const truncated = hugeText.slice(0, FALLBACK_MAX_CHARS)
    const metadata = "\n[Truncated from 250000 tokens to 512 tokens]"
    const fallbackOutput = truncated + metadata
    const outputTokens = Token.estimate(fallbackOutput)

    // Output should be roughly 512 + small metadata overhead
    expect(outputTokens).toBeLessThan(700)
    expect(outputTokens).toBeLessThan(inputTokens)
  })
})

// ---------------------------------------------------------------------------
// 3. condenseFallback convergence
// ---------------------------------------------------------------------------

describe("condenseFallback convergence", () => {
  const FALLBACK_MAX_CHARS = 2048

  test("combining N summaries then truncating produces fewer tokens", () => {
    // Simulate 5 summaries of ~1000 tokens each (4000 chars each)
    const summaries = Array.from({ length: 5 }, (_, i) => `Summary ${i}: ${"y".repeat(4000)}`)
    const combinedContent = summaries.join("\n\n")
    const inputTokens = Token.estimate(combinedContent)

    // Simulate what condenseFallback does
    const truncated = combinedContent.slice(0, FALLBACK_MAX_CHARS)
    const metadataBlock = [
      "[Summary IDs: sum_aaaaaaaaaaaaaaaa, sum_bbbbbbbbbbbbbbbb]",
      "[LCM File IDs: none]",
      `[Truncated from ${inputTokens} tokens]`,
    ].join("\n")
    const fallbackOutput = `${truncated}\n\n${metadataBlock}`
    const outputTokens = Token.estimate(fallbackOutput)

    expect(outputTokens).toBeLessThan(inputTokens)
  })

  test("condenseFallback output bounded even with many large summaries", () => {
    // 20 summaries of ~5000 tokens each
    const summaries = Array.from({ length: 20 }, (_, i) => `Summary ${i}: ${"z".repeat(20000)}`)
    const combinedContent = summaries.join("\n\n")
    const inputTokens = Token.estimate(combinedContent)

    const truncated = combinedContent.slice(0, FALLBACK_MAX_CHARS)
    const metadataBlock = [
      "[Summary IDs: sum_aaaaaaaaaaaaaaaa]",
      "[LCM File IDs: file_abc123def456789a]",
      `[Truncated from ${inputTokens} tokens]`,
    ].join("\n")
    const fallbackOutput = `${truncated}\n\n${metadataBlock}`
    const outputTokens = Token.estimate(fallbackOutput)

    // Output should be bounded around 512 + metadata overhead
    expect(outputTokens).toBeLessThan(800)
    expect(outputTokens).toBeLessThan(inputTokens)
  })
})

// ---------------------------------------------------------------------------
// 4. isOverThreshold math (unit test of the arithmetic, no DB)
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
// 5. MAX_COMPACTION_ROUNDS constant
// ---------------------------------------------------------------------------

test("MAX_COMPACTION_ROUNDS is 10", () => {
  expect(LcmContext.MAX_COMPACTION_ROUNDS).toBe(10)
})

// ---------------------------------------------------------------------------
// 6. L0->L1 turn window selection
// ---------------------------------------------------------------------------

describe("selectTurnsForLeafCompaction", () => {
  const baseMessages = Array.from({ length: 8 }, (_, i) => ({
    position: i,
    messageId: i + 1,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i}`,
    tokenCount: 100,
  }))

  test("never selects turns from the protected fresh tail", () => {
    const result = LcmContext.selectTurnsForLeafCompaction({
      messages: baseMessages,
      tokenBudget: 10_000,
      protectedTailCount: 3,
    })

    expect(result.selectedMessages.map((msg) => msg.position)).toEqual([0, 1, 2, 3, 4])
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([5, 6, 7])
  })

  test("returns no selection when all turns are inside protected tail", () => {
    const result = LcmContext.selectTurnsForLeafCompaction({
      messages: baseMessages.slice(0, 3),
      tokenBudget: 200,
      protectedTailCount: 3,
    })

    expect(result.selectedMessages).toEqual([])
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([0, 1, 2])
  })

  test("caps selected turns by token budget within the eligible prefix", () => {
    const result = LcmContext.selectTurnsForLeafCompaction({
      messages: baseMessages,
      tokenBudget: 250,
      protectedTailCount: 2,
    })

    expect(result.selectedMessages.map((msg) => msg.position)).toEqual([0, 1])
    expect(result.selectedMessages.reduce((sum, msg) => sum + msg.tokenCount, 0)).toBe(200)
    expect(result.protectedTailMessages.map((msg) => msg.position)).toEqual([6, 7])
  })
})

// ---------------------------------------------------------------------------
// 7. File ID extraction from structured block
// ---------------------------------------------------------------------------

describe("file ID extraction from structured blocks", () => {
  test("extracts file IDs from LCM File ID block (singular)", () => {
    const content = `Summary of work done.
LCM File ID: file_abc123def456789a
LCM File ID: file_def456abc789012b`
    const ids = extractFileIds(content)
    expect(ids).toEqual(["file_abc123def456789a", "file_def456abc789012b"])
  })

  // NOTE: The extractFileIds regex matches "LCM File ID:" (singular) but the
  // blocks appended by summarize/condense use "[LCM File IDs: ...]" (plural
  // with square brackets and comma-separated list). The regex "LCM File ID:"
  // does NOT match "LCM File IDs:" because the 's' precedes the colon.
  //
  // This means file IDs in the appended block format [LCM File IDs: file_xxx,
  // file_yyy] are NOT re-extracted by extractFileIds in subsequent condensation
  // rounds. This is acceptable because:
  //   1. File IDs are stored structurally in the fileIds field of Summary.Info
  //   2. The condense functions collect both extracted AND structural file IDs
  //      (via summary.fileIds), so propagation is handled structurally.
  test("does NOT extract from [LCM File IDs: ...] block (plural with 's')", () => {
    const content = `Summary of work done.
[LCM File IDs: file_abc123def456789a, file_def456abc789012b]`
    const ids = extractFileIds(content)
    // The plural "LCM File IDs:" does not match the singular "LCM File ID:" regex
    expect(ids).toEqual([])
  })

  test("file IDs survive through mixed content with singular pattern", () => {
    // In practice, if a summary contains the singular pattern, IDs are extracted
    const content = `[Condensed from: sum_aaaaaaaaaaaaaaaa, sum_bbbbbbbbbbbbbbbb]
User implemented feature X in src/foo.ts.
LCM File ID: file_1111111111111111
Modified src/bar.ts for tests.
LCM File ID: file_2222222222222222`
    const ids = extractFileIds(content)
    expect(ids).toEqual(["file_1111111111111111", "file_2222222222222222"])
  })
})
