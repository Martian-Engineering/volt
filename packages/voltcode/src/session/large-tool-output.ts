import { Log } from "@/util/log"
import { Token } from "@/util/token"
import type { Provider } from "@/provider/provider"

const log = Log.create({ service: "session.large-tool-output" })

/**
 * Threshold for large tool output in tokens.
 * Outputs larger than this will be stored in LCM and replaced with a reference.
 */
export const LARGE_TOOL_OUTPUT_THRESHOLD = 10_000

/**
 * Result of handling a large tool output
 */
export interface LargeToolOutputResult {
  /** The modified output (either original or LCM reference) */
  output: string
  /** Whether the output was stored in LCM */
  storedInLcm: boolean
  /** The LCM file ID if stored */
  fileId?: string
  /** Token count of the original output */
  tokenCount: number
}

/**
 * Handle a potentially large tool output.
 *
 * If the output exceeds LARGE_TOOL_OUTPUT_THRESHOLD tokens:
 * - Store the content in LCM
 * - Return a short reference message instead
 *
 * @param input - The tool output and context
 * @returns The processed output result
 */
export async function handleLargeToolOutput(input: {
  sessionID: string
  toolName: string
  toolCallId: string
  output: string
  model: Provider.Model
}): Promise<LargeToolOutputResult> {
  const tokenCount = Token.estimate(input.output)

  // If output is small enough, return as-is
  if (tokenCount <= LARGE_TOOL_OUTPUT_THRESHOLD) {
    return {
      output: input.output,
      storedInLcm: false,
      tokenCount,
    }
  }

  // Large output - try to store in LCM
  log.info("tool output exceeds threshold, storing in LCM", {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    tokenCount,
    threshold: LARGE_TOOL_OUTPUT_THRESHOLD,
  })

  try {
    // Dynamic import to avoid loading LCM code when not needed
    const { LcmDb } = await import("./lcm/db")
    const { SessionPrompt } = await import("./prompt")

    const conversationId = await SessionPrompt.getOrCreateLcmConversation(input.sessionID, input.model)
    if (conversationId === null) {
      log.warn("failed to get LCM conversation, returning truncated output", {
        toolName: input.toolName,
      })
      const maxChars = LARGE_TOOL_OUTPUT_THRESHOLD * 4
      const truncated = input.output.slice(0, maxChars)
      return {
        output:
          truncated + `\n\n[Output truncated: ${tokenCount} tokens exceeded limit. LCM conversation unavailable.]`,
        storedInLcm: false,
        tokenCount,
      }
    }

    // Store the tool output in LCM
    const { fileId } = await LcmDb.insertLargeTextContent({
      conversationId,
      content: input.output,
      mimeType: "text/plain",
      label: `tool_output_${input.toolName}_${input.toolCallId}`,
    })

    log.info("stored large tool output in LCM", {
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      fileId,
      tokenCount,
    })

    // Generate a summary of the first part of the output
    const previewChars = 2000
    const preview = input.output.slice(0, previewChars)
    const hasMore = input.output.length > previewChars

    // Return a reference message instead of full output
    const referenceOutput = [
      `**Tool output stored in LCM (${tokenCount} tokens)**`,
      ``,
      `**LCM File ID:** ${fileId}`,
      `**Tool:** ${input.toolName}`,
      ``,
      `## Preview`,
      preview,
      hasMore ? `\n...[${tokenCount - Token.estimate(preview)} more tokens]` : "",
      ``,
      `To access the full output, use the Read tool with the original file path, or use lcm_describe with file_id "${fileId}" to see metadata about this stored output.`,
    ].join("\n")

    return {
      output: referenceOutput,
      storedInLcm: true,
      fileId,
      tokenCount,
    }
  } catch (e) {
    log.error("failed to store tool output in LCM", {
      toolName: input.toolName,
      error: e,
    })

    // Fallback: truncate output
    const maxChars = LARGE_TOOL_OUTPUT_THRESHOLD * 4
    const truncated = input.output.slice(0, maxChars)
    return {
      output: truncated + `\n\n[Output truncated: ${tokenCount} tokens exceeded limit. LCM storage failed: ${e}]`,
      storedInLcm: false,
      tokenCount,
    }
  }
}
