import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import { LcmDb } from "../../../src/session/lcm/db"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { LcmContext } from "../../../src/session/lcm/context"
import { Token } from "../../../src/util/token"
import { Session } from "../../../src/session"
import { LcmGrepTool } from "../../../src/tool/lcm-grep"
import { LcmExpandTool } from "../../../src/tool/lcm-expand"
import { LcmDescribeTool } from "../../../src/tool/lcm-describe"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

/**
 * Integration tests for the LCM tools:
 * - lcm_grep: Regex search through conversation history
 * - lcm_expand: Expand summaries (sub-agent only)
 *
 * Requirements:
 * - Embedded PostgreSQL must be available
 */
describe("session.lcm.tools", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping LCM tools tests", () => {})
    return
  }

  let testConversationId: number
  const createdConversationIds: number[] = []

  const MAX_TOKENS = 10_000
  const THRESHOLD = 0.6

  // Generate a message with a specific keyword for searching
  function generateMessageWithKeyword(index: number, keyword: string): string {
    return `Message ${index}: This message discusses ${keyword}. The topic of ${keyword} is important for understanding the conversation. We covered ${keyword} in detail with examples and explanations.`
  }

  async function cleanupConversation(id: number) {
    const conn = LcmDb.getConnection()
    await conn`DELETE FROM context_items WHERE conversation_id = ${id}`.catch(() => {})
    await conn`DELETE FROM summary_parents WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ${id})`.catch(
      () => {},
    )
    await conn`DELETE FROM summary_messages WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ${id})`.catch(
      () => {},
    )
    await conn`DELETE FROM summaries WHERE conversation_id = ${id}`.catch(() => {})
    await conn`DELETE FROM messages WHERE conversation_id = ${id}`.catch(() => {})
    await conn`DELETE FROM large_files WHERE conversation_id = ${id}`.catch(() => {})
    await conn`DELETE FROM conversations WHERE conversation_id = ${id}`.catch(() => {})
  }

  // Create a mock tool context
  function createMockContext(sessionID: string, options: { abort?: AbortController } = {}) {
    const abort = options.abort ?? new AbortController()
    return {
      sessionID,
      messageID: "msg_test_123",
      agent: "test",
      abort: abort.signal,
      callID: "call_test_123",
      extra: {},
      metadata: () => {},
      ask: async () => {},
    }
  }

  beforeAll(async () => {
    await LcmDb.initialize()
  })

  afterAll(async () => {
    for (const id of createdConversationIds) {
      await cleanupConversation(id)
    }
  })

  beforeEach(async () => {
    // Ensure conversation_id is a proper number (PostgreSQL may return bigint)
    testConversationId = Number(
      await LcmDb.createConversation({
        title: "[Test] LCM Tools Integration Test",
        modelName: "test-model",
        modelCtxMaxTokens: MAX_TOKENS,
        ctxCutoffThreshold: THRESHOLD,
      }),
    )
    createdConversationIds.push(testConversationId)
  })

  describe("lcm_grep tool", () => {
    test("searches messages by regex pattern", async () => {
      // Add messages with specific keywords
      const keywords = ["TypeScript", "Python", "JavaScript", "Rust", "Go"]
      const messageIds: number[] = []

      for (let i = 0; i < keywords.length; i++) {
        const content = generateMessageWithKeyword(i, keywords[i])
        const messageId = await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content,
          tokenCount: Token.estimate(content),
        })
        messageIds.push(messageId)
      }

      // Initialize tool and search for TypeScript
      const tool = await LcmGrepTool.init()
      const ctx = createMockContext("session_test_123")

      const result = await tool.execute(
        {
          pattern: "TypeScript",
          conversation_id: testConversationId,
        },
        ctx,
      )

      expect(result.metadata.matchCount).toBeGreaterThan(0)
      expect(result.output).toContain("TypeScript")
    })

    test("searches with regex patterns", async () => {
      // Add messages with various programming patterns
      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "The function handleClick should work properly",
        tokenCount: 10,
      })

      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "assistant",
        content: "The function handleSubmit is similar to handleClick",
        tokenCount: 15,
      })

      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "What about the processData function?",
        tokenCount: 10,
      })

      const tool = await LcmGrepTool.init()
      const ctx = createMockContext("session_test_123")

      // Search for pattern matching "handle*" functions
      const result = await tool.execute(
        {
          pattern: "handle[A-Z][a-z]+",
          conversation_id: testConversationId,
        },
        ctx,
      )

      expect(result.metadata.matchCount).toBe(2) // handleClick and handleSubmit
      expect(result.output).toContain("handleClick")
      expect(result.output).toContain("handleSubmit")
    })

    test("returns empty results for non-matching pattern", async () => {
      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "Hello world",
        tokenCount: 5,
      })

      const tool = await LcmGrepTool.init()
      const ctx = createMockContext("session_test_123")

      const result = await tool.execute(
        {
          pattern: "ZZZZNOTFOUND",
          conversation_id: testConversationId,
        },
        ctx,
      )

      expect(result.metadata.matchCount).toBe(0)
      expect(result.output).toContain("No matches found")
    })

    test("groups results by covering summary", async () => {
      // Add messages and create a summary linking to them
      const messageIds: number[] = []
      for (let i = 0; i < 5; i++) {
        const content = `Message ${i}: Discussion about algorithms and data structures`
        const messageId = await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content,
          tokenCount: Token.estimate(content),
        })
        messageIds.push(messageId)
      }

      // Create a summary that covers messages 0-2
      const summaryId = `sum_${Date.now().toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId,
        conversationId: testConversationId,
        content: "Summary of algorithm discussion",
        tokenCount: 20,
        messageIds: messageIds.slice(0, 3),
      })

      const tool = await LcmGrepTool.init()
      const ctx = createMockContext("session_test_123")

      const result = await tool.execute(
        {
          pattern: "algorithms",
          conversation_id: testConversationId,
        },
        ctx,
      )

      expect(result.metadata.matchCount).toBeGreaterThan(0)
      // Results should show grouping by summary
      expect(result.output).toContain("Covered by:")
      expect(result.output).toContain("type=leaf")
      expect(result.output).toContain("level=leaf")
      expect(result.output).toContain("archived_pointer=false")
      expect(result.metadata.archivedCoveringSummaryIds).toEqual([])
    })

    test("handles pagination for large result sets", async () => {
      // Add many messages
      for (let i = 0; i < 60; i++) {
        const content = `Message ${i}: Contains the special_keyword_${i} for testing pagination`
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content,
          tokenCount: Token.estimate(content),
        })
      }

      const tool = await LcmGrepTool.init()
      const ctx = createMockContext("session_test_123")

      // First page
      const result1 = await tool.execute(
        {
          pattern: "special_keyword",
          conversation_id: testConversationId,
          page: 1,
        },
        ctx,
      )

      expect(result1.metadata.page).toBe(1)
      expect(result1.metadata.matchCount).toBeGreaterThan(0)
      expect(result1.metadata.hasMore).toBe(true)

      // Second page
      const result2 = await tool.execute(
        {
          pattern: "special_keyword",
          conversation_id: testConversationId,
          page: 2,
        },
        ctx,
      )

      expect(result2.metadata.page).toBe(2)
    })
  })

  describe("lcm_expand tool", () => {
    test("rejects expansion from main agent (no parentID)", async () => {
      // Mock Session.get to return a session without parentID
      const originalGet = Session.get
      // @ts-ignore - override for testing
      Session.get = async () =>
        ({
          id: "session_main_123",
          parentID: undefined, // No parent = main agent
          title: "Main Session",
        }) as any

      try {
        // Create a summary to expand
        const messageId = await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: "Original message content that was summarized",
          tokenCount: 20,
        })

        const summaryId = `sum_${Date.now().toString(16).padStart(16, "0")}`
        await LcmDb.insertLeafSummary({
          summaryId,
          conversationId: testConversationId,
          content: "Summary of original message",
          tokenCount: 10,
          messageIds: [messageId],
        })

        const tool = await LcmExpandTool.init()
        const ctx = createMockContext("session_main_123")

        const result = await tool.execute({ summary_id: summaryId }, ctx)

        // Should return an error message, not throw
        expect(result.output).toContain("ERROR: Only sub-agents can expand summaries")
        expect(result.output).toContain("Task")
        expect(result.metadata.messageCount).toBe(0)
      } finally {
        // @ts-ignore - restore for testing
        Session.get = originalGet
      }
    })

    test("allows expansion from sub-agent (has parentID)", async () => {
      // Mock Session.get to return a session WITH parentID (sub-agent)
      const originalGet = Session.get
      // @ts-ignore - override for testing
      Session.get = async () =>
        ({
          id: "session_child_123",
          parentID: "session_parent_123", // Has parent = sub-agent
          title: "Child Session",
        }) as any

      try {
        // Create messages and a summary
        const messageIds: number[] = []
        for (let i = 0; i < 3; i++) {
          const content = `Original message ${i}: Detailed discussion about topic ${i}`
          const messageId = await LcmDb.appendMessage({
            conversationId: testConversationId,
            role: i % 2 === 0 ? "user" : "assistant",
            content,
            tokenCount: Token.estimate(content),
          })
          messageIds.push(messageId)
        }

        const summaryId = `sum_${Date.now().toString(16).padStart(16, "0")}`
        await LcmDb.insertLeafSummary({
          summaryId,
          conversationId: testConversationId,
          content: "Summary covering 3 messages about various topics",
          tokenCount: 20,
          messageIds,
        })

        const tool = await LcmExpandTool.init()
        const ctx = createMockContext("session_child_123")

        const result = await tool.execute({ summary_id: summaryId }, ctx)

        // Should successfully expand
        expect(result.metadata.messageCount).toBe(3)
        expect(result.metadata.summaryLevel).toBe("leaf")
        expect(result.metadata.summaryType).toBe("leaf")
        expect(result.metadata.archivedPointer).toBe(false)
        expect(result.output).toContain("Original message 0")
        expect(result.output).toContain("Original message 1")
        expect(result.output).toContain("Original message 2")
        expect(result.output).toContain("Expanded summary")
      } finally {
        // @ts-ignore - restore for testing
        Session.get = originalGet
      }
    })

    test("handles summary not found error", async () => {
      // Mock Session.get to return a sub-agent session
      const originalGet = Session.get
      // @ts-ignore - override for testing
      Session.get = async () =>
        ({
          id: "session_child_456",
          parentID: "session_parent_456",
          title: "Child Session",
        }) as any

      try {
        const tool = await LcmExpandTool.init()
        const ctx = createMockContext("session_child_456")

        // Try to expand non-existent summary
        await expect(tool.execute({ summary_id: "sum_nonexistent_id_12345" }, ctx)).rejects.toThrow()
      } finally {
        // @ts-ignore - restore for testing
        Session.get = originalGet
      }
    })
  })

  describe("lcm_describe tool", () => {
    test("shows archive stub lineage metadata for summary IDs", async () => {
      const messageId = await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "Message for archive lineage traversal test",
        tokenCount: 12,
      })

      const leafSummaryId = `sum_${Date.now().toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId: leafSummaryId,
        conversationId: testConversationId,
        content: "Leaf summary for archive lineage test",
        tokenCount: 12,
        messageIds: [messageId],
      })

      const bindleSummaryId = `sum_${(Date.now() + 1).toString(16).padStart(16, "0")}`
      await LcmDb.insertCondensedSummary({
        summaryId: bindleSummaryId,
        conversationId: testConversationId,
        content: "Bindle summary for archive lineage test",
        tokenCount: 10,
        parentSummaryIds: [leafSummaryId],
      })

      const archiveStubId = `sum_${(Date.now() + 2).toString(16).padStart(16, "0")}`
      await LcmDb.insertCondensedSummary({
        summaryId: archiveStubId,
        conversationId: testConversationId,
        content: "[Archive Stub for test]",
        tokenCount: 8,
        parentSummaryIds: [],
      })
      await LcmDb.markSummaryAsArchiveStub(archiveStubId)
      await LcmDb.upsertSummaryLineagePointers({
        summaryId: archiveStubId,
        pointers: [{ pointsToSummaryId: bindleSummaryId, pointerKind: "archive_stub" }],
      })

      const tool = await LcmDescribeTool.init()
      const ctx = createMockContext("session_test_123")
      const result = await tool.execute({ id: archiveStubId }, ctx)

      expect(result.metadata.type).toBe("summary")
      expect(result.metadata.summaryType).toBe("archive_stub")
      expect(result.metadata.archivedPointer).toBe(true)
      expect(result.output).toContain("## Dolt Lineage Metadata")
      expect(result.output).toContain("**Type:** archive_stub")
      expect(result.output).toContain("**Archived Pointer:** true")
      expect(result.output).toContain("**Archive Stub Targets:**")
      expect(result.output).toContain(bindleSummaryId)
    })
  })

  describe("multi-summary scenario with expansion", () => {
    /**
     * This test creates a realistic scenario where:
     * 1. Many messages are added to fill context
     * 2. Multiple summaries are created
     * 3. Summaries are condensed
     * 4. A sub-agent expands a summary and retrieves the original data
     */
    test("creates multiple summaries and expands to retrieve original data", async () => {
      // Mock Session.get to simulate a sub-agent (has parentID)
      const originalGet = Session.get
      // @ts-ignore - override for testing
      Session.get = async () =>
        ({
          id: "session_subagent_multi",
          parentID: "session_parent_multi",
          title: "Sub-agent Session",
        }) as any

      try {
        // Phase 1: Add 30 messages with unique identifiable content
        console.log("Adding 30 messages with unique content...")
        const allMessageIds: number[] = []

        for (let i = 0; i < 30; i++) {
          const uniqueId = `UNIQUE_ID_${i.toString().padStart(3, "0")}`
          const content = `Message ${i} with ${uniqueId}: This is a detailed message about topic ${i % 5}. It contains specific information that should be retrievable after summarization.`
          const messageId = await LcmDb.appendMessage({
            conversationId: testConversationId,
            role: i % 2 === 0 ? "user" : "assistant",
            content,
            tokenCount: Token.estimate(content),
          })
          allMessageIds.push(messageId)
        }

        // Phase 2: Create leaf summaries for message groups
        console.log("Creating leaf summaries...")

        // Summary 1: messages 0-9
        const summary1Id = `sum_${Date.now().toString(16).padStart(16, "0")}`
        await LcmDb.insertLeafSummary({
          summaryId: summary1Id,
          conversationId: testConversationId,
          content: "Summary of messages 0-9: Initial discussion covering UNIQUE_ID_000 through UNIQUE_ID_009",
          tokenCount: 30,
          messageIds: allMessageIds.slice(0, 10),
        })

        // Summary 2: messages 10-19
        const summary2Id = `sum_${(Date.now() + 1).toString(16).padStart(16, "0")}`
        await LcmDb.insertLeafSummary({
          summaryId: summary2Id,
          conversationId: testConversationId,
          content: "Summary of messages 10-19: Continued discussion covering UNIQUE_ID_010 through UNIQUE_ID_019",
          tokenCount: 30,
          messageIds: allMessageIds.slice(10, 20),
        })

        // Summary 3: messages 20-29
        const summary3Id = `sum_${(Date.now() + 2).toString(16).padStart(16, "0")}`
        await LcmDb.insertLeafSummary({
          summaryId: summary3Id,
          conversationId: testConversationId,
          content: "Summary of messages 20-29: Final discussion covering UNIQUE_ID_020 through UNIQUE_ID_029",
          tokenCount: 30,
          messageIds: allMessageIds.slice(20, 30),
        })

        // Phase 3: Create a condensed summary combining all three
        console.log("Creating condensed summary...")
        const condensedId = `sum_${(Date.now() + 3).toString(16).padStart(16, "0")}`
        await LcmDb.insertCondensedSummary({
          summaryId: condensedId,
          conversationId: testConversationId,
          content: `Condensed summary combining: ${summary1Id}, ${summary2Id}, ${summary3Id}. This meta-summary covers all 30 messages discussing topics 0-4 with unique identifiers.`,
          tokenCount: 50,
          parentSummaryIds: [summary1Id, summary2Id, summary3Id],
        })

        // Verify summary hierarchy
        const parentIds = await LcmDb.getSummaryParentIds(condensedId)
        expect(parentIds).toContain(summary1Id)
        expect(parentIds).toContain(summary2Id)
        expect(parentIds).toContain(summary3Id)

        // Verify child relationships
        const childIds = await LcmDb.getChildSummaryIds(summary1Id)
        expect(childIds).toContain(condensedId)

        // Phase 4: Use lcm_grep to search for specific content
        console.log("Testing lcm_grep search...")
        const grepTool = await LcmGrepTool.init()
        const grepCtx = createMockContext("session_subagent_multi")

        const grepResult = await grepTool.execute(
          {
            pattern: "UNIQUE_ID_005",
            conversation_id: testConversationId,
          },
          grepCtx,
        )

        expect(grepResult.metadata.matchCount).toBeGreaterThan(0)
        expect(grepResult.output).toContain("UNIQUE_ID_005")

        // Phase 5: Use lcm_expand to retrieve original messages from a leaf summary
        console.log("Testing lcm_expand on leaf summary...")
        const expandTool = await LcmExpandTool.init()
        const expandCtx = createMockContext("session_subagent_multi")

        const expandResult = await expandTool.execute({ summary_id: summary1Id }, expandCtx)

        expect(expandResult.metadata.messageCount).toBe(10)
        expect(expandResult.output).toContain("UNIQUE_ID_000")
        expect(expandResult.output).toContain("UNIQUE_ID_005")
        expect(expandResult.output).toContain("UNIQUE_ID_009")

        // Phase 6: Expand the condensed summary to get all 30 messages
        console.log("Testing lcm_expand on condensed summary...")
        const expandCondensedResult = await expandTool.execute({ summary_id: condensedId }, expandCtx)

        // Condensed summary should expand to all 30 original messages
        expect(expandCondensedResult.metadata.messageCount).toBe(30)
        expect(expandCondensedResult.metadata.summaryLevel).toBe("bindle")
        expect(expandCondensedResult.metadata.summaryType).toBe("bindle")
        expect(expandCondensedResult.output).toContain("UNIQUE_ID_000")
        expect(expandCondensedResult.output).toContain("UNIQUE_ID_015")
        expect(expandCondensedResult.output).toContain("UNIQUE_ID_029")

        console.log("Multi-summary scenario completed successfully!")
        console.log(`  - Created ${allMessageIds.length} messages`)
        console.log(`  - Created 3 leaf summaries + 1 condensed summary`)
        console.log(`  - Grep found ${grepResult.metadata.matchCount} matches`)
        console.log(`  - Leaf expand returned ${expandResult.metadata.messageCount} messages`)
        console.log(`  - Condensed expand returned ${expandCondensedResult.metadata.messageCount} messages`)
      } finally {
        // @ts-ignore - restore for testing
        Session.get = originalGet
      }
    })
  })

  describe("regexSearchMessages database function", () => {
    test("searches within summary scope when summaryId provided", async () => {
      // Add messages across two different logical groups
      const group1MessageIds: number[] = []
      const group2MessageIds: number[] = []

      for (let i = 0; i < 5; i++) {
        const content = `Group 1 message ${i}: Contains KEYWORD_A`
        const messageId = await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content,
          tokenCount: Token.estimate(content),
        })
        group1MessageIds.push(messageId)
      }

      for (let i = 0; i < 5; i++) {
        const content = `Group 2 message ${i}: Contains KEYWORD_A`
        const messageId = await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content,
          tokenCount: Token.estimate(content),
        })
        group2MessageIds.push(messageId)
      }

      // Create summary only for group 1
      const summary1Id = `sum_${Date.now().toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId: summary1Id,
        conversationId: testConversationId,
        content: "Summary of group 1",
        tokenCount: 10,
        messageIds: group1MessageIds,
      })

      // Search all messages - should find 10
      const allResults = await LcmDb.regexSearchMessages(testConversationId, "KEYWORD_A")
      expect(allResults.length).toBe(10)

      // Search within summary scope - should find only 5
      const scopedResults = await LcmDb.regexSearchMessages(testConversationId, "KEYWORD_A", summary1Id)
      expect(scopedResults.length).toBe(5)

      // Verify all scoped results are from group 1
      for (const result of scopedResults) {
        expect(group1MessageIds).toContain(result.messageId)
      }
    })
  })
})
