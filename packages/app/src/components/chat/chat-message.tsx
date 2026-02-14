import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { type Message, type Part, type TextPart, type ToolPart, type ReasoningPart } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Markdown } from "@opencode-ai/ui/markdown"
import { getFilename } from "@opencode-ai/util/path"

interface ChatMessageProps {
  message: Message
  parts: () => Part[]
}

/**
 * Format a token count into a readable string (e.g. 2450 -> "2,450")
 */
function formatTokenCount(count: number): string {
  return count.toLocaleString()
}

/**
 * Format byte size into a human-readable string (e.g. 64510 -> "63kB")
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Detect whether a synthetic text part contains LCM debug information
 * that should be suppressed from the chat UI.
 *
 * These patterns come from:
 *   - prompt.ts: "Called the Read tool with the following input: ..."
 *   - read.ts: "**Large file automatically stored in LCM ...**"
 *   - read.ts: "**File ID:** file_xxx ..."
 *   - prompt.ts: "[Large file detected: ...]"
 *   - prompt.ts: LCM context text with file references and summaries
 */
function isLcmDebugText(text: string): boolean {
  if (!text) return false
  // "Called the Read tool" synthetic prefix
  if (text.startsWith("Called the Read tool")) return true
  // LCM stored file marker from buildLcmEventPart
  if (text.startsWith("LCM stored file:")) return true
  // Large file auto-stored message from read.ts storeLargeFileInLcm
  if (text.includes("Large file automatically stored in LCM")) return true
  // File ID debug line
  if (/^\*?\*?File ID:\*?\*?\s*file_[a-f0-9]/.test(text)) return true
  // Large file detected marker from prompt.ts
  if (/^\[Large file detected:/.test(text)) return true
  // LCM context text containing file reference and summary
  if (text.includes("[LCM File Reference]") || text.includes("[Large File ID:")) return true
  // LCM large file stored context from formatLargeFileContext
  if (/^\[Large File Stored:/.test(text)) return true
  // Full LCM file output block (starts with bold header, contains File ID line)
  if (text.includes("**File ID:**") && text.includes("**Explorer Used:**")) return true
  return false
}

/**
 * Derive a human-readable tool label from the tool name.
 */
function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Shell",
    glob: "Glob",
    grep: "Grep",
    list: "List",
    webfetch: "Web Fetch",
    task: "Agent",
    apply_patch: "Patch",
    todowrite: "To-dos",
    todoread: "Read To-dos",
    question: "Questions",
  }
  return labels[tool] ?? tool
}

/**
 * Get a short description for a tool call from its input.
 */
function toolDescription(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "read":
      return input.filePath ? getFilename(input.filePath as string) : ""
    case "write":
    case "edit":
      return input.filePath ? getFilename(input.filePath as string) : ""
    case "bash":
      return (input.description as string) ?? ""
    case "glob":
      return input.pattern ? `${input.pattern}` : ""
    case "grep":
      return input.pattern ? `${input.pattern}` : ""
    case "list":
      return input.path ? getFilename(input.path as string) : ""
    case "webfetch":
      return (input.url as string) ?? ""
    case "task":
      return (input.description as string) ?? ""
    case "apply_patch": {
      const files = input.files as unknown[] | undefined
      if (!files?.length) return ""
      return `${files.length} file${files.length > 1 ? "s" : ""}`
    }
    default:
      return ""
  }
}

export function ChatMessage(props: ChatMessageProps) {
  const isUser = () => props.message.role === "user"
  const isCompleted = () =>
    props.message.role === "assistant" && !!(props.message as { time: { completed?: number } }).time.completed

  return (
    <div class="flex gap-4 group">
      <div class="flex-shrink-0">
        <Avatar fallback={isUser() ? "You" : "VC"} size="normal" />
      </div>

      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 mb-1">
          <span class="font-semibold text-text-strong">{isUser() ? "You" : "VoltCode"}</span>
        </div>

        <For each={props.parts()}>
          {(part) => (
            <Switch>
              <Match when={part.type === "text" && part}>{(p) => <ChatTextPart part={p() as TextPart} />}</Match>
              <Match when={part.type === "reasoning" && part}>
                {(p) => <ChatReasoningPart part={p() as ReasoningPart} isCompleted={isCompleted()} />}
              </Match>
              <Match when={part.type === "tool" && part}>{(p) => <ChatToolPart part={p() as ToolPart} />}</Match>
            </Switch>
          )}
        </For>
        <Show when={!isUser() && props.parts().length === 0 && !isCompleted()}>
          <div class="flex items-center gap-2 py-2 text-sm text-text-weak">
            <span
              class="inline-block w-4 h-4 border-2 border-text-weak border-t-transparent rounded-full flex-shrink-0"
              style={{ animation: "spin 1s linear infinite" }}
            />
            <span>Working...</span>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text Part (handles plain text and LCM file load events)
// ---------------------------------------------------------------------------

function ChatTextPart(props: { part: TextPart }) {
  const lcmMetadata = createMemo(() => {
    const meta = props.part.metadata as
      | {
          lcm?: {
            type: string
            tokenCount?: number
            filePath?: string
            sizeBytes?: number
            fileId?: string
            explorerUsed?: string
            mimeType?: string
            source?: string
          }
        }
      | undefined
    if (!meta?.lcm) return undefined
    return meta.lcm
  })

  const isLcmFile = createMemo(() => lcmMetadata()?.type === "file")

  // Skip ignored parts that are not LCM events
  if (props.part.ignored && !lcmMetadata()) return null

  const textContent = createMemo(() => {
    if (isLcmFile()) return ""
    if (props.part.ignored) return ""
    const raw = props.part.text ?? ""
    const trimmed = raw.trim()
    // Suppress synthetic LCM debug text from display
    if (props.part.synthetic && isLcmDebugText(trimmed)) return ""
    return trimmed
  })

  return (
    <>
      <Show when={isLcmFile()}>
        <LcmFileIndicator metadata={lcmMetadata()!} />
      </Show>
      <Show when={textContent()}>
        <Markdown text={textContent()} class="prose prose-sm max-w-none dark:prose-invert" />
      </Show>
    </>
  )
}

// ---------------------------------------------------------------------------
// LCM File Load Indicator (expandable)
// ---------------------------------------------------------------------------

interface LcmFileMetadata {
  type: string
  tokenCount?: number
  filePath?: string
  sizeBytes?: number
  fileId?: string
  explorerUsed?: string
  mimeType?: string
  source?: string
}

function LcmFileIndicator(props: { metadata: LcmFileMetadata }) {
  const [expanded, setExpanded] = createSignal(false)
  const filename = createMemo(() => getFilename(props.metadata.filePath))
  const sizeLabel = createMemo(() =>
    props.metadata.sizeBytes != null ? formatBytes(props.metadata.sizeBytes) : undefined,
  )
  const tokenCount = createMemo(() =>
    props.metadata.tokenCount != null ? formatTokenCount(props.metadata.tokenCount) : undefined,
  )

  return (
    <div class="py-1">
      {/* Clickable one-liner */}
      <button
        class="flex items-center gap-2 text-sm w-full text-left rounded-md px-2 py-1.5 hover:bg-fill-element/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <span class="text-orange-500 font-bold text-base flex-shrink-0">&#x25CF;</span>
        <span class="text-text-strong">
          File loaded: <span class="font-medium">{filename() || "unknown"}</span>
          <Show when={sizeLabel()}>
            <span class="text-text-weak font-normal">, {sizeLabel()}</span>
          </Show>
        </span>
        <span class="ml-auto text-text-weaker text-xs flex-shrink-0">
          <svg
            class="w-3.5 h-3.5 transition-transform"
            classList={{ "rotate-90": expanded() }}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fill-rule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clip-rule="evenodd"
            />
          </svg>
        </span>
      </button>

      {/* Expanded details panel */}
      <Show when={expanded()}>
        <div class="ml-8 mt-1 mb-2 rounded-md bg-fill-element/30 border border-border text-xs overflow-hidden relative">
          {/* Close button */}
          <button
            class="absolute top-1.5 right-1.5 text-text-weaker hover:text-text-strong transition-colors cursor-pointer p-0.5"
            onClick={() => setExpanded(false)}
            aria-label="Close"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>

          <div class="px-3 py-2 space-y-1">
            <Show when={props.metadata.filePath}>
              <div class="text-text-weak">
                <span class="text-text-weaker">Path:</span> {props.metadata.filePath}
              </div>
            </Show>
            <Show when={sizeLabel()}>
              <div class="text-text-weak">
                <span class="text-text-weaker">Size:</span> {sizeLabel()}
                <Show when={tokenCount()}>
                  {" "}
                  <span class="text-text-weaker">({tokenCount()} tokens)</span>
                </Show>
              </div>
            </Show>
            <Show when={props.metadata.fileId}>
              <div class="text-text-weak">
                <span class="text-text-weaker">File ID:</span> {props.metadata.fileId}
              </div>
            </Show>
            <Show when={props.metadata.mimeType}>
              <div class="text-text-weak">
                <span class="text-text-weaker">Type:</span> {props.metadata.mimeType}
              </div>
            </Show>
            <Show when={props.metadata.explorerUsed}>
              <div class="text-text-weak">
                <span class="text-text-weaker">Explorer:</span> {props.metadata.explorerUsed}
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reasoning / Thinking Part
// ---------------------------------------------------------------------------

function ChatReasoningPart(props: { part: ReasoningPart; isCompleted: boolean }) {
  return (
    <Show when={!props.isCompleted}>
      <div class="flex items-center gap-2 py-2 text-sm text-text-weak">
        <span
          class="inline-block w-4 h-4 border-2 border-text-weak border-t-transparent rounded-full flex-shrink-0"
          style={{ animation: "spin 1s linear infinite" }}
        />
        <span>Thinking...</span>
      </div>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Tool Call Part
// ---------------------------------------------------------------------------

function ChatToolPart(props: { part: ToolPart }) {
  const [open, setOpen] = createSignal(false)

  const status = createMemo(() => props.part.state.status)
  const title = createMemo(() => {
    const state = props.part.state
    if ("title" in state && state.title) return state.title
    return toolDescription(props.part.tool, props.part.state.input ?? {})
  })

  const output = createMemo(() => {
    if (status() === "completed") {
      const state = props.part.state as { output?: string }
      return state.output ?? ""
    }
    if (status() === "error") {
      const state = props.part.state as { error?: string }
      return state.error ?? ""
    }
    return ""
  })

  const inputJson = createMemo(() => {
    const input = props.part.state.input
    if (!input || Object.keys(input).length === 0) return ""
    return JSON.stringify(input, null, 2)
  })

  const hasDetails = createMemo(() => !!(inputJson() || output()))

  return (
    <div class="py-1">
      <button
        class="flex items-center gap-2 text-sm w-full text-left rounded-md px-2 py-1.5 hover:bg-fill-element/50 transition-colors"
        classList={{ "cursor-pointer": hasDetails(), "cursor-default": !hasDetails() }}
        onClick={() => {
          if (hasDetails()) setOpen((v) => !v)
        }}
      >
        <ToolStatusIcon status={status()} />
        <span class="font-medium text-text-strong">{toolLabel(props.part.tool)}</span>
        <Show when={title()}>
          <span class="text-text-weak truncate">{title()}</span>
        </Show>
        <Show when={hasDetails()}>
          <span class="ml-auto text-text-weaker text-xs flex-shrink-0">
            <svg
              class="w-3.5 h-3.5 transition-transform"
              classList={{ "rotate-90": open() }}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clip-rule="evenodd"
              />
            </svg>
          </span>
        </Show>
      </button>

      <Show when={open() && hasDetails()}>
        <div class="ml-8 mt-1 mb-2 rounded-md bg-fill-element/30 border border-border text-xs overflow-hidden">
          <Show when={inputJson()}>
            <div class="px-3 py-2 border-b border-border">
              <div class="text-text-weaker uppercase tracking-wide text-[10px] mb-1">Input</div>
              <pre class="whitespace-pre-wrap break-words text-text-weak font-mono text-xs leading-relaxed">
                {inputJson()}
              </pre>
            </div>
          </Show>
          <Show when={output()}>
            <div class="px-3 py-2">
              <div class="text-text-weaker uppercase tracking-wide text-[10px] mb-1">
                {status() === "error" ? "Error" : "Output"}
              </div>
              <pre
                class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed max-h-60 overflow-y-auto"
                classList={{
                  "text-red-400": status() === "error",
                  "text-text-weak": status() !== "error",
                }}
              >
                {output()}
              </pre>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool Status Icon
// ---------------------------------------------------------------------------

function ToolStatusIcon(props: { status: string }) {
  return (
    <Switch>
      <Match when={props.status === "pending" || props.status === "running"}>
        <span
          class="inline-block w-4 h-4 border-2 border-text-weak border-t-transparent rounded-full flex-shrink-0"
          style={{ animation: "spin 1s linear infinite" }}
        />
      </Match>
      <Match when={props.status === "completed"}>
        <span class="text-green-500 font-bold flex-shrink-0">&#x2713;</span>
      </Match>
      <Match when={props.status === "error"}>
        <span class="text-red-500 font-bold flex-shrink-0">&#x2717;</span>
      </Match>
    </Switch>
  )
}
