import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

if (!isLcmAvailable) {
  test.skip("Embedded PostgreSQL not available, skipping async compaction tests", () => {})
} else {
  const { LcmDb } = await import("../../../src/session/lcm/db")
  const { LcmContext } = await import("../../../src/session/lcm/context")

  let testConversationId: number
  const createdConversationIds: number[] = []

  const MAX_TOKENS = 1000
  const THRESHOLD = 0.5

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

  beforeAll(async () => {
    await LcmDb.initialize()
  })

  afterAll(async () => {
    for (const id of createdConversationIds) {
      await cleanupConversation(id)
    }
  })

  beforeEach(async () => {
    testConversationId = await LcmDb.createConversation({
      title: "[Test] LCM Async Compaction",
      modelName: "test-model",
      modelCtxMaxTokens: MAX_TOKENS,
      ctxCutoffThreshold: THRESHOLD,
    })
    createdConversationIds.push(testConversationId)
  })

  describe("session.lcm.async-compaction", () => {
    test("scheduleCompaction dedupes in-flight job and respects fresh-tail floor", async () => {
      // Keep message count below freshTailFloor (default 4) so no turns are
      // eligible for compaction. This validates in-flight dedupe behavior
      // without requiring LLM summarization.
      for (let i = 0; i < 3; i++) {
        await LcmDb.appendMessage({
          conversationId: testConversationId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          tokenCount: 400,
        })
      }

      const thresholdCheck = await LcmContext.isOverThreshold({
        conversationId: testConversationId,
        overhead: 0,
        reserve: 0,
        contextWindow: MAX_TOKENS,
      })
      expect(thresholdCheck.overSoft).toBe(true)

      const user = {
        id: "user-1",
        sessionID: "session-1",
        role: "user",
        model: { providerID: "test", modelID: "test" },
        time: { created: Date.now() },
      } as any
      const model = { id: "test-model", providerID: "test" } as any

      const job = LcmContext.scheduleCompaction({
        conversationId: testConversationId,
        sessionID: "session-1",
        user,
        model,
        overhead: 0,
        reserve: 0,
        contextWindow: MAX_TOKENS,
      })

      expect(job).not.toBeNull()

      const second = LcmContext.scheduleCompaction({
        conversationId: testConversationId,
        sessionID: "session-1",
        user,
        model,
        overhead: 0,
        reserve: 0,
        contextWindow: MAX_TOKENS,
      })

      expect(second).toBeNull()

      const result = await job
      expect(result?.actionTaken).toBe(false)
      expect(result?.createdSummary).toBeUndefined()

      const summaries = await LcmContext.getSummariesInContext(testConversationId)
      expect(summaries.length).toBe(0)
    })
  })
}
