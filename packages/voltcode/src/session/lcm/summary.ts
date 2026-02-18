import { createHash } from "crypto"
import z from "zod"
import { Token } from "@/util/token"

/**
 * Lossless Context Management (LCM) Summary Module
 *
 * This module defines the Summary data model for LCM's high-fanout summary DAG.
 * Summaries come in two kinds:
 * - 'leaf': Summarizes a set of raw messages
 * - 'condensed': Summarizes a set of other summaries (for recursive compression)
 *
 * Summary IDs are deterministic, based on content hash + timestamp, ensuring
 * reproducibility and deduplication.
 */
export namespace Summary {
  /**
   * Summary kind discriminator
   * - 'leaf': Direct summary of messages
   * - 'condensed': Summary of other summaries (high-fanout DAG node)
   */
  export const Kind = z.enum(["leaf", "condensed"])
  export type Kind = z.infer<typeof Kind>

  /**
   * Dolt lane level for summaries.
   * - leaf: L1 summaries over turns/messages
   * - bindle: L2 summaries over leaves
   */
  export const Level = z.enum(["leaf", "bindle"])
  export type Level = z.infer<typeof Level>

  /**
   * Dolt summary node type.
   * - leaf: standard leaf summary
   * - bindle: aggregated summary over leaves
   * - archive_stub: off-context pointer node for evicted bindles
   */
  export const Type = z.enum(["leaf", "bindle", "archive_stub"])
  export type Type = z.infer<typeof Type>

  /**
   * Base schema for Summary data
   */
  export const Schema = z
    .object({
      /** Deterministic ID: "sum_" + hash(content + timestamp) */
      summaryId: z.string().startsWith("sum_"),
      /** The summary text content */
      content: z.string(),
      /** Whether this is a leaf (message summary) or condensed (summary of summaries) */
      kind: Kind,
      /** Explicit Dolt lane level for leaf vs bindle semantics */
      level: Level.optional(),
      /** Explicit Dolt summary node type */
      summaryType: Type.optional(),
      /** Estimated token count for the summary content */
      tokenCount: z.number().int().nonnegative(),
      /** Reference to the conversation/session this summary belongs to */
      conversationId: z.string(),
      /** Parent summary IDs for condensed summaries; empty array for leaf summaries */
      parents: z.array(z.string().startsWith("sum_")),
      /** LCM file IDs referenced by the summarized messages/summaries */
      fileIds: z.array(z.string()).default([]),
      /** Timestamp when the summary was created */
      createdAt: z.number(),
    })
    .meta({
      ref: "Summary",
    })

  export type Info = z.infer<typeof Schema>

  /**
   * Schema for creating a new leaf summary (summarizes messages)
   */
  export const CreateLeafInput = z
    .object({
      content: z.string().min(1),
      tokenCount: z.number().int().nonnegative(),
      conversationId: z.string(),
      /** Message IDs that this summary covers (for leaf summaries) */
      messageIds: z.array(z.string()),
      /** LCM file IDs referenced by the summarized messages */
      fileIds: z.array(z.string()).optional(),
    })
    .meta({
      ref: "CreateLeafSummaryInput",
    })

  export type CreateLeafInput = z.infer<typeof CreateLeafInput>

  /**
   * Schema for creating a new condensed summary (summarizes other summaries)
   */
  export const CreateCondensedInput = z
    .object({
      content: z.string().min(1),
      tokenCount: z.number().int().nonnegative(),
      conversationId: z.string(),
      /** Parent summary IDs being condensed */
      parents: z.array(z.string().startsWith("sum_")).min(1),
      /** LCM file IDs propagated from child summaries */
      fileIds: z.array(z.string()).optional(),
    })
    .meta({
      ref: "CreateCondensedSummaryInput",
    })

  export type CreateCondensedInput = z.infer<typeof CreateCondensedInput>

  /**
   * Schema for creating an archival stub for an evicted bindle.
   *
   * Archive stubs are short, off-context pointer nodes that reference a full
   * bindle via lineage pointers.
   */
  export const CreateArchiveStubInput = z
    .object({
      archivedSummaryId: z.string().startsWith("sum_"),
      archivedSummaryContent: z.string(),
      conversationId: z.string(),
    })
    .meta({
      ref: "CreateArchiveStubInput",
    })

  export type CreateArchiveStubInput = z.infer<typeof CreateArchiveStubInput>

  /**
   * Schema for summary with linked message IDs (for leaf summaries)
   */
  export const WithMessages = Schema.extend({
    /** Message IDs that this leaf summary covers (only for leaf kind) */
    messageIds: z.array(z.string()),
  }).meta({
    ref: "SummaryWithMessages",
  })

  export type WithMessages = z.infer<typeof WithMessages>

  /**
   * Generate a deterministic summary ID based on content and timestamp.
   *
   * The ID format is: "sum_" + first 16 chars of SHA-256 hash
   * Hash input: content + timestamp (ms since epoch)
   *
   * This ensures:
   * - Same content at same time = same ID (idempotent)
   * - Different content or time = different ID (collision-resistant)
   * - IDs are filesystem-safe and URL-safe
   *
   * @param content - The summary text content
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Deterministic summary ID prefixed with "sum_"
   */
  export function generateId(content: string, timestamp?: number): string {
    const ts = timestamp ?? Date.now()
    const hash = createHash("sha256")
      .update(content + ts.toString())
      .digest("hex")
      .slice(0, 16)
    return `sum_${hash}`
  }

  /**
   * Create a new leaf summary info object.
   *
   * @param input - Input data for creating the summary
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete Summary.Info object with generated ID
   */
  export function createLeaf(input: CreateLeafInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    return {
      summaryId: generateId(input.content, ts),
      content: input.content,
      kind: "leaf",
      level: "leaf",
      summaryType: "leaf",
      tokenCount: input.tokenCount,
      conversationId: input.conversationId,
      parents: [],
      fileIds: input.fileIds ?? [],
      createdAt: ts,
    }
  }

  /**
   * Create a new condensed summary info object.
   *
   * A condensed summary is a summary of other summaries, creating
   * a high-fanout DAG structure for efficient retrieval.
   *
   * @param input - Input data for creating the condensed summary
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete Summary.Info object with generated ID and parent references
   */
  export function createCondensed(input: CreateCondensedInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    return {
      summaryId: generateId(input.content, ts),
      content: input.content,
      kind: "condensed",
      level: "bindle",
      summaryType: "bindle",
      tokenCount: input.tokenCount,
      conversationId: input.conversationId,
      parents: input.parents,
      fileIds: input.fileIds ?? [],
      createdAt: ts,
    }
  }

  /**
   * Create a short archival stub for an evicted bindle.
   *
   * The stub carries a compact textual cue for retrieval and keeps the full
   * lineage in DB pointer tables (stub -> full bindle -> leaves/messages).
   *
   * @param input - Input data for creating the archive stub
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete Summary.Info object for the archive stub
   */
  export function createArchiveStub(input: CreateArchiveStubInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    const normalizedContent = input.archivedSummaryContent.replace(/\s+/g, " ").trim()
    const excerptLimit = 160
    const excerpt = normalizedContent.slice(0, excerptLimit).trimEnd()
    const suffix = normalizedContent.length > excerptLimit ? "..." : ""
    const content = `[Archive Stub for ${input.archivedSummaryId}] ${excerpt}${suffix}`

    return {
      summaryId: generateId(`archive_stub:${input.archivedSummaryId}:${content}`, ts),
      content,
      kind: "condensed",
      level: "bindle",
      summaryType: "archive_stub",
      tokenCount: Token.estimate(content),
      conversationId: input.conversationId,
      parents: [],
      fileIds: [],
      createdAt: ts,
    }
  }

  /**
   * Extract the timestamp from a summary ID (if the ID was generated with generateId).
   *
   * Note: This is not directly extractable from hash-based IDs.
   * Use the createdAt field on the Summary.Info object instead.
   *
   * @deprecated Use Summary.Info.createdAt instead
   */
  export function extractTimestamp(_summaryId: string): number | undefined {
    // Hash-based IDs don't contain extractable timestamps
    // The timestamp is stored in the Summary.Info.createdAt field
    return undefined
  }

  /**
   * Validate that a string is a valid summary ID format
   */
  export function isValidId(id: string): boolean {
    return /^sum_[a-f0-9]{16}$/.test(id)
  }

  /**
   * Backwards-compatible mapping from legacy kind values to Dolt level.
   */
  export function levelFromKind(kind: Kind): Level {
    return kind === "condensed" ? "bindle" : "leaf"
  }

  /**
   * Backwards-compatible mapping from legacy kind values to Dolt summary type.
   */
  export function typeFromKind(kind: Kind): Type {
    return kind === "condensed" ? "bindle" : "leaf"
  }

  /**
   * Format summary content for injection into context.
   *
   * This deterministically includes all parent summary IDs in the formatted text,
   * ensuring the model always has access to all IDs for retrieval.
   *
   * @param summary - The summary info object
   * @returns Formatted string for context injection
   */
  export function formatForContext(summary: Info): string {
    const lines: string[] = []
    lines.push(`[Summary ID: ${summary.summaryId}]`)
    if (summary.parents.length > 0) {
      lines.push(`[Parent Summaries: ${summary.parents.join(", ")}]`)
    }
    lines.push("")
    lines.push(summary.content)
    return lines.join("\n")
  }

  /**
   * Extract all summary IDs mentioned in a formatted context string.
   *
   * Useful for parsing context to find retrievable summary references.
   *
   * @param contextText - The context string to search
   * @returns Array of summary IDs found in the text
   */
  export function extractIdsFromContext(contextText: string): string[] {
    const pattern = /sum_[a-f0-9]{16}/g
    const matches = contextText.match(pattern)
    return matches ? [...new Set(matches)] : []
  }
}
