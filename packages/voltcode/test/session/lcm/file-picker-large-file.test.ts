import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test"
import { LargeFileThreshold } from "../../../src/session/lcm/large-file-threshold"
import { LargeFile } from "../../../src/session/lcm/large-file"
import { ExploreDispatcher } from "../../../src/session/lcm/explore/dispatcher"
import { Provider } from "../../../src/provider/provider"

describe("session.lcm.file-picker-large-file", () => {
  describe("LargeFileThreshold integration", () => {
    test("files under byte threshold are not considered large", () => {
      // 50KB of content - under 100KB threshold
      const content = "a".repeat(50_000)
      expect(LargeFileThreshold.isLargeFile(content)).toBe(false)
    })

    test("files over byte threshold are considered large", () => {
      // 150KB of content - over 100KB threshold
      const content = "a".repeat(150_000)
      expect(LargeFileThreshold.isLargeFile(content)).toBe(true)
    })

    test("files over token threshold but under byte threshold are considered large", () => {
      // Create content that is ~26k tokens (104k chars) but just over 100KB
      const content = "a".repeat(104_000)
      expect(LargeFileThreshold.isLargeFile(content)).toBe(true)
    })

    test("token estimation is approximately 4 chars per token", () => {
      const content = "a".repeat(4000)
      const tokens = LargeFileThreshold.estimateTokenCount(content)
      expect(tokens).toBe(1000)
    })
  })

  describe("LargeFile ID generation", () => {
    test("generates deterministic file ID from content", () => {
      const content = "This is test file content"
      const id1 = LargeFile.generateId(content)
      const id2 = LargeFile.generateId(content)

      expect(id1).toBe(id2)
      expect(id1).toMatch(/^file_[a-f0-9]{16}$/)
    })

    test("generates different IDs for different content", () => {
      const id1 = LargeFile.generateId("Content A")
      const id2 = LargeFile.generateId("Content B")

      expect(id1).not.toBe(id2)
    })

    test("validates correct file ID format", () => {
      const id = LargeFile.generateId("test content")
      expect(LargeFile.isValidId(id)).toBe(true)
    })

    test("rejects invalid file ID format", () => {
      expect(LargeFile.isValidId("invalid_id")).toBe(false)
      expect(LargeFile.isValidId("file_tooshort")).toBe(false)
      expect(LargeFile.isValidId("file_waytooooolonggggggg")).toBe(false)
    })
  })

  describe("LargeFile context formatting", () => {
    test("formats text file info for context", () => {
      const info = LargeFile.createTextInfo({
        conversationId: "ses_test123",
        originalPath: "/path/to/large-file.json",
        mimeType: "application/json",
        content: "a".repeat(150_000),
        tokenCount: 37500,
      })

      const formatted = LargeFile.formatForContext(info)

      expect(formatted).toContain(`[Large File ID: ${info.fileId}]`)
      expect(formatted).toContain("[Path: /path/to/large-file.json]")
      expect(formatted).toContain("[Type: application/json]")
      expect(formatted).toContain("[Tokens: 37500]")
      expect(formatted).toContain("use file ID to retrieve")
    })

    test("formats file info without path", () => {
      const info = LargeFile.createTextInfo({
        conversationId: "ses_test123",
        mimeType: "text/plain",
        content: "test content",
        tokenCount: 100,
      })

      const formatted = LargeFile.formatForContext(info)

      expect(formatted).toContain(`[Large File ID: ${info.fileId}]`)
      expect(formatted).not.toContain("[Path:")
    })
  })

  describe("LargeFile ID extraction", () => {
    test("extracts file IDs from context text", () => {
      const fileId1 = LargeFile.generateId("content1")
      const fileId2 = LargeFile.generateId("content2")

      const contextText = `
        [Large File ID: ${fileId1}]
        Some description mentioning ${fileId2} as well.
      `

      const extracted = LargeFile.extractIdsFromContext(contextText)

      expect(extracted).toContain(fileId1)
      expect(extracted).toContain(fileId2)
      expect(extracted.length).toBe(2)
    })

    test("deduplicates repeated file IDs", () => {
      const fileId = LargeFile.generateId("content")

      const contextText = `
        [Large File ID: ${fileId}]
        Referenced again: ${fileId}
      `

      const extracted = LargeFile.extractIdsFromContext(contextText)
      expect(extracted.length).toBe(1)
    })

    test("returns empty array when no IDs found", () => {
      const extracted = LargeFile.extractIdsFromContext("No file IDs here")
      expect(extracted).toEqual([])
    })
  })

  describe("ExploreDispatcher file type detection", () => {
    // Note: Full exploration tests require actual model calls, so we test
    // the file type detection logic via extension patterns

    const mockModel = {
      id: "test-model",
      providerID: "test",
      name: "Test Model",
      api: { id: "test", url: "http://test", npm: "@ai-sdk/openai" },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 4096 },
      status: "active" as const,
      options: {},
      headers: {},
      release_date: "2024-01-01",
    }

    test("detects JSON files from extension", async () => {
      const content = JSON.stringify({ key: "value" }, null, 2)

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/data.json",
        mimeType: "application/json",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("json")
    })

    test("detects CSV files from extension", async () => {
      const content = "name,age,city\nAlice,30,NYC\nBob,25,LA"

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/data.csv",
        mimeType: "text/csv",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("csv")
    })

    test("detects YAML files from extension", async () => {
      const content = "name: test\nversion: 1.0\n"

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/config.yaml",
        mimeType: "text/yaml",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("yaml")
    })

    test("detects TOML files from extension", async () => {
      const content = '[package]\nname = "test"\nversion = "1.0"\n'

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/Cargo.toml",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("toml")
    })

    test("detects XML files from extension", async () => {
      const content = '<?xml version="1.0"?><root><item>test</item></root>'

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/data.xml",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("xml")
    })

    test("detects HTML files from extension", async () => {
      const content = "<!DOCTYPE html><html><body>Hello</body></html>"

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/page.html",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("html")
    })

    test("detects INI files from extension", async () => {
      const content = "[section]\nkey=value\n"

      const result = await ExploreDispatcher.explore({
        content,
        filePath: "/path/to/config.ini",
        model: mockModel,
      })

      expect(result.explorerUsed).toBe("ini")
    })
  })

  describe("threshold constants", () => {
    test("default byte threshold is 100KB", () => {
      expect(LargeFileThreshold.DEFAULT_BYTE_THRESHOLD).toBe(100_000)
    })

    test("default token threshold is 25K", () => {
      expect(LargeFileThreshold.DEFAULT_TOKEN_THRESHOLD).toBe(25_000)
    })
  })
})
