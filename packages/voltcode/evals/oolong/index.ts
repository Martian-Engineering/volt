/**
 * OOLONG Benchmark Runner
 *
 * Replicates the OOLONG evaluation from the "Recursive Language Models" paper
 * (arXiv:2512.24601v2) on the trec_coarse split.
 *
 * OOLONG is a long-context reasoning benchmark that requires the model to:
 * 1. Semantically classify thousands of unlabeled questions into 6 categories
 * 2. Answer aggregate queries about label statistics across all entries
 *
 * Each task consists of a ~131K token context (thousands of questions with
 * metadata) followed by an aggregate query (e.g., "which label is most common?",
 * "how many instances have label X for user Y?").
 *
 * Architecture: The context data (3190 lines, ~310K chars) is written to a file
 * per context window (only 2 unique windows across 50 tasks). A task-aware prompt
 * is piped via stdin directing the model to write and run a classification script
 * using Bash.
 *
 * Prompt approach (v4 — semantic classification, harness-aware):
 * Separate prompts for VoltCode and Claude Code. Both describe the task as
 * semantic classification (not regex pattern matching). VoltCode's prompt
 * lets it use LCM + sub-agents to classify questions natively. Claude Code's
 * prompt keeps a workflow structure since it can't leverage LCM.
 *
 * Previous approaches (archived):
 * - v3: Unified prompt for both runners, told model to "implement a classifier
 *   (e.g., in Python)" — both models wrote brittle regex classifiers that
 *   massively over-predicted entity (default fallthrough).
 * - v2: Same definitions but told the model to "read first 100 questions" —
 *   this sabotaged VoltCode's LCM by forcing a sample-and-regex approach.
 * - v1: Shipped a pre-built regex classifier (trec_classifier.py, ~78% accuracy).
 *   Achieved 56.8% but bypassed the benchmark's core classification test.
 *
 * Historical scores (512K tokens):
 *   v3 (unified, "implement classifier"): VoltCode 32-36%, Claude Code 50%
 * Historical scores (256K tokens):
 *   v3 (unified, "implement classifier"): VoltCode 46%, Claude Code 42%
 * Historical scores (131K tokens):
 *   v0 (no definitions, no classifier): ~37% average score
 *   v1 (reference classifier):          56.8% average score
 *   v2 (definitions, "read 100"):       46-50% average score
 *
 * @see https://arxiv.org/abs/2511.02817 (OOLONG paper)
 * @see https://arxiv.org/abs/2512.24601 (RLM paper using this benchmark)
 * @see https://github.com/abertsch72/oolong
 */
import { EvalTypes } from "../types"
import { loadTrecCoarse, type OolongTask } from "./dataset"
import { scoreResponse, type ScoredResult } from "./scoring"
import { EvalLog } from "../log"
import path from "path"
import fs from "fs/promises"

// ---------------------------------------------------------------------------
// Bare API support — direct model calls without VoltCode harness
// ---------------------------------------------------------------------------

interface BareApiConfig {
  provider: "openai" | "anthropic" | "openai-compatible"
  model: string
  apiKey: string
  baseUrl: string
  /** Optional system prompt override (e.g., to tell GPT-5.2 the context is complete) */
  systemPrompt?: string
}

/**
 * Known OpenAI-compatible providers with their base URLs and env keys.
 */
const OPENAI_COMPATIBLE_PROVIDERS: Record<string, { baseUrl: string; envKey: string; defaultKey?: string }> = {
  moonshotai: { baseUrl: "https://api.moonshot.ai/v1", envKey: "MOONSHOT_API_KEY" },
  voltcode: { baseUrl: "http://3.210.228.110:8080/v1", envKey: "VOLTCODE_API_KEY" },
  voltropy: { baseUrl: "https://api.voltropy.com/v1", envKey: "", defaultKey: "voltropy" },
}

/**
 * Parse a --bare model spec into a BareApiConfig.
 *
 * Supported formats:
 *   openai/gpt-5.2                  → OpenAI API
 *   anthropic/claude-opus-4-5       → Anthropic API
 *   moonshotai/kimi-k2.5            → Moonshot AI (OpenAI-compatible)
 *   voltcode/zai-glm-4.7            → Prime Intellect (OpenAI-compatible)
 */
export function parseBareModel(spec: string): BareApiConfig {
  const slash = spec.indexOf("/")
  if (slash === -1) throw new Error(`--bare model must be provider/model, got: ${spec}`)
  const provider = spec.slice(0, slash)
  const model = spec.slice(slash + 1)

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY not set (required for --bare openai/...)")
    return {
      provider: "openai",
      model,
      apiKey,
      baseUrl: "https://api.openai.com/v1",
      systemPrompt:
        "The user message contains the COMPLETE dataset. All rows are present and nothing is truncated. Answer the question directly.",
    }
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (required for --bare anthropic/...)")
    return { provider: "anthropic", model, apiKey, baseUrl: "https://api.anthropic.com/v1" }
  }

  // OpenAI-compatible providers
  const compat = OPENAI_COMPATIBLE_PROVIDERS[provider]
  if (compat) {
    const apiKey = compat.envKey ? process.env[compat.envKey] : (compat.defaultKey ?? "no-key-needed")
    if (!apiKey) throw new Error(`${compat.envKey} not set (required for --bare ${provider}/...)`)
    // Moonshot's content filter may reject large prompts; add a research context system prompt
    const systemPrompt =
      provider === "moonshotai"
        ? "You are a research assistant evaluating a text classification benchmark. The user message contains a dataset of general-knowledge questions that you must analyze. Answer the question at the end directly."
        : undefined
    return { provider: "openai-compatible", model, apiKey, baseUrl: compat.baseUrl, systemPrompt }
  }

  throw new Error(
    `Unsupported bare provider: ${provider} (supported: openai, anthropic, ${Object.keys(OPENAI_COMPATIBLE_PROVIDERS).join(", ")})`,
  )
}

/** Sleep helper */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Map backend provider names to VoltCode provider IDs.
 * The backend uses short names (moonshot) while VoltCode uses full IDs (moonshotai).
 */
const BACKEND_PROVIDER_MAP: Record<string, string> = {
  moonshot: "moonshotai",
}

/**
 * Convert backend spec (provider:model) to model spec (provider/model).
 * The --backend CLI flag uses colon separator, while volt run --model uses slash.
 * Returns the converted model spec, or undefined if no backend is provided.
 */
function backendToModel(backend: string | undefined): string | undefined {
  if (!backend) return undefined
  // Convert provider:model to provider/model
  const colonIdx = backend.indexOf(":")
  if (colonIdx === -1) return backend // No colon, return as-is
  const provider = backend.slice(0, colonIdx)
  const model = backend.slice(colonIdx + 1)
  return (BACKEND_PROVIDER_MAP[provider] ?? provider) + "/" + model
}

/**
 * Get the effective model spec from config, preferring backend over model.
 * Converts backend format (provider:model) to model format (provider/model).
 */
function getEffectiveModel(config: { backend?: string; model?: string }): string | undefined {
  return backendToModel(config.backend) ?? config.model
}

/**
 * Call the model directly via the provider's chat completions API.
 * Sends one user message = context_window_text + "\n" + question.
 * No system prompt, no tools — matches the paper's base-model protocol.
 *
 * Includes retry with exponential backoff for rate limit (429) errors.
 */
async function callBareApi(bareConfig: BareApiConfig, userMessage: string, maxRetries = 5): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    EvalLog.trace("oolong.bare_api.request", {
      provider: bareConfig.provider,
      model: bareConfig.model,
      attempt: attempt + 1,
      maxAttempts: maxRetries + 1,
      inputChars: userMessage.length,
    })
    let resp: Response

    if (bareConfig.provider === "anthropic") {
      resp = await fetch(`${bareConfig.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": bareConfig.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: bareConfig.model,
          max_tokens: 4096,
          messages: [{ role: "user", content: userMessage }],
        }),
      })
    } else {
      // OpenAI and OpenAI-compatible providers
      const messages: Array<{ role: string; content: string }> = []
      if (bareConfig.systemPrompt) {
        messages.push({ role: "system", content: bareConfig.systemPrompt })
      }
      messages.push({ role: "user", content: userMessage })

      resp = await fetch(`${bareConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bareConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: bareConfig.model,
          messages,
          max_completion_tokens: 4096,
        }),
      })
    }

    if (resp.status === 429) {
      const retryAfter = resp.headers.get("retry-after")
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(60_000 * (attempt + 1), 300_000)
      EvalLog.warn("oolong.bare_api.rate_limited", {
        provider: bareConfig.provider,
        model: bareConfig.model,
        attempt: attempt + 1,
        waitMs,
      })
      console.log(
        `  Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${(waitMs / 1000).toFixed(0)}s...`,
      )
      await resp.text()
      await sleep(waitMs)
      continue
    }

    if (!resp.ok) {
      const body = await resp.text()
      EvalLog.error("oolong.bare_api.http_error", {
        provider: bareConfig.provider,
        model: bareConfig.model,
        status: resp.status,
        bodyChars: body.length,
      })
      throw new Error(`${bareConfig.provider} API ${resp.status}: ${body.slice(0, 500)}`)
    }

    if (bareConfig.provider === "anthropic") {
      const json = (await resp.json()) as { content: Array<{ type: string; text: string }> }
      const textBlock = json.content.find((b) => b.type === "text")
      return textBlock?.text?.trim() ?? ""
    }

    // OpenAI / OpenAI-compatible
    const json = (await resp.json()) as {
      choices: Array<{ message: { content: string | null; reasoning_content?: string } }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    if (json.usage) {
      EvalLog.trace("oolong.bare_api.usage", {
        provider: bareConfig.provider,
        model: bareConfig.model,
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
      })
      console.log(
        `  [usage] prompt_tokens=${json.usage.prompt_tokens} completion_tokens=${json.usage.completion_tokens}`,
      )
    }
    const msg = json.choices[0]?.message
    // Some reasoning models (Kimi, DeepSeek) put the answer in content and reasoning in reasoning_content.
    // If content is null/empty but reasoning_content exists, use reasoning_content.
    const text = msg?.content?.trim() || msg?.reasoning_content?.trim() || ""
    EvalLog.trace("oolong.bare_api.response", {
      provider: bareConfig.provider,
      model: bareConfig.model,
      outputChars: text.length,
    })
    return text
  }

  EvalLog.error("oolong.bare_api.retry_exhausted", {
    provider: bareConfig.provider,
    model: bareConfig.model,
    maxAttempts: maxRetries + 1,
  })
  throw new Error(`${bareConfig.provider} API: exceeded ${maxRetries} retries due to rate limiting`)
}

/**
 * Extract model text from volt run --format json output.
 * The JSON stream contains events like {"type":"text","part":{"text":"..."}}.
 * When the model uses tools across multiple steps, the final answer is in
 * the LAST text step. We return text from the last step that has text content.
 */
function isToolTranscript(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.startsWith("<tool") ||
    trimmed.endsWith("</tool>") ||
    /^<tool\b/i.test(trimmed) ||
    (trimmed.includes("<tool") && trimmed.includes("</tool>"))
  )
}

function extractLastAnswer(raw: string): string {
  const steps: string[][] = []
  let currentStep: string[] = []

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === "step_start") {
        currentStep = []
      } else if (event.type === "text" && event.part?.text) {
        currentStep.push(event.part.text)
      } else if (event.type === "step_finish") {
        if (currentStep.length > 0) {
          steps.push(currentStep)
        }
      }
    } catch {
      // Not valid JSON, skip (DB notices, etc.)
    }
  }

  // Return text from the last step that is NOT a tool transcript
  // Walk backwards to find a real answer step
  for (let i = steps.length - 1; i >= 0; i--) {
    const text = steps[i]!.join("").trim()
    if (text && !isToolTranscript(text)) {
      return text
    }
  }

  // If all steps were tool transcripts, return the last one anyway
  if (steps.length > 0) {
    return steps[steps.length - 1]!.join("").trim()
  }

  // Fallback: concatenate ALL text events
  const allText: string[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === "text" && event.part?.text) {
        allText.push(event.part.text)
      }
    } catch {
      // skip
    }
  }
  return allText.join("").trim()
}

/** Extract token usage from the JSON event stream (step_finish events) */
function extractTokenUsage(raw: string): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
} {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === "step_finish" && event.part?.usage) {
        const usage = event.part.usage
        if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens
        if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens
        if (typeof usage.cache_read_input_tokens === "number") cacheReadTokens += usage.cache_read_input_tokens
      }
    } catch {
      // skip
    }
  }

  return { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheReadTokens }
}

/** Count tool calls in the JSON event stream for diagnostics */
function extractToolUsage(raw: string): { totalCalls: number; tools: Record<string, number> } {
  const tools: Record<string, number> = {}
  let totalCalls = 0

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === "tool_use" && event.part?.tool) {
        const tool = String(event.part.tool)
        tools[tool] = (tools[tool] ?? 0) + 1
        totalCalls++
      }
    } catch {
      // skip
    }
  }

  return { totalCalls, tools }
}

const LABELS = [
  "abbreviation",
  "entity",
  "location",
  "description and abstract concept",
  "human being",
  "numeric value",
] as const

/** Common label definitions used by all prompts */
const LABEL_DEFINITIONS = [
  "Categories (6 labels) — based on TREC QA coarse classification:",
  "Each question must be classified by what its ANSWER would be.",
  "",
  "  abbreviation — ANY question about an abbreviation, acronym, or what initials stand for.",
  "    This includes: 'What does X stand for?', 'What is [acronym]?', 'What does [letters] mean?'",
  "    IMPORTANT: 'What is HTML?' = abbreviation (answer explains what the acronym means).",
  "    'What does CNN stand for?' = abbreviation. 'What is SVHS?' = abbreviation.",
  "    This category is MORE COMMON than you'd think — roughly 25-30% of questions in this dataset.",
  "",
  "  numeric value — the answer is a number, count, date, amount, measurement, speed, or time period.",
  "    Includes: 'How many...?', 'How much...?', 'When did...?', 'How fast...?', 'What year...?'",
  "",
  "  human being — the answer is a specific person, named group, organization, company, or team.",
  "    Includes: 'Who was...?', 'Who invented...?', 'What company...?', 'Which president...?'",
  "",
  "  location — the answer is a specific place: city, country, state, building, river, mountain, etc.",
  "    Includes: 'Where is...?', 'What country...?', 'What state...?', 'Which city...?'",
  "",
  "  description and abstract concept — the answer is a definition, explanation, reason, method, or process.",
  "    Includes: 'How do you...?', 'Why does...?', 'What causes...?', 'What is the definition of...?'",
  "    NOTE: 'What is X?' is ONLY 'description' if X is a common word/concept (not an acronym).",
  "",
  "  entity — the answer is a concrete THING: animal, product, food, color, language, currency, etc.",
  "    ONLY use this when the answer is NOT a person/org, NOT a place, NOT an acronym expansion,",
  "    NOT a number, and NOT a definition/explanation. This is typically the RAREST category.",
]

/** Build task-specific hints based on task type */
function buildTaskHints(task: OolongTask): string[] {
  const lowerQuestion = task.question.trim().toLowerCase()
  const asksForUser =
    lowerQuestion.includes("which user is represented most often") ||
    lowerQuestion.includes("which user is represented least often")

  const hints: string[] = []

  if (task.taskGroup === "user") {
    if (asksForUser) {
      hints.push(
        "This task asks which user ID appears most/least often. " +
          "Count occurrences of each User ID in the data lines. No label classification needed for this task, " +
          "but you still need to load the cache if other tasks will need it.",
      )
    } else {
      hints.push(
        "This task is filtered to specific user IDs. Load the cached labels, " +
          "filter to only the user IDs listed in the question, then count labels among those filtered entries.",
      )
    }
  }

  if (task.task === "TASK_TYPE.RELATIVE_FREQ") {
    hints.push(
      "Compare the counts for the two labels in the question. " +
        "Answer with exactly: 'more common than', 'less common than', or 'same frequency as'.",
    )
  }

  if (task.task === "TASK_TYPE.NUMERIC_ONE_CLASS") {
    hints.push("Return the exact count (a single integer) for the specified label.")
  }

  if (task.task === "TASK_TYPE.MOST_FREQ") {
    hints.push(asksForUser ? "Return the user ID with the highest count." : "Return the label with the highest count.")
  }

  if (task.task === "TASK_TYPE.LEAST_FREQ") {
    hints.push(asksForUser ? "Return the user ID with the lowest count." : "Return the label with the lowest count.")
  }

  return hints
}

/**
 * Build VoltCode-specific task prompt for OOLONG evaluation.
 *
 * This is the v4 "semantic classification" approach. Instead of telling the
 * model to write a regex classifier (which produces brittle, inaccurate rules),
 * we describe the task as what it actually is: a semantic classification problem.
 * VoltCode's LCM system + sub-agents can process the full dataset natively —
 * the model should read and classify each question using its own understanding,
 * not write a script to approximate it.
 *
 * @param cacheSuffix - runner-specific suffix to prevent cache sharing between runners
 */
function buildVoltCodePrompt(task: OolongTask, contextFile: string, cacheSuffix: string): string {
  const question = task.question.trim()
  const cachePath = contextFile.replace(/\.txt$/, `.${cacheSuffix}.labels.db`)
  const taskHints = buildTaskHints(task)
  const hintBlock = taskHints.length > 0 ? "\nTask hints:\n" + taskHints.map((h) => `- ${h}`).join("\n") : ""

  const classificationInstructions = [
    "Your task: classify every question in the file into one of the 6 labels above,",
    "then answer the aggregate question below using exact counts from your classification.",
    "",
    "IMPORTANT: Do NOT write a regex or keyword-based classifier. Regex classifiers produce",
    "terrible results on this data. Each question must be classified SEMANTICALLY by an LLM",
    "that understands what the question is asking.",
    "",
    "You MUST write scripts and execute them using your tools (Write tool to create files,",
    "Bash tool to run them). Do NOT simulate or imagine execution.",
    "",
    "IMPORTANT: The Write tool may report LSP/TypeScript diagnostic errors after writing a file.",
    "IGNORE THESE ERRORS — they are cosmetic. The script will run correctly with `bun run`.",
    "Do NOT try to fix LSP errors. Just write the file and immediately run it.",
    "",
    "REQUIRED APPROACH — use the llm_map tool (NOT agentic_map) with BATCHED classification,",
    "then load results into SQLite for querying:",
    "You MUST call the tool named 'llm_map'. Do NOT use 'agentic_map' — it is much slower.",
    "",
    "Step 1 — Parse the context file into batched JSONL:",
    "  Write a TypeScript script for Bun that parses the context file line by line,",
    "  extracts items matching the format 'Date: ... || User: <id> || Instance: <question>',",
    "  groups them into batches of 10, and writes a JSONL file where EACH LINE is a batch:",
    '  {"batch_index": 0, "items": [{"date": "...", "user": "...", "question": "..."}, ...up to 10]}',
    "  IMPORTANT: Each item MUST include the date, user, AND question fields.",
    "  Do NOT try to read the context file with the Read tool — it is too large.",
    "  After writing the script, IMMEDIATELY run it with: bun run <script-path>",
    "",
    "Step 2 — Classify all batches with llm_map:",
    "  Call the llm_map tool to classify all batches in parallel:",
    "  - input_path: the batched JSONL file from step 1",
    "  - output_path: a JSONL output file for classification results",
    "  - prompt: the full label definitions above + instruction to classify EVERY question in the",
    "    batch's 'items' array. Return a 'labels' array with one label per item, in the SAME ORDER.",
    '  - output_schema: {"type":"object","properties":{"labels":{"type":"array","items":{"type":"string","enum":' +
      '["abbreviation","numeric value","human being","location","description and abstract concept","entity"]}}},' +
      '"required":["labels"]}',
    "  - effort: 'low'",
    "  - concurrency: 16",
    "  - timeout_seconds: 300",
    "  This reduces ~3000 LLM calls to ~300 batched calls, which is MUCH faster.",
    "",
    "Step 3 — Load classifications into SQLite:",
    "  Write a TypeScript script for Bun that:",
    "  a) Reads the batched JSONL from step 1 (to get date, user for each item)",
    "  b) Reads the llm_map output JSONL from step 2 (to get the labels array per batch)",
    "  c) Zips them together to produce one row per item: {date, user, label}",
    "  d) Creates a SQLite database at the cache path with a table:",
    "     CREATE TABLE labels (date TEXT, user TEXT, label TEXT)",
    "  e) Inserts every row into the table",
    "  f) Creates indexes: CREATE INDEX idx_label ON labels(label);",
    "     CREATE INDEX idx_user ON labels(user);",
    "  Use bun:sqlite (built into Bun) for database access. Run it immediately with bun run.",
    "",
    "IMPORTANT: After llm_map completes (or even if it reports a timeout), IMMEDIATELY check if the",
    "output file exists. If it does, proceed to step 3 regardless of any timeout message.",
    "Do NOT stop or output reasoning text — go straight to writing and running the loader script.",
    "",
    "Step 4 — Query the database to answer the question:",
    "  Write a short TypeScript script that opens the SQLite database at the cache path",
    "  and runs SQL queries to answer the question below. Use bun:sqlite.",
    "  Print the answer to stdout. Run it with bun run.",
  ]

  return [
    "You are given a dataset file containing thousands of questions with metadata.",
    `File: ${contextFile}`,
    "",
    "The file begins with a short header (a few lines of instructions), followed by the data rows.",
    "Each data row has the format:",
    "  Date: <date> || User: <id> || Instance: <question text>",
    "",
    ...LABEL_DEFINITIONS,
    "",
    ...classificationInstructions,
    "",
    "Caching:",
    `  Cache path: ${cachePath}`,
    `  If ${cachePath} already exists AND is non-empty (a valid SQLite database), skip steps 1-3.`,
    "  Just go directly to step 4 — open the database and query it to answer the question.",
    "  If it does not exist, run steps 1-3 to create and populate the database.",
    `  CRITICAL: Save the SQLite database to EXACTLY this path: ${cachePath}`,
    "  Do NOT use checkpoint files, progress files, or any other intermediate files as the final cache.",
    "  After creating the database, verify the file exists and is non-empty with a real Bash tool call.",
    "",
    "Do NOT guess or approximate. Classify every question and compute exact counts.",
    "Complete all tool execution (writing scripts, running them, reading results) before giving your final answer.",
    hintBlock,
    "",
    "Question:",
    question,
    "",
    "CRITICAL: Do NOT output any text until you have finished ALL tool calls. Every response you",
    "give MUST include at least one tool call until the final answer. If you output text without",
    "a tool call, the session will end and your answer will be scored. Do not narrate what you",
    "plan to do — just do it by calling tools.",
    "",
    "After completing classification and reading the results, output ONLY the answer. No explanation.",
  ].join("\n")
}

/**
 * Build Claude Code task prompt for OOLONG evaluation.
 *
 * Standard prompt — describes the data, labels, and question. Does NOT
 * prescribe a solution method. Claude Code is free to approach it however
 * it wants (regex, LLM API calls, reading in context, etc.).
 *
 * @param cacheSuffix - runner-specific suffix to prevent cache sharing between runners
 */
function buildClaudeCodePrompt(task: OolongTask, contextFile: string, cacheSuffix: string): string {
  const question = task.question.trim()
  const cachePath = contextFile.replace(/\.txt$/, `.${cacheSuffix}.labels.json`)
  const taskHints = buildTaskHints(task)
  const hintBlock = taskHints.length > 0 ? "\nTask hints:\n" + taskHints.map((h) => `- ${h}`).join("\n") : ""

  return [
    "You are given a dataset file containing thousands of questions with metadata.",
    `File: ${contextFile}`,
    "",
    "The file begins with a short header (a few lines of instructions), followed by the data rows.",
    "Each data row has the format:",
    "  Date: <date> || User: <id> || Instance: <question text>",
    "",
    ...LABEL_DEFINITIONS,
    "",
    "Your task: classify every question in the file into one of the 6 labels above,",
    "then answer the aggregate question below using exact counts from your classification.",
    "",
    "Caching:",
    `  Cache path: ${cachePath}`,
    `  If ${cachePath} already exists, load it and do NOT re-classify.`,
    "  If it does not exist, classify all questions and save results as JSON:",
    '  {"total": N, "counts": {"label": count, ...}, "by_user": {"userID": {"label": count, ...}}}',
    "",
    "Do NOT guess or approximate. Classify every question and compute exact counts.",
    hintBlock,
    "",
    "Question:",
    question,
    "",
    "Output ONLY the answer in the exact format requested by the question. No explanation.",
  ].join("\n")
}

/**
 * Extract the final answer from Claude Code's plain text output.
 *
 * Claude Code in -p mode outputs all text responses (interleaved with tool use).
 * The final answer is typically the last meaningful line of output.
 * We look for the last non-empty line that isn't a tool-use artifact.
 */
function extractClaudeCodeAnswer(raw: string): string {
  const lines = raw.trim().split("\n")

  // Walk backwards to find the last substantive line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    // Skip common Claude Code output artifacts
    if (line.startsWith("⏺") || line.startsWith("─") || line.startsWith("╭") || line.startsWith("╰")) continue
    if (line.startsWith("Tool:") || line.startsWith("Running:")) continue
    return line
  }

  // Fallback: return the last non-empty line
  return (
    lines
      .filter((l) => l.trim())
      .pop()
      ?.trim() ?? ""
  )
}

/**
 * ARCHIVED: v1 prompt builder that used a pre-built reference classifier.
 * Achieved 56.8% average score on trec_coarse at 131K tokens.
 * Kept for reference — not used in the current evaluation.
 */
function _buildPromptV1(task: OolongTask, contextFile: string, classifierPath: string): string {
  const question = task.question.trim()
  const lowerQuestion = question.toLowerCase()
  const asksForUser =
    lowerQuestion.includes("which user is represented most often") ||
    lowerQuestion.includes("which user is represented least often")
  const cachePath = contextFile.replace(/\.txt$/, ".counts.json")
  const taskHints: string[] = []
  if (task.taskGroup === "user") {
    if (asksForUser) {
      taskHints.push("This is a user-frequency task. Count User IDs only; no label classification needed.")
    } else {
      taskHints.push(
        "Filter to the user IDs listed in the question before counting labels. " +
          "Run the classifier with --users to get per-user label counts.",
      )
    }
  }
  if (task.task === "TASK_TYPE.RELATIVE_FREQ")
    taskHints.push(
      "Compare counts for the two labels mentioned in the question: answer 'more common', 'less common', or 'same frequency'.",
    )
  if (task.task === "TASK_TYPE.NUMERIC_ONE_CLASS")
    taskHints.push("Return the exact count (a single number) for the specified label.")
  if (task.task === "TASK_TYPE.MOST_FREQ")
    taskHints.push(
      asksForUser ? "Return the user ID with the highest count." : "Return the label with the highest count.",
    )
  if (task.task === "TASK_TYPE.LEAST_FREQ")
    taskHints.push(
      asksForUser ? "Return the user ID with the lowest count." : "Return the label with the lowest count.",
    )
  const hintLines = taskHints.length > 0 ? ["", "Task hints:", ...taskHints.map((h) => `- ${h}`)] : []
  return [
    "You are given a dataset file containing thousands of questions with metadata.",
    `The file is at: ${contextFile}`,
    "",
    "Each data line: Date: <date> || User: <id> || Instance: <question text>",
    "",
    "Each question must be classified into one of 6 TREC coarse categories:",
    `  ${LABELS.join(", ")}`,
    "",
    "IMPORTANT: A reference classifier script is provided. You MUST use it.",
    `Classifier: ${classifierPath}`,
    "",
    "Step 1: Check if cached counts exist:",
    `  If ${cachePath} exists, load it and skip to Step 3.`,
    "",
    "Step 2: Run the classifier to compute and cache counts:",
    `  python3 ${classifierPath} ${contextFile} ${cachePath}`,
    "",
    "Step 3: Load the cached counts from the JSON and answer the question.",
    `  The JSON has: {"total": N, "counts": {"label": count, ...}}`,
    "",
    "Do NOT write your own classifier. Do NOT modify the reference script.",
    "Do NOT guess or approximate. Use the exact counts from the classifier output.",
    ...hintLines,
    "",
    "Your task:",
    question,
    "",
    "Answer format: follow the task's instruction exactly. Output only the answer, no explanation.",
  ].join("\n")
}

export namespace Oolong {
  export const NAME = "oolong"
  export const VERSION = "1.0.0"
  export const DESCRIPTION =
    "OOLONG long-context reasoning benchmark (trec_coarse split) — semantic classification + aggregation over 131K tokens"

  /** Default context length matching the RLM paper's Table 1 */
  const DEFAULT_CONTEXT_LEN = 131072

  /** Default timeout: 120 minutes per task (large-context runs can exceed 60 minutes) */
  const DEFAULT_TIMEOUT = 7_200_000

  /** VoltCode source dir for running from the local codebase */
  const VOLTCODE_DIR = path.resolve(import.meta.dir, "../..")

  export class Runner implements EvalTypes.BenchmarkRunner {
    name = NAME
    version = VERSION
    description = DESCRIPTION

    private tasks: OolongTask[] = []
    private resultsDir = ""
    private contextDir = ""
    private contextLen: number
    /** Map contextWindowId → absolute path of the data file on disk */
    private contextFiles = new Map<number, string>()

    constructor(contextLen?: number) {
      this.contextLen = contextLen ?? DEFAULT_CONTEXT_LEN
    }

    async setup(): Promise<void> {
      EvalLog.info("oolong.runner.setup.start", { runner: this.name, contextLen: this.contextLen })
      const cacheBase = process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache")
      this.resultsDir = path.join(cacheBase, "voltcode", "evals", "oolong", "results")
      this.contextDir = path.join(cacheBase, "voltcode", "evals", "oolong", "contexts")
      await fs.mkdir(this.resultsDir, { recursive: true })
      await fs.mkdir(this.contextDir, { recursive: true })

      this.tasks = await loadTrecCoarse(this.contextLen)
      console.log(`OOLONG: loaded ${this.tasks.length} trec_coarse tasks at ${this.contextLen} tokens`)

      // Write context files to disk (one per unique context window).
      // Only 2 context windows exist, each reused by 25 tasks.
      const seen = new Set<number>()
      for (const task of this.tasks) {
        if (seen.has(task.contextWindowId)) continue
        seen.add(task.contextWindowId)

        const filePath = path.join(this.contextDir, `trec_coarse_cw${task.contextWindowId}.txt`)
        await fs.writeFile(filePath, task.contextWindowText)
        this.contextFiles.set(task.contextWindowId, filePath)
        const lines = task.contextWindowText.split("\n").length
        EvalLog.trace("oolong.runner.context_file.written", {
          contextWindowId: task.contextWindowId,
          filePath,
          lines,
        })
        console.log(`OOLONG: wrote context window ${task.contextWindowId} (${lines} lines) to ${filePath}`)
      }

      // Remove ALL stale caches, checkpoints, and scripts so the model
      // re-classifies from scratch.  Previous runs may have left partial
      // checkpoint files that confuse resume logic.
      for (const [, filePath] of this.contextFiles) {
        const base = filePath.replace(/\.txt$/, "")
        await fs.rm(`${base}.voltcode.labels.json`, { force: true })
        await fs.rm(`${base}.voltcode.labels.db`, { force: true })
        await fs.rm(`${base}.checkpoint.jsonl`, { force: true })
        await fs.rm(`${base}.progress.jsonl`, { force: true })
      }
      // Also remove any classification scripts from previous runs
      const contextDirEntries = await fs.readdir(this.contextDir)
      for (const entry of contextDirEntries) {
        if (entry.endsWith(".ts") || entry.endsWith(".py")) {
          await fs.rm(path.join(this.contextDir, entry), { force: true })
        }
      }
      EvalLog.info("oolong.runner.setup.complete", {
        runner: this.name,
        tasks: this.tasks.length,
        contextWindows: this.contextFiles.size,
      })
    }

    async listTasks(): Promise<string[]> {
      return this.tasks.map((t) => String(t.id))
    }

    async runTask(taskId: string, config: EvalTypes.RunConfig): Promise<EvalTypes.TaskResult> {
      const startTime = Date.now()
      const task = this.tasks.find((t) => String(t.id) === taskId)
      EvalLog.trace("oolong.runner.task.start", { runner: this.name, taskId })

      if (!task) {
        EvalLog.error("oolong.runner.task.missing", { runner: this.name, taskId })
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: `Task not found: ${taskId}`,
        }
      }

      try {
        const contextFile = this.contextFiles.get(task.contextWindowId)
        if (!contextFile) {
          throw new Error(`No context file for contextWindowId=${task.contextWindowId}`)
        }

        const prompt = buildVoltCodePrompt(task, contextFile, "voltcode")

        // Build model args - prefer backend over model
        const effectiveModel = getEffectiveModel(config)
        const modelArgs = effectiveModel ? ["--model", effectiveModel] : []
        // Skip variant for OpenAI — xhigh reasoning creates verbose tool transcripts that confuse scoring
        const isOpenAI = config.backend?.startsWith("openai:") || effectiveModel?.startsWith("openai/")
        const variantArgs = config.variant && !isOpenAI ? ["--variant", config.variant] : []
        const timeout = config.timeout ?? DEFAULT_TIMEOUT

        // Auto-approve tool permissions. Deny Read to prevent the LCM-summary
        // shortcut — the model must use Bash to write+run a script.
        const permissionConfig = JSON.stringify({
          read: "allow",
          grep: "allow",
          glob: "allow",
          bash: "allow",
          edit: "allow",
          write: "allow",
          external_directory: "allow",
          task: "allow",
          question: "deny",
        })

        const cmd = config.binary
          ? ["volt", "run", ...modelArgs, ...variantArgs, "--format", "json"]
          : [
              "bun",
              "run",
              "--conditions=browser",
              "src/index.ts",
              "run",
              ...modelArgs,
              ...variantArgs,
              "--format",
              "json",
            ]

        // Retry loop for rate limit errors (up to 5 retries with longer exponential backoff)
        const MAX_RETRIES = 5
        let lastStdout = ""
        let lastStderr = ""
        let lastExitCode = 0
        let output: string | null = null
        let toolUsage: { totalCalls: number; tools: Record<string, number> } = { totalCalls: 0, tools: {} }
        let tokenUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            const backoffMs = Math.min(300_000, 60_000 * Math.pow(2, attempt - 1))
            EvalLog.warn("oolong.runner.task.retry", {
              runner: this.name,
              taskId,
              attempt,
              maxRetries: MAX_RETRIES,
              waitMs: backoffMs,
            })
            console.log(`[${taskId}] Rate limit retry ${attempt}/${MAX_RETRIES}, waiting ${backoffMs / 1000}s...`)
            await new Promise((r) => setTimeout(r, backoffMs))
          }

          const proc = Bun.spawn(cmd, {
            cwd: config.binary ? "/tmp/voltcode-eval" : VOLTCODE_DIR,
            stdin: new Blob([prompt]),
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              VOLTCODE_PERMISSION: permissionConfig,
            },
          })

          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              proc.kill()
              reject(new Error(`Command timed out after ${timeout}ms`))
            }, timeout)
          })

          const [exitCode, stdout, stderr] = await Promise.race([
            Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
            timeoutPromise,
          ])
          EvalLog.trace("oolong.runner.task.process_exit", {
            runner: this.name,
            taskId,
            attempt: attempt + 1,
            exitCode,
            stdoutChars: stdout.length,
            stderrChars: stderr.length,
          })

          lastStdout = stdout
          lastStderr = stderr
          lastExitCode = exitCode

          if (exitCode !== 0) {
            const stderrSnippet = stderr.slice(0, 500)
            EvalLog.error("oolong.runner.task.process_failed", {
              runner: this.name,
              taskId,
              exitCode,
              stderrSnippet,
            })
            console.error(`volt run failed (${exitCode}): ${stderrSnippet}`)
            if (exitCode === 143 || exitCode === 137) {
              throw new Error(`Process killed (exit ${exitCode}): ${stderrSnippet}`)
            }
          }

          // Check for rate limit error in the JSON event stream
          const isRateLimit = stdout.includes("rate_limit_exceeded") || stdout.includes("Rate limit reached")
          output = extractLastAnswer(stdout)
          toolUsage = extractToolUsage(stdout)
          tokenUsage = extractTokenUsage(stdout)
          EvalLog.trace("oolong.runner.task.output_parsed", {
            runner: this.name,
            taskId,
            attempt: attempt + 1,
            outputChars: output?.length ?? 0,
            toolCalls: toolUsage.totalCalls,
            tokenUsage,
          })

          if (output || !isRateLimit || attempt === MAX_RETRIES) {
            break
          }
        }

        // Save raw JSON event stream per task for later debugging/review.
        const outputDir = config.outputDir ?? this.resultsDir
        const traceDir = path.join(outputDir, "traces")
        await fs.mkdir(traceDir, { recursive: true })
        await fs.writeFile(path.join(traceDir, `${taskId}.json`), lastStdout)
        EvalLog.trace("oolong.runner.task.trace_saved", { runner: this.name, taskId, traceDir })

        // Also append to trace.jsonl if outputDir is specified (with token usage)
        if (config.outputDir) {
          const traceEntry = { taskId, timestamp: new Date().toISOString(), usage: tokenUsage, stdout: lastStdout }
          await fs.appendFile(path.join(config.outputDir, "trace.jsonl"), JSON.stringify(traceEntry) + "\n")
        }

        if (!output) {
          throw new Error(`Empty model output (exit ${lastExitCode}), stderr: ${lastStderr.slice(0, 300)}`)
        }

        // Score the response
        const scored = scoreResponse(
          {
            id: task.id,
            contextWindowId: task.contextWindowId,
            dataset: task.dataset,
            answer: task.answer,
            answerType: task.answerType,
            taskGroup: task.taskGroup,
            task: task.task,
          },
          output,
          effectiveModel ?? "default",
        )

        // Append to per-run JSONL
        await this.appendResult(scored, config.outputDir)
        EvalLog.trace("oolong.runner.task.scored", {
          runner: this.name,
          taskId,
          score: scored.score,
          parseConfidence: scored.parseConfidence,
        })

        return {
          taskId,
          passed: scored.score >= 0.5,
          score: scored.score,
          duration: Date.now() - startTime,
          metadata: {
            attemptedParse: scored.attemptedParse,
            parseConfidence: scored.parseConfidence,
            goldAnswer: scored.answer,
            answerType: task.answerType,
            taskGroup: task.taskGroup,
            task: task.task,
            contextWindowId: task.contextWindowId,
            toolUsage,
          },
        }
      } catch (error) {
        EvalLog.error("oolong.runner.task.error", {
          runner: this.name,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    private async appendResult(scored: ScoredResult, outputDir?: string): Promise<void> {
      const dir = outputDir ?? this.resultsDir
      const jsonlPath = path.join(dir, "voltcode_output.jsonl")
      await fs.appendFile(jsonlPath, JSON.stringify(scored) + "\n")
    }

    async run(config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
      const startedAt = new Date().toISOString()
      let taskIds = config.taskIds ?? (await this.listTasks())
      EvalLog.info("oolong.runner.run.start", {
        runner: this.name,
        tasksRequested: taskIds.length,
        concurrency: config.concurrency ?? 1,
      })

      if (config.limit) {
        taskIds = taskIds.slice(0, config.limit)
      }

      // Use outputDir if provided, otherwise default resultsDir
      const outputDir = config.outputDir ?? this.resultsDir
      await fs.mkdir(outputDir, { recursive: true })

      // Clear previous JSONL for this run
      const jsonlPath = path.join(outputDir, "voltcode_output.jsonl")
      await fs.writeFile(jsonlPath, "")

      const results: EvalTypes.TaskResult[] = []
      let runningScore = 0
      let completed = 0
      const concurrency = config.concurrency ?? 1

      // Worker pool: run up to `concurrency` tasks in parallel
      const queue = [...taskIds]
      const running: Promise<void>[] = []

      // Track which context windows have had their first task run,
      // so we can verify the cache file was created.
      const cwFirstTaskDone = new Set<number>()

      const processResult = async (taskId: string, result: EvalTypes.TaskResult) => {
        results.push(result)
        runningScore += result.score
        completed++

        const task = this.tasks.find((t) => String(t.id) === taskId)
        const avgScore = (runningScore / completed) * 100
        console.log(
          `[${completed}/${taskIds.length}] task=${taskId} ` +
            `type=${task?.taskGroup}/${task?.task} ` +
            `score=${result.score.toFixed(3)} ` +
            `running_avg=${avgScore.toFixed(1)}% ` +
            `${result.error ? `ERROR: ${result.error}` : ""}`,
        )

        // After the first task for each context window, verify the cache
        // file was created.  If not, subsequent tasks will waste time
        // re-classifying from scratch and get inconsistent results.
        if (task && !cwFirstTaskDone.has(task.contextWindowId)) {
          cwFirstTaskDone.add(task.contextWindowId)
          const contextFile = this.contextFiles.get(task.contextWindowId)
          if (contextFile) {
            const cachePath = contextFile.replace(/\.txt$/, ".voltcode.labels.db")
            try {
              await fs.access(cachePath)
              const stat = await fs.stat(cachePath)
              console.log(`OOLONG: CW${task.contextWindowId} cache verified (${(stat.size / 1024).toFixed(0)} KB)`)
            } catch {
              EvalLog.warn("oolong.runner.cache_missing", {
                runner: this.name,
                contextWindowId: task.contextWindowId,
                cachePath,
              })
              console.warn(
                `OOLONG WARNING: CW${task.contextWindowId} cache NOT found at ${cachePath} ` +
                  `after first task. Subsequent tasks will re-classify from scratch!`,
              )
            }
          }
        }
      }

      const runOne = async (taskId: string) => {
        const result = await this.runTask(taskId, config)
        await processResult(taskId, result)
      }

      while (queue.length > 0 || running.length > 0) {
        while (running.length < concurrency && queue.length > 0) {
          const taskId = queue.shift()!
          const promise = runOne(taskId).then(() => {
            running.splice(running.indexOf(promise), 1)
          })
          running.push(promise)
        }
        if (running.length > 0) {
          await Promise.race(running)
        }
      }

      const completedAt = new Date().toISOString()
      const passedTasks = results.filter((r) => r.passed).length
      const averageScore = results.reduce((sum, r) => sum + r.score, 0) / results.length

      // Print summary matching the paper's format
      console.log(`\n=== OOLONG Results (trec_coarse, ${this.contextLen} tokens) ===`)
      console.log(`Score: ${(averageScore * 100).toFixed(1)} (paper reference: GPT-5=44.0, Qwen3-Coder=36.0)`)
      console.log(`Tasks: ${results.length}, Passed: ${passedTasks}`)
      console.log(`Results saved to: ${jsonlPath}`)

      const benchmarkResult: EvalTypes.BenchmarkResult = {
        benchmark: this.name,
        version: this.version,
        model: getEffectiveModel(config) ?? "default",
        startedAt,
        completedAt,
        totalTasks: results.length,
        passedTasks,
        passRate: passedTasks / results.length,
        averageScore,
        totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
        tasks: results,
      }
      EvalLog.info("oolong.runner.run.complete", {
        runner: this.name,
        totalTasks: benchmarkResult.totalTasks,
        passedTasks: benchmarkResult.passedTasks,
        averageScore: benchmarkResult.averageScore,
      })

      // Write result.json to outputDir if specified
      if (config.outputDir) {
        const resultPath = path.join(config.outputDir, "result.json")
        await fs.writeFile(resultPath, JSON.stringify(benchmarkResult, null, 2))
        console.log(`Result written to: ${resultPath}`)
      }

      return benchmarkResult
    }

    async cleanup(): Promise<void> {
      // Context files are cached and reused across runs — don't delete them
    }
  }

  /**
   * Claude Code runner — uses the `claude` CLI (Claude Code) as the agentic harness.
   * Same prompt as VoltCode but stripped of VoltCode/LCM-specific references.
   * Claude Code has bash + file tools, so the model can write/run classifiers.
   *
   * Usage:
   *   bun evals/cli.ts oolong --claude-code
   *   bun evals/cli.ts oolong --claude-code --model opus
   */
  export class ClaudeCodeRunner implements EvalTypes.BenchmarkRunner {
    name = `${NAME}-claude-code`
    version = VERSION
    description = `${DESCRIPTION} (Claude Code agentic harness)`

    private tasks: OolongTask[] = []
    private resultsDir = ""
    private contextDir = ""
    private contextLen: number
    private contextFiles = new Map<number, string>()

    constructor(contextLen?: number) {
      this.contextLen = contextLen ?? DEFAULT_CONTEXT_LEN
    }

    async setup(): Promise<void> {
      EvalLog.info("oolong.claude.setup.start", { runner: this.name, contextLen: this.contextLen })
      const cacheBase = process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache")
      this.resultsDir = path.join(cacheBase, "voltcode", "evals", "oolong", "results")
      this.contextDir = path.join(cacheBase, "voltcode", "evals", "oolong", "contexts")
      await fs.mkdir(this.resultsDir, { recursive: true })
      await fs.mkdir(this.contextDir, { recursive: true })

      this.tasks = await loadTrecCoarse(this.contextLen)
      console.log(`OOLONG (claude-code): loaded ${this.tasks.length} trec_coarse tasks at ${this.contextLen} tokens`)

      const seen = new Set<number>()
      for (const task of this.tasks) {
        if (seen.has(task.contextWindowId)) continue
        seen.add(task.contextWindowId)

        const filePath = path.join(this.contextDir, `trec_coarse_cw${task.contextWindowId}.txt`)
        await fs.writeFile(filePath, task.contextWindowText)
        this.contextFiles.set(task.contextWindowId, filePath)
        const lines = task.contextWindowText.split("\n").length
        EvalLog.trace("oolong.claude.context_file.written", {
          contextWindowId: task.contextWindowId,
          filePath,
          lines,
        })
        console.log(`OOLONG: wrote context window ${task.contextWindowId} (${lines} lines) to ${filePath}`)
      }

      // Remove stale label caches so the model re-classifies
      for (const [, filePath] of this.contextFiles) {
        const cachePath = filePath.replace(/\.txt$/, ".claude-code.labels.json")
        await fs.rm(cachePath, { force: true })
      }
      EvalLog.info("oolong.claude.setup.complete", {
        runner: this.name,
        tasks: this.tasks.length,
        contextWindows: this.contextFiles.size,
      })
    }

    async listTasks(): Promise<string[]> {
      return this.tasks.map((t) => String(t.id))
    }

    async runTask(taskId: string, config: EvalTypes.RunConfig): Promise<EvalTypes.TaskResult> {
      const startTime = Date.now()
      const task = this.tasks.find((t) => String(t.id) === taskId)
      EvalLog.trace("oolong.claude.task.start", { runner: this.name, taskId })

      if (!task) {
        EvalLog.error("oolong.claude.task.missing", { runner: this.name, taskId })
        return { taskId, passed: false, score: 0, duration: Date.now() - startTime, error: `Task not found: ${taskId}` }
      }

      try {
        const contextFile = this.contextFiles.get(task.contextWindowId)
        if (!contextFile) {
          throw new Error(`No context file for contextWindowId=${task.contextWindowId}`)
        }

        const prompt = buildClaudeCodePrompt(task, contextFile, "claude-code")
        const timeout = config.timeout ?? DEFAULT_TIMEOUT

        // Build model args - prefer backend over model
        const effectiveModel = getEffectiveModel(config)

        // Claude Code CLI: -p for print mode, --dangerously-skip-permissions for unattended
        const cmd = [
          "claude",
          "-p",
          "--dangerously-skip-permissions",
          "--output-format",
          "json",
          "--no-session-persistence",
          ...(effectiveModel ? ["--model", effectiveModel] : []),
        ]

        const proc = Bun.spawn(cmd, {
          cwd: this.contextDir,
          stdin: new Blob([prompt]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        })

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            proc.kill()
            reject(new Error(`Command timed out after ${timeout}ms`))
          }, timeout)
        })

        const [exitCode, stdout, stderr] = await Promise.race([
          Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
          timeoutPromise,
        ])
        EvalLog.trace("oolong.claude.task.process_exit", {
          runner: this.name,
          taskId,
          exitCode,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
        })

        if (exitCode !== 0) {
          const stderrSnippet = stderr.slice(0, 500)
          EvalLog.error("oolong.claude.task.process_failed", {
            runner: this.name,
            taskId,
            exitCode,
            stderrSnippet,
          })
          console.error(`claude -p failed (${exitCode}): ${stderrSnippet}`)
          if (exitCode === 143 || exitCode === 137) {
            throw new Error(`Process killed (exit ${exitCode}): ${stderrSnippet}`)
          }
        }

        // Save raw output per task for debugging
        const outputDir = config.outputDir ?? this.resultsDir
        const traceDir = path.join(outputDir, "traces-claude-code")
        await fs.mkdir(traceDir, { recursive: true })
        await fs.writeFile(path.join(traceDir, `${taskId}.json`), stdout)
        EvalLog.trace("oolong.claude.task.trace_saved", { runner: this.name, taskId, traceDir })

        // Claude Code with --output-format json returns {"result": "...", ...}
        // Extract the result field; fall back to plain text extraction
        let output = ""
        let ccUsage: { input_tokens?: number; output_tokens?: number } = {}
        try {
          const json = JSON.parse(stdout) as {
            result?: string
            is_error?: boolean
            num_turns?: number
            total_cost_usd?: number
            input_tokens?: number
            output_tokens?: number
          }
          ccUsage = { input_tokens: json.input_tokens, output_tokens: json.output_tokens }
          if (json.num_turns)
            console.log(`  [claude-code] turns=${json.num_turns} cost=$${json.total_cost_usd?.toFixed(4) ?? "?"}`)
          if (json.is_error) throw new Error(`Claude Code returned error: ${json.result}`)
          output = json.result?.trim() ?? ""
        } catch (e) {
          if (e instanceof SyntaxError) {
            // Fallback to plain text extraction if JSON parsing fails
            output = extractClaudeCodeAnswer(stdout)
          } else {
            throw e
          }
        }

        // Append to trace.jsonl if outputDir is specified (with token usage from Claude Code response)
        if (config.outputDir) {
          const usage = {
            input_tokens: ccUsage.input_tokens ?? 0,
            output_tokens: ccUsage.output_tokens ?? 0,
            cache_read_input_tokens: 0,
          }
          const traceEntry = { taskId, timestamp: new Date().toISOString(), usage, stdout }
          await fs.appendFile(path.join(config.outputDir, "trace.jsonl"), JSON.stringify(traceEntry) + "\n")
        }

        // The result may contain markdown or multi-line explanation.
        // Extract the actual answer from the last meaningful line.
        if (output.includes("\n")) {
          output = extractClaudeCodeAnswer(output)
        }

        if (!output) {
          throw new Error(`Empty model output (exit ${exitCode}), stderr: ${stderr.slice(0, 300)}`)
        }

        const scored = scoreResponse(
          {
            id: task.id,
            contextWindowId: task.contextWindowId,
            dataset: task.dataset,
            answer: task.answer,
            answerType: task.answerType,
            taskGroup: task.taskGroup,
            task: task.task,
          },
          output,
          effectiveModel ?? "claude-code",
        )

        await this.appendResult(scored, config.outputDir)
        EvalLog.trace("oolong.claude.task.scored", {
          runner: this.name,
          taskId,
          score: scored.score,
          parseConfidence: scored.parseConfidence,
        })

        return {
          taskId,
          passed: scored.score >= 0.5,
          score: scored.score,
          duration: Date.now() - startTime,
          metadata: {
            attemptedParse: scored.attemptedParse,
            parseConfidence: scored.parseConfidence,
            goldAnswer: scored.answer,
            answerType: task.answerType,
            taskGroup: task.taskGroup,
            task: task.task,
            contextWindowId: task.contextWindowId,
          },
        }
      } catch (error) {
        EvalLog.error("oolong.claude.task.error", {
          runner: this.name,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    private async appendResult(scored: ScoredResult, outputDir?: string): Promise<void> {
      const dir = outputDir ?? this.resultsDir
      const jsonlPath = path.join(dir, "claude_code_output.jsonl")
      await fs.appendFile(jsonlPath, JSON.stringify(scored) + "\n")
    }

    async run(config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
      const startedAt = new Date().toISOString()
      let taskIds = config.taskIds ?? (await this.listTasks())
      EvalLog.info("oolong.claude.run.start", {
        runner: this.name,
        tasksRequested: taskIds.length,
      })

      if (config.limit) {
        taskIds = taskIds.slice(0, config.limit)
      }

      // Use outputDir if provided, otherwise default resultsDir
      const outputDir = config.outputDir ?? this.resultsDir
      await fs.mkdir(outputDir, { recursive: true })

      const jsonlPath = path.join(outputDir, "claude_code_output.jsonl")
      await fs.writeFile(jsonlPath, "")

      const results: EvalTypes.TaskResult[] = []
      let runningScore = 0
      let completed = 0

      // Run sequentially — Claude Code sessions are heavyweight
      for (const taskId of taskIds) {
        const result = await this.runTask(taskId, config)
        results.push(result)
        runningScore += result.score
        completed++
        const task = this.tasks.find((t) => String(t.id) === taskId)
        const avgScore = (runningScore / completed) * 100
        console.log(
          `[${completed}/${taskIds.length}] task=${taskId} ` +
            `type=${task?.taskGroup}/${task?.task} ` +
            `score=${result.score.toFixed(3)} ` +
            `running_avg=${avgScore.toFixed(1)}% ` +
            `${result.error ? `ERROR: ${result.error}` : ""}`,
        )
      }

      const completedAt = new Date().toISOString()
      const passedTasks = results.filter((r) => r.passed).length
      const averageScore = results.reduce((sum, r) => sum + r.score, 0) / results.length

      console.log(`\n=== OOLONG Results — Claude Code (trec_coarse, ${this.contextLen} tokens) ===`)
      console.log(`Model: ${getEffectiveModel(config) ?? "default"}`)
      console.log(`Score: ${(averageScore * 100).toFixed(1)} (paper reference: GPT-5=44.0, Qwen3-Coder=36.0)`)
      console.log(`Tasks: ${results.length}, Passed: ${passedTasks}`)
      console.log(`Results saved to: ${jsonlPath}`)

      const benchmarkResult: EvalTypes.BenchmarkResult = {
        benchmark: this.name,
        version: this.version,
        model: getEffectiveModel(config) ?? "claude-code",
        startedAt,
        completedAt,
        totalTasks: results.length,
        passedTasks,
        passRate: passedTasks / results.length,
        averageScore,
        totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
        tasks: results,
      }
      EvalLog.info("oolong.claude.run.complete", {
        runner: this.name,
        totalTasks: benchmarkResult.totalTasks,
        passedTasks: benchmarkResult.passedTasks,
        averageScore: benchmarkResult.averageScore,
      })

      // Write result.json to outputDir if specified
      if (config.outputDir) {
        const resultPath = path.join(config.outputDir, "result.json")
        await fs.writeFile(resultPath, JSON.stringify(benchmarkResult, null, 2))
        console.log(`Result written to: ${resultPath}`)
      }

      return benchmarkResult
    }

    async cleanup(): Promise<void> {}
  }

  /**
   * Bare API runner — sends context + question directly to a model API
   * with no system prompt, no tools, no VoltCode harness.
   * This matches the paper's "base model" evaluation protocol.
   *
   * Usage:
   *   bun evals/cli.ts oolong --bare --model openai/gpt-4o
   *   bun evals/cli.ts oolong --bare --model anthropic/claude-sonnet-4
   */
  export class BareRunner implements EvalTypes.BenchmarkRunner {
    name = `${NAME}-bare`
    version = VERSION
    description = `${DESCRIPTION} (bare API — no tools, no system prompt)`

    private tasks: OolongTask[] = []
    private resultsDir = ""
    private contextLen: number

    constructor(contextLen?: number) {
      this.contextLen = contextLen ?? DEFAULT_CONTEXT_LEN
    }

    async setup(): Promise<void> {
      EvalLog.info("oolong.bare.setup.start", { runner: this.name, contextLen: this.contextLen })
      const cacheBase = process.env.XDG_CACHE_HOME || path.join(process.env.HOME!, ".cache")
      this.resultsDir = path.join(cacheBase, "voltcode", "evals", "oolong", "results")
      await fs.mkdir(this.resultsDir, { recursive: true })
      this.tasks = await loadTrecCoarse(this.contextLen)
      console.log(`OOLONG (bare): loaded ${this.tasks.length} trec_coarse tasks at ${this.contextLen} tokens`)
      EvalLog.info("oolong.bare.setup.complete", { runner: this.name, tasks: this.tasks.length })
    }

    async listTasks(): Promise<string[]> {
      return this.tasks.map((t) => String(t.id))
    }

    async runTask(taskId: string, config: EvalTypes.RunConfig): Promise<EvalTypes.TaskResult> {
      const startTime = Date.now()
      const task = this.tasks.find((t) => String(t.id) === taskId)
      EvalLog.trace("oolong.bare.task.start", { runner: this.name, taskId })

      if (!task) {
        EvalLog.error("oolong.bare.task.missing", { runner: this.name, taskId })
        return { taskId, passed: false, score: 0, duration: Date.now() - startTime, error: `Task not found: ${taskId}` }
      }

      // Get effective model - prefer backend over model
      const effectiveModel = getEffectiveModel(config)
      if (!effectiveModel) {
        EvalLog.error("oolong.bare.task.model_missing", { runner: this.name, taskId })
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: "No --model or --backend specified for bare mode",
        }
      }

      const bareConfig = parseBareModel(effectiveModel)

      try {
        // Paper protocol: context_window_text + question, nothing else
        const userMessage = task.contextWindowText + "\n\n" + task.question.trim()

        const output = await callBareApi(bareConfig, userMessage)
        EvalLog.trace("oolong.bare.task.response", {
          runner: this.name,
          taskId,
          outputChars: output.length,
        })

        if (!output) {
          throw new Error("Empty model response")
        }

        const scored = scoreResponse(
          {
            id: task.id,
            contextWindowId: task.contextWindowId,
            dataset: task.dataset,
            answer: task.answer,
            answerType: task.answerType,
            taskGroup: task.taskGroup,
            task: task.task,
          },
          output,
          effectiveModel,
        )

        await this.appendResult(scored, config.outputDir)
        EvalLog.trace("oolong.bare.task.scored", {
          runner: this.name,
          taskId,
          score: scored.score,
          parseConfidence: scored.parseConfidence,
        })

        // Write to trace.jsonl if outputDir specified
        if (config.outputDir) {
          const traceEntry = { taskId, timestamp: new Date().toISOString(), output }
          await fs.appendFile(path.join(config.outputDir, "trace.jsonl"), JSON.stringify(traceEntry) + "\n")
        }

        return {
          taskId,
          passed: scored.score >= 0.5,
          score: scored.score,
          duration: Date.now() - startTime,
          metadata: {
            attemptedParse: scored.attemptedParse,
            parseConfidence: scored.parseConfidence,
            goldAnswer: scored.answer,
            answerType: task.answerType,
            taskGroup: task.taskGroup,
            task: task.task,
            contextWindowId: task.contextWindowId,
            bare: true,
          },
        }
      } catch (error) {
        EvalLog.error("oolong.bare.task.error", {
          runner: this.name,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        })
        return {
          taskId,
          passed: false,
          score: 0,
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    private async appendResult(scored: ScoredResult, outputDir?: string): Promise<void> {
      const dir = outputDir ?? this.resultsDir
      const jsonlPath = path.join(dir, "bare_output.jsonl")
      await fs.appendFile(jsonlPath, JSON.stringify(scored) + "\n")
    }

    async run(config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
      const startedAt = new Date().toISOString()
      let taskIds = config.taskIds ?? (await this.listTasks())
      EvalLog.info("oolong.bare.run.start", {
        runner: this.name,
        tasksRequested: taskIds.length,
        concurrency: config.concurrency ?? 1,
      })

      if (config.limit) {
        taskIds = taskIds.slice(0, config.limit)
      }

      // Use outputDir if provided, otherwise default resultsDir
      const outputDir = config.outputDir ?? this.resultsDir
      await fs.mkdir(outputDir, { recursive: true })

      // Clear previous JSONL for this run
      const jsonlPath = path.join(outputDir, "bare_output.jsonl")
      await fs.writeFile(jsonlPath, "")

      const results: EvalTypes.TaskResult[] = []
      let runningScore = 0
      let completed = 0
      const concurrency = config.concurrency ?? 1

      const queue = [...taskIds]
      const running: Promise<void>[] = []

      const processResult = (taskId: string, result: EvalTypes.TaskResult) => {
        results.push(result)
        runningScore += result.score
        completed++
        const task = this.tasks.find((t) => String(t.id) === taskId)
        const avgScore = (runningScore / completed) * 100
        console.log(
          `[${completed}/${taskIds.length}] task=${taskId} ` +
            `type=${task?.taskGroup}/${task?.task} ` +
            `score=${result.score.toFixed(3)} ` +
            `running_avg=${avgScore.toFixed(1)}% ` +
            `${result.error ? `ERROR: ${result.error}` : ""}`,
        )
      }

      const runOne = async (taskId: string) => {
        const result = await this.runTask(taskId, config)
        processResult(taskId, result)
      }

      while (queue.length > 0 || running.length > 0) {
        while (running.length < concurrency && queue.length > 0) {
          const taskId = queue.shift()!
          const promise = runOne(taskId).then(() => {
            running.splice(running.indexOf(promise), 1)
          })
          running.push(promise)
        }
        if (running.length > 0) {
          await Promise.race(running)
        }
      }

      const completedAt = new Date().toISOString()
      const passedTasks = results.filter((r) => r.passed).length
      const averageScore = results.reduce((sum, r) => sum + r.score, 0) / results.length

      console.log(`\n=== OOLONG Bare Results (trec_coarse, ${this.contextLen} tokens) ===`)
      console.log(`Model: ${getEffectiveModel(config)}`)
      console.log(`Score: ${(averageScore * 100).toFixed(1)} (paper reference: GPT-5=44.0, Qwen3-Coder=36.0)`)
      console.log(`Tasks: ${results.length}, Passed: ${passedTasks}`)
      console.log(`Results saved to: ${jsonlPath}`)

      const benchmarkResult: EvalTypes.BenchmarkResult = {
        benchmark: this.name,
        version: this.version,
        model: getEffectiveModel(config) ?? "unknown",
        startedAt,
        completedAt,
        totalTasks: results.length,
        passedTasks,
        passRate: passedTasks / results.length,
        averageScore,
        totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
        tasks: results,
      }
      EvalLog.info("oolong.bare.run.complete", {
        runner: this.name,
        totalTasks: benchmarkResult.totalTasks,
        passedTasks: benchmarkResult.passedTasks,
        averageScore: benchmarkResult.averageScore,
      })

      // Write result.json to outputDir if specified
      if (config.outputDir) {
        const resultPath = path.join(config.outputDir, "result.json")
        await fs.writeFile(resultPath, JSON.stringify(benchmarkResult, null, 2))
        console.log(`Result written to: ${resultPath}`)
      }

      return benchmarkResult
    }

    async cleanup(): Promise<void> {}
  }
}
