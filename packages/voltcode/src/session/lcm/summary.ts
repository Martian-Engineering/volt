import { createHash } from "crypto"
import z from "zod"
import { Token } from "@/util/token"

/**
 * Lossless Context Management (LCM) Summary Module
 *
 * This module defines the Summary data model for LCM's high-fanout summary DAG.
 * Summaries come in two kinds:
 * - 'sprig': Summarizes a set of raw messages
 * - 'bindle': Summarizes a set of other summaries (for recursive compression)
 *
 * Summary IDs are deterministic, based on content hash + timestamp, ensuring
 * reproducibility and deduplication.
 */
export namespace Summary {
  /**
   * Summary kind discriminator
   * - 'sprig': Direct summary of messages
   * - 'bindle': Summary of other summaries (high-fanout DAG node)
   */
  export const Kind = z.enum(["sprig", "bindle"])
  export type Kind = z.infer<typeof Kind>

  /**
   * Storage/display level labels.
   * - Dolt aliases: sprig (d1), bindle (d2)
   * - Canonical ordered labels: d1, d2, d3, ...
   */
  export const CanonicalLevel = z.string().regex(/^d[1-9]\d*$/)
  export type CanonicalLevel = z.infer<typeof CanonicalLevel>

  export const DisplayLevelAlias = z.enum(["sprig", "bindle"])
  export type DisplayLevelAlias = z.infer<typeof DisplayLevelAlias>

  export const Level = z.union([DisplayLevelAlias, CanonicalLevel])
  export type Level = z.infer<typeof Level>

  /**
   * Canonical condensation order for summary rows.
   * - 1 => d1 (sprig alias in Dolt)
   * - 2 => d2 (bindle alias in Dolt)
   * - N => dN
   */
  export const CondensationOrder = z.number().int().min(1)
  export type CondensationOrder = z.infer<typeof CondensationOrder>

  /**
   * Dolt summary node type.
   * - sprig: standard sprig summary
   * - bindle: aggregated summary over sprigs
   * - archive_stub: off-context pointer node for evicted bindles
   */
  export const Type = z.enum(["sprig", "bindle", "archive_stub"])
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
      /** Whether this is a sprig (message summary) or bindle (summary of summaries) */
      kind: Kind,
      /** Explicit Dolt lane level for sprig vs bindle semantics */
      level: Level.optional(),
      /** Canonical condensation order for summary hierarchy traversal */
      condensationOrder: CondensationOrder.optional(),
      /** Explicit Dolt summary node type */
      summaryType: Type.optional(),
      /** Estimated token count for the summary content */
      tokenCount: z.number().int().nonnegative(),
      /** Reference to the conversation/session this summary belongs to */
      conversationId: z.string(),
      /** Parent summary IDs for bindle summaries; empty array for sprig summaries */
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
   * Schema for creating a new sprig summary (summarizes messages)
   */
  export const CreateSprigInput = z
    .object({
      content: z.string().min(1),
      tokenCount: z.number().int().nonnegative(),
      conversationId: z.string(),
      /** Message IDs that this summary covers (for sprig summaries) */
      messageIds: z.array(z.string()),
      /** LCM file IDs referenced by the summarized messages */
      fileIds: z.array(z.string()).optional(),
    })
    .meta({
      ref: "CreateSprigSummaryInput",
    })

  export type CreateSprigInput = z.infer<typeof CreateSprigInput>

  /**
   * Schema for creating a new bindle summary (summarizes other summaries)
   */
  export const CreateBindleInput = z
    .object({
      content: z.string().min(1),
      tokenCount: z.number().int().nonnegative(),
      conversationId: z.string(),
      /** Parent summary IDs being grouped into a bindle */
      parents: z.array(z.string().startsWith("sum_")).min(1),
      /** Canonical order for bindle condensation level (default: 2 / d2) */
      condensationOrder: CondensationOrder.optional(),
      /** LCM file IDs propagated from child summaries */
      fileIds: z.array(z.string()).optional(),
    })
    .meta({
      ref: "CreateBindleSummaryInput",
    })

  export type CreateBindleInput = z.infer<typeof CreateBindleInput>

  /**
   * Schema for creating an archival stub for an evicted bindle.
   *
   * Archive stubs are short, off-context pointer nodes that reference a full
   * bindle via lineage pointers.
   */
  export const CreateArchiveStubInput = z
    .object({
      archivedSummaryId: z.string().startsWith("sum_"),
      archivedSummaryContent: z.string().optional(),
      ghostCueContent: z.string().optional(),
      conversationId: z.string(),
    })
    .meta({
      ref: "CreateArchiveStubInput",
    })

  export type CreateArchiveStubInput = z.infer<typeof CreateArchiveStubInput>

  /**
   * Convert canonical condensation order to canonical dN label.
   */
  export function canonicalLevelFromOrder(order: number): CanonicalLevel {
    const parsed = CondensationOrder.parse(order)
    return `d${parsed}`
  }

  /**
   * Convert canonical order to Dolt presentation aliases where available.
   */
  export function displayLevelFromOrder(order: number): Level {
    const parsed = CondensationOrder.parse(order)
    if (parsed === 1) return "sprig"
    if (parsed === 2) return "bindle"
    return canonicalLevelFromOrder(parsed)
  }

  /**
   * Convert stored/display level labels into canonical order.
   */
  export function condensationOrderFromLevel(level: string): CondensationOrder {
    if (level === "sprig") return 1
    if (level === "bindle") return 2
    const match = level.match(/^d([1-9]\d*)$/)
    if (!match) throw new Error(`Unknown condensation level label: ${level}`)
    return CondensationOrder.parse(Number.parseInt(match[1], 10))
  }

  /**
   * Convert canonical hierarchy level to condensation order.
   * Leaves are basal units and do not correspond to summary rows.
   */
  export function condensationOrderFromHierarchyLevel(level: "leaf" | string): CondensationOrder | null {
    if (level === "leaf") return null
    return condensationOrderFromLevel(level)
  }

  /**
   * Canonical order from legacy summary kind.
   */
  export function condensationOrderFromKind(kind: Kind): CondensationOrder {
    return kind === "bindle" ? 2 : 1
  }

  /**
   * Schema for summary with linked message IDs (for sprig summaries)
   */
  export const WithMessages = Schema.extend({
    /** Message IDs that this sprig summary covers (only for sprig kind) */
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
   * Create a new sprig summary info object.
   *
   * @param input - Input data for creating the summary
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete Summary.Info object with generated ID
   */
  export function createSprig(input: CreateSprigInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    const condensationOrder = condensationOrderFromKind("sprig")
    return {
      summaryId: generateId(input.content, ts),
      content: input.content,
      kind: "sprig",
      level: displayLevelFromOrder(condensationOrder),
      condensationOrder,
      summaryType: "sprig",
      tokenCount: input.tokenCount,
      conversationId: input.conversationId,
      parents: [],
      fileIds: input.fileIds ?? [],
      createdAt: ts,
    }
  }

  /**
   * Create a new bindle summary info object.
   *
   * A bindle summary is a summary of other summaries, creating
   * a high-fanout DAG structure for efficient retrieval.
   *
   * @param input - Input data for creating the bindle summary
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete Summary.Info object with generated ID and parent references
   */
  export function createBindle(input: CreateBindleInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    const condensationOrder = CondensationOrder.parse(input.condensationOrder ?? 2)
    if (condensationOrder < 2) throw new Error(`Bindle summaries require condensation order >= 2 (received ${condensationOrder})`)
    return {
      summaryId: generateId(input.content, ts),
      content: input.content,
      kind: "bindle",
      level: displayLevelFromOrder(condensationOrder),
      condensationOrder,
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
   * lineage in DB pointer tables (stub -> full bindle -> sprigs/messages).
   *
   * @param input - Input data for creating the archive stub
   * @param timestamp - Optional timestamp (defaults to Date.now())
   * @returns Complete Summary.Info object for the archive stub
   */
  export function createArchiveStub(input: CreateArchiveStubInput, timestamp?: number): Info {
    const ts = timestamp ?? Date.now()
    const condensationOrder = 2
    const ghostCue = input.ghostCueContent?.trim()
    const content =
      ghostCue && ghostCue.length > 0
        ? ghostCue
        : (() => {
            const normalizedContent = (input.archivedSummaryContent ?? "").replace(/\s+/g, " ").trim()
            const excerptLimit = 160
            const excerpt = normalizedContent.slice(0, excerptLimit).trimEnd()
            const suffix = normalizedContent.length > excerptLimit ? "..." : ""
            return `[Archive Stub for ${input.archivedSummaryId}] ${excerpt}${suffix}`
          })()

    return {
      summaryId: generateId(`archive_stub:${input.archivedSummaryId}:${content}`, ts),
      content,
      kind: "bindle",
      level: displayLevelFromOrder(condensationOrder),
      condensationOrder,
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
    return displayLevelFromOrder(condensationOrderFromKind(kind))
  }

  /**
   * Backwards-compatible mapping from legacy kind values to Dolt summary type.
   */
  export function typeFromKind(kind: Kind): Type {
    return kind === "bindle" ? "bindle" : "sprig"
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
