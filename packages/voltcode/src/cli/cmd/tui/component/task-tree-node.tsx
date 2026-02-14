import { Show, type Component } from "solid-js"
import { useTheme } from "../context/theme"
import type { TaskNode } from "../context/task-tree"
import { STATUS_DOT, formatDuration, truncate, formatTokens } from "../util/tree-chars"
import { RGBA } from "@opentui/core"

// Fixed width for the tree column (prefix + dot + padding)
// This ensures all columns after the tree align perfectly regardless of nesting depth
export const TREE_COLUMN_WIDTH = 24

export interface TaskTreeNodeProps {
  node: TaskNode
  treePrefix: string
  depth: number
  maxDepth: number
  showDevInfo: boolean
  active?: boolean
  onMouseUp?: () => void
}

export const TaskTreeNode: Component<TaskTreeNodeProps> = (props) => {
  const { theme } = useTheme()

  const statusColor = () => {
    switch (props.node.status) {
      case "running":
        return theme.warning
      case "completed":
        return theme.success
      case "failed":
        return theme.error
    }
  }

  const duration = () => formatDuration(props.node.startTime, props.node.endTime)

  const prompt = () => truncate(props.node.title, 50)

  const toolCount = () => String(props.node.toolCallCount).padStart(3, " ")

  const toolDesc = () => {
    const tool = props.node.currentTool
    return tool ? truncate(tool.description, 30) : ""
  }

  const toolColor = () => {
    const tool = props.node.currentTool
    if (!tool) return theme.textMuted
    switch (tool.status) {
      case "running":
        return theme.warning
      case "completed":
        return theme.success
      case "failed":
        return theme.error
    }
  }

  const devInfo = () => {
    if (!props.showDevInfo || !props.node.tokens) return ""
    const t = props.node.tokens
    // Pad token values to fixed widths for alignment: used (5 chars), max (5 chars), percentage (3 chars)
    const used = formatTokens(t.used).padStart(5, " ")
    const max = formatTokens(t.max).padStart(5, " ")
    const pct = String(t.percentage).padStart(3, " ")
    return `${used}/${max} (${pct}%)`
  }

  // Padding after dot to align content columns across different depths
  // Use fixed tree column width for consistent alignment
  const treePrefixWidth = () => props.treePrefix.length + 1 // prefix + dot
  const postDotPadding = () => " ".repeat(Math.max(0, TREE_COLUMN_WIDTH - treePrefixWidth()))

  // Background color for selected row: dark gray vs transparent
  const bgColor = () => (props.active ? RGBA.fromInts(40, 40, 40, 255) : RGBA.fromInts(0, 0, 0, 0))

  return (
    <box flexDirection="row" gap={0} flexShrink={0} backgroundColor={bgColor()} onMouseUp={props.onMouseUp}>
      <text fg={theme.textMuted} wrapMode="none">
        {props.treePrefix}
      </text>
      <text fg={statusColor()} wrapMode="none">
        {STATUS_DOT}
      </text>
      <text wrapMode="none">{postDotPadding()}</text>
      <text fg={theme.textMuted} wrapMode="none">
        {duration().padStart(7, " ")}{" "}
      </text>
      <text fg={theme.text} wrapMode="none">
        {prompt().padEnd(50, " ")}
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        [{toolCount()}]{" "}
      </text>
      <text fg={toolColor()} wrapMode="none">
        {toolDesc().padEnd(30, " ")}
      </text>
      <Show when={props.showDevInfo && props.node.tokens}>
        <text fg={theme.accent} wrapMode="none">
          {devInfo()}
        </text>
      </Show>
    </box>
  )
}
