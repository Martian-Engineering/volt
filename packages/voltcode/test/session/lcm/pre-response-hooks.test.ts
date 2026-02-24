import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { SessionPrompt } from "../../../src/session/prompt"
import type { LcmRetrieval } from "../../../src/session/lcm/retrieval"
import { Log } from "../../../src/util/log"

Log.init({ print: false })

function makeHit(input: {
  summaryId: string
  cueText: string
  score: number
  distance: number
  summaryType?: "bindle" | "archive_stub" | "sprig"
  pointerSummaryIds?: string[]
  lineageSummaryIds?: string[]
}): LcmRetrieval.QueryHit {
  return {
    summaryId: input.summaryId,
    summaryType: input.summaryType ?? "bindle",
    cueText: input.cueText,
    score: input.score,
    distance: input.distance,
    qmdDocId: `doc-${input.summaryId}`,
    pointerSummaryIds: input.pointerSummaryIds ?? [],
    lineageSummaryIds: input.lineageSummaryIds ?? [],
  }
}

describe("pre-response memory hooks", () => {
  test("formats cues with pointer metadata and excludes active-context summaries", () => {
    const activeId = "sum_aaaaaaaaaaaaaaaa"
    const block = SessionPrompt.formatPreResponseMemoryCueBlock({
      hits: [
        makeHit({
          summaryId: activeId,
          cueText: "should not appear",
          score: 0.99,
          distance: 0.01,
          pointerSummaryIds: ["sum_p0"],
          lineageSummaryIds: ["sum_l0"],
        }),
        makeHit({
          summaryId: "sum_bbbbbbbbbbbbbbbb",
          cueText: "memory cue b",
          score: 0.94,
          distance: 0.06,
          pointerSummaryIds: ["sum_pb1", "sum_pb2"],
          lineageSummaryIds: ["sum_lb1", "sum_lb2"],
        }),
        makeHit({
          summaryId: "sum_cccccccccccccccc",
          cueText: "memory cue c",
          summaryType: "archive_stub",
          score: 0.91,
          distance: 0.09,
          pointerSummaryIds: ["sum_pc1"],
          lineageSummaryIds: ["sum_lc1"],
        }),
      ],
      activeSummaryIds: [activeId],
      topK: 3,
    })

    expect(block).toBeTruthy()
    expect(block).not.toContain(activeId)
    expect(block).toContain("summaryId=sum_bbbbbbbbbbbbbbbb")
    expect(block).toContain("summaryType=bindle")
    expect(block).toContain("archived=no")
    expect(block).toContain("summaryType=archive_stub")
    expect(block).toContain("archived=yes")
    expect(block).toContain("score=0.940")
    expect(block).toContain("distance=0.060")
    expect(block).toContain("pointerIds=sum_pb1,sum_pb2")
    expect(block).toContain("lineageIds=sum_lb1,sum_lb2")
  })

  test("inserts cue block before the most recent user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "older user message" },
      { role: "assistant", content: "older assistant message" },
      { role: "user", content: "latest user message" },
    ]

    const result = SessionPrompt.injectPreResponseMemoryCueBlock(messages, "<memory-cues>\n[cue 1]\n</memory-cues>")
    expect(result).toHaveLength(4)
    expect(result[2]).toEqual({
      role: "user",
      content: "<memory-cues>\n[cue 1]\n</memory-cues>",
    })
    expect(result[3]).toEqual({
      role: "user",
      content: "latest user message",
    })
  })
})
