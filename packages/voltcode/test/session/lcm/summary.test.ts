import { describe, expect, test } from "bun:test"
import { Summary } from "../../../src/session/lcm/summary"

describe("session.lcm.summary", () => {
  describe("generateId", () => {
    test("generates deterministic IDs for same content and timestamp", () => {
      const content = "This is a test summary"
      const timestamp = 1700000000000

      const id1 = Summary.generateId(content, timestamp)
      const id2 = Summary.generateId(content, timestamp)

      expect(id1).toBe(id2)
    })

    test("generates different IDs for different content", () => {
      const timestamp = 1700000000000

      const id1 = Summary.generateId("Content A", timestamp)
      const id2 = Summary.generateId("Content B", timestamp)

      expect(id1).not.toBe(id2)
    })

    test("generates different IDs for different timestamps", () => {
      const content = "Same content"

      const id1 = Summary.generateId(content, 1700000000000)
      const id2 = Summary.generateId(content, 1700000000001)

      expect(id1).not.toBe(id2)
    })

    test("generates IDs with correct prefix format", () => {
      const id = Summary.generateId("test content", 1700000000000)

      expect(id).toMatch(/^sum_[a-f0-9]{16}$/)
    })
  })

  describe("isValidId", () => {
    test("validates correct summary IDs", () => {
      const validId = Summary.generateId("test", 1700000000000)
      expect(Summary.isValidId(validId)).toBe(true)
    })

    test("rejects IDs without prefix", () => {
      expect(Summary.isValidId("abc123def456789012")).toBe(false)
    })

    test("rejects IDs with wrong prefix", () => {
      expect(Summary.isValidId("msg_abc123def456789012")).toBe(false)
    })

    test("rejects IDs with wrong length", () => {
      expect(Summary.isValidId("sum_abc123")).toBe(false)
      expect(Summary.isValidId("sum_abc123def456789012345")).toBe(false)
    })
  })

  describe("createLeaf", () => {
    test("creates a leaf summary with correct properties", () => {
      const timestamp = 1700000000000
      const input: Summary.CreateLeafInput = {
        content: "This summarizes messages 1-5",
        tokenCount: 50,
        conversationId: "ses_test123",
        messageIds: ["msg_1", "msg_2", "msg_3"],
      }

      const summary = Summary.createLeaf(input, timestamp)

      expect(summary.kind).toBe("leaf")
      expect(summary.content).toBe(input.content)
      expect(summary.tokenCount).toBe(input.tokenCount)
      expect(summary.conversationId).toBe(input.conversationId)
      expect(summary.level).toBe("leaf")
      expect(summary.summaryType).toBe("leaf")
      expect(summary.parents).toEqual([])
      expect(summary.createdAt).toBe(timestamp)
      expect(Summary.isValidId(summary.summaryId)).toBe(true)
    })

    test("leaf summaries have empty parents array", () => {
      const summary = Summary.createLeaf({
        content: "test",
        tokenCount: 10,
        conversationId: "ses_test",
        messageIds: ["msg_1"],
      })

      expect(summary.parents).toEqual([])
    })
  })

  describe("createCondensed", () => {
    test("creates a condensed summary with parent references", () => {
      const timestamp = 1700000000000
      const parentIds = [
        Summary.generateId("parent1", timestamp - 1000),
        Summary.generateId("parent2", timestamp - 2000),
        Summary.generateId("parent3", timestamp - 3000),
      ]

      const input: Summary.CreateCondensedInput = {
        content: "This condenses multiple summaries",
        tokenCount: 100,
        conversationId: "ses_test123",
        parents: parentIds,
      }

      const summary = Summary.createCondensed(input, timestamp)

      expect(summary.kind).toBe("condensed")
      expect(summary.content).toBe(input.content)
      expect(summary.tokenCount).toBe(input.tokenCount)
      expect(summary.conversationId).toBe(input.conversationId)
      expect(summary.level).toBe("bindle")
      expect(summary.summaryType).toBe("bindle")
      expect(summary.parents).toEqual(parentIds)
      expect(summary.createdAt).toBe(timestamp)
      expect(Summary.isValidId(summary.summaryId)).toBe(true)
    })
  })

  describe("formatForContext", () => {
    test("formats leaf summary without parents", () => {
      const summary = Summary.createLeaf(
        {
          content: "The user asked about TypeScript types",
          tokenCount: 20,
          conversationId: "ses_test",
          messageIds: ["msg_1"],
        },
        1700000000000,
      )

      const formatted = Summary.formatForContext(summary)

      expect(formatted).toContain(`[Summary ID: ${summary.summaryId}]`)
      expect(formatted).not.toContain("[Parent Summaries:")
      expect(formatted).toContain("The user asked about TypeScript types")
    })

    test("formats condensed summary with parent IDs", () => {
      const parentIds = [Summary.generateId("p1", 1700000000000), Summary.generateId("p2", 1700000001000)]

      const summary = Summary.createCondensed(
        {
          content: "Combined summary of previous discussions",
          tokenCount: 40,
          conversationId: "ses_test",
          parents: parentIds,
        },
        1700000002000,
      )

      const formatted = Summary.formatForContext(summary)

      expect(formatted).toContain(`[Summary ID: ${summary.summaryId}]`)
      expect(formatted).toContain(`[Parent Summaries: ${parentIds.join(", ")}]`)
      expect(formatted).toContain("Combined summary of previous discussions")
    })
  })

  describe("extractIdsFromContext", () => {
    test("extracts summary IDs from formatted context", () => {
      const id1 = Summary.generateId("test1", 1700000000000)
      const id2 = Summary.generateId("test2", 1700000001000)

      const contextText = `
        [Summary ID: ${id1}]
        Some summary content mentioning ${id2} as a reference.
      `

      const extracted = Summary.extractIdsFromContext(contextText)

      expect(extracted).toContain(id1)
      expect(extracted).toContain(id2)
      expect(extracted.length).toBe(2)
    })

    test("deduplicates repeated IDs", () => {
      const id = Summary.generateId("test", 1700000000000)

      const contextText = `
        [Summary ID: ${id}]
        Referencing ${id} again and ${id} once more.
      `

      const extracted = Summary.extractIdsFromContext(contextText)

      expect(extracted.length).toBe(1)
      expect(extracted[0]).toBe(id)
    })

    test("returns empty array when no IDs found", () => {
      const contextText = "No summary IDs here, just regular text."

      const extracted = Summary.extractIdsFromContext(contextText)

      expect(extracted).toEqual([])
    })
  })

  describe("Schema validation", () => {
    test("validates correct summary info", () => {
      const summary = Summary.createLeaf(
        {
          content: "test",
          tokenCount: 10,
          conversationId: "ses_test",
          messageIds: ["msg_1"],
        },
        1700000000000,
      )

      const result = Summary.Schema.safeParse(summary)
      expect(result.success).toBe(true)
    })

    test("rejects invalid summary ID prefix", () => {
      const result = Summary.Schema.safeParse({
        summaryId: "invalid_abc123def456",
        content: "test",
        kind: "leaf",
        tokenCount: 10,
        conversationId: "ses_test",
        parents: [],
        createdAt: 1700000000000,
      })

      expect(result.success).toBe(false)
    })

    test("rejects invalid kind", () => {
      const result = Summary.Schema.safeParse({
        summaryId: "sum_abc123def4567890",
        content: "test",
        kind: "invalid",
        tokenCount: 10,
        conversationId: "ses_test",
        parents: [],
        createdAt: 1700000000000,
      })

      expect(result.success).toBe(false)
    })

    test("rejects negative token count", () => {
      const result = Summary.Schema.safeParse({
        summaryId: "sum_abc123def4567890",
        content: "test",
        kind: "leaf",
        tokenCount: -5,
        conversationId: "ses_test",
        parents: [],
        createdAt: 1700000000000,
      })

      expect(result.success).toBe(false)
    })
  })

  describe("CreateLeafInput validation", () => {
    test("validates correct leaf input", () => {
      const result = Summary.CreateLeafInput.safeParse({
        content: "test summary",
        tokenCount: 10,
        conversationId: "ses_test",
        messageIds: ["msg_1", "msg_2"],
      })

      expect(result.success).toBe(true)
    })

    test("rejects empty content", () => {
      const result = Summary.CreateLeafInput.safeParse({
        content: "",
        tokenCount: 10,
        conversationId: "ses_test",
        messageIds: ["msg_1"],
      })

      expect(result.success).toBe(false)
    })
  })

  describe("CreateCondensedInput validation", () => {
    test("validates correct condensed input", () => {
      const result = Summary.CreateCondensedInput.safeParse({
        content: "condensed summary",
        tokenCount: 20,
        conversationId: "ses_test",
        parents: ["sum_abc123def4567890"],
      })

      expect(result.success).toBe(true)
    })

    test("rejects empty parents array", () => {
      const result = Summary.CreateCondensedInput.safeParse({
        content: "condensed summary",
        tokenCount: 20,
        conversationId: "ses_test",
        parents: [],
      })

      expect(result.success).toBe(false)
    })

    test("rejects parents with invalid prefix", () => {
      const result = Summary.CreateCondensedInput.safeParse({
        content: "condensed summary",
        tokenCount: 20,
        conversationId: "ses_test",
        parents: ["msg_abc123def4567890"],
      })

      expect(result.success).toBe(false)
    })
  })

  describe("legacy kind mapping", () => {
    test("maps leaf kind to leaf level/type", () => {
      expect(Summary.levelFromKind("leaf")).toBe("leaf")
      expect(Summary.typeFromKind("leaf")).toBe("leaf")
    })

    test("maps condensed kind to bindle level/type", () => {
      expect(Summary.levelFromKind("condensed")).toBe("bindle")
      expect(Summary.typeFromKind("condensed")).toBe("bindle")
    })
  })
})
