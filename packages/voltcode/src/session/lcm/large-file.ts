import { createHash } from "crypto"
import z from "zod"

/**
 * Lossless Context Management (LCM) Large File Module
 *
 * This module defines the LargeFile data model for LCM's large file storage.
 * Large files are files that are too large to fit in context but need to be
 * stored for potential retrieval during a conversation.
 *
 * File IDs are deterministic, based on content hash, ensuring
 * reproducibility and deduplication.
 */
export namespace LargeFile {
  /**
   * Base schema for LargeFile metadata (without content)
   */
  export const Schema = z
    .object({
      /** Deterministic ID: "file_" + hash(content) */
      fileId: z.string().startsWith("file_"),
      /** Reference to the conversation/session this file belongs to */
      conversationId: z.string(),
      /** Original file path (if available) */
      originalPath: z.string().nullable(),
      /** MIME type of the file */
      mimeType: z.string(),
      /** Estimated token count for the file content */
      tokenCount: z.number().int().nonnegative(),
      /** Whether this is a binary file (vs text) */
      isBinary: z.boolean(),
      /** Timestamp when the file was stored */
      createdAt: z.number(),
    })
    .meta({
      ref: "LargeFile",
    })

  export type Info = z.infer<typeof Schema>

  /**
   * Schema for creating a new large text file
   */
  export const CreateTextInput = z
    .object({
      conversationId: z.string(),
      originalPath: z.string().optional(),
      mimeType: z.string(),
      content: z.string(),
      tokenCount: z.number().int().nonnegative(),
    })
    .meta({
      ref: "CreateLargeTextFileInput",
    })

  export type CreateTextInput = z.infer<typeof CreateTextInput>

  /**
   * Schema for creating a new large binary file
   */
  export const CreateBinaryInput = z
    .object({
      conversationId: z.string(),
      originalPath: z.string().optional(),
      mimeType: z.string(),
      binaryContent: z.instanceof(Uint8Array),
      tokenCount: z.number().int().nonnegative(),
    })
    .meta({
      ref: "CreateLargeBinaryFileInput",
    })

  export type CreateBinaryInput = z.infer<typeof CreateBinaryInput>

  /**
   * Generate a deterministic file ID based on content hash.
   *
   * The ID format is: "file_" + first 16 chars of SHA-256 hash
   * Hash input: the file content
   *
   * This ensures:
   * - Same content = same ID (idempotent/deduplication)
   * - Different content = different ID (collision-resistant)
   * - IDs are filesystem-safe and URL-safe
   *
   * @param content - The file content (string or Uint8Array)
   * @returns Deterministic file ID prefixed with "file_"
   */
  export function generateId(content: string | Uint8Array): string {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
    return `file_${hash}`
  }

  /**
   * Create a new large text file info object (metadata only).
   *
   * @param input - Input data for creating the file entry
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete LargeFile.Info object with generated ID
   */
  export function createTextInfo(input: CreateTextInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    return {
      fileId: generateId(input.content),
      conversationId: input.conversationId,
      originalPath: input.originalPath ?? null,
      mimeType: input.mimeType,
      tokenCount: input.tokenCount,
      isBinary: false,
      createdAt: ts,
    }
  }

  /**
   * Create a new large binary file info object (metadata only).
   *
   * @param input - Input data for creating the binary file entry
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete LargeFile.Info object with generated ID
   */
  export function createBinaryInfo(input: CreateBinaryInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    return {
      fileId: generateId(input.binaryContent),
      conversationId: input.conversationId,
      originalPath: input.originalPath ?? null,
      mimeType: input.mimeType,
      tokenCount: input.tokenCount,
      isBinary: true,
      createdAt: ts,
    }
  }

  /**
   * Validate that a string is a valid file ID format
   */
  export function isValidId(id: string): boolean {
    return /^file_[a-f0-9]{16}$/.test(id)
  }

  /**
   * Format file metadata for context injection.
   *
   * This creates a marker that can be included in context to indicate
   * the existence of a large file that can be retrieved.
   *
   * @param file - The file info object
   * @returns Formatted string for context injection
   */
  export function formatForContext(file: Info): string {
    const lines: string[] = []
    lines.push(`[Large File ID: ${file.fileId}]`)
    if (file.originalPath) {
      lines.push(`[Path: ${file.originalPath}]`)
    }
    lines.push(`[Type: ${file.mimeType}]`)
    lines.push(`[Tokens: ${file.tokenCount}]`)
    lines.push("")
    lines.push("(File content stored externally - use file ID to retrieve)")
    return lines.join("\n")
  }

  /**
   * Extract all file IDs mentioned in a context string.
   *
   * Useful for parsing context to find retrievable file references.
   *
   * @param contextText - The context string to search
   * @returns Array of file IDs found in the text
   */
  export function extractIdsFromContext(contextText: string): string[] {
    const pattern = /file_[a-f0-9]{16}/g
    const matches = contextText.match(pattern)
    return matches ? [...new Set(matches)] : []
  }
}
