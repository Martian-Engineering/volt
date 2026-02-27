import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Token } from "../util/token"

import { Instance } from "../project/instance"
import path from "path"
import os from "os"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_CODEX_INSTRUCTIONS from "./prompt/codex_header.txt"
import PROMPT_CHAT_INSTRUCTIONS from "./prompt/chat.txt"
import PROMPT_CHATINGPT from "./prompt/chatingpt.txt"
import PROMPT_SUBAGENT_RULES from "./prompt/subagent-rules.txt"
import type { Provider } from "@/provider/provider"
import { Flag } from "@/flag/flag"

export namespace SystemPrompt {
  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function instructions() {
    const mode = Flag.VOLTCODE_MODE
    if (mode === "chat") {
      return PROMPT_CHAT_INSTRUCTIONS.trim()
    }
    return PROMPT_CODEX_INSTRUCTIONS.trim()
  }

  export function provider(model: Provider.Model) {
    const mode = Flag.VOLTCODE_MODE
    if (mode === "chat") {
      return [PROMPT_CHATINGPT]
    }
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export function subagentRules() {
    return [PROMPT_SUBAGENT_RULES]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Local date: ${new Date().toDateString()}`,
        `  Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  /**
   * Returns LCM (Lossless Context Management) instructions when enabled.
   * Loads from disk to allow runtime modifications.
   */
  export async function lcm(): Promise<string[]> {
    // Load from disk to allow runtime modifications
    const lcmPromptPath = path.join(path.dirname(import.meta.path), "prompt", "lcm.txt")
    const content = await Bun.file(lcmPromptPath)
      .text()
      .catch(() => "")
    if (!content) {
      return []
    }
    return [content]
  }

  /**
   * Returns symbolic recursion guidance for large-scale semantic processing.
   * Teaches the model when to delegate classification to sub-LLM calls
   * (batch API scripts) vs. using llm_map or direct processing.
   *
   * Injects the user's configured API endpoint, model ID, and API key so
   * recursive calls use the same provider as the current session.
   */
  export async function symbolicRecursion(apiConfig?: {
    url: string
    model: string
    apiKey: string
  }): Promise<string[]> {
    const promptPath = path.join(path.dirname(import.meta.path), "prompt", "symbolic-recursion.txt")
    let content = await Bun.file(promptPath)
      .text()
      .catch(() => "")
    if (!content) {
      return []
    }
    if (apiConfig) {
      content = content.replace(
        /\*\*API selection\*\*:.*?Do NOT use Anthropic or OpenAI SDKs\./s,
        `**API selection**: Use the same model you're running as for recursive classification calls. ` +
          `The API is available at \`${apiConfig.url}\` with model \`${apiConfig.model}\`. ` +
          `Authenticate with \`Authorization: Bearer ${apiConfig.apiKey}\`. ` +
          `This is an OpenAI-compatible endpoint — use raw HTTP requests (\`fetch()\` or \`curl\`). ` +
          `Do NOT use Anthropic or OpenAI SDKs.`,
      )
    }
    return [content]
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
  const GLOBAL_RULE_FILES = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.VOLTCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    GLOBAL_RULE_FILES.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }

  if (Flag.VOLTCODE_CONFIG_DIR) {
    GLOBAL_RULE_FILES.push(path.join(Flag.VOLTCODE_CONFIG_DIR, "AGENTS.md"))
  }

  export async function custom() {
    const config = await Config.get()
    const paths = new Set<string>()

    for (const localRuleFile of LOCAL_RULE_FILES) {
      const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
      if (matches.length > 0) {
        matches.forEach((path) => paths.add(path))
        break
      }
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        paths.add(globalRuleFile)
        break
      }
    }

    const urls: string[] = []
    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
          continue
        }
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        let matches: string[] = []
        if (path.isAbsolute(instruction)) {
          matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
        } else {
          matches = await Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
        }
        matches.forEach((path) => paths.add(path))
      }
    }

    const foundFiles = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => "Instructions from: " + p + "\n" + x),
    )
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter(Boolean))
  }

  /**
   * Build the "inner" system prompt sections that are passed as the `system`
   * array in the main loop (subagentRules, environment, lcm, symbolicRecursion,
   * custom).  Does NOT include header() or provider() — those are layered on
   * by llm.ts at call time.
   *
   * Both prompt.ts and the debug CLI should call this instead of manually
   * listing the individual section functions.
   */
  export async function buildSections(
    model: Provider.Model,
    apiConfig?: { url: string; model: string; apiKey: string },
  ): Promise<string[]> {
    return [
      ...subagentRules(),
      ...(await environment(model)),
      ...(await lcm()),
      ...(await symbolicRecursion(apiConfig)),
      ...(await custom()),
    ]
  }

  /**
   * Build the complete system prompt for a given model, including header,
   * provider-specific base prompt, and all inner sections.
   *
   * This is the canonical assembly point — use it whenever you need the full
   * system prompt text (e.g. for training data extraction or debugging).
   */
  export async function build(
    model: Provider.Model,
    apiConfig?: { url: string; model: string; apiKey: string },
  ): Promise<string> {
    const parts = [...header(model.providerID), ...provider(model), ...(await buildSections(model, apiConfig))]
    return parts.filter(Boolean).join("\n\n")
  }

  /**
   * Measure the total token count of all system prompt sections used in the loop.
   * Calls buildSections() and sums their token estimates.
   *
   * @returns Total estimated token count of the system prompt sections
   */
  export async function measureSystemPromptTokens(model?: Provider.Model): Promise<number> {
    const dummyModel = model ?? ({ api: { id: "unknown" }, providerID: "unknown" } as Provider.Model)
    const sections = await buildSections(dummyModel)
    const total = sections.reduce((sum, text) => sum + Token.estimate(text), 0)
    return total
  }
}
