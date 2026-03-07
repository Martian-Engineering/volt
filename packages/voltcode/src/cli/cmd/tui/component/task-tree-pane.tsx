import { createMemo, createSignal, For, Match, Show, Switch, onMount, onCleanup } from "solid-js"
import path from "path"
import { useTaskTree, type TaskNode, type JobTree } from "../context/task-tree"
import { useTheme } from "../context/theme"
import { useKeybind } from "../context/keybind"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useSync } from "../context/sync"
import { TaskTreeNode, TREE_COLUMN_WIDTH } from "./task-tree-node"
import { getTreePrefix, truncate } from "../util/tree-chars"
import { RGBA } from "@opentui/core"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"

// Represents either a job root (tool call) or a child session node
interface FlattenedItem {
  type: "job-root" | "job-child"
  job: JobTree
  node?: TaskNode // Only set for job-child
  prefix: string
  depth: number
}

interface FlattenResult {
  items: FlattenedItem[]
  maxDepth: number
}

interface ToolCallInfo {
  name: string
  input: Record<string, unknown>
  status: "pending" | "running" | "completed" | "error"
  startTime?: number
  endTime?: number
  title?: string
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

interface ThinkingInfo {
  text: string
  isStreaming: boolean
  startTime?: number
}

// Flatten jobs into a list for display
function flattenJobs(jobs: JobTree[]): FlattenResult {
  if (jobs.length === 0) return { items: [], maxDepth: 0 }

  const items: FlattenedItem[] = []
  let maxDepth = 0

  function traverseNode(node: TaskNode, job: JobTree, isLastAtLevel: boolean[], depth: number) {
    maxDepth = Math.max(maxDepth, depth)
    items.push({
      type: "job-child",
      job,
      node,
      prefix: getTreePrefix(isLastAtLevel),
      depth,
    })

    const children = node.children
    children.forEach((child, index) => {
      const isLast = index === children.length - 1
      traverseNode(child, job, [...isLastAtLevel, isLast], depth + 1)
    })
  }

  jobs.forEach((job, jobIndex) => {
    // Add job root (depth 0)
    items.push({
      type: "job-root",
      job,
      prefix: "",
      depth: 0,
    })

    // Add children with tree prefixes
    job.children.forEach((child, childIndex) => {
      const isLast = childIndex === job.children.length - 1
      traverseNode(child, job, [isLast], 1)
    })
  })

  return { items, maxDepth }
}

// Format tool arguments, truncating if needed
function formatToolArgs(input: Record<string, unknown> | undefined, maxLen: number): string {
  if (!input) return ""
  const entries = Object.entries(input)
  if (entries.length === 0) return ""

  const perValueMax = Math.max(30, Math.floor(maxLen * 0.7))
  const parts: string[] = []
  for (const [key, value] of entries) {
    let valueStr: string
    if (typeof value === "string") {
      valueStr = value.length > perValueMax ? value.slice(0, perValueMax - 3) + "..." : value
    } else if (typeof value === "object") {
      valueStr = JSON.stringify(value)
      if (valueStr.length > perValueMax) valueStr = valueStr.slice(0, perValueMax - 3) + "..."
    } else {
      valueStr = String(value)
    }
    parts.push(`${key}=${valueStr}`)
  }

  const result = parts.join(", ")
  return result.length > maxLen ? result.slice(0, maxLen - 3) + "..." : result
}

// Format time ago
function formatTimeAgo(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  if (diff < 1000) return "<1s ago"
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return `${Math.floor(diff / 3600000)}h ago`
}

// Format duration for tool calls
function formatToolDuration(start: number, end?: number): string {
  if (!end) return "running"
  const diff = end - start
  if (diff < 1000) return `${diff}ms`
  if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`
  return `${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`
}

// Format timestamp as HH:MM:SS from unix ms
function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  return d.toTimeString().slice(0, 8)
}

// Format live duration with reactive tick dependency
function formatLiveDuration(start: number, end: number | undefined, _tick: number): string {
  const elapsed = (end ?? Date.now()) - start
  if (elapsed < 1000) return `${elapsed}ms`
  if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)}s`
  return `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`
}

const MAX_RESULT_LINES = 6
const MAX_ARG_LINES = 8

interface ArgEntry {
  key: string
  lines: string[]
  inline: boolean
}

// Wrap text into lines, splitting on newlines and hard-wrapping long lines
function wrapText(text: string, lineWidth: number, maxLines: number): string[] {
  if (!text) return []
  const rawLines = text.split("\n")
  const output: string[] = []
  let hitLimit = false

  for (const raw of rawLines) {
    if (output.length >= maxLines) {
      hitLimit = true
      break
    }
    if (raw.length <= lineWidth) {
      output.push(raw)
    } else {
      for (let pos = 0; pos < raw.length; pos += lineWidth) {
        if (output.length >= maxLines) {
          hitLimit = true
          break
        }
        output.push(raw.slice(pos, pos + lineWidth))
      }
    }
  }

  if (hitLimit) {
    output[output.length - 1] = `... (${rawLines.length} total lines)`
  }

  return output
}

// Format tool arguments as structured entries supporting multi-line values
function formatArgEntries(input: Record<string, unknown> | undefined, paneWidth: number): ArgEntry[] {
  if (!input) return []

  return Object.entries(input).map(([key, value]) => {
    let raw: string
    if (typeof value === "string") {
      raw = value
    } else if (typeof value === "object" && value !== null) {
      raw = JSON.stringify(value, null, 2)
    } else {
      raw = String(value ?? "")
    }

    // Width available for inline value (after "  key: " — 2 container pad + 2 for ": ")
    const inlineWidth = paneWidth - key.length - 4
    const hasNewlines = raw.includes("\n")
    const fitsInline = !hasNewlines && raw.length <= inlineWidth && inlineWidth > 20

    if (fitsInline) {
      return { key, lines: [raw], inline: true }
    }

    // Multi-line: value lines indented 4 chars total (2 container + 2 inner)
    const valueWidth = Math.max(20, paneWidth - 4)
    const lines = wrapText(raw, valueWidth, MAX_ARG_LINES)
    return { key, lines, inline: false }
  })
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

export interface TaskTreePaneProps {
  sessionID: string
  showDevInfo: boolean
}

// Component for rendering a job root (main-thread tool call)
function JobRootNode(props: { job: JobTree; active: boolean; onMouseUp?: () => void }) {
  const { theme } = useTheme()

  const statusColor = () => {
    switch (props.job.toolStatus) {
      case "running":
      case "pending":
        return theme.warning
      case "completed":
        return theme.success
      case "error":
        return theme.error
    }
  }

  const statusIcon = () => {
    switch (props.job.toolStatus) {
      case "running":
      case "pending":
        return "○"
      case "completed":
        return "●"
      case "error":
        return "✗"
    }
  }

  const duration = () => {
    if (!props.job.toolStartTime) return ""
    const end = props.job.toolEndTime ?? Date.now()
    const diff = end - props.job.toolStartTime
    if (diff < 1000) return `${diff}ms`
    if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`
    return `${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`
  }

  const title = () => truncate(props.job.toolTitle, 60)

  const childCount = () => props.job.children.length

  // Background color for selected row
  const bgColor = () => (props.active ? RGBA.fromInts(40, 40, 40, 255) : RGBA.fromInts(0, 0, 0, 0))

  return (
    <box flexDirection="row" gap={0} flexShrink={0} backgroundColor={bgColor()} onMouseUp={props.onMouseUp}>
      <text fg={statusColor()} wrapMode="none">
        {statusIcon()}{" "}
      </text>
      <text fg={theme.accent} wrapMode="none">
        {props.job.toolName.padEnd(TREE_COLUMN_WIDTH - 2, " ")}
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {duration().padStart(7, " ")}{" "}
      </text>
      <text fg={theme.text} wrapMode="none">
        {title().padEnd(50, " ")}
      </text>
      <Show when={childCount() > 0}>
        <text fg={theme.textMuted} wrapMode="none">
          [{childCount()} sub-tasks]
        </text>
      </Show>
    </box>
  )
}

// Tool call detail view (local component)
function ToolCallDetailView(props: { call: ToolCallInfo; tick: number; width: number }) {
  const { theme, syntax } = useTheme()

  const resultColor = () => {
    switch (props.call.status) {
      case "completed":
        return theme.success
      case "error":
        return theme.error
      default:
        return theme.warning
    }
  }

  const resultLines = () => {
    const lineWidth = Math.max(40, props.width - 2)
    const text = props.call.error ?? props.call.output
    if (!text) {
      return [props.call.status === "completed" ? "(completed)" : "(in progress...)"]
    }
    return wrapText(text, lineWidth, MAX_RESULT_LINES)
  }

  const argEntries = () => formatArgEntries(props.call.input, props.width)

  const duration = () => {
    if (!props.call.startTime) return "—"
    return formatLiveDuration(props.call.startTime, props.call.endTime, props.tick)
  }

  const isLive = () => props.call.startTime && !props.call.endTime

  const isEdit = () => props.call.name === "edit" && props.call.metadata?.diff !== undefined

  const editFilePath = () => props.call.input.filePath as string | undefined

  const ft = () => filetype(editFilePath())

  return (
    <box flexDirection="column">
      {/* Tool name + title */}
      <box>
        <text fg={theme.text}>
          <b>Tool: {props.call.name}</b>
          {props.call.title ? ` - ${props.call.title}` : ""}
        </text>
      </box>

      {/* Timestamps */}
      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>Start: {props.call.startTime ? formatTimestamp(props.call.startTime) : "—"}</text>
        <text fg={theme.textMuted}>End: {props.call.endTime ? formatTimestamp(props.call.endTime) : "—"}</text>
        <text fg={theme.textMuted}>
          Duration: {duration()}
          {isLive() ? " (live)" : ""}
        </text>
      </box>

      {/* Result */}
      <box flexDirection="column">
        <text fg={theme.textMuted}>Result:</text>
        <box flexDirection="column" paddingLeft={2}>
          <For each={resultLines()}>{(line) => <text fg={resultColor()}>{line}</text>}</For>
        </box>
      </box>

      <Switch>
        {/* Edit tool: show diff view */}
        <Match when={isEdit()}>
          <box flexDirection="column">
            <text fg={theme.textMuted}>File: {normalizePath(editFilePath())}</text>
            <box paddingTop={1}>
              <diff
                diff={props.call.metadata!.diff as string}
                view="unified"
                filetype={ft()}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="word"
                fg={theme.text}
                addedBg={theme.diffAddedBg}
                removedBg={theme.diffRemovedBg}
                contextBg={theme.diffContextBg}
                addedSignColor={theme.diffHighlightAdded}
                removedSignColor={theme.diffHighlightRemoved}
                lineNumberFg={theme.diffLineNumber}
                lineNumberBg={theme.diffContextBg}
                addedLineNumberBg={theme.diffAddedLineNumberBg}
                removedLineNumberBg={theme.diffRemovedLineNumberBg}
              />
            </box>
          </box>
        </Match>

        {/* Default: show raw arguments */}
        <Match when={argEntries().length > 0}>
          <box flexDirection="column">
            <text fg={theme.textMuted}>Arguments:</text>
            <For each={argEntries()}>
              {(entry) => (
                <Show
                  when={!entry.inline}
                  fallback={
                    <box paddingLeft={2}>
                      <text fg={theme.text}>
                        {entry.key}: {entry.lines[0]}
                      </text>
                    </box>
                  }
                >
                  <box flexDirection="column" paddingLeft={2}>
                    <text fg={theme.textMuted}>{entry.key}:</text>
                    <For each={entry.lines}>
                      {(line) => (
                        <box paddingLeft={2}>
                          <text fg={theme.text}>{line}</text>
                        </box>
                      )}
                    </For>
                  </box>
                </Show>
              )}
            </For>
          </box>
        </Match>
      </Switch>
    </box>
  )
}

function SelectedTaskDetails(props: {
  item: FlattenedItem | null
  sessionData: { prompt: string; toolCalls: ToolCallInfo[]; thinking: ThinkingInfo | null }
  recentToolCalls: ToolCallInfo[]
  focusSection: "tree" | "toolcalls"
  selectedToolIndex: number
  paneWidth: number
  isJobRoot: boolean
  thinking: ThinkingInfo | null
  onToolCallClick?: (index: number) => void
}) {
  const { theme } = useTheme()

  const titleLines = () => {
    const item = props.item
    if (!item) return ["No task selected"]
    // For job-root, show the tool title; for job-child, show the session title
    const title = item.type === "job-root" ? item.job.toolTitle : item.node!.title
    return wrapText(title, props.paneWidth, 2)
  }
  const promptLines = () => {
    if (!props.item) return []
    return wrapText(truncate(props.sessionData.prompt || "(loading...)", 200), props.paneWidth - 2, 4)
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexShrink={0}>
        <For each={titleLines()}>
          {(line) => (
            <text fg={props.item ? theme.text : theme.textMuted}>
              <b>{line}</b>
            </text>
          )}
        </For>
      </box>
      <Show when={!props.isJobRoot}>
        <text flexShrink={0} fg={theme.textMuted}>
          {props.item ? "Prompt:" : ""}
        </text>
        <box flexDirection="column" flexShrink={0} paddingLeft={2}>
          <For each={promptLines()}>{(line) => <text fg={theme.text}>{line}</text>}</For>
        </box>
      </Show>
      <text flexShrink={0} fg={props.focusSection === "toolcalls" ? theme.text : theme.textMuted}>
        <span style={{ fg: props.focusSection === "toolcalls" ? theme.accent : theme.textMuted }}>
          {props.focusSection === "toolcalls" ? "> " : "  "}
        </span>
        {props.item
          ? props.isJobRoot
            ? "Root Tool Call:"
            : `Tool Calls (${props.sessionData.toolCalls.length} total):`
          : ""}
      </text>
      <scrollbox paddingLeft={2} flexGrow={1}>
        <For each={props.recentToolCalls}>
          {(call, index) => {
            // For job-root, the single tool call is always "selected" visually
            const isSelected = () =>
              props.isJobRoot || (props.focusSection === "toolcalls" && index() === props.selectedToolIndex)
            const bgColor = () => (isSelected() ? RGBA.fromInts(40, 40, 40, 255) : RGBA.fromInts(0, 0, 0, 0))
            const statusColor = () => {
              switch (call.status) {
                case "running":
                case "pending":
                  return theme.warning
                case "completed":
                  return theme.success
                case "error":
                  return theme.error
              }
            }
            const statusIcon = () => {
              switch (call.status) {
                case "running":
                case "pending":
                  return "○"
                case "completed":
                  return "✓"
                case "error":
                  return "✗"
              }
            }
            const argsWidth = () => Math.max(20, props.paneWidth - 39)
            return (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={bgColor()}
                onMouseUp={() => props.onToolCallClick?.(index())}
              >
                <text fg={statusColor()}>{statusIcon()}</text>
                <text fg={theme.text}>{call.name.padEnd(12)}</text>
                <text fg={theme.textMuted}>{formatToolArgs(call.input, argsWidth()).padEnd(argsWidth() + 2)}</text>
                <text fg={theme.textMuted}>
                  {call.startTime ? formatTimeAgo(call.startTime).padEnd(8) : "".padEnd(8)}
                </text>
                <text fg={theme.textMuted}>
                  {call.startTime ? formatToolDuration(call.startTime, call.endTime) : ""}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={props.thinking}>
          {(thinking) => {
            const thinkingIndex = () => props.recentToolCalls.length
            const isSelected = () => props.focusSection === "toolcalls" && thinkingIndex() === props.selectedToolIndex
            const bgColor = () => (isSelected() ? RGBA.fromInts(40, 40, 40, 255) : RGBA.fromInts(0, 0, 0, 0))
            const label = () => {
              const preview = thinking().text.replace(/\n/g, " ").slice(0, Math.max(20, props.paneWidth - 30))
              return preview ? `${preview}${thinking().text.length > props.paneWidth - 30 ? "..." : ""}` : ""
            }
            return (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={bgColor()}
                onMouseUp={() => props.onToolCallClick?.(thinkingIndex())}
              >
                <text fg={thinking().isStreaming ? theme.warning : theme.textMuted}>
                  {thinking().isStreaming ? "◐" : "●"}
                </text>
                <text fg={theme.accent}>
                  <i>{"thinking".padEnd(12)}</i>
                </text>
                <text fg={theme.textMuted}>{label()}</text>
              </box>
            )
          }}
        </Show>
      </scrollbox>
    </box>
  )
}

// Thinking/reasoning detail view — shows tail of CoT, streams in live
function ThinkingDetailView(props: { thinking: ThinkingInfo; tick: number; width: number; height: number }) {
  const { theme } = useTheme()

  const lines = createMemo(() => {
    // Force reactivity on tick so we re-render while streaming
    void props.tick
    const text = props.thinking.text
    if (!text) return props.thinking.isStreaming ? ["(thinking...)"] : ["(no reasoning content)"]

    const lineWidth = Math.max(40, props.width - 2)
    // Wrap all text into lines
    const allLines = wrapText(text, lineWidth, 10000)
    // Show only what fits in the available height, biased toward the end
    const maxLines = Math.max(1, props.height - 3)
    if (allLines.length <= maxLines) return allLines
    return allLines.slice(-maxLines)
  })

  const duration = () => {
    if (!props.thinking.startTime) return ""
    return formatLiveDuration(props.thinking.startTime, props.thinking.isStreaming ? undefined : Date.now(), props.tick)
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={2}>
        <text fg={theme.accent}>
          <b>Thinking</b>
          {props.thinking.isStreaming ? " (streaming)" : ""}
        </text>
        <Show when={duration()}>
          <text fg={theme.textMuted}>{duration()}</text>
        </Show>
      </box>
      <box flexDirection="column" paddingTop={1}>
        <For each={lines()}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
      </box>
    </box>
  )
}

export function TaskTreePane(props: TaskTreePaneProps) {
  const { data } = useTaskTree()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const sync = useSync()

  const dimensions = useTerminalDimensions()
  // Usable width inside the pane (subtract paddingLeft + paddingRight)
  const paneWidth = createMemo(() => Math.max(40, dimensions().width - 4))

  // Fixed section heights so panes don't shift when selecting different tool calls
  const sectionHeights = createMemo(() => {
    const totalHeight = dimensions().height
    // Overhead: outer padding (2) + divider1 (3) + divider2 (3) + footer (2) = 10
    const overhead = 10
    const available = Math.max(9, totalHeight - overhead)
    const treeHeight = Math.max(3, Math.floor(available * 0.4))
    const toolCallsHeight = Math.max(3, Math.floor(available * 0.3))
    const detailHeight = Math.max(3, available - treeHeight - toolCallsHeight)
    return { treeHeight, toolCallsHeight, detailHeight }
  })

  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusSection, setFocusSection] = createSignal<"tree" | "toolcalls">("tree")
  const [selectedToolIndex, setSelectedToolIndex] = createSignal(-1)
  const [tick, setTick] = createSignal(0)
  let scrollRef: any

  // Tick timer for live duration updates
  const tickInterval = setInterval(() => setTick((t) => t + 1), 1000)
  onCleanup(() => clearInterval(tickInterval))

  const flattened = createMemo(() => {
    return flattenJobs(data.jobs)
  })

  const maxDepth = createMemo(() => flattened().maxDepth)

  // Get the selected item (could be job-root or job-child)
  const selectedItem = createMemo(() => {
    const items = flattened().items
    const idx = selectedIndex()
    return idx >= 0 && idx < items.length ? items[idx] : null
  })

  // Get whether the selected item is a job root
  const isJobRootSelected = createMemo(() => {
    const item = selectedItem()
    return item?.type === "job-root"
  })

  // Get messages and tool parts for selected session (only for job-child items)
  const selectedSessionData = createMemo(() => {
    const item = selectedItem()

    // For job-root, show only the root tool call
    if (!item || item.type === "job-root") {
      const job = item?.job
      if (!job) return { prompt: "", toolCalls: [] as ToolCallInfo[], thinking: null as ThinkingInfo | null }

      // For job root, return just the job's tool call info
      const toolCall: ToolCallInfo = {
        name: job.toolName,
        input: job.toolInput,
        status: job.toolStatus,
        startTime: job.toolStartTime,
        endTime: job.toolEndTime,
        title: job.toolTitle,
        output: job.toolOutput,
        metadata: {},
      }
      return { prompt: job.toolTitle, toolCalls: [toolCall], thinking: null as ThinkingInfo | null }
    }

    // For job-child, show the child session's tool calls
    const node = item.node!
    const sessionID = node.sessionID
    const messages = sync.data.message[sessionID] ?? []

    // Get the initial prompt from the first user message
    let prompt = ""
    for (const msg of messages) {
      if (msg.role === "user") {
        const parts = sync.data.part[msg.id] ?? []
        for (const part of parts) {
          if (part.type === "text") {
            prompt = part.text
            break
          }
        }
        break
      }
    }

    // Collect all tool calls and find reasoning parts from all assistant messages
    const toolCalls: ToolCallInfo[] = []
    let thinking: ThinkingInfo | null = null
    for (const msg of messages) {
      if (msg.role === "assistant") {
        const parts = sync.data.part[msg.id] ?? []
        for (const part of parts) {
          if (part.type === "tool") {
            const toolPart = part as ToolPart
            toolCalls.push({
              name: toolPart.tool,
              input: toolPart.state.input,
              status: toolPart.state.status as "pending" | "running" | "completed" | "error",
              startTime: toolPart.state.time?.start,
              endTime: toolPart.state.time?.end,
              title: toolPart.state.title,
              output: toolPart.state.output,
              error: toolPart.state.error,
              metadata: toolPart.state.metadata,
            })
          }
          if (part.type === "reasoning") {
            const rp = part as ReasoningPart
            thinking = {
              text: rp.text,
              isStreaming: !rp.time?.end,
              startTime: rp.time?.start,
            }
          }
        }
      }
    }

    return { prompt, toolCalls, thinking }
  })

  // Get last 10 tool calls, newest at bottom
  const recentToolCalls = createMemo(() => {
    const calls = selectedSessionData().toolCalls
    return calls.slice(-10)
  })

  // Derived memo for selected tool call
  const selectedToolCall = createMemo(() => {
    const item = selectedItem()

    // For job-root, auto-select the single tool call (index 0)
    if (item?.type === "job-root") {
      const calls = recentToolCalls()
      return calls.length > 0 ? calls[0] : null
    }

    // For job-child, use the selected index
    const idx = selectedToolIndex()
    const calls = recentToolCalls()
    return idx >= 0 && idx < calls.length ? calls[idx] : null
  })

  // Tree navigation — resets tool call selection and focus
  function move(direction: number) {
    const items = flattened().items
    if (items.length === 0) return

    let next = selectedIndex() + direction
    if (next < 0) next = 0
    if (next >= items.length) next = items.length - 1

    setSelectedIndex(next)
    setSelectedToolIndex(-1)
    setFocusSection("tree")

    // Scroll into view
    if (scrollRef) {
      const children = scrollRef.getChildren?.()
      if (children && children[next]) {
        const target = children[next]
        const y = target.y - scrollRef.y
        if (y >= scrollRef.height) {
          scrollRef.scrollBy(y - scrollRef.height + 1)
        }
        if (y < 0) {
          scrollRef.scrollBy(y)
        }
      }
    }
  }

  // Total selectable items in the tool call section (tool calls + optional thinking)
  const toolSectionCount = createMemo(() => {
    const count = recentToolCalls().length
    const thinking = selectedSessionData().thinking
    return thinking ? count + 1 : count
  })

  // Whether the selected tool index points to the thinking entry
  const isThinkingSelected = createMemo(() => {
    const thinking = selectedSessionData().thinking
    return thinking && selectedToolIndex() === recentToolCalls().length
  })

  // Tool call list navigation
  function moveToolCall(direction: number) {
    const total = toolSectionCount()
    if (total === 0) return

    let next = selectedToolIndex() + direction
    if (next < 0) next = 0
    if (next >= total) next = total - 1

    setSelectedToolIndex(next)
  }

  // Click to select a tree item
  function selectTreeItem(index: number) {
    setSelectedIndex(index)
    setSelectedToolIndex(-1)
    setFocusSection("tree")
  }

  // Click to select a tool call
  function selectToolCall(index: number) {
    setFocusSection("toolcalls")
    setSelectedToolIndex(index)
  }

  // Reset selection when tree changes
  onMount(() => {
    setSelectedIndex(0)
  })

  // Keyboard handling
  useKeyboard((evt) => {
    if (evt.name === "tab") {
      evt.preventDefault()
      if (focusSection() === "tree") {
        const total = toolSectionCount()
        if (total > 0) {
          setFocusSection("toolcalls")
          if (selectedToolIndex() < 0) setSelectedToolIndex(0)
        }
      } else {
        setFocusSection("tree")
      }
      return
    }

    if (evt.name === "escape") {
      if (focusSection() === "toolcalls") {
        evt.preventDefault()
        setFocusSection("tree")
        setSelectedToolIndex(-1)
      }
      // In tree mode: don't handle — let parent close pane
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      if (focusSection() === "tree") {
        move(-1)
      } else {
        moveToolCall(-1)
      }
    }

    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      if (focusSection() === "tree") {
        move(1)
      } else {
        moveToolCall(1)
      }
    }

    if (evt.name === "home") {
      evt.preventDefault()
      if (focusSection() === "tree") {
        setSelectedIndex(0)
      } else {
        setSelectedToolIndex(0)
      }
    }

    if (evt.name === "end") {
      evt.preventDefault()
      if (focusSection() === "tree") {
        const items = flattened().items
        if (items.length > 0) setSelectedIndex(items.length - 1)
      } else {
        const total = toolSectionCount()
        if (total > 0) setSelectedToolIndex(total - 1)
      }
    }
  })

  // Sync selected session data
  const syncSelectedSession = createMemo(() => {
    const item = selectedItem()
    if (item?.type === "job-child" && item.node) {
      sync.session.sync(item.node.sessionID)
    }
    return item
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
      <box flexDirection="column" flexGrow={1}>
        {/* Section 1: Tree */}
        <box flexDirection="column" height={sectionHeights().treeHeight}>
          {/* Tree header with focus indicator */}
          <box paddingBottom={1}>
            <text fg={theme.text}>
              <span style={{ fg: focusSection() === "tree" ? theme.accent : theme.textMuted }}>
                {focusSection() === "tree" ? "> " : "  "}
              </span>
              <b>Jobs</b>
              <span style={{ fg: theme.textMuted }}>
                {" "}
                - {data.jobs.length} jobs, {data.totalCount} sub-tasks
                <Show when={data.activeCount > 0}> ({data.activeCount} active)</Show>
              </span>
            </text>
          </box>
          <scrollbox ref={(r) => (scrollRef = r)} flexGrow={1}>
            <For each={flattened().items}>
              {(item, index) => (
                <Switch>
                  <Match when={item.type === "job-root"}>
                    <JobRootNode
                      job={item.job}
                      active={index() === selectedIndex()}
                      onMouseUp={() => selectTreeItem(index())}
                    />
                  </Match>
                  <Match when={item.type === "job-child" && item.node}>
                    <TaskTreeNode
                      node={item.node!}
                      treePrefix={item.prefix}
                      depth={item.depth}
                      maxDepth={maxDepth()}
                      showDevInfo={props.showDevInfo}
                      active={index() === selectedIndex()}
                      onMouseUp={() => selectTreeItem(index())}
                    />
                  </Match>
                </Switch>
              )}
            </For>
          </scrollbox>
        </box>

        {/* Divider */}
        <box paddingTop={1} paddingBottom={1}>
          <text fg={theme.textMuted}>{"─".repeat(paneWidth())}</text>
        </box>

        {/* Section 2: Selected task details + Tool calls list */}
        <box flexDirection="column" height={sectionHeights().toolCallsHeight}>
          <SelectedTaskDetails
            item={selectedItem()}
            sessionData={selectedSessionData()}
            recentToolCalls={recentToolCalls()}
            focusSection={focusSection()}
            selectedToolIndex={selectedToolIndex()}
            paneWidth={paneWidth()}
            isJobRoot={isJobRootSelected()}
            thinking={selectedSessionData().thinking}
            onToolCallClick={selectToolCall}
          />
        </box>

        {/* Section 3: Tool call detail view */}
        <box paddingTop={1} paddingBottom={1}>
          <text fg={theme.textMuted}>{"─".repeat(paneWidth())}</text>
        </box>
        <scrollbox height={sectionHeights().detailHeight}>
          <Show
            when={isThinkingSelected() && selectedSessionData().thinking}
            fallback={
              <Show
                when={selectedToolCall()}
                fallback={<text fg={theme.textMuted}>Select a job or tool call to view details</text>}
              >
                <ToolCallDetailView call={selectedToolCall()!} tick={tick()} width={paneWidth()} />
              </Show>
            }
          >
            <ThinkingDetailView
              thinking={selectedSessionData().thinking!}
              tick={tick()}
              width={paneWidth()}
              height={sectionHeights().detailHeight}
            />
          </Show>
        </scrollbox>
      </box>

      {/* Footer */}
      <box paddingTop={1}>
        <text fg={theme.textMuted}>
          {keybind.print("tasktree_open")} or esc
          <span style={{ fg: theme.text }}> exit</span>
          <span style={{ fg: theme.textMuted }}> | ↑/↓ or j/k</span>
          <span style={{ fg: theme.text }}> navigate</span>
          <span style={{ fg: theme.textMuted }}> | tab</span>
          <span style={{ fg: theme.text }}> switch section</span>
        </text>
      </box>
    </box>
  )
}

// Type definitions for tool parts
interface ToolPart {
  type: "tool"
  tool: string
  state: {
    status: string
    input: Record<string, unknown>
    title?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    time?: { start: number; end?: number }
  }
}

interface ReasoningPart {
  type: "reasoning"
  text: string
  time?: { start: number; end?: number }
}
