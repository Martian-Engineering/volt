import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Summary } from "./summary"
import { LcmDb } from "./db"
import { extractFileIds } from "./summarize"
import CONDENSE_PROMPT from "./prompts/condense.txt"

const CONDENSE_AGGRESSIVE_PROMPT = await Bun.file(import.meta.dirname + "/prompts/condense-aggressive.txt")
  .text()
  .catch(
    () =>
      "You are condensing multiple summaries into one. Be maximally terse. " +
      "Keep ONLY: key decisions, artifacts changed, outcomes, and ALL summary IDs (sum_xxx) and file IDs (file_xxx). " +
      "Output MUST be shorter than input. Target 300-600 tokens. " +
      "Start with [Condensed from: <all parent summary IDs>] and [LCM File IDs: <all file IDs>].",
  )

/**
 * LCM Condense Module
 *
 * Provides the condense_summaries() function that combines multiple summaries
 * into a single condensed summary, forming the high-fanout DAG structure
 * for efficient context retrieval.
 */
export namespace Condense {
  const log = Log.create({ service: "lcm.condense" })

  /**
   * Enforce Dolt L1->L2 invariant: bindles are created from leaves only.
   * Any non-leaf parent would create bindle->bindle aggregation paths.
   */
  function assertLeafParentsOnly(summaries: Summary.Info[]): void {
    const nonLeafParents = summaries.filter((summary) => summary.kind !== "leaf")
    if (nonLeafParents.length > 0) {
      throw new Error(
        `Cannot condense non-leaf summaries into bindles: ${nonLeafParents.map((s) => s.summaryId).join(", ")}`,
      )
    }
  }

  /**
   * Format summaries for the condense prompt.
   * Each summary is formatted with its ID and content for the LLM to process.
   */
  function formatSummariesForPrompt(summaries: Summary.Info[]): string {
    return summaries
      .map((summary) => {
        const lines: string[] = []
        lines.push(`--- Summary ${summary.summaryId} ---`)
        lines.push(summary.content)
        lines.push("")
        return lines.join("\n")
      })
      .join("\n")
  }

  /**
   * Condense multiple summaries into a single higher-level summary.
   *
   * This function:
   * 1. Takes a list of Summary objects to condense
   * 2. Formats them and sends to the LLM with the condense prompt
   * 3. Creates a new Summary with kind='condensed' and parent references
   * 4. Stores the result using LCMDB.insertCondensedSummary()
   *
   * @param input - Configuration for the condense operation
   * @param input.summaries - List of Summary objects to condense (must have at least 1)
   * @param input.conversationId - The conversation/session ID (as string for Summary.Info compatibility)
   * @param input.dbConversationId - The numeric database conversation ID for storage
   * @param input.model - The provider model to use for the LLM call
   * @param input.abort - Optional abort signal for cancellation
   * @returns The newly created condensed Summary
   */
  export async function condenseSummaries(input: {
    summaries: Summary.Info[]
    conversationId: string
    dbConversationId: number
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<Summary.Info> {
    if (input.summaries.length === 0) {
      throw new Error("Cannot condense empty list of summaries")
    }
    assertLeafParentsOnly(input.summaries)

    const inputTokens = input.summaries.reduce((sum, s) => sum + s.tokenCount, 0)
    log.info("condensing summaries", {
      count: input.summaries.length,
      inputTokens,
      parentIds: input.summaries.map((s) => s.summaryId),
    })

    const parentIds = input.summaries.map((s) => s.summaryId)
    const formattedSummaries = formatSummariesForPrompt(input.summaries)

    // Build the user message with the summaries to condense
    const userMessage = `
## Parent Summary IDs (you MUST include ALL of these in your output)

${parentIds.join(", ")}

## Summaries to Condense

${formattedSummaries}
`.trim()

    const promptTemplate = CONDENSE_PROMPT

    // Get language model for the provider
    const language = await Provider.getLanguage(input.model)

    // Call the LLM to generate the condensed summary
    const result = await generateText({
      model: language,
      abortSignal: input.abort,
      messages: [
        {
          role: "system",
          content: promptTemplate,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    })

    const condensedContent = result.text.trim()

    // Verify that parent IDs are included in the output
    const missingIds = parentIds.filter((id) => !condensedContent.includes(id))
    if (missingIds.length > 0) {
      log.warn("condensed summary missing parent IDs, injecting them", {
        missingIds,
      })
    }

    // Ensure the [Condensed from: ...] header is present with all parent IDs
    // If the LLM didn't include it properly, we inject it
    let finalContent = condensedContent
    const condensedFromPattern = /^\[Condensed from:.*?\]/m
    if (!condensedFromPattern.test(finalContent)) {
      // Inject the header at the start
      finalContent = `[Condensed from: ${parentIds.join(", ")}]\n\n${finalContent}`
    } else if (missingIds.length > 0) {
      // Replace the existing header to ensure all IDs are included
      finalContent = finalContent.replace(condensedFromPattern, `[Condensed from: ${parentIds.join(", ")}]`)
    }

    // Extract and propagate file IDs from input summaries
    const allContent = input.summaries.map((s) => s.content).join("\n")
    const extractedFileIds = extractFileIds(allContent)
    const existingFileIds = input.summaries.flatMap((s) => s.fileIds ?? [])
    const allFileIds = [...new Set([...extractedFileIds, ...existingFileIds])].sort()

    if (allFileIds.length > 0) {
      finalContent += `\n[LCM File IDs: ${allFileIds.join(", ")}]`
    }

    // Create the condensed summary using Summary.createCondensed
    const timestamp = Date.now()
    const summary = Summary.createCondensed(
      {
        content: finalContent,
        tokenCount: Token.estimate(finalContent),
        conversationId: input.conversationId,
        parents: parentIds,
        fileIds: allFileIds,
      },
      timestamp,
    )

    // Store the condensed summary in the database
    await LcmDb.insertCondensedSummary({
      summaryId: summary.summaryId,
      conversationId: input.dbConversationId,
      content: summary.content,
      tokenCount: summary.tokenCount,
      parentSummaryIds: parentIds,
      fileIds: allFileIds,
    })

    log.info("created condensed summary", {
      summaryId: summary.summaryId,
      tokenCount: summary.tokenCount,
      inputTokens,
      reduction: inputTokens - summary.tokenCount,
      parentCount: parentIds.length,
    })

    return summary
  }

  /**
   * Condense multiple summaries using an aggressive (maximally terse) prompt.
   *
   * Identical to condenseSummaries() but uses the aggressive prompt that
   * targets 300-600 tokens and drops low-value details. Used when normal
   * condensation fails to reduce token count below the input size.
   */
  export async function condenseSummariesAggressive(input: {
    summaries: Summary.Info[]
    conversationId: string
    dbConversationId: number
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<Summary.Info> {
    if (input.summaries.length === 0) {
      throw new Error("Cannot condense empty list of summaries")
    }
    assertLeafParentsOnly(input.summaries)

    const inputTokens = input.summaries.reduce((sum, s) => sum + s.tokenCount, 0)
    log.info("condensing summaries (aggressive)", {
      count: input.summaries.length,
      inputTokens,
      parentIds: input.summaries.map((s) => s.summaryId),
    })

    const parentIds = input.summaries.map((s) => s.summaryId)
    const formattedSummaries = formatSummariesForPrompt(input.summaries)

    const userMessage = `
## Parent Summary IDs (you MUST include ALL of these in your output)

${parentIds.join(", ")}

## Summaries to Condense

${formattedSummaries}
`.trim()

    const language = await Provider.getLanguage(input.model)

    const result = await generateText({
      model: language,
      abortSignal: input.abort,
      messages: [
        {
          role: "system",
          content: CONDENSE_AGGRESSIVE_PROMPT,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    })

    const condensedContent = result.text.trim()

    const missingIds = parentIds.filter((id) => !condensedContent.includes(id))
    if (missingIds.length > 0) {
      log.warn("aggressive condensed summary missing parent IDs, injecting them", {
        missingIds,
      })
    }

    let finalContent = condensedContent
    const condensedFromPattern = /^\[Condensed from:.*?\]/m
    if (!condensedFromPattern.test(finalContent)) {
      finalContent = `[Condensed from: ${parentIds.join(", ")}]\n\n${finalContent}`
    } else if (missingIds.length > 0) {
      finalContent = finalContent.replace(condensedFromPattern, `[Condensed from: ${parentIds.join(", ")}]`)
    }

    // Extract and propagate file IDs from input summaries
    const allContent = input.summaries.map((s) => s.content).join("\n")
    const extractedFileIds = extractFileIds(allContent)
    const existingFileIds = input.summaries.flatMap((s) => s.fileIds ?? [])
    const allFileIds = [...new Set([...extractedFileIds, ...existingFileIds])].sort()

    if (allFileIds.length > 0) {
      finalContent += `\n[LCM File IDs: ${allFileIds.join(", ")}]`
    }

    const timestamp = Date.now()
    const summary = Summary.createCondensed(
      {
        content: finalContent,
        tokenCount: Token.estimate(finalContent),
        conversationId: input.conversationId,
        parents: parentIds,
        fileIds: allFileIds,
      },
      timestamp,
    )

    await LcmDb.insertCondensedSummary({
      summaryId: summary.summaryId,
      conversationId: input.dbConversationId,
      content: summary.content,
      tokenCount: summary.tokenCount,
      parentSummaryIds: parentIds,
      fileIds: allFileIds,
    })

    log.info("created aggressive condensed summary", {
      summaryId: summary.summaryId,
      tokenCount: summary.tokenCount,
      parentCount: parentIds.length,
    })

    return summary
  }

  /** Maximum token budget for the fallback deterministic truncation */
  const FALLBACK_MAX_TOKENS = 512

  /**
   * Deterministic fallback condensation that guarantees size reduction
   * without calling the LLM.
   *
   * Truncates the combined summary text to FALLBACK_MAX_TOKENS worth of
   * characters and appends a structured metadata block preserving all
   * summary IDs and LCM file IDs. This is the last-resort condensation
   * used when both normal and aggressive LLM condensation fail to
   * produce output smaller than the input.
   */
  export async function condenseFallback(input: {
    summaries: Summary.Info[]
    conversationId: string
    dbConversationId: number
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<Summary.Info> {
    if (input.summaries.length === 0) {
      throw new Error("Cannot condense empty list of summaries")
    }
    assertLeafParentsOnly(input.summaries)

    log.info("condensing summaries (fallback/deterministic)", {
      count: input.summaries.length,
      parentIds: input.summaries.map((s) => s.summaryId),
    })

    const parentIds = input.summaries.map((s) => s.summaryId)

    // Combine all summary content
    const combinedContent = input.summaries.map((s) => s.content).join("\n\n")
    const originalTokens = Token.estimate(combinedContent)

    // Truncate to FALLBACK_MAX_TOKENS worth of characters (~4 chars per token)
    const maxChars = FALLBACK_MAX_TOKENS * 4
    const truncatedContent = combinedContent.length > maxChars ? combinedContent.slice(0, maxChars) : combinedContent

    // Extract file IDs from ALL input summary content
    const allFileIds = extractFileIds(combinedContent)

    // Build the structured metadata block
    const metadataBlock = [
      `[Summary IDs: ${parentIds.join(", ")}]`,
      `[LCM File IDs: ${allFileIds.length > 0 ? allFileIds.join(", ") : "none"}]`,
      `[Truncated from ${originalTokens} tokens]`,
    ].join("\n")

    const finalContent = `${truncatedContent}\n\n${metadataBlock}`

    const timestamp = Date.now()
    const summary = Summary.createCondensed(
      {
        content: finalContent,
        tokenCount: Token.estimate(finalContent),
        conversationId: input.conversationId,
        parents: parentIds,
        fileIds: allFileIds,
      },
      timestamp,
    )

    await LcmDb.insertCondensedSummary({
      summaryId: summary.summaryId,
      conversationId: input.dbConversationId,
      content: summary.content,
      tokenCount: summary.tokenCount,
      parentSummaryIds: parentIds,
      fileIds: allFileIds,
    })

    log.info("created fallback condensed summary", {
      summaryId: summary.summaryId,
      tokenCount: summary.tokenCount,
      parentCount: parentIds.length,
      originalTokens,
      fileIds: allFileIds,
    })

    return summary
  }
}
