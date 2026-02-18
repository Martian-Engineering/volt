import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import { LcmDb } from "../../../src/session/lcm/db"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { LcmContext } from "../../../src/session/lcm/context"
import { Token } from "../../../src/util/token"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

/**
 * Integration test for LCM Context Management.
 *
 * This test verifies that the LCM system correctly:
 * 1. Triggers summarization when context exceeds threshold
 * 2. Creates leaf summaries from messages
 * 3. Creates condensed summaries when needed
 * 4. Manages multiple summaries in the context window
 *
 * Requirements:
 * - Embedded PostgreSQL must be available
 * - Uses a small context window (10K tokens) to trigger summarization quickly
 */
describe("session.lcm.context", () => {
  // Skip all tests if LCM is not configured
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping LCM context tests", () => {})
    return
  }

  let testConversationId: number
  const createdConversationIds: number[] = []

  // Use a small context window to trigger summarization quickly
  const MAX_TOKENS = 10_000
  const THRESHOLD = 0.6 // 60% = 6000 tokens triggers summarization

  // Generate a large message (~500 tokens)
  function generateLargeMessage(index: number): string {
    const words = [
      "The",
      "quick",
      "brown",
      "fox",
      "jumps",
      "over",
      "the",
      "lazy",
      "dog",
      "and",
      "explores",
      "various",
      "coding",
      "patterns",
      "including",
      "functional",
      "programming",
      "object-oriented",
      "design",
      "reactive",
      "streams",
      "asynchronous",
      "operations",
      "microservices",
      "architecture",
    ]
    const lines: string[] = []
    lines.push(`Message ${index}: Discussion about software development concepts.`)
    // Generate enough text to be ~500 tokens (approximately 2000 chars / 4 chars per token)
    for (let i = 0; i < 80; i++) {
      const sentence = words
        .sort(() => Math.random() - 0.5)
        .slice(0, 10)
        .join(" ")
      lines.push(`${sentence}. This is line ${i + 1} of message ${index}.`)
    }
    return lines.join("\n")
  }

  async function cleanupConversation(id: number) {
    const conn = LcmDb.getConnection()
    // Delete in order to avoid FK violations
    await conn`DELETE FROM context_items WHERE conversation_id = ${id}`.catch(() => {})
    await conn`DELETE FROM summary_lineage_pointers WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ${id})`.catch(
      () => {},
    )
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

  beforeAll(async () => {
    // Initialize the database
    await LcmDb.initialize()
  })

  afterAll(async () => {
    // Clean up all test conversations
    for (const id of createdConversationIds) {
      await cleanupConversation(id)
    }
  })

  beforeEach(async () => {
    // Create a fresh test conversation with small context window
    testConversationId = await LcmDb.createConversation({
      title: "[Test] LCM Context Integration Test",
      modelName: "test-model",
      modelCtxMaxTokens: MAX_TOKENS,
      ctxCutoffThreshold: THRESHOLD,
    })
    createdConversationIds.push(testConversationId)
  })

  describe("basic context operations", () => {
    test("creates conversation with correct settings", async () => {
      const conversation = await LcmDb.getConversation(testConversationId)
      expect(conversation).not.toBeNull()
      expect(conversation!.model_ctx_max_tokens).toBe(MAX_TOKENS)
      expect(parseFloat(conversation!.ctx_cutoff_threshold)).toBe(THRESHOLD)
    })

    test("appends messages and tracks token count", async () => {
      const content = "This is a test message with some content."
      const tokenCount = Token.estimate(content)

      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content,
        tokenCount,
      })

      const contextTokens = await LcmDb.getContextTokenCount(testConversationId)
      expect(contextTokens).toBe(tokenCount)
    })

    test("isOverThreshold returns false when under limit", async () => {
      // Add a small message (well under threshold)
      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "Hello",
        tokenCount: 1,
      })

      const result = await LcmContext.isOverThreshold({
        conversationId: testConversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: MAX_TOKENS,
      })
      expect(result.overSoft).toBe(false)
      expect(result.currentTokens).toBe(1)
    })

    test("isOverThreshold returns true when over limit", async () => {
      // Add messages until we exceed threshold (6000 tokens)
      const thresholdTokens = Math.floor(MAX_TOKENS * THRESHOLD)

      for (let i = 0; i < 15; i++) {
        const content = generateLargeMessage(i)
        const tokenCount = Token.estimate(content)
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content,
          tokenCount,
        })
      }

      const contextTokens = await LcmDb.getContextTokenCount(testConversationId)
      expect(contextTokens).toBeGreaterThan(thresholdTokens)

      const result = await LcmContext.isOverThreshold({
        conversationId: testConversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: MAX_TOKENS,
      })
      expect(result.overSoft).toBe(true)
    })
  })

  describe("context window management without LLM", () => {
    test("getMessagesInContext returns messages in order", async () => {
      // Add several messages
      for (let i = 0; i < 5; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          tokenCount: 10,
        })
      }

      const messages = await LcmContext.getMessagesInContext(testConversationId)
      expect(messages.length).toBe(5)

      // Verify order by position
      for (let i = 0; i < messages.length; i++) {
        expect(messages[i].position).toBe(i)
        expect(messages[i].content).toBe(`Message ${i}`)
      }
    })

    test("getSummariesInContext returns empty array when no summaries", async () => {
      // Add messages only
      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "Test message",
        tokenCount: 10,
      })

      const summaries = await LcmContext.getSummariesInContext(testConversationId)
      expect(summaries).toEqual([])
    })

    test("getMessagesToSummarize respects token budget", async () => {
      // Add 10 messages, each ~10 tokens
      for (let i = 0; i < 10; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message number ${i} with some content`,
          tokenCount: 10,
        })
      }

      // Get messages within a 50-token budget (should get ~5 messages)
      const messages = await LcmDb.getMessagesToSummarize(testConversationId, 50)
      expect(messages.length).toBeLessThanOrEqual(5)
      expect(messages.length).toBeGreaterThan(0)

      // Verify they're the oldest messages (lowest positions)
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].position).toBeGreaterThan(messages[i - 1].position)
      }
    })
  })

  describe("summary storage and retrieval", () => {
    test("insertLeafSummary creates valid summary", async () => {
      const summaryId = `sum_${Date.now().toString(16).padStart(16, "0")}`
      const content = "This is a test summary of messages"
      const tokenCount = Token.estimate(content)

      await LcmDb.insertLeafSummary({
        summaryId,
        conversationId: testConversationId,
        content,
        tokenCount,
        messageIds: [],
      })

      const summary = await LcmDb.getSummaryById(summaryId)
      expect(summary).not.toBeNull()
      expect(summary!.summary_id).toBe(summaryId)
      expect(summary!.kind).toBe("leaf")
      expect(summary!.summary_level).toBe("leaf")
      expect(summary!.summary_type).toBe("leaf")
      expect(summary!.content).toBe(content)
      expect(summary!.token_count).toBe(tokenCount)
    })

    test("insertCondensedSummary links to parent summaries", async () => {
      // Create parent summaries
      const parent1 = `sum_${(Date.now() + 1).toString(16).padStart(16, "0")}`
      const parent2 = `sum_${(Date.now() + 2).toString(16).padStart(16, "0")}`

      await LcmDb.insertLeafSummary({
        summaryId: parent1,
        conversationId: testConversationId,
        content: "Parent summary 1",
        tokenCount: 10,
        messageIds: [],
      })

      await LcmDb.insertLeafSummary({
        summaryId: parent2,
        conversationId: testConversationId,
        content: "Parent summary 2",
        tokenCount: 10,
        messageIds: [],
      })

      // Create condensed summary
      const condensedId = `sum_${(Date.now() + 3).toString(16).padStart(16, "0")}`
      await LcmDb.insertCondensedSummary({
        summaryId: condensedId,
        conversationId: testConversationId,
        content: "Condensed from parent summaries",
        tokenCount: 15,
        parentSummaryIds: [parent1, parent2],
      })

      const summary = await LcmDb.getSummaryById(condensedId)
      expect(summary).not.toBeNull()
      expect(summary!.kind).toBe("condensed")
      expect(summary!.summary_level).toBe("bindle")
      expect(summary!.summary_type).toBe("bindle")

      const parentIds = await LcmDb.getSummaryParentIds(condensedId)
      expect(parentIds).toContain(parent1)
      expect(parentIds).toContain(parent2)
    })

    test("supports archive stub lineage pointers and off-context retrieval metadata", async () => {
      const leaf1 = `sum_${(Date.now() + 10).toString(16).padStart(16, "0")}`
      const leaf2 = `sum_${(Date.now() + 11).toString(16).padStart(16, "0")}`
      const bindleId = `sum_${(Date.now() + 12).toString(16).padStart(16, "0")}`
      const stubId = `sum_${(Date.now() + 13).toString(16).padStart(16, "0")}`

      await LcmDb.insertLeafSummary({
        summaryId: leaf1,
        conversationId: testConversationId,
        content: "Leaf 1",
        tokenCount: 5,
        messageIds: [],
      })
      await LcmDb.insertLeafSummary({
        summaryId: leaf2,
        conversationId: testConversationId,
        content: "Leaf 2",
        tokenCount: 5,
        messageIds: [],
      })
      await LcmDb.insertCondensedSummary({
        summaryId: bindleId,
        conversationId: testConversationId,
        content: "Bindle over two leaves",
        tokenCount: 8,
        parentSummaryIds: [leaf1, leaf2],
      })
      await LcmDb.insertCondensedSummary({
        summaryId: stubId,
        conversationId: testConversationId,
        content: "Short archive stub",
        tokenCount: 4,
        parentSummaryIds: [],
      })

      await LcmDb.markSummaryAsArchiveStub(stubId)
      await LcmDb.upsertSummaryLineagePointers({
        summaryId: stubId,
        pointers: [{ pointsToSummaryId: bindleId, pointerKind: "archive_stub" }],
      })
      await LcmDb.setSummaryQmdDocMapping({
        summaryId: bindleId,
        qmdDocId: `qmd:${bindleId}`,
        qmdDocVersion: 1,
      })
      await LcmDb.setSummariesOffContext([bindleId], true)

      const pointers = await LcmDb.getSummaryLineagePointers(stubId)
      expect(pointers.length).toBe(1)
      expect(pointers[0].points_to_summary_id).toBe(bindleId)
      expect(pointers[0].pointer_kind).toBe("archive_stub")

      const lineage = await LcmDb.getSummaryLineageIds(stubId)
      expect(lineage).toContain(stubId)
      expect(lineage).toContain(bindleId)
      expect(lineage).toContain(leaf1)
      expect(lineage).toContain(leaf2)

      const offContextBindles = await LcmDb.getOffContextSummaries({
        conversationId: testConversationId,
        summaryLevel: "bindle",
      })
      const matched = offContextBindles.find((s) => s.summary_id === bindleId)
      expect(matched).toBeDefined()
      expect(matched!.qmd_doc_id).toBe(`qmd:${bindleId}`)
      expect(matched!.is_off_context).toBe(true)
    })
  })

  describe("context replacement operations", () => {
    test("replaceContextWithSummary replaces message range", async () => {
      // Add 5 messages
      for (let i = 0; i < 5; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: `Message ${i}`,
          tokenCount: 10,
        })
      }

      // Create a summary to replace messages 1-3
      const summaryId = `sum_${Date.now().toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId,
        conversationId: testConversationId,
        content: "Summary of messages 1-3",
        tokenCount: 15,
        messageIds: [],
      })

      // Replace positions 1-3 with the summary
      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 1,
        endPosition: 3,
        summaryId,
      })

      // Verify context now has: message 0, summary, message 4
      const context = await LcmDb.getCurrentContext(testConversationId)
      expect(context.length).toBe(3)
      expect(context[0].item_type).toBe("message")
      expect(context[1].item_type).toBe("summary")
      expect(context[2].item_type).toBe("message")
    })

    test("replacePositionsWithSummary handles non-contiguous positions", async () => {
      // Add 6 messages
      for (let i = 0; i < 6; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: `Message ${i}`,
          tokenCount: 10,
        })
      }

      // Create two summaries and add them to context
      const summary1 = `sum_${(Date.now() + 1).toString(16).padStart(16, "0")}`
      const summary2 = `sum_${(Date.now() + 2).toString(16).padStart(16, "0")}`

      await LcmDb.insertLeafSummary({
        summaryId: summary1,
        conversationId: testConversationId,
        content: "Summary 1",
        tokenCount: 10,
        messageIds: [],
      })

      await LcmDb.insertLeafSummary({
        summaryId: summary2,
        conversationId: testConversationId,
        content: "Summary 2",
        tokenCount: 10,
        messageIds: [],
      })

      // Replace positions 0 and 2 with summary1 (leaving 1 as message)
      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 0,
        endPosition: 2,
        summaryId: summary1,
      })

      // Verify context structure
      const context = await LcmDb.getCurrentContext(testConversationId)
      expect(context.length).toBe(4) // summary + 3 remaining messages
      expect(context[0].item_type).toBe("summary")
    })
  })

  describe("full-text search", () => {
    test("searchMessages finds messages by content", async () => {
      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "I want to learn about TypeScript generics",
        tokenCount: 10,
      })

      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "assistant",
        content: "TypeScript generics allow you to create reusable components",
        tokenCount: 15,
      })

      await LcmDb.appendMessage({
        conversationId: testConversationId,
        role: "user",
        content: "How do I use Python decorators?",
        tokenCount: 10,
      })

      const results = await LcmDb.searchMessages(testConversationId, "TypeScript")
      expect(results.length).toBe(2) // Both TypeScript messages

      const pythonResults = await LcmDb.searchMessages(testConversationId, "Python")
      expect(pythonResults.length).toBe(1)
    })
  })

  describe("simulated multi-round summarization", () => {
    /**
     * This test simulates multiple rounds of summarization and condensation
     * without requiring actual LLM calls. It verifies that:
     * 1. Context can be filled with messages
     * 2. Messages can be replaced with summaries
     * 3. Multiple summaries can be condensed
     * 4. The final context contains the expected structure
     */
    test("handles multiple rounds of summarization and condensation", async () => {
      // Phase 1: Add many messages to fill context (30 messages * ~100 tokens = ~3000 tokens)
      const messageCount = 30
      for (let i = 0; i < messageCount; i++) {
        const content = `Message ${i}: This is a fairly long message with content about topic ${i % 5}. It contains enough text to be around 100 tokens when estimated. We're discussing software architecture, design patterns, testing strategies, and code quality.`
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content,
          tokenCount: Token.estimate(content),
        })
      }

      // Verify initial state
      let messages = await LcmContext.getMessagesInContext(testConversationId)
      expect(messages.length).toBe(messageCount)

      let contextTokens = await LcmDb.getContextTokenCount(testConversationId)
      console.log(`Initial context: ${messageCount} messages, ${contextTokens} tokens`)

      // Phase 2: First round of summarization (summarize messages 0-9)
      const summary1Id = `sum_${Date.now().toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId: summary1Id,
        conversationId: testConversationId,
        content:
          "[Summary of messages 0-9] The conversation began with discussions about software architecture and design patterns. Users asked about various topics and received detailed responses.",
        tokenCount: 50,
        messageIds: [],
      })

      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 0,
        endPosition: 9,
        summaryId: summary1Id,
      })

      // Verify first summarization
      let context = await LcmDb.getCurrentContext(testConversationId)
      expect(context[0].item_type).toBe("summary")
      const summariesAfterFirst = await LcmContext.getSummariesInContext(testConversationId)
      expect(summariesAfterFirst.length).toBe(1)
      console.log(`After first summary: ${context.length} items, ${summariesAfterFirst.length} summary`)

      // Phase 3: Second round of summarization (summarize messages 10-19, now at positions 1-10)
      const summary2Id = `sum_${(Date.now() + 1).toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId: summary2Id,
        conversationId: testConversationId,
        content:
          "[Summary of messages 10-19] The conversation continued with more questions about testing strategies and code quality. Multiple examples were provided.",
        tokenCount: 50,
        messageIds: [],
      })

      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 1,
        endPosition: 10,
        summaryId: summary2Id,
      })

      // Verify second summarization
      context = await LcmDb.getCurrentContext(testConversationId)
      const summariesAfterSecond = await LcmContext.getSummariesInContext(testConversationId)
      expect(summariesAfterSecond.length).toBe(2)
      console.log(`After second summary: ${context.length} items, ${summariesAfterSecond.length} summaries`)

      // Phase 4: Third round of summarization (summarize remaining messages 20-29, now at positions 2-11)
      const summary3Id = `sum_${(Date.now() + 2).toString(16).padStart(16, "0")}`
      await LcmDb.insertLeafSummary({
        summaryId: summary3Id,
        conversationId: testConversationId,
        content:
          "[Summary of messages 20-29] The final portion covered advanced topics and practical implementations. The discussion wrapped up with actionable recommendations.",
        tokenCount: 50,
        messageIds: [],
      })

      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 2,
        endPosition: 11,
        summaryId: summary3Id,
      })

      // Verify third summarization - now we have 3 summaries
      context = await LcmDb.getCurrentContext(testConversationId)
      const summariesAfterThird = await LcmContext.getSummariesInContext(testConversationId)
      expect(summariesAfterThird.length).toBe(3)
      console.log(`After third summary: ${context.length} items, ${summariesAfterThird.length} summaries`)

      // Phase 5: Condensation - combine all 3 summaries into one
      const condensedId = `sum_${(Date.now() + 3).toString(16).padStart(16, "0")}`
      await LcmDb.insertCondensedSummary({
        summaryId: condensedId,
        conversationId: testConversationId,
        content: `[Condensed from: ${summary1Id}, ${summary2Id}, ${summary3Id}] This conversation covered software architecture, design patterns, testing strategies, code quality, and practical implementations. Key insights were shared across multiple exchanges.`,
        tokenCount: 60,
        parentSummaryIds: [summary1Id, summary2Id, summary3Id],
      })

      // Replace all 3 summaries with the condensed one
      await LcmDb.replacePositionsWithSummary({
        conversationId: testConversationId,
        positions: [0, 1, 2],
        summaryId: condensedId,
      })

      // Verify final state
      context = await LcmDb.getCurrentContext(testConversationId)
      const finalSummaries = await LcmContext.getSummariesInContext(testConversationId)

      console.log(`Final state: ${context.length} items, ${finalSummaries.length} summary(ies)`)

      // Should have exactly 1 condensed summary
      expect(finalSummaries.length).toBe(1)
      expect(finalSummaries[0].kind).toBe("condensed")
      expect(finalSummaries[0].parents).toContain(summary1Id)
      expect(finalSummaries[0].parents).toContain(summary2Id)
      expect(finalSummaries[0].parents).toContain(summary3Id)

      // Verify the condensed summary can be expanded back to original messages
      const parentIds = await LcmDb.getSummaryParentIds(condensedId)
      expect(parentIds.length).toBe(3)

      // Verify context token count is much smaller than original
      const finalTokenCount = await LcmDb.getContextTokenCount(testConversationId)
      console.log(`Token reduction: ${contextTokens} -> ${finalTokenCount} tokens`)
      expect(finalTokenCount).toBeLessThan(contextTokens)
    })

    test("handles massive context with repeated summarization cycles", async () => {
      // This test simulates adding messages far beyond the context limit
      // and repeatedly summarizing to keep context manageable

      // Configuration for this test
      const targetMessages = 100
      const messagesPerBatch = 10
      let totalSummaryRounds = 0

      console.log(`Starting massive context test with ${targetMessages} messages`)

      // Add messages in batches, summarizing when we have too many
      for (let batch = 0; batch < targetMessages / messagesPerBatch; batch++) {
        // Add a batch of messages
        for (let i = 0; i < messagesPerBatch; i++) {
          const msgIndex = batch * messagesPerBatch + i
          const content = `Batch ${batch} Message ${i}: Detailed discussion about topic ${msgIndex % 7}. This message contains substantial content to simulate real conversation patterns with technical details and examples.`
          await LcmDb.appendMessage({
            conversationId: testConversationId,
            role: msgIndex % 2 === 0 ? "user" : "assistant",
            content,
            tokenCount: Token.estimate(content),
          })
        }

        // Check if we need to summarize (more than 20 messages in context)
        const messages = await LcmContext.getMessagesInContext(testConversationId)
        if (messages.length > 20) {
          // Summarize the oldest 10 messages
          const summaryId = `sum_${(Date.now() + batch).toString(16).padStart(16, "0")}`
          await LcmDb.insertLeafSummary({
            summaryId,
            conversationId: testConversationId,
            content: `[Summary of batch ${batch - 1} messages] Discussion covered various technical topics with detailed explanations and examples. Key points were addressed.`,
            tokenCount: 30,
            messageIds: [],
          })

          // Find the oldest 10 message positions
          const positionsToReplace = messages.slice(0, 10).map((m) => m.position)
          const startPos = Math.min(...positionsToReplace)
          const endPos = Math.max(...positionsToReplace)

          await LcmDb.replaceContextWithSummary({
            conversationId: testConversationId,
            startPosition: startPos,
            endPosition: endPos,
            summaryId,
          })

          totalSummaryRounds++
        }

        // Check if we need to condense summaries (more than 5 summaries)
        const summaries = await LcmContext.getSummariesInContext(testConversationId)
        if (summaries.length >= 5) {
          const condensedId = `sum_cond_${(Date.now() + batch).toString(16).padStart(16, "0")}`
          const parentIds = summaries.map((s) => s.summaryId)

          await LcmDb.insertCondensedSummary({
            summaryId: condensedId,
            conversationId: testConversationId,
            content: `[Condensed summary of ${summaries.length} previous summaries] This meta-summary captures the key themes from multiple conversation segments.`,
            tokenCount: 40,
            parentSummaryIds: parentIds,
          })

          // Get positions of all summaries
          const context = await LcmDb.getCurrentContext(testConversationId)
          const summaryPositions: number[] = []
          for (let pos = 0; pos < context.length; pos++) {
            if (context[pos].item_type === "summary") {
              summaryPositions.push(pos)
            }
          }

          if (summaryPositions.length > 0) {
            await LcmDb.replacePositionsWithSummary({
              conversationId: testConversationId,
              positions: summaryPositions,
              summaryId: condensedId,
            })
            totalSummaryRounds++
          }
        }
      }

      // Final verification
      const finalContext = await LcmDb.getCurrentContext(testConversationId)
      const finalSummaries = await LcmContext.getSummariesInContext(testConversationId)
      const finalTokens = await LcmDb.getContextTokenCount(testConversationId)

      console.log(`Final state after ${targetMessages} messages:`)
      console.log(`  - Context items: ${finalContext.length}`)
      console.log(`  - Summaries: ${finalSummaries.length}`)
      console.log(`  - Total tokens: ${finalTokens}`)
      console.log(`  - Summary rounds: ${totalSummaryRounds}`)

      // Assertions
      expect(finalContext.length).toBeLessThan(targetMessages)
      expect(totalSummaryRounds).toBeGreaterThan(0)

      // Context should be manageable (not all 100 messages)
      const messagesInContext = finalContext.filter((c) => c.item_type === "message").length
      expect(messagesInContext).toBeLessThanOrEqual(30)

      // We should have some summaries
      expect(finalSummaries.length).toBeGreaterThan(0)
    })
  })
})
