import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Summary } from "./summary"
import { LcmDb } from "./db"
import { extractFileIds } from "./summarize"
import { getLcmPolicyConfig } from "./config"
import { resolveLcmPrompt } from "./prompt-registry"

type GenerateTextInput = Parameters<typeof generateText>[0]

/**
 * Build the `generateText` request payload for summary condensation.
 */
export function createCondenseLlmRequest(input: {
  model: GenerateTextInput["model"]
  promptTemplate: string
  userMessage: string
  abort?: AbortSignal
}): GenerateTextInput {
  return {
    model: input.model,
    abortSignal: input.abort,
    maxOutputTokens: getLcmPolicyConfig().runtime.condenseMaxOutputTokens,
    messages: [
      {
        role: "system",
        content: input.promptTemplate,
      },
      {
        role: "user",
        content: input.userMessage,
      },
    ],
  }
}

/**
 * LCM Condense Module
 *
 * Provides the condense_summaries() function that combines multiple summaries
 * into a single bindle summary, forming the high-fanout DAG structure
 * for efficient context retrieval.
 */
export namespace Condense {
  const log = Log.create({ service: "lcm.condense" })

  /**
   * Enforce L1->L2 invariant: bindles are created from sprigs only.
   * Any non-sprig parent would create bindle->bindle aggregation paths.
   */
  function assertParentsMatchCondensationOrder(summaries: Summary.Info[], condensationOrder: number): void {
    const requiredParentOrder = condensationOrder - 1
    const invalidParents = summaries.filter((summary) => {
      const summaryOrder = summary.condensationOrder ?? Summary.condensationOrderFromKind(summary.kind)
      if (requiredParentOrder === 1) {
        return summary.kind !== "sprig" || summaryOrder !== 1
      }
      return summary.kind !== "bindle" || summaryOrder !== requiredParentOrder
    })
    if (invalidParents.length > 0) {
      const expected =
        requiredParentOrder === 1 ? "d1 sprig summaries" : `d${requiredParentOrder} bindle summaries`
      throw new Error(
        `Cannot condense into d${condensationOrder}; expected ${expected}. Invalid parents: ${invalidParents
          .map((s) => s.summaryId)
          .join(", ")}`,
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
   * 3. Creates a new Summary with kind='bindle' and parent references
   * 4. Stores the result using LCMDB.insertBindleSummary()
   *
   * @param input - Configuration for the condense operation
   * @param input.summaries - List of Summary objects to condense (must have at least 1)
   * @param input.conversationId - The conversation/session ID (as string for Summary.Info compatibility)
   * @param input.dbConversationId - The numeric database conversation ID for storage
   * @param input.model - The provider model to use for the LLM call
   * @param input.abort - Optional abort signal for cancellation
   * @returns The newly created bindle Summary
   */
  export async function condenseSummaries(input: {
    summaries: Summary.Info[]
    conversationId: string
    dbConversationId: number
    model: Provider.Model
    /** Canonical condensation order for resulting bindle (default d2). */
    condensationOrder?: number
    abort?: AbortSignal
  }): Promise<Summary.Info> {
    if (input.summaries.length === 0) {
      throw new Error("Cannot condense empty list of summaries")
    }
    const condensationOrder = Summary.CondensationOrder.parse(input.condensationOrder ?? 2)
    if (condensationOrder < 2) {
      throw new Error(`Cannot condense summaries into d${condensationOrder}; bindles require order >= d2`)
    }
    assertParentsMatchCondensationOrder(input.summaries, condensationOrder)

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
## Input Summary IDs

${parentIds.join(", ")}

## Summaries to Condense

${formattedSummaries}
`.trim()

    const promptTemplate = await resolveLcmPrompt({
      operation: "condense",
      condensationOrder,
    })

    // Get language model for the provider
    const language = await Provider.getLanguage(input.model)

    // Call the LLM to generate the bindle summary
    const result = await generateText(
      createCondenseLlmRequest({
        model: language,
        promptTemplate,
        userMessage,
        abort: input.abort,
      }),
    )

    const finalContent = result.text.trim()

    // Propagate file IDs through structured metadata only; do not emit
    // programmatic metadata in summary text.
    const allContent = input.summaries.map((s) => s.content).join("\n")
    const extractedFileIds = extractFileIds(allContent)
    const existingFileIds = input.summaries.flatMap((s) => s.fileIds ?? [])
    const allFileIds = [...new Set([...extractedFileIds, ...existingFileIds])].sort()

    // Create the bindle summary using Summary.createBindle
    const timestamp = Date.now()
    const summary = Summary.createBindle(
      {
        content: finalContent,
        tokenCount: Token.estimate(finalContent),
        conversationId: input.conversationId,
        parents: parentIds,
        condensationOrder,
        fileIds: allFileIds,
      },
      timestamp,
    )

    // Store the bindle summary in the database
    await LcmDb.insertBindleSummary({
      summaryId: summary.summaryId,
      conversationId: input.dbConversationId,
      content: summary.content,
      tokenCount: summary.tokenCount,
      parentSummaryIds: parentIds,
      condensationOrder,
      fileIds: allFileIds,
    })

    log.info("created bindle summary", {
      summaryId: summary.summaryId,
      tokenCount: summary.tokenCount,
      inputTokens,
      reduction: inputTokens - summary.tokenCount,
      condensationOrder,
      parentCount: parentIds.length,
    })

    return summary
  }
}
