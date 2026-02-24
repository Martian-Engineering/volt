import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import GHOST_CUE_PROMPT from "./prompts/ghost-cue.txt"

const GHOST_CUE_MAX_OUTPUT_TOKENS = 220

export namespace LcmGhostCue {
  const log = Log.create({ service: "lcm.ghost-cue" })

  export async function generate(input: {
    bindleId: string
    bindleContent: string
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<string> {
    const language = await Provider.getLanguage(input.model)
    const result = await generateText({
      model: language,
      abortSignal: input.abort,
      maxOutputTokens: GHOST_CUE_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: "system",
          content: GHOST_CUE_PROMPT,
        },
        {
          role: "user",
          content: `<bindle>\n${input.bindleContent}\n</bindle>`,
        },
      ],
    })
    const narrative = result.text.replace(/\s+/g, " ").trim()
    if (!narrative) {
      throw new Error(`empty ghost cue narrative generated for bindle ${input.bindleId}`)
    }
    return narrative
  }

  export function fallbackNarrative(content: string): string {
    const singleLine = content.replace(/\s+/g, " ").trim()
    const excerptLimit = 320
    const excerpt = singleLine.slice(0, excerptLimit).trimEnd()
    return singleLine.length > excerptLimit ? `${excerpt}...` : excerpt
  }

  export function withFrontmatter(bindleId: string, narrative: string): string {
    const cleanNarrative = narrative.trim()
    return `---\nbindle_id: ${bindleId}\n---\n${cleanNarrative}`
  }

  export async function generateWithFallback(input: {
    bindleId: string
    bindleContent: string
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<string> {
    try {
      const narrative = await generate(input)
      return withFrontmatter(input.bindleId, narrative)
    } catch (error) {
      log.warn("failed to generate ultra-lapidary ghost cue, using fallback narrative", {
        bindleId: input.bindleId,
        error,
      })
      return withFrontmatter(input.bindleId, fallbackNarrative(input.bindleContent))
    }
  }
}
