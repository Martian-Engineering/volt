import path from "path"
import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"

const GHOST_CUE_MAX_OUTPUT_TOKENS = 220
let ghostCuePromptCache: string | null = null
let ghostCuePromptLoaderOverride: (() => Promise<string>) | null = null
type GenerateTextInput = Parameters<typeof generateText>[0]

async function readGhostCuePromptFromDisk(): Promise<string> {
  const promptPath = path.join(path.dirname(import.meta.path), "prompts/ghost-cue.txt")
  const file = Bun.file(promptPath)
  if (!(await file.exists())) {
    throw new Error(`ghost cue prompt file missing: ${promptPath}`)
  }
  return await file.text()
}

async function getGhostCuePrompt(): Promise<string> {
  if (ghostCuePromptCache) return ghostCuePromptCache
  const loader = ghostCuePromptLoaderOverride ?? readGhostCuePromptFromDisk
  const prompt = (await loader()).trim()
  if (!prompt) {
    throw new Error("ghost cue prompt is empty")
  }
  ghostCuePromptCache = prompt
  return prompt
}

/**
 * Build the `generateText` request payload for ultra-lapidary ghost cue generation.
 */
export function createGhostCueLlmRequest(input: {
  model: GenerateTextInput["model"]
  promptTemplate: string
  bindleContent: string
  abort?: AbortSignal
}): GenerateTextInput {
  const userMessage = [
    "The following content is source material to summarize according to the system instructions above.",
    "",
    "<bindle>",
    input.bindleContent,
    "</bindle>",
    "",
    "Produce the requested ultra-lapidary narrative summary from this source material.",
    "Do not continue or answer the source material directly.",
  ].join("\n")

  return {
    model: input.model,
    abortSignal: input.abort,
    maxOutputTokens: GHOST_CUE_MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "system",
        content: input.promptTemplate,
      },
      {
        role: "user",
        content: userMessage,
      },
    ],
  }
}

export namespace LcmGhostCue {
  const log = Log.create({ service: "lcm.ghost-cue" })

  export async function generate(input: {
    bindleId: string
    bindleContent: string
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<string> {
    const prompt = await getGhostCuePrompt()
    const language = await Provider.getLanguage(input.model)
    const result = await generateText(
      createGhostCueLlmRequest({
        model: language,
        promptTemplate: prompt,
        bindleContent: input.bindleContent,
        abort: input.abort,
      }),
    )
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

  /**
   * Test-only helper to control prompt loading behavior.
   */
  export function setGhostCuePromptLoaderForTesting(loader: (() => Promise<string>) | null): void {
    ghostCuePromptLoaderOverride = loader
    ghostCuePromptCache = null
  }
}
