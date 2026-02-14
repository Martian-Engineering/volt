import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup } from "solid-js"
import { useTaskTree, type TaskNode } from "@/context/task-tree"
import { useSync } from "@/context/sync"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import type { ToolPart } from "@opencode-ai/sdk/v2/client"

interface ChatTaskTreeProps {
  onClose: () => void
}

// Tree drawing characters matching the TUI implementation
const TREE_CHARS = {
  vertical: "\u2502", // │
  branch: "\u251C", // ├
  lastBranch: "\u2514", // └
  horizontal: "\u2500", // ─
}

/**
 * Generate tree prefix string for a node.
 * isLastAtLevel[i] indicates if the ancestor at depth i was the last child.
 * Produces prefixes like "│   ├── " or "    └── ".
 */
function getTreePrefix(isLastAtLevel: boolean[]): string {
  if (isLastAtLevel.length === 0) return ""

  const ancestorPrefixes = isLastAtLevel
    .slice(0, -1)
    .map((wasLast) => (wasLast ? "\u00A0\u00A0\u00A0\u00A0" : TREE_CHARS.vertical + "\u00A0\u00A0\u00A0"))

  const isLast = isLastAtLevel[isLastAtLevel.length - 1]
  const currentPrefix = isLast
    ? TREE_CHARS.lastBranch + TREE_CHARS.horizontal + TREE_CHARS.horizontal + "\u00A0"
    : TREE_CHARS.branch + TREE_CHARS.horizontal + TREE_CHARS.horizontal + "\u00A0"

  return ancestorPrefixes.join("") + currentPrefix
}

interface FlattenedNode {
  node: TaskNode
  prefix: string
  depth: number
  isLast: boolean
}

/**
 * Flatten the tree into a list with pre-computed tree prefixes.
 */
function flattenTreeWithPrefixes(root: TaskNode): FlattenedNode[] {
  const result: FlattenedNode[] = []

  function traverse(node: TaskNode, isLastAtLevel: boolean[], depth: number) {
    result.push({
      node,
      prefix: getTreePrefix(isLastAtLevel),
      depth,
      isLast: isLastAtLevel.length > 0 ? isLastAtLevel[isLastAtLevel.length - 1] : true,
    })

    const children = node.children
    children.forEach((child, index) => {
      const isLast = index === children.length - 1
      traverse(child, [...isLastAtLevel, isLast], depth + 1)
    })
  }

  // Start traversal from root's children (root is the parent session, not shown)
  for (let i = 0; i < root.children.length; i++) {
    const isLast = i === root.children.length - 1
    traverse(root.children[i], [isLast], 1)
  }

  return result
}

function formatDuration(startTime: number, endTime?: number): string {
  const now = endTime ?? Date.now()
  const elapsed = Math.max(0, now - startTime)
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function StatusDot(props: { status: "running" | "completed" | "failed" }) {
  return (
    <span
      class="inline-block w-2 h-2 rounded-full flex-shrink-0"
      classList={{
        "bg-amber-400": props.status === "running",
        "animate-pulse": props.status === "running",
        "bg-green-500": props.status === "completed",
        "bg-red-500": props.status === "failed",
      }}
    />
  )
}

function ToolStatusIcon(props: { status: string }) {
  return (
    <span
      class="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
      classList={{
        "bg-amber-400": props.status === "running" || props.status === "pending",
        "bg-green-500": props.status === "completed",
        "bg-red-500": props.status === "error",
      }}
    />
  )
}

function toolDuration(state: ToolPart["state"]): string {
  if (state.status === "pending") return ""
  if (state.status === "running") return formatDuration(state.time.start)
  return formatDuration(state.time.start, state.time.end)
}

function toolTitle(part: ToolPart): string {
  if (part.state.status === "completed") return part.state.title
  if (part.state.status === "running") return part.state.title ?? part.tool
  if (part.state.status === "error") return part.state.error
  return part.tool
}

export function ChatTaskTree(props: ChatTaskTreeProps) {
  const taskTree = useTaskTree()
  const sync = useSync()
  const [selectedNodeID, setSelectedNodeID] = createSignal<string | null>(null)
  const [selectedToolIdx, setSelectedToolIdx] = createSignal<number | null>(null)
  const [expandedTools, setExpandedTools] = createSignal<Set<string>>(new Set())
  const [focusSection, setFocusSection] = createSignal<"tree" | "tools">("tree")
  const [treeIndex, setTreeIndex] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  // Tick every second for duration updates
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => setNow(Date.now()), 1000)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  // Flatten tree for keyboard navigation with pre-computed prefixes
  const flatNodes = createMemo((): FlattenedNode[] => {
    const tree = taskTree.data.tree
    if (!tree) return []
    return flattenTreeWithPrefixes(tree)
  })

  // Auto-select first node if nothing selected
  createEffect(() => {
    const nodes = flatNodes()
    if (nodes.length > 0 && !selectedNodeID()) {
      setSelectedNodeID(nodes[0].node.sessionID)
    }
  })

  const selectedNode = createMemo(() => {
    const id = selectedNodeID()
    if (!id) return null
    return taskTree.findNode(id) ?? null
  })

  // Get tool parts for the selected node
  const selectedToolParts = createMemo((): ToolPart[] => {
    const node = selectedNode()
    if (!node) return []
    const messages = sync.data.message[node.sessionID] ?? []
    const parts: ToolPart[] = []
    for (const msg of messages) {
      if (msg.role !== "assistant") continue
      const msgParts = sync.data.part[msg.id] ?? []
      for (const p of msgParts) {
        if (p.type === "tool") parts.push(p)
      }
    }
    return parts
  })

  const handleKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return
    const nodes = flatNodes()
    if (e.key === "Escape") {
      e.preventDefault()
      props.onClose()
      return
    }
    if (e.key === "Tab") {
      e.preventDefault()
      setFocusSection((s) => (s === "tree" ? "tools" : "tree"))
      return
    }

    if (focusSection() === "tree") {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault()
        const nextIdx = Math.min(treeIndex() + 1, nodes.length - 1)
        setTreeIndex(nextIdx)
        if (nodes[nextIdx]) {
          setSelectedNodeID(nodes[nextIdx].node.sessionID)
          setSelectedToolIdx(null)
        }
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault()
        const nextIdx = Math.max(treeIndex() - 1, 0)
        setTreeIndex(nextIdx)
        if (nodes[nextIdx]) {
          setSelectedNodeID(nodes[nextIdx].node.sessionID)
          setSelectedToolIdx(null)
        }
      }
      if (e.key === "Enter") {
        e.preventDefault()
        setFocusSection("tools")
        setSelectedToolIdx(0)
      }
    }

    if (focusSection() === "tools") {
      const tools = selectedToolParts()
      const idx = selectedToolIdx()
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault()
        const next = idx === null ? 0 : Math.min(idx + 1, tools.length - 1)
        setSelectedToolIdx(next)
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault()
        const next = idx === null ? 0 : Math.max(idx - 1, 0)
        setSelectedToolIdx(next)
      }
      if (e.key === "Enter" && idx !== null && tools[idx]) {
        e.preventDefault()
        toggleToolExpanded(tools[idx].id)
      }
    }
  }

  const toggleToolExpanded = (toolID: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(toolID)) {
        next.delete(toolID)
      } else {
        next.add(toolID)
      }
      return next
    })
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
  })

  return (
    <div class="w-[420px] flex-shrink-0 border-l border-border bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div class="flex items-center gap-3">
          <Icon name="brain" size="normal" />
          <span class="font-semibold text-text-strong">Tasks</span>
          <span class="text-sm text-text-weak">
            {taskTree.data.totalCount - 1} task{taskTree.data.totalCount - 1 !== 1 ? "s" : ""}
            <Show when={taskTree.data.activeCount > 0}>, {taskTree.data.activeCount} active</Show>
          </span>
        </div>
        <IconButton icon="close" onClick={props.onClose} variant="ghost" />
      </div>

      {/* Main content split into tree + tools */}
      <div class="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Tree section */}
        <div
          class="flex-1 overflow-y-auto border-b border-border min-h-0"
          classList={{ "bg-surface": focusSection() === "tree" }}
        >
          <div class="py-2">
            <Show
              when={flatNodes().length > 0}
              fallback={<div class="px-4 py-8 text-center text-text-weak">No tasks</div>}
            >
              <For each={flatNodes()}>
                {(item, idx) => (
                  <FlatTreeNodeRow
                    node={item.node}
                    prefix={item.prefix}
                    depth={item.depth}
                    isSelected={selectedNodeID() === item.node.sessionID}
                    now={now()}
                    onSelect={() => {
                      setSelectedNodeID(item.node.sessionID)
                      setSelectedToolIdx(null)
                      setTreeIndex(idx())
                    }}
                  />
                )}
              </For>
            </Show>
          </div>
        </div>

        {/* Tool calls section */}
        <div class="flex-1 overflow-y-auto min-h-0" classList={{ "bg-surface": focusSection() === "tools" }}>
          <Show
            when={selectedNode()}
            fallback={
              <div class="px-4 py-8 text-center text-text-weak text-sm">Select a task to view its tool calls</div>
            }
          >
            <div class="px-4 py-2 border-b border-border flex-shrink-0">
              <div class="flex items-center gap-2">
                <StatusDot status={selectedNode()!.status} />
                <span class="text-sm font-medium text-text-strong truncate">{selectedNode()!.title || "Untitled"}</span>
                <span class="text-xs text-text-weak ml-auto font-mono">[{selectedNode()!.toolCallCount}]</span>
              </div>
            </div>
            <div class="py-1">
              <For each={selectedToolParts()}>
                {(tool, idx) => (
                  <ToolCallRow
                    tool={tool}
                    isSelected={selectedToolIdx() === idx()}
                    isExpanded={expandedTools().has(tool.id)}
                    now={now()}
                    onClick={() => {
                      setFocusSection("tools")
                      setSelectedToolIdx(idx())
                    }}
                    onToggleExpand={() => toggleToolExpanded(tool.id)}
                  />
                )}
              </For>
              <Show when={selectedToolParts().length === 0}>
                <div class="px-4 py-4 text-center text-text-weak text-sm">No tool calls yet</div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* Footer hints */}
      <div class="px-4 py-2 border-t border-border flex-shrink-0">
        <div class="flex items-center gap-4 text-xs text-text-weak">
          <span>
            <kbd class="px-1 py-0.5 bg-surface-hover rounded text-[10px]">j/k</kbd> navigate
          </span>
          <span>
            <kbd class="px-1 py-0.5 bg-surface-hover rounded text-[10px]">Tab</kbd> switch section
          </span>
          <span>
            <kbd class="px-1 py-0.5 bg-surface-hover rounded text-[10px]">Enter</kbd> expand
          </span>
          <span>
            <kbd class="px-1 py-0.5 bg-surface-hover rounded text-[10px]">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}

function FlatTreeNodeRow(props: {
  node: TaskNode
  prefix: string
  depth: number
  isSelected: boolean
  now: number
  onSelect: () => void
}) {
  const duration = () =>
    formatDuration(props.node.startTime, props.node.status === "running" ? props.now : props.node.endTime)

  const toolDesc = () => {
    if (props.node.status === "completed") return "(completed)"
    if (!props.node.currentTool) return props.node.status === "running" ? "(working...)" : ""
    const desc = props.node.currentTool.description
    if (desc.length > 28) return desc.slice(0, 25) + "..."
    return desc
  }

  const title = () => {
    const t = props.node.title || "Untitled"
    if (t.length > 36) return t.slice(0, 33) + "..."
    return t
  }

  return (
    <button
      onClick={props.onSelect}
      class="w-full text-left px-3 py-1.5 flex items-center gap-1.5 group"
      classList={{
        "bg-surface-base-active": props.isSelected,
        "hover:bg-surface-base-hover": !props.isSelected,
      }}
    >
      {/* Tree prefix with connector lines */}
      <Show when={props.prefix}>
        <span class="text-text-weak text-xs select-none flex-shrink-0 font-mono whitespace-pre">{props.prefix}</span>
      </Show>

      <StatusDot status={props.node.status} />

      <span class="text-sm text-text truncate flex-1 min-w-0">{title()}</span>

      <span class="text-xs text-text-weak font-mono flex-shrink-0">[{props.node.toolCallCount}]</span>

      <span class="text-xs text-text-weak truncate max-w-[180px] flex-shrink-0 hidden sm:inline">{toolDesc()}</span>

      <span class="text-xs text-text-weak font-mono flex-shrink-0 tabular-nums w-16 text-right">{duration()}</span>
    </button>
  )
}

function ToolCallRow(props: {
  tool: ToolPart
  isSelected: boolean
  isExpanded: boolean
  now: number
  onClick: () => void
  onToggleExpand: () => void
}) {
  const duration = () => toolDuration(props.tool.state)
  const title = () => toolTitle(props.tool)

  return (
    <div>
      <button
        onClick={() => {
          props.onClick()
          props.onToggleExpand()
        }}
        class="w-full text-left px-4 py-1.5 flex items-center gap-2"
        classList={{
          "bg-surface-base-active": props.isSelected,
          "hover:bg-surface-base-hover": !props.isSelected,
        }}
      >
        <Icon
          name="chevron-right"
          size="small"
          class="transition-transform flex-shrink-0"
          classList={{ "rotate-90": props.isExpanded }}
        />
        <ToolStatusIcon status={props.tool.state.status} />
        <span class="text-xs font-medium text-text-strong flex-shrink-0">{props.tool.tool}</span>
        <span class="text-xs text-text-weak truncate flex-1 min-w-0">{title()}</span>
        <Show when={duration()}>
          <span class="text-xs text-text-weak font-mono flex-shrink-0 tabular-nums">{duration()}</span>
        </Show>
      </button>

      <Show when={props.isExpanded}>
        <ToolCallDetail tool={props.tool} />
      </Show>
    </div>
  )
}

function ToolCallDetail(props: { tool: ToolPart }) {
  const input = () => {
    const state = props.tool.state
    if ("input" in state && state.input) {
      try {
        return JSON.stringify(state.input, null, 2)
      } catch {
        return String(state.input)
      }
    }
    return ""
  }

  const output = () => {
    const state = props.tool.state
    if (state.status === "completed" && state.output) {
      const text = state.output
      if (text.length > 2000) return text.slice(0, 2000) + "\n... (truncated)"
      return text
    }
    if (state.status === "error") return state.error
    return ""
  }

  return (
    <div class="mx-4 mb-2 border border-border rounded-lg overflow-hidden text-xs">
      <Show when={input()}>
        <div class="border-b border-border">
          <div class="px-3 py-1.5 bg-surface text-text-weak font-medium">Input</div>
          <pre class="px-3 py-2 overflow-x-auto max-h-48 overflow-y-auto text-text font-mono whitespace-pre-wrap break-all">
            {input()}
          </pre>
        </div>
      </Show>
      <Show when={output()}>
        <div>
          <div class="px-3 py-1.5 bg-surface text-text-weak font-medium">Output</div>
          <pre class="px-3 py-2 overflow-x-auto max-h-48 overflow-y-auto text-text font-mono whitespace-pre-wrap break-all">
            {output()}
          </pre>
        </div>
      </Show>
      <Show when={!input() && !output()}>
        <div class="px-3 py-3 text-text-weak text-center">
          {props.tool.state.status === "pending" || props.tool.state.status === "running" ? "Running..." : "No data"}
        </div>
      </Show>
    </div>
  )
}
