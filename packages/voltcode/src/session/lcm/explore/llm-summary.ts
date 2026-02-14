import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { generateAgentSummary } from "./agent-summary"

const log = Log.create({ service: "lcm.explore.llm-summary" })

/**
 * Input for generating an LLM-based summary
 */
export interface LLMSummaryInput {
  /** The file content to summarize */
  content: string
  /** File path for context */
  filePath?: string
  /** Detected language/type */
  language: string
  /** Pre-extracted structured metadata (from regex parsing) */
  structuredMetadata: string
  /** The provider model to use */
  model: Provider.Model
  /** Optional session ID for spawning exploration agent (enables agentic loop) */
  sessionID?: string
  /** Optional abort signal */
  abort?: AbortSignal
}

/**
 * Result of LLM summary generation
 */
export interface LLMSummaryResult {
  /** The generated summary */
  summary: string
  /** Estimated token count */
  tokenCount: number
}

const SYSTEM_PROMPT = `You are a code exploration assistant. Your task is to produce a concise, high-quality summary of a source file that captures its essential purpose and structure.

## What You Receive

1. File path and detected language
2. The raw file content
3. Pre-extracted structural metadata (imports, classes, functions, etc.)

## Your Task

Using both the structural metadata AND the actual content, write a summary that explains:

1. **Purpose**: What does this file do? What problem does it solve?
2. **Key Components**: What are the main classes/functions/types and what do they do?
3. **Architecture**: How does this file fit into a larger system? What does it depend on?
4. **Notable Details**: Any important patterns, configurations, or conventions?

## Guidelines

- **Be specific**: Use actual names (class names, function names, variable names)
- **Be concise**: Target 300-800 tokens
- **Add insight**: Don't just list what the metadata already shows - explain WHY and HOW
- **Be searchable**: Include keywords that help find this file later
- **Focus on uniqueness**: What makes this file special? Skip boilerplate descriptions.

## Output Format

Write in clear prose with markdown formatting. Use headers and bullet points for structure.
Do NOT reproduce code - describe what it does instead.
Do NOT start with "This file..." - jump straight into the substance.`

/**
 * Generate a high-quality summary using an LLM.
 *
 * When sessionID is provided, spawns an exploration agent that can use tools
 * (Read, Grep, etc.) to understand the file better. This produces higher
 * quality summaries but requires a session context.
 *
 * When sessionID is not provided, falls back to a single LLM call with the
 * file content and metadata as context.
 */
export async function generateLLMSummary(input: LLMSummaryInput): Promise<LLMSummaryResult> {
  // If sessionID is provided, use the agent-based approach
  if (input.sessionID && input.filePath) {
    log.info("using agent-based exploration", {
      filePath: input.filePath,
      language: input.language,
      sessionID: input.sessionID,
    })

    const result = await generateAgentSummary({
      content: input.content,
      filePath: input.filePath,
      language: input.language,
      structuredMetadata: input.structuredMetadata,
      model: input.model,
      sessionID: input.sessionID,
      abort: input.abort,
    })

    return {
      summary: result.summary,
      tokenCount: result.tokenCount,
    }
  }

  // Fall back to single LLM call
  const fileName = input.filePath?.split("/").pop() ?? "unknown"

  log.info("generating single-call LLM summary", {
    filePath: input.filePath,
    language: input.language,
    contentLength: input.content.length,
    metadataLength: input.structuredMetadata.length,
  })

  // Build the user message with all context
  const userMessage = `## File Information
- Path: ${input.filePath ?? "unknown"}
- Language: ${input.language}
- File name: ${fileName}

## Pre-Extracted Structure

${input.structuredMetadata}

## Raw File Content

\`\`\`${input.language.toLowerCase()}
${truncateContent(input.content, 50000)}
\`\`\`

Please provide a concise, insightful summary of this file.`

  // Get language model
  const languageModel = await Provider.getLanguage(input.model)

  // Call the LLM
  const result = await generateText({
    model: languageModel,
    abortSignal: input.abort,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
  })

  const summary = result.text.trim()
  const tokenCount = Token.estimate(summary)

  log.info("generated LLM summary", {
    filePath: input.filePath,
    summaryTokenCount: tokenCount,
  })

  return { summary, tokenCount }
}

/**
 * Truncate content to a maximum character count, keeping beginning and end
 */
function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content

  const halfSize = Math.floor(maxChars / 2) - 50
  const beginning = content.slice(0, halfSize)
  const end = content.slice(-halfSize)

  return `${beginning}\n\n... [${content.length - maxChars} characters truncated] ...\n\n${end}`
}
