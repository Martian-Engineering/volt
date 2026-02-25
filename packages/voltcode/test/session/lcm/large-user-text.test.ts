import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { LcmDb } from "../../../src/session/lcm/db"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"
import { LargeFileThreshold } from "../../../src/session/lcm/large-file-threshold"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

/**
 * Integration test for Large User Text Storage in LCM.
 *
 * This test verifies that:
 * 1. Large text content can be stored via insertLargeTextContent
 * 2. The content can be retrieved via getLargeFileContent
 * 3. Token counts are correctly estimated
 * 4. File IDs are deterministic based on content hash
 *
 * Requirements:
 * - Embedded PostgreSQL must be available
 */
describe("session.lcm.large-user-text", () => {
  // Skip all tests if LCM is not configured
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping large user text tests", () => {})
    return
  }

  let testConversationId: number
  const createdConversationIds: number[] = []
  const createdFileIds: string[] = []

  async function cleanupConversation(id: number) {
    const conn = LcmDb.getConnection()
    await conn`DELETE FROM large_files WHERE conversation_id = ${id}`.catch(() => {})
    await conn`DELETE FROM conversations WHERE conversation_id = ${id}`.catch(() => {})
  }

  beforeAll(async () => {
    // Initialize the database
    await LcmDb.initialize()

    // Create a test conversation
    testConversationId = await LcmDb.createConversation({
      title: "[Test] Large User Text",
      modelName: "test-model",
      modelCtxMaxTokens: 128000,
    })
    createdConversationIds.push(testConversationId)
  })

  afterAll(async () => {
    // Clean up all test conversations
    for (const id of createdConversationIds) {
      await cleanupConversation(id)
    }
  })

  test("insertLargeTextContent stores text and returns correct metadata", async () => {
    // Generate content that exceeds the threshold (~100KB)
    const largeContent = "x".repeat(LargeFileThreshold.DEFAULT_BYTE_THRESHOLD + 1000)

    const result = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: largeContent,
      mimeType: "text/plain",
      label: "test_user_prompt_1",
    })

    createdFileIds.push(result.fileId)

    expect(result.fileId).toMatch(/^file_/)
    expect(result.tokenCount).toBeGreaterThan(0)

    // Token count should be approximately content.length / 4
    const expectedTokenCount = Math.ceil(largeContent.length / 4)
    expect(result.tokenCount).toBe(expectedTokenCount)
  })

  test("getLargeFileContent retrieves stored inline content", async () => {
    const testContent = "This is a test of inline content storage. " + "y".repeat(200)

    const { fileId } = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: testContent,
      mimeType: "text/plain",
      label: "test_user_prompt_2",
    })

    createdFileIds.push(fileId)

    const retrieved = await LcmDb.getLargeFileContent(fileId)

    expect(retrieved).not.toBeNull()
    expect(retrieved!.content).toBe(testContent)
    expect(retrieved!.truncated).toBe(false)
    expect(retrieved!.totalSize).toBe(testContent.length)
  })

  test("getLargeFileContent respects maxBytes parameter", async () => {
    const testContent = "Hello World! ".repeat(100)

    const { fileId } = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: testContent,
      mimeType: "text/plain",
      label: "test_user_prompt_3",
    })

    createdFileIds.push(fileId)

    // Request only first 50 bytes
    const retrieved = await LcmDb.getLargeFileContent(fileId, 50)

    expect(retrieved).not.toBeNull()
    expect(retrieved!.content.length).toBeLessThanOrEqual(50)
    expect(retrieved!.truncated).toBe(true)
    expect(retrieved!.totalSize).toBe(testContent.length)
  })

  test("duplicate content produces same file ID (idempotency)", async () => {
    const duplicateContent = "This content should produce the same ID."

    const result1 = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: duplicateContent,
      mimeType: "text/plain",
      label: "test_dup_1",
    })

    const result2 = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: duplicateContent,
      mimeType: "text/plain",
      label: "test_dup_2",
    })

    createdFileIds.push(result1.fileId)

    // Same content should produce same file ID
    expect(result1.fileId).toBe(result2.fileId)
  })

  test("different content produces different file IDs", async () => {
    const content1 = "First unique content block."
    const content2 = "Second unique content block."

    const result1 = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: content1,
      mimeType: "text/plain",
      label: "test_unique_1",
    })

    const result2 = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: content2,
      mimeType: "text/plain",
      label: "test_unique_2",
    })

    createdFileIds.push(result1.fileId, result2.fileId)

    // Different content should produce different file IDs
    expect(result1.fileId).not.toBe(result2.fileId)
  })

  test("getLargeFile returns correct metadata for inline content", async () => {
    const testContent = "Metadata test content."

    const { fileId, tokenCount } = await LcmDb.insertLargeTextContent({
      conversationId: testConversationId,
      content: testContent,
      mimeType: "text/plain",
      label: "test_metadata",
    })

    createdFileIds.push(fileId)

    const file = await LcmDb.getLargeFile(fileId)

    expect(file).not.toBeNull()
    expect(file!.file_id).toBe(fileId)
    expect(file!.conversation_id).toBe(testConversationId)
    expect(file!.storage_kind).toBe("inline_text")
    expect(file!.mime_type).toBe("text/plain")
    expect(file!.original_path).toBeNull()
    expect(file!.content).toBe(testContent)
    expect(Number(file!.token_count)).toBe(tokenCount)
  })

  test("LargeFileThreshold.isLargeFile correctly identifies large text", () => {
    // Just under threshold
    const smallContent = "x".repeat(LargeFileThreshold.DEFAULT_BYTE_THRESHOLD - 1)
    expect(LargeFileThreshold.isLargeFile(smallContent)).toBe(false)

    // Just over threshold
    const largeContent = "x".repeat(LargeFileThreshold.DEFAULT_BYTE_THRESHOLD + 1)
    expect(LargeFileThreshold.isLargeFile(largeContent)).toBe(true)
  })
})
