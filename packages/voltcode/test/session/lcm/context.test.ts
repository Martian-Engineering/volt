import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import { LcmDb } from "../../../src/session/lcm/db"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { LcmContext } from "../../../src/session/lcm/context"
import { LcmGhostCue } from "../../../src/session/lcm/ghost-cue"
import { parseLcmPolicyConfig, setLcmPolicyConfigForTesting } from "../../../src/session/lcm/config"
import { Token } from "../../../src/util/token"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

/**
 * Integration test for LCM Context Management.
 *
 * This test verifies that the LCM system correctly:
 * 1. Triggers summarization when context exceeds threshold
 * 2. Creates sprig summaries from messages
 * 3. Creates bindle summaries when needed
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

  function extractSummaryIdFromContextContent(content: string): string | null {
    const match = content.match(/\[Summary ID: (sum_[a-f0-9]{16})\]/)
    return match ? match[1] : null
  }

  let summaryIdCounter = 0
  function nextSummaryId(prefix = "sum"): string {
    summaryIdCounter += 1
    return `${prefix}_${summaryIdCounter.toString(16).padStart(16, "0")}`
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
    test("insertSprigSummary creates valid summary", async () => {
      const summaryId = nextSummaryId()
      const content = "This is a test summary of messages"
      const tokenCount = Token.estimate(content)

      await LcmDb.insertSprigSummary({
        summaryId,
        conversationId: testConversationId,
        content,
        tokenCount,
        messageIds: [],
      })

      const summary = await LcmDb.getSummaryById(summaryId)
      expect(summary).not.toBeNull()
      expect(summary!.summary_id).toBe(summaryId)
      expect(summary!.kind).toBe("sprig")
      expect(summary!.summary_level).toBe("sprig")
      expect(summary!.summary_type).toBe("sprig")
      expect(summary!.content).toBe(content)
      expect(summary!.token_count).toBe(tokenCount)
    })

    test("insertBindleSummary links to parent summaries", async () => {
      // Create parent summaries
      const parent1 = nextSummaryId()
      const parent2 = nextSummaryId()

      await LcmDb.insertSprigSummary({
        summaryId: parent1,
        conversationId: testConversationId,
        content: "Parent summary 1",
        tokenCount: 10,
        messageIds: [],
      })

      await LcmDb.insertSprigSummary({
        summaryId: parent2,
        conversationId: testConversationId,
        content: "Parent summary 2",
        tokenCount: 10,
        messageIds: [],
      })

      // Create bindle summary
      const condensedId = nextSummaryId()
      await LcmDb.insertBindleSummary({
        summaryId: condensedId,
        conversationId: testConversationId,
        content: "Condensed from parent summaries",
        tokenCount: 15,
        parentSummaryIds: [parent1, parent2],
      })

      const summary = await LcmDb.getSummaryById(condensedId)
      expect(summary).not.toBeNull()
      expect(summary!.kind).toBe("bindle")
      expect(summary!.summary_level).toBe("bindle")
      expect(summary!.summary_type).toBe("bindle")

      const parentIds = await LcmDb.getSummaryParentIds(condensedId)
      expect(parentIds).toContain(parent1)
      expect(parentIds).toContain(parent2)
    })

    test("insertBindleSummary rejects bindle parents", async () => {
      const leaf1 = nextSummaryId()
      const leaf2 = nextSummaryId()
      const bindleId = nextSummaryId()
      const invalidBindleId = nextSummaryId()

      await LcmDb.insertSprigSummary({
        summaryId: leaf1,
        conversationId: testConversationId,
        content: "Leaf summary 1",
        tokenCount: 8,
        messageIds: [],
      })
      await LcmDb.insertSprigSummary({
        summaryId: leaf2,
        conversationId: testConversationId,
        content: "Leaf summary 2",
        tokenCount: 8,
        messageIds: [],
      })
      await LcmDb.insertBindleSummary({
        summaryId: bindleId,
        conversationId: testConversationId,
        content: "Bindle over sprig summaries",
        tokenCount: 12,
        parentSummaryIds: [leaf1, leaf2],
      })

      await expect(
        LcmDb.insertBindleSummary({
          summaryId: invalidBindleId,
          conversationId: testConversationId,
          content: "Invalid bindle over bindle parent",
          tokenCount: 10,
          parentSummaryIds: [bindleId],
        }),
      ).rejects.toMatchObject({
        name: "LcmDbInvariantError",
        data: { message: "Cannot aggregate bindle summaries; bindles may only be created from sprig summaries" },
      })

      const invalidBindle = await LcmDb.getSummaryById(invalidBindleId)
      expect(invalidBindle).toBeNull()
    })

    test("migrate remaps legacy sprig/bindle labels to canonical order metadata", async () => {
      const sprigId = nextSummaryId()
      const bindleId = nextSummaryId()
      const conn = LcmDb.getConnection()

      await LcmDb.insertSprigSummary({
        summaryId: sprigId,
        conversationId: testConversationId,
        content: "legacy sprig seed",
        tokenCount: 6,
        messageIds: [],
      })
      await LcmDb.insertBindleSummary({
        summaryId: bindleId,
        conversationId: testConversationId,
        content: "legacy bindle seed",
        tokenCount: 8,
        parentSummaryIds: [sprigId],
      })

      await conn`ALTER TABLE summaries DROP CONSTRAINT IF EXISTS summaries_summary_level_check`
      await conn`ALTER TABLE summaries ALTER COLUMN condensation_order DROP NOT NULL`
      await conn`
        UPDATE summaries
        SET summary_level = 'sprig',
            condensation_order = NULL,
            summary_type = 'sprig'
        WHERE summary_id = ${sprigId}
      `
      await conn`
        UPDATE summaries
        SET summary_level = 'bindle',
            condensation_order = NULL,
            summary_type = 'bindle'
        WHERE summary_id = ${bindleId}
      `

      await LcmDb.migrate()

      const rows = await conn<{ summary_id: string; summary_level: string; condensation_order: number }[]>`
        SELECT summary_id, summary_level, condensation_order
        FROM summaries
        WHERE summary_id IN (${sprigId}, ${bindleId})
        ORDER BY summary_id ASC
      `
      const byId = new Map(rows.map((row) => [row.summary_id, row]))
      expect(byId.get(sprigId)?.summary_level).toBe("d1")
      expect(byId.get(sprigId)?.condensation_order).toBe(1)
      expect(byId.get(bindleId)?.summary_level).toBe("d2")
      expect(byId.get(bindleId)?.condensation_order).toBe(2)
    })

    test("persists and reads d3 condensation order summaries", async () => {
      const sprig1 = nextSummaryId()
      const sprig2 = nextSummaryId()
      const d2 = nextSummaryId()
      const d3 = nextSummaryId()

      await LcmDb.insertSprigSummary({
        summaryId: sprig1,
        conversationId: testConversationId,
        content: "d1 parent 1",
        tokenCount: 4,
        messageIds: [],
      })
      await LcmDb.insertSprigSummary({
        summaryId: sprig2,
        conversationId: testConversationId,
        content: "d1 parent 2",
        tokenCount: 4,
        messageIds: [],
      })
      await LcmDb.insertBindleSummary({
        summaryId: d2,
        conversationId: testConversationId,
        content: "d2 condensation",
        tokenCount: 7,
        parentSummaryIds: [sprig1, sprig2],
        condensationOrder: 2,
      })
      await LcmDb.insertBindleSummary({
        summaryId: d3,
        conversationId: testConversationId,
        content: "d3 condensation",
        tokenCount: 9,
        parentSummaryIds: [d2],
        condensationOrder: 3,
      })

      const summary = await LcmDb.getSummaryById(d3)
      expect(summary).not.toBeNull()
      expect(summary!.condensation_order).toBe(3)
      expect(summary!.summary_level).toBe("d3")
      expect(summary!.summary_type).toBe("bindle")
    })

    test("supports archive stub lineage pointers and off-context retrieval metadata", async () => {
      const leaf1 = nextSummaryId()
      const leaf2 = nextSummaryId()
      const bindleId = nextSummaryId()
      const stubId = nextSummaryId()

      await LcmDb.insertSprigSummary({
        summaryId: leaf1,
        conversationId: testConversationId,
        content: "Leaf 1",
        tokenCount: 5,
        messageIds: [],
      })
      await LcmDb.insertSprigSummary({
        summaryId: leaf2,
        conversationId: testConversationId,
        content: "Leaf 2",
        tokenCount: 5,
        messageIds: [],
      })
      await LcmDb.insertBindleSummary({
        summaryId: bindleId,
        conversationId: testConversationId,
        content: "Bindle over two leaves",
        tokenCount: 8,
        parentSummaryIds: [leaf1, leaf2],
      })
      await LcmDb.insertBindleSummary({
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

    test("evicts oldest active bindles on overflow with archive-stub lineage across repeated rounds", async () => {
      setLcmPolicyConfigForTesting(
        parseLcmPolicyConfig({
          VOLTCODE_LCM_MODE: "dolt",
          VOLTCODE_LCM_DOLT_BINDLES_SOFT: "20",
          VOLTCODE_LCM_DOLT_BINDLES_DELTA: "1",
          VOLTCODE_LCM_DOLT_BINDLES_TARGET: "15",
        }),
      )

      const conn = LcmDb.getConnection()

      async function appendBindleToContext(label: string): Promise<string> {
        const leaf1 = nextSummaryId()
        const leaf2 = nextSummaryId()
        const bindleId = nextSummaryId()

        await LcmDb.insertSprigSummary({
          summaryId: leaf1,
          conversationId: testConversationId,
          content: `${label} sprig 1`,
          tokenCount: 4,
          messageIds: [],
        })
        await LcmDb.insertSprigSummary({
          summaryId: leaf2,
          conversationId: testConversationId,
          content: `${label} sprig 2`,
          tokenCount: 4,
          messageIds: [],
        })
        await LcmDb.insertBindleSummary({
          summaryId: bindleId,
          conversationId: testConversationId,
          content: `${label} bindle with longer content to ensure deterministic eviction behavior`,
          tokenCount: 12,
          parentSummaryIds: [leaf1, leaf2],
        })

        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: `placeholder for ${bindleId}`,
          tokenCount: 1,
        })
        const contextBeforeReplacement = await LcmDb.getCurrentContext(testConversationId)
        const insertedMessagePosition = contextBeforeReplacement.length - 1
        await LcmDb.replaceContextWithSummary({
          conversationId: testConversationId,
          startPosition: insertedMessagePosition,
          endPosition: insertedMessagePosition,
          summaryId: bindleId,
        })

        return bindleId
      }

      try {
        const firstBatch = [
          await appendBindleToContext("batch-1"),
          await appendBindleToContext("batch-2"),
          await appendBindleToContext("batch-3"),
          await appendBindleToContext("batch-4"),
        ]

        const user = {
          id: "user-overflow",
          sessionID: "session-overflow",
          role: "user",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        } as any
        const model = { id: "test-model", providerID: "test" } as any

        const firstPass = await LcmContext.onContextThresholdReached({
          conversationId: testConversationId,
          sessionID: "session-overflow",
          user,
          model,
          overhead: 0,
          reserve: 0,
          contextWindow: MAX_TOKENS,
        })
        expect(firstPass.actionTaken).toBe(true)

        const contextAfterFirstPass = await LcmContext.getSummariesInContext(testConversationId)
        expect(contextAfterFirstPass.map((summary) => summary.summaryId)).toEqual([firstBatch[3]])

        const secondBatch = [await appendBindleToContext("batch-5"), await appendBindleToContext("batch-6")]
        const secondPass = await LcmContext.onContextThresholdReached({
          conversationId: testConversationId,
          sessionID: "session-overflow",
          user,
          model,
          overhead: 0,
          reserve: 0,
          contextWindow: MAX_TOKENS,
        })
        expect(secondPass.actionTaken).toBe(true)

        const contextAfterSecondPass = await LcmContext.getSummariesInContext(testConversationId)
        expect(contextAfterSecondPass.map((summary) => summary.summaryId)).toEqual([secondBatch[1]])

        const evictedBindles = [firstBatch[0], firstBatch[1], firstBatch[2], firstBatch[3], secondBatch[0]]
        for (const bindleId of evictedBindles) {
          const bindle = await LcmDb.getSummaryById(bindleId)
          expect(bindle).not.toBeNull()
          expect(bindle!.summary_type).toBe("bindle")
          expect(bindle!.is_off_context).toBe(true)

          const pointersToBindle = await conn<{ summary_id: string; pointer_kind: string }[]>`
            SELECT summary_id, pointer_kind
            FROM summary_lineage_pointers
            WHERE points_to_summary_id = ${bindleId}
              AND pointer_kind = 'archive_stub'
            ORDER BY created_at ASC
          `
          expect(pointersToBindle.length).toBeGreaterThan(0)
          const stubId = pointersToBindle[0].summary_id
          const stub = await LcmDb.getSummaryById(stubId)
          expect(stub).not.toBeNull()
          expect(stub!.summary_type).toBe("archive_stub")
          expect(stub!.is_off_context).toBe(true)
          expect(stub!.content).toContain(`bindle_id: ${bindleId}`)
          const parentLeafIds = await LcmDb.getSummaryParentIds(bindleId)
          expect(parentLeafIds.length).toBeGreaterThan(0)
        }

        const activeBindle = await LcmDb.getSummaryById(secondBatch[1])
        expect(activeBindle).not.toBeNull()
        expect(activeBindle!.summary_type).toBe("bindle")
        expect(activeBindle!.is_off_context).toBe(false)

        const offContextBindles = await LcmDb.getOffContextSummaries({
          conversationId: testConversationId,
          summaryLevel: "bindle",
        })
        for (const bindleId of evictedBindles) {
          expect(offContextBindles.some((summary) => summary.summary_id === bindleId)).toBe(true)
        }
        expect(offContextBindles.some((summary) => summary.summary_id === secondBatch[1])).toBe(false)

        const bindleToBindleEdges = await conn<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM summary_parents sp
          JOIN summaries child ON child.summary_id = sp.summary_id
          JOIN summaries parent ON parent.summary_id = sp.parent_summary_id
          WHERE child.condensation_order = 2
            AND parent.condensation_order = 2
            AND child.summary_type = 'bindle'
            AND parent.summary_type = 'bindle'
        `
        expect(bindleToBindleEdges[0]?.count ?? 0).toBe(0)
      } finally {
        setLcmPolicyConfigForTesting(null)
      }
    })

    test("skips ghost cue generation and archive stub writes in upward mode under bindle pressure", async () => {
      setLcmPolicyConfigForTesting(
        parseLcmPolicyConfig({
          VOLTCODE_LCM_MODE: "upward",
          VOLTCODE_LCM_UPWARD_BINDLES_SOFT: "20",
          VOLTCODE_LCM_UPWARD_BINDLES_DELTA: "1",
          VOLTCODE_LCM_UPWARD_BINDLES_TARGET: "15",
        }),
      )

      const conn = LcmDb.getConnection()
      let ghostCuePromptLoads = 0
      LcmGhostCue.setGhostCuePromptLoaderForTesting(async () => {
        ghostCuePromptLoads += 1
        return "ghost cue prompt should not be loaded in upward mode"
      })

      async function appendBindleToContext(label: string): Promise<string> {
        const leaf1 = nextSummaryId()
        const leaf2 = nextSummaryId()
        const bindleId = nextSummaryId()

        await LcmDb.insertSprigSummary({
          summaryId: leaf1,
          conversationId: testConversationId,
          content: `${label} sprig 1`,
          tokenCount: 4,
          messageIds: [],
        })
        await LcmDb.insertSprigSummary({
          summaryId: leaf2,
          conversationId: testConversationId,
          content: `${label} sprig 2`,
          tokenCount: 4,
          messageIds: [],
        })
        await LcmDb.insertBindleSummary({
          summaryId: bindleId,
          conversationId: testConversationId,
          content: `${label} bindle with longer content to ensure deterministic eviction behavior`,
          tokenCount: 12,
          parentSummaryIds: [leaf1, leaf2],
        })

        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: `placeholder for ${bindleId}`,
          tokenCount: 1,
        })
        const contextBeforeReplacement = await LcmDb.getCurrentContext(testConversationId)
        const insertedMessagePosition = contextBeforeReplacement.length - 1
        await LcmDb.replaceContextWithSummary({
          conversationId: testConversationId,
          startPosition: insertedMessagePosition,
          endPosition: insertedMessagePosition,
          summaryId: bindleId,
        })

        return bindleId
      }

      try {
        await appendBindleToContext("upward-batch-1")
        await appendBindleToContext("upward-batch-2")
        await appendBindleToContext("upward-batch-3")
        await appendBindleToContext("upward-batch-4")

        const user = {
          id: "user-overflow-upward",
          sessionID: "session-overflow-upward",
          role: "user",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        } as any
        const model = { id: "test-model", providerID: "test" } as any

        const result = await LcmContext.onContextThresholdReached({
          conversationId: testConversationId,
          sessionID: "session-overflow-upward",
          user,
          model,
          overhead: 0,
          reserve: 0,
          contextWindow: MAX_TOKENS,
        })

        expect(result.actionTaken).toBe(true)
        expect((result.evictedBindleIds ?? []).length).toBeGreaterThan(0)
        expect(result.archiveStubIds ?? []).toEqual([])
        expect(ghostCuePromptLoads).toBe(0)

        const archiveStubCount = await conn<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM summaries
          WHERE conversation_id = ${testConversationId}
            AND summary_type = 'archive_stub'
        `
        expect(archiveStubCount[0]?.count ?? 0).toBe(0)

        const archivePointerCount = await conn<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM summary_lineage_pointers sp
          JOIN summaries s ON s.summary_id = sp.summary_id
          WHERE s.conversation_id = ${testConversationId}
            AND sp.pointer_kind = 'archive_stub'
        `
        expect(archivePointerCount[0]?.count ?? 0).toBe(0)
      } finally {
        LcmGhostCue.setGhostCuePromptLoaderForTesting(null)
        setLcmPolicyConfigForTesting(null)
      }
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
      const summaryId = nextSummaryId()
      await LcmDb.insertSprigSummary({
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

      // Verify context is lane-ordered: summary lane first, then leaves
      const context = await LcmDb.getCurrentContext(testConversationId)
      expect(context.length).toBe(3)
      expect(context[0].item_type).toBe("summary")
      expect(context[1].item_type).toBe("message")
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
      const summary1 = nextSummaryId()
      const summary2 = nextSummaryId()

      await LcmDb.insertSprigSummary({
        summaryId: summary1,
        conversationId: testConversationId,
        content: "Summary 1",
        tokenCount: 10,
        messageIds: [],
      })

      await LcmDb.insertSprigSummary({
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

    test("replacePositionsWithSummary keeps lane-order invariant when compacting sprigs", async () => {
      for (let i = 0; i < 8; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: `Message ${i}`,
          tokenCount: 10,
        })
      }

      const leaf1 = nextSummaryId()
      const leaf2 = nextSummaryId()
      const bindle = nextSummaryId()
      const compactedBindle = nextSummaryId()

      await LcmDb.insertSprigSummary({
        summaryId: leaf1,
        conversationId: testConversationId,
        content: "Leaf 1",
        tokenCount: 8,
        messageIds: [],
      })
      await LcmDb.insertSprigSummary({
        summaryId: leaf2,
        conversationId: testConversationId,
        content: "Leaf 2",
        tokenCount: 8,
        messageIds: [],
      })
      await LcmDb.insertBindleSummary({
        summaryId: bindle,
        conversationId: testConversationId,
        content: "Existing bindle",
        tokenCount: 10,
        parentSummaryIds: [leaf1, leaf2],
      })
      await LcmDb.insertBindleSummary({
        summaryId: compactedBindle,
        conversationId: testConversationId,
        content: "Compacted sprig-only bindle",
        tokenCount: 9,
        parentSummaryIds: [leaf1, leaf2],
      })

      // Create mixed context, then verify normalization into lane order.
      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 1,
        endPosition: 1,
        summaryId: leaf1,
      })
      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 3,
        endPosition: 3,
        summaryId: bindle,
      })
      await LcmDb.replaceContextWithSummary({
        conversationId: testConversationId,
        startPosition: 5,
        endPosition: 5,
        summaryId: leaf2,
      })

      const before = await LcmDb.getCurrentContext(testConversationId)
      const beforeLabels = before.map((entry) => {
        if (entry.item_type === "message") return entry.content
        return extractSummaryIdFromContextContent(entry.content) ?? "unknown-summary"
      })
      expect(beforeLabels).toEqual([
        bindle,
        leaf1,
        leaf2,
        "Message 0",
        "Message 2",
        "Message 4",
        "Message 6",
        "Message 7",
      ])

      const sprigPositions = before
        .filter((entry) => entry.item_type === "summary")
        .map((entry) => ({ position: entry.position, summaryId: extractSummaryIdFromContextContent(entry.content) }))
        .filter((entry) => entry.summaryId === leaf1 || entry.summaryId === leaf2)
        .map((entry) => entry.position)
      expect(sprigPositions.length).toBe(2)

      await LcmDb.replacePositionsWithSummary({
        conversationId: testConversationId,
        positions: sprigPositions,
        summaryId: compactedBindle,
      })

      const after = await LcmDb.getCurrentContext(testConversationId)
      const afterLabels = after.map((entry) => {
        if (entry.item_type === "message") return entry.content
        return extractSummaryIdFromContextContent(entry.content) ?? "unknown-summary"
      })
      expect(afterLabels).toEqual([
        bindle,
        compactedBindle,
        "Message 0",
        "Message 2",
        "Message 4",
        "Message 6",
        "Message 7",
      ])
    })

    test("replacePositionsWithSummary normalizes duplicate and unsorted positions", async () => {
      for (let i = 0; i < 7; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: "user",
          content: `Message ${i}`,
          tokenCount: 10,
        })
      }

      const summaryId = nextSummaryId()
      await LcmDb.insertSprigSummary({
        summaryId,
        conversationId: testConversationId,
        content: "Summary replacement",
        tokenCount: 10,
        messageIds: [],
      })

      await LcmDb.replacePositionsWithSummary({
        conversationId: testConversationId,
        positions: [4, 2, 2, 1, -3],
        summaryId,
      })

      const context = await LcmDb.getCurrentContext(testConversationId)
      expect(context.length).toBe(5)
      expect(context.filter((entry) => entry.item_type === "summary").length).toBe(1)
      expect(context[0].item_type).toBe("summary")
      expect(context[1].content).toContain("Message 0")
      expect(context[2].content).toContain("Message 3")
      expect(context[3].content).toContain("Message 5")
      expect(context[4].content).toContain("Message 6")
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
     * 3. Multiple summaries can be bindle
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
      const summary1Id = nextSummaryId()
      await LcmDb.insertSprigSummary({
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
      const summary2Id = nextSummaryId()
      await LcmDb.insertSprigSummary({
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
      const summary3Id = nextSummaryId()
      await LcmDb.insertSprigSummary({
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
      const condensedId = nextSummaryId()
      await LcmDb.insertBindleSummary({
        summaryId: condensedId,
        conversationId: testConversationId,
        content: `[Condensed from: ${summary1Id}, ${summary2Id}, ${summary3Id}] This conversation covered software architecture, design patterns, testing strategies, code quality, and practical implementations. Key insights were shared across multiple exchanges.`,
        tokenCount: 60,
        parentSummaryIds: [summary1Id, summary2Id, summary3Id],
      })

      // Replace all 3 summaries with the bindle one
      await LcmDb.replacePositionsWithSummary({
        conversationId: testConversationId,
        positions: [0, 1, 2],
        summaryId: condensedId,
      })

      // Verify final state
      context = await LcmDb.getCurrentContext(testConversationId)
      const finalSummaries = await LcmContext.getSummariesInContext(testConversationId)

      console.log(`Final state: ${context.length} items, ${finalSummaries.length} summary(ies)`)

      // Should have exactly 1 bindle summary
      expect(finalSummaries.length).toBe(1)
      expect(finalSummaries[0].kind).toBe("bindle")
      expect(finalSummaries[0].parents).toContain(summary1Id)
      expect(finalSummaries[0].parents).toContain(summary2Id)
      expect(finalSummaries[0].parents).toContain(summary3Id)

      // Verify the bindle summary can be expanded back to original messages
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
          const summaryId = nextSummaryId()
          await LcmDb.insertSprigSummary({
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

        // Check if we need to condense sprig summaries (more than 5 leaves)
        const summaries = await LcmContext.getSummariesInContext(testConversationId)
        const leafSummaries = summaries.filter((summary) => summary.kind === "sprig")
        if (leafSummaries.length >= 5) {
          const condensedId = nextSummaryId("sum_cond")
          const parentIds = leafSummaries.map((summary) => summary.summaryId)

          await LcmDb.insertBindleSummary({
            summaryId: condensedId,
            conversationId: testConversationId,
            content: `[Condensed summary of ${leafSummaries.length} sprig summaries] This bindle captures the key themes from multiple conversation segments.`,
            tokenCount: 40,
            parentSummaryIds: parentIds,
          })

          // Replace only sprig summaries in context; keep existing bindles untouched
          const leafSummaryIds = new Set(parentIds)
          const context = await LcmDb.getCurrentContext(testConversationId)
          const summaryPositions: number[] = []
          for (let pos = 0; pos < context.length; pos++) {
            if (context[pos].item_type !== "summary") continue
            const summaryId = extractSummaryIdFromContextContent(context[pos].content)
            if (summaryId && leafSummaryIds.has(summaryId)) {
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
      const conn = LcmDb.getConnection()
      const bindleToBindleEdges = await conn<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM summary_parents sp
        JOIN summaries child ON child.summary_id = sp.summary_id
        JOIN summaries parent ON parent.summary_id = sp.parent_summary_id
        WHERE child.condensation_order = 2
          AND parent.condensation_order = 2
          AND child.summary_type = 'bindle'
          AND parent.summary_type = 'bindle'
      `

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

      // Invariant: bindles are only aggregated from leaves
      expect(bindleToBindleEdges[0]?.count ?? 0).toBe(0)
    })
  })
})
