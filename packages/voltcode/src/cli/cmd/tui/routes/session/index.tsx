import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  on,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  MacOSScrollAccel,
  type ScrollAcceleration,
  TextAttributes,
  RGBA,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type { AssistantMessage, Part, ToolPart, UserMessage, TextPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { ListTool } from "@/tool/ls"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { TaskTool } from "@/tool/task"
import type { TasksTool } from "@/tool/tasks"
import type { QuestionTool } from "@/tool/question"
import type { LcmExpandTool } from "@/tool/lcm-expand"
import type { LcmGrepTool } from "@/tool/lcm-grep"
import type { LcmReadTool } from "@/tool/lcm-read"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { Header } from "./header"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Editor } from "../../util/editor"
import stripAnsi from "strip-ansi"
import { Footer } from "./footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { TaskTreeProvider, useTaskTree } from "../../context/task-tree"
import { TaskTreePane } from "../../component/task-tree-pane"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { useArgs } from "../../context/args"
import "opentui-spinner/solid"

addDefaultParsers(parsers.parsers)

const LCM_INTERNAL_TOOLS = ["lcm_expand", "lcm_expand_query", "lcm_grep", "lcm_read"]

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  diffWrapMode: () => "word" | "none"
  devMode: () => boolean
  sync: ReturnType<typeof useSync>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

// Component to handle automatic task tree visibility switching
function TaskTreeAutoSwitch(props: {
  setTaskTreeVisible: (visible: boolean | ((prev: boolean) => boolean)) => void
  isRootSession: boolean
}) {
  const { data } = useTaskTree()

  // Track previous values to detect transitions
  let prevTotalCount = 1
  let prevActiveCount = 0
  let autoOpened = false

  createEffect(() => {
    if (!props.isRootSession) return

    const totalCount = data.totalCount
    const activeCount = data.activeCount

    // Auto-show: when child tasks are first created (total goes from 1 to >1)
    if (prevTotalCount <= 1 && totalCount > 1) {
      props.setTaskTreeVisible(true)
      autoOpened = true
    }

    // Auto-hide: when all child tasks complete (active goes to 0, and we auto-opened)
    // Only auto-hide if there were child tasks (total > 1) and now none are active
    if (autoOpened && prevActiveCount > 0 && activeCount === 0 && totalCount > 1) {
      props.setTaskTreeVisible(false)
      autoOpened = false
    }

    prevTotalCount = totalCount
    prevActiveCount = activeCount
  })

  return null
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const args = useArgs()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  // Context token override for immediate update after /compact
  const [contextOverride, setContextOverride] = createSignal<{ tokens: number; maxTokens: number } | null>(null)
  // Clear override when a new assistant message arrives (message-based calc becomes current)
  createEffect(
    on(lastAssistant, () => {
      setContextOverride(null)
    }),
  )

  // Compute incomplete todos for warning display
  const incompleteTodos = createMemo(() => {
    const todos = sync.data.todo[route.sessionID] ?? []
    return todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", true)
  const [diffWrapMode, setDiffWrapMode] = createSignal<"word" | "none">("word")
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [taskTreeVisible, setTaskTreeVisible] = createSignal(false)
  const [atBottom, setAtBottom] = createSignal(true)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) {
      return new MacOSScrollAccel()
    }
    if (tui?.scroll_speed) {
      return new CustomSpeedScroll(tui.scroll_speed)
    }

    return new CustomSpeedScroll(3)
  })

  createEffect(async () => {
    await sync.session
      .sync(route.sessionID)
      .then(() => {
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch((e) => {
        console.error(e)
        toast.show({
          message: `Session not found: ${route.sessionID}`,
          variant: "error",
        })
        return navigate({ type: "home" })
      })
  })

  const toast = useToast()
  const sdk = useSDK()

  // Handle initial prompt from fork
  createEffect(() => {
    if (route.initialPrompt && prompt) {
      prompt.set(route.initialPrompt)
    }
  })

  let lastSwitch: string | undefined = undefined
  sdk.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  const keybind = useKeybind()

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()
  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  // Find root session (the one without a parentID)
  const rootSessionID = createMemo(() => {
    let current = session()
    while (current?.parentID) {
      current = sync.session.get(current.parentID)
    }
    return current?.id
  })

  // Handle escape to exit task tree view or return to root session
  useKeyboard((evt) => {
    if (evt.name !== "escape") return

    // First priority: close task tree if open
    if (taskTreeVisible()) {
      evt.preventDefault()
      evt.stopPropagation()
      setTaskTreeVisible(false)
      return
    }

    // Second priority: return to root session if in a child session
    const root = rootSessionID()
    if (session()?.parentID && root) {
      evt.preventDefault()
      evt.stopPropagation()
      navigate({ type: "session", sessionID: root })
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setAtBottom(true) // Immediately hide the button
    setTimeout(() => {
      if (scroll) scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  // Check if scrolled to bottom and update state
  function updateAtBottom() {
    if (!scroll) {
      setAtBottom(true)
      return
    }
    const scrollTop = (scroll as any).scrollTop ?? 0
    const contentHeight = scroll.scrollHeight
    const viewportHeight = scroll.height
    // At bottom if content fits in viewport, or scrolled to within 10px of bottom
    const isAtBottom = contentHeight <= viewportHeight || scrollTop + viewportHeight >= contentHeight - 10
    setAtBottom(isAtBottom)
  }

  // Update atBottom when messages change (content size changes)
  createEffect(
    on(messages, () => {
      // Delay to let layout settle
      setTimeout(updateAtBottom, 100)
    }),
  )

  // Periodically check scroll position (for mouse wheel scrolling)
  onMount(() => {
    const interval = setInterval(updateAtBottom, 300)
    onCleanup(() => clearInterval(interval))
  })

  const local = useLocal()

  function moveChild(direction: number) {
    if (children().length === 1) return
    let next = children().findIndex((x) => x.id === session()?.id) + direction
    if (next >= children().length) next = 0
    if (next < 0) next = children().length - 1
    if (children()[next]) {
      navigate({
        type: "session",
        sessionID: children()[next].id,
      })
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: "Share session",
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled" && !session()?.share?.url,
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) =>
            Clipboard.copy(res.data!.share!.url).catch(() =>
              toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }),
            ),
          )
          .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to share session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork from message",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to unshare session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt.set({ input: "", parts: [] })
          return
        }
        sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: taskTreeVisible() ? "Close task tree" : "View task tree",
      value: "session.tasktree.toggle",
      keybind: "tasktree_open",
      category: "Session",
      slash: {
        name: "tasks",
        aliases: ["task-tree", "tree"],
      },
      onSelect: (dialog) => {
        setTaskTreeVisible((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: "Initialize repo for training",
      value: "repo.init",
      category: "Repo",
      slash: {
        name: "init",
      },
      enabled: true,
      onSelect: async (dialog) => {
        const { Volt01 } = await import("@/volt01/backend")
        if (!(await Volt01.isConfigured())) {
          toast.show({
            message: "Volt01 backend not configured. Add provider.br.options.baseURL to voltcode.json",
            variant: "error",
          })
          dialog.clear()
          return
        }
        try {
          const cached = await Volt01.getCachedInitState()
          if (cached?.state === "ready") {
            toast.show({
              message: "Repo is already initialized and ready",
              variant: "info",
            })
            dialog.clear()
            return
          }
          const initResponse = await Volt01.initRepo()
          toast.show({
            message: "Initiating repo training...",
            variant: "info",
          })
          await Volt01.mirrorPush(initResponse.git_remote)
          toast.show({
            message: "Mirror push completed. Training will start shortly.",
            variant: "success",
          })
        } catch (error) {
          toast.show({
            message: `Init failed: ${error instanceof Error ? error.message : String(error)}`,
            variant: "error",
          })
        }
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle diff wrapping",
      value: "session.toggle.diffwrap",
      category: "Session",
      slash: {
        name: "diffwrap",
      },
      onSelect: (dialog) => {
        setDiffWrapMode((prev) => (prev === "word" ? "none" : "word"))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: animationsEnabled() ? "Disable animations" : "Enable animations",
      value: "session.toggle.animations",
      category: "Session",
      onSelect: (dialog) => {
        setAnimationsEnabled((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        updateAtBottom()
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        updateAtBottom()
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        updateAtBottom()
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        updateAtBottom()
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        updateAtBottom()
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        updateAtBottom()
        dialog.clear()
      },
    },
    {
      title: "Check LCM context integrity",
      value: "session.lcm.check_integrity",
      category: "Debug",
      hidden: true,
      slash: {
        name: "check-integrity",
        aliases: ["integrity"],
      },
      onSelect: async (dialog) => {
        dialog.clear()
        toast.show({ message: "Running integrity check...", variant: "info", duration: 2000 })
        try {
          const res = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/lcm/check-integrity`)
          const body = await res.text()
          if (!res.ok) {
            const outPath = path.join(Global.Path.log, "integrity-check.json")
            await Bun.write(outPath, body)
            toast.show({ message: `Integrity check failed (${res.status}): ${outPath}`, variant: "error" })
            return
          }
          const report = JSON.parse(body) as {
            healthy: boolean
            issues: { severity: string; check: string; message: string }[]
            stats: Record<string, number>
          }
          const outPath = path.join(Global.Path.log, "integrity-check.json")
          await Bun.write(outPath, JSON.stringify(report, null, 2))
          const errorCount = report.issues.filter((i) => i.severity === "error").length
          const warnCount = report.issues.filter((i) => i.severity === "warning").length
          const s = report.stats
          const statsLine = `ctx=${s.contextItems} msgs=${s.messages} sums=${s.summaries} tokens=${s.contextTokens}/${s.maxTokens}`
          const variant = !report.healthy ? "error" : warnCount > 0 ? "warning" : "success"
          const status = !report.healthy
            ? `Unhealthy: ${errorCount} error(s), ${warnCount} warning(s)`
            : warnCount > 0
              ? `Healthy with ${warnCount} warning(s)`
              : "Healthy"
          toast.show({ message: `${status} (${statsLine}) → ${outPath}`, variant })
        } catch (e) {
          toast.show({
            message: `Integrity check error: ${e instanceof Error ? e.message : String(e)}`,
            variant: "error",
          })
        }
      },
    },
    {
      title: "Compact session",
      value: "session.lcm.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["compaction", "summarize"],
      },
      onSelect: async (dialog) => {
        dialog.clear()
        toast.show({ message: "Running LCM compaction...", variant: "info", duration: 5000 })
        try {
          const res = await sdk.fetch(`${sdk.url}/session/${route.sessionID}/lcm/compact`, { method: "POST" })
          const body = await res.text()
          const outPath = path.join(Global.Path.log, "compact-result.json")
          await Bun.write(outPath, body)
          if (!res.ok) {
            toast.show({ message: `Compaction failed (${res.status}): ${outPath}`, variant: "error" })
            return
          }
          const result = JSON.parse(body) as {
            strategy?: string
            status?: "executed" | "no_op"
            mode?: string
            executed?: boolean
            actionTaken: boolean
            condensed: boolean
            beforeTokenCount?: number
            newTokenCount?: number
            maxTokens?: number
            messagesSummarized?: number
            noOpReasons?: string[]
          }
          const strategy = result.strategy ?? "unknown"
          const status = result.status ?? (result.actionTaken ? "executed" : "no_op")
          const actionTaken = result.executed ?? result.actionTaken
          if (!actionTaken) {
            const noOpDetail =
              result.noOpReasons && result.noOpReasons.length > 0 ? ` reasons=${result.noOpReasons.join(",")}` : ""
            toast.show({
              message: `LCM compact [strategy=${strategy} status=${status}] no-op (${result.beforeTokenCount ?? "?"}/${result.maxTokens ?? "?"} tokens)${noOpDetail} → ${outPath}`,
              variant: "info",
            })
          } else {
            const before = result.beforeTokenCount ?? "?"
            const after = result.newTokenCount ?? "?"
            const msgs = result.messagesSummarized ?? "?"
            toast.show({
              message: `LCM compact [strategy=${strategy} status=${status}] ${before}→${after} tokens, ${msgs} msgs summarized${result.condensed ? " +condensed" : ""} → ${outPath}`,
              variant: "success",
            })
            if (result.newTokenCount != null && result.maxTokens != null) {
              setContextOverride({ tokens: result.newTokenCount, maxTokens: result.maxTokens })
            }
          }
        } catch (e) {
          toast.show({
            message: `Compaction error: ${e instanceof Error ? e.message : String(e)}`,
            variant: "error",
          })
        }
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch (error) {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch (error) {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => {
    const diffText = revertInfo()?.diff ?? ""
    if (!diffText) return []

    try {
      const patches = parsePatch(diffText)
      return patches.map((patch) => {
        const filename = patch.newFileName || patch.oldFileName || "unknown"
        const cleanFilename = filename.replace(/^[ab]\//, "")
        return {
          filename: cleanFilename,
          additions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
            0,
          ),
          deletions: patch.hunks.reduce(
            (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
            0,
          ),
        }
      })
    } catch (error) {
      return []
    }
  })

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  const dialog = useDialog()
  const renderer = useRenderer()

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <TaskTreeProvider sessionID={route.sessionID}>
      <TaskTreeAutoSwitch setTaskTreeVisible={setTaskTreeVisible} isRootSession={!session()?.parentID} />
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          showThinking,
          showTimestamps,
          showDetails,
          diffWrapMode,
          devMode: () => args.dev ?? false,
          sync,
        }}
      >
        <Switch>
          <Match when={taskTreeVisible() && !session()?.parentID}>
            <box flexDirection="column" flexGrow={1}>
              <TaskTreePane sessionID={route.sessionID} showDevInfo={args.dev ?? false} />
              <box flexShrink={0}>
                <Show when={permissions().length > 0}>
                  <PermissionPrompt request={permissions()[0]} />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt request={questions()[0]} />
                </Show>
              </box>
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection="row">
              <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
                <Show when={session()}>
                  <Show when={!sidebarVisible() || !wide()}>
                    <Header />
                  </Show>
                  <box position="relative" flexGrow={1}>
                    <scrollbox
                      ref={(r) => {
                        scroll = r
                        // Initial check after scrollbox mounts
                        setTimeout(updateAtBottom, 200)
                      }}
                      viewportOptions={{
                        paddingRight: showScrollbar() ? 1 : 0,
                      }}
                      verticalScrollbarOptions={{
                        paddingLeft: 1,
                        visible: showScrollbar(),
                        trackOptions: {
                          backgroundColor: theme.backgroundElement,
                          foregroundColor: theme.border,
                        },
                      }}
                      stickyScroll={true}
                      stickyStart="bottom"
                      flexGrow={1}
                      scrollAcceleration={scrollAcceleration()}
                    >
                      <For each={messages()}>
                        {(message, index) => (
                          <Switch>
                            <Match when={message.id === revert()?.messageID}>
                              {(function () {
                                const command = useCommandDialog()
                                const [hover, setHover] = createSignal(false)
                                const dialog = useDialog()

                                const handleUnrevert = async () => {
                                  const confirmed = await DialogConfirm.show(
                                    dialog,
                                    "Confirm Redo",
                                    "Are you sure you want to restore the reverted messages?",
                                  )
                                  if (confirmed) {
                                    command.trigger("session.redo")
                                  }
                                }

                                return (
                                  <box
                                    onMouseOver={() => setHover(true)}
                                    onMouseOut={() => setHover(false)}
                                    onMouseUp={handleUnrevert}
                                    marginTop={1}
                                    flexShrink={0}
                                    border={["left"]}
                                    customBorderChars={SplitBorder.customBorderChars}
                                    borderColor={theme.backgroundPanel}
                                  >
                                    <box
                                      paddingTop={1}
                                      paddingBottom={1}
                                      paddingLeft={2}
                                      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                                    >
                                      <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                      <text fg={theme.textMuted}>
                                        <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or
                                        /redo to restore
                                      </text>
                                      <Show when={revert()!.diffFiles?.length}>
                                        <box marginTop={1}>
                                          <For each={revert()!.diffFiles}>
                                            {(file) => (
                                              <text fg={theme.text}>
                                                {file.filename}
                                                <Show when={file.additions > 0}>
                                                  <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                                </Show>
                                                <Show when={file.deletions > 0}>
                                                  <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                                </Show>
                                              </text>
                                            )}
                                          </For>
                                        </box>
                                      </Show>
                                    </box>
                                  </box>
                                )
                              })()}
                            </Match>
                            <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                              <></>
                            </Match>
                            <Match when={message.role === "user"}>
                              <UserMessage
                                index={index()}
                                onMouseUp={() => {
                                  if (renderer.getSelection()?.getSelectedText()) return
                                  dialog.replace(() => (
                                    <DialogMessage
                                      messageID={message.id}
                                      sessionID={route.sessionID}
                                      setPrompt={(promptInfo) => prompt.set(promptInfo)}
                                    />
                                  ))
                                }}
                                message={message as UserMessage}
                                parts={sync.data.part[message.id] ?? []}
                                pending={pending()}
                              />
                            </Match>
                            <Match when={message.role === "assistant"}>
                              <AssistantMessage
                                last={lastAssistant()?.id === message.id}
                                message={message as AssistantMessage}
                                parts={sync.data.part[message.id] ?? []}
                              />
                            </Match>
                          </Switch>
                        )}
                      </For>
                    </scrollbox>
                    <Show when={!atBottom()}>
                      {(() => {
                        const [hover, setHover] = createSignal(false)
                        return (
                          <box position="absolute" bottom={0} width="100%" alignItems="center">
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={() => toBottom()}
                              paddingLeft={3}
                              paddingRight={3}
                              paddingTop={1}
                              paddingBottom={1}
                              backgroundColor={hover() ? theme.border : theme.backgroundElement}
                            >
                              <text fg={theme.accent}>↓ Jump to End</text>
                            </box>
                          </box>
                        )
                      })()}
                    </Show>
                  </box>
                  <box flexShrink={0}>
                    <Show when={permissions().length > 0}>
                      <PermissionPrompt request={permissions()[0]} />
                    </Show>
                    <Show when={permissions().length === 0 && questions().length > 0}>
                      <QuestionPrompt request={questions()[0]} />
                    </Show>
                    <Show when={lastAssistant()?.time.completed && incompleteTodos().length > 0}>
                      <box paddingLeft={3} marginTop={1} marginBottom={1}>
                        <text fg={theme.warning}>
                          {incompleteTodos().length} todo{incompleteTodos().length > 1 ? "s" : ""} remaining — say
                          "continue" to resume
                        </text>
                      </box>
                    </Show>
                    <Prompt
                      visible={!session()?.parentID && permissions().length === 0 && questions().length === 0}
                      ref={(r) => {
                        prompt = r
                        promptRef.set(r)
                        // Apply initial prompt when prompt component mounts (e.g., from fork)
                        if (route.initialPrompt) {
                          r.set(route.initialPrompt)
                        }
                      }}
                      disabled={permissions().length > 0 || questions().length > 0}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                    />
                  </box>
                </Show>
                <Toast />
                <Footer contextOverride={contextOverride} />
              </box>
              <Show when={sidebarVisible()}>
                <Switch>
                  <Match when={wide()}>
                    <Sidebar sessionID={route.sessionID} />
                  </Match>
                  <Match when={!wide()}>
                    <box
                      position="absolute"
                      top={0}
                      left={0}
                      right={0}
                      bottom={0}
                      alignItems="flex-end"
                      backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                    >
                      <Sidebar sessionID={route.sessionID} />
                    </box>
                  </Match>
                </Switch>
              </Show>
            </box>
          </Match>
        </Switch>
      </context.Provider>
    </TaskTreeProvider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const lcmEvents = createMemo(() =>
    props.parts.flatMap((x) => (x.type === "text" && (x as any).metadata?.lcm ? [x] : [])),
  )
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const sync = useSync()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => (queued() ? theme.accent : local.agent.color(props.message.agent)))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()?.text}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <For each={lcmEvents()}>{(part) => <LcmEvent part={part as any} event={(part as any).metadata?.lcm} />}</For>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const { theme } = useTheme()
  const ctx = use()
  // Check if there are hidden tools with no visible content
  const hasHiddenToolsOnly = createMemo(() => {
    // Check if there are any tool parts
    const hasToolParts = props.parts.some((p) => p.type === "tool")
    if (!hasToolParts) return false

    // Check if there's visible text content
    const hasVisibleText = props.parts.some(
      (p) => p.type === "text" && (p as TextPart).text?.trim() && !(p as TextPart).ignored,
    )
    if (hasVisibleText) return false

    // Check if tools would be hidden (showDetails is false)
    // Also need to check that at least some tools would be hidden
    // (tools are hidden when showDetails=false and completed, or they're internal LCM tools)
    if (ctx.showDetails()) return false

    // Check if all tool parts would be hidden
    const allToolsHidden = props.parts
      .filter((p) => p.type === "tool")
      .every((p) => {
        const toolPart = p as ToolPart
        // See LCM_INTERNAL_TOOLS definition above
        // Internal LCM tools are always hidden when not in dev mode
        if (!ctx.devMode() && LCM_INTERNAL_TOOLS.includes(toolPart.tool)) return true
        // Other tools are hidden when showDetails=false and completed
        return toolPart.state.status === "completed"
      })

    return allToolsHidden
  })

  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                lastMessage={props.last}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={hasHiddenToolsOnly()}>
        <box paddingLeft={3} marginTop={1}>
          <text fg={theme.textMuted}>Tool output hidden - use /details to show</text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>
            {(typeof props.message.error?.data?.message === "string"
              ? props.message.error.data.message.trim()
              : null) ||
              props.message.error?.name ||
              "Unknown error"}
          </text>
        </box>
      </Show>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

const thinkingSpinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function ReasoningPart(props: { last: boolean; lastMessage: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const kv = useKV()
  const content = createMemo(() => {
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  // Only show "Thinking..." if this is the last message AND it's not completed
  // Historical messages (not the last) should never show the spinner
  const isActive = createMemo(() => props.lastMessage && !props.message.time.completed)
  // Only show while actively thinking
  return (
    <Show when={content() && isActive()}>
      <box id={"text-" + props.part.id} paddingLeft={2} marginTop={1} flexDirection="row" gap={1}>
        <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>·</text>}>
          <spinner frames={thinkingSpinnerFrames} interval={80} color={theme.textMuted} />
        </Show>
        <text fg={theme.textMuted}>Thinking...</text>
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const lcmEvent = createMemo(() => (props.part.metadata as any)?.lcm)

  if (lcmEvent()) {
    return <LcmEvent part={props.part} event={lcmEvent()!} />
  }
  if (props.part.ignored) {
    return null
  }

  const renderer = useRenderer()
  const trimmed = createMemo(() => props.part.text.trim())
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createMemo(() => needsTruncation(trimmed()))
  const displayText = createMemo(() => {
    if (expanded() || !overflow()) return trimmed()
    return truncateLongLines(trimmed())
  })

  return (
    <Show when={displayText()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={3}
        marginTop={1}
        flexShrink={0}
        onMouseUp={() => {
          if (!overflow()) return
          if (renderer.getSelection()?.getSelectedText()) return
          setExpanded((prev) => !prev)
        }}
      >
        <code
          width="100%"
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={syntax()}
          content={displayText()}
          conceal={ctx.conceal()}
          fg={theme.text}
        />
        <Show when={overflow()}>
          <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
        </Show>
      </box>
    </Show>
  )
}

function LcmEvent(props: { part: TextPart; event: any }) {
  const ctx = use()
  // Only show LCM events in dev mode
  if (!ctx.devMode()) {
    return null
  }
  if (props.event?.type === "summary") {
    return <LcmSummaryEvent part={props.part} event={props.event} />
  }
  if (props.event?.type === "file") {
    return <LcmFileEvent part={props.part} event={props.event} />
  }
  return null
}

function LcmSummaryEvent(props: { part: TextPart; event: any }) {
  const { theme, syntax } = useTheme()
  const event = props.event ?? {}

  const formatTokens = (value?: number) => (value == null ? "n/a" : Math.round(value).toString())
  const formatPercent = (value?: number) => (value == null ? "n/a" : `${value.toFixed(1)}%`)

  const thresholdConstant = Number(event.thresholdConstant ?? 0)
  const threshold = event.threshold != null ? Number(event.threshold) : undefined
  const showThreshold = threshold != null && Math.abs(threshold - thresholdConstant) > 0.0001

  return (
    <BlockTool title={`# LCM Summary (${event.summaryKind ?? "summary"})`}>
      <box flexDirection="column" gap={1}>
        <text fg={theme.textMuted}>Summary ID: {event.summaryId ?? "unknown"}</text>
        <text fg={theme.textMuted}>Summary tokens: {formatTokens(event.summaryTokenCount)}</text>
        <text fg={theme.textMuted}>Messages summarized: {formatTokens(event.messagesSummarized)}</text>
        <text fg={theme.textMuted}>Summaries in context: {formatTokens(event.totalSummaries)}</text>
        <text fg={theme.textMuted}>Condensed existing summaries: {event.condensed ? "true" : "false"}</text>
        <text fg={theme.textMuted}>
          Cutoff threshold (constant): {thresholdConstant} ({formatPercent(thresholdConstant * 100)})
        </text>
        <Show when={showThreshold}>
          <text fg={theme.textMuted}>
            Cutoff threshold (conversation): {threshold} ({formatPercent((threshold ?? 0) * 100)})
          </text>
        </Show>
        <text fg={theme.textMuted}>
          Context usage: {formatPercent(event.beforePercent)} ({formatTokens(event.beforeTokens)} tokens) →{" "}
          {formatPercent(event.afterPercent)} ({formatTokens(event.afterTokens)} tokens)
        </text>
        <text fg={theme.textMuted}>
          Reduction: {formatPercent(event.reductionPercent)} ({formatTokens(event.reductionTokens)} tokens)
        </text>
        <text fg={theme.textMuted}>Summary text:</text>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={syntax()}
          content={event.summaryText ?? ""}
          conceal={false}
          fg={theme.text}
        />
      </box>
    </BlockTool>
  )
}

function LcmFileEvent(props: { part: TextPart; event: any }) {
  return (
    <BlockTool title={`# LCM File Stored`}>
      <LcmFileEventDetails event={props.event} />
    </BlockTool>
  )
}

function LcmFileEventDetails(props: { event: any }) {
  const { theme } = useTheme()
  const event = props.event ?? {}

  const formatTokens = (value?: number) => (value == null ? "n/a" : Math.round(value).toString())

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.textMuted}>File ID: {event.fileId ?? "unknown"}</text>
      <Show when={event.source}>
        <text fg={theme.textMuted}>Source: {event.source}</text>
      </Show>
      <Show when={event.filePath}>
        <text fg={theme.textMuted}>Path: {event.filePath}</text>
      </Show>
      <Show when={event.label}>
        <text fg={theme.textMuted}>Label: {event.label}</text>
      </Show>
      <Show when={event.mimeType}>
        <text fg={theme.textMuted}>MIME type: {event.mimeType}</text>
      </Show>
      <Show when={event.sizeBytes != null}>
        <text fg={theme.textMuted}>Size: {event.sizeBytes} bytes</text>
      </Show>
      <Show when={event.originalLength != null}>
        <text fg={theme.textMuted}>Original length: {event.originalLength} characters</text>
      </Show>
      <Show when={event.tokenCount != null}>
        <text fg={theme.textMuted}>Token count: {formatTokens(event.tokenCount)}</text>
      </Show>
      <Show when={event.explorerUsed}>
        <text fg={theme.textMuted}>Explorer: {event.explorerUsed}</text>
      </Show>
    </box>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()
  // Hide tool if showDetails is false and tool completed successfully
  // Hide internal LCM tools when not in dev mode
  const shouldHide = createMemo(() => {
    // See LCM_INTERNAL_TOOLS definition above
    // Hide internal LCM tools when not in dev mode
    if (!ctx.devMode() && LCM_INTERNAL_TOOLS.includes(props.part.tool)) return true
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === "bash"}>
          <Bash {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "lcm_expand"}>
          <LcmExpand {...toolprops} />
        </Match>
        <Match when={props.part.tool === "lcm_grep"}>
          <LcmGrep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "lcm_read"}>
          <LcmRead {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "list"}>
          <List {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "codesearch"}>
          <CodeSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={props.part.tool === "tasks"}>
          <Tasks {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T extends Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps<any>) {
  return (
    <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
      {props.tool} {input(props.input)}
    </InlineTool>
  )
}

function ToolTitle(props: { fallback: string; when: any; icon: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <text paddingLeft={3} fg={props.when ? theme.textMuted : theme.text}>
      <Show fallback={<>~ {props.fallback}</>} when={props.when}>
        <span style={{ bold: true }}>{props.icon}</span> {props.children}
      </Show>
    </text>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  children: JSX.Element
  part: ToolPart
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show fallback={<>~ {props.pending}</>} when={props.complete}>
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </Show>
      </text>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: { title: string; children: JSX.Element; onClick?: () => void; part?: ToolPart }) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <text paddingLeft={3} fg={theme.textMuted}>
        {props.title}
      </text>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Bash(props: ToolProps<typeof BashTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <text fg={theme.text}>{limited()}</text>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + normalizePath(props.input.filePath!)} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>({props.metadata.count} matches)</Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const ctx = use()
  const lcm = createMemo(() => (props.metadata as any).lcm)
  const showLcm = createMemo(() => !!lcm())
  const formatTokens = (n: number) => (n >= 1000 ? `~${Math.round(n / 1000)}k` : `${n}`)

  return (
    <Switch>
      {/* LCM file loaded: compact one-liner + technical block in dev mode */}
      <Match when={showLcm()}>
        <box flexDirection="column">
          <InlineTool
            icon="●"
            iconColor={theme.warning}
            pending="Loading file..."
            complete={props.input.filePath}
            part={props.part}
          >
            <span style={{ bold: true, fg: theme.warning }}>File Loaded</span> {normalizePath(props.input.filePath!)} (
            {formatTokens(lcm()?.tokenCount ?? 0)} tokens)
          </InlineTool>
          <Show when={ctx.devMode()}>
            <box paddingLeft={3} flexDirection="column" gap={1}>
              <LcmFileEventDetails event={lcm()} />
            </box>
          </Show>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Reading file..." complete={props.input.filePath} part={props.part}>
          Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function LcmExpand(props: ToolProps<typeof LcmExpandTool>) {
  return (
    <InlineTool icon="↧" pending="Expanding summary..." complete={props.input.summary_id} part={props.part}>
      LCM expand {props.input.summary_id} {input(props.input, ["summary_id"])}
    </InlineTool>
  )
}

function LcmGrep(props: ToolProps<typeof LcmGrepTool>) {
  return (
    <InlineTool icon="⌕" pending="Searching LCM..." complete={props.input.pattern} part={props.part}>
      LCM grep "{props.input.pattern}" {input(props.input, ["pattern"])}
    </InlineTool>
  )
}

function LcmRead(props: ToolProps<typeof LcmReadTool>) {
  return (
    <InlineTool icon="↥" pending="Reading LCM content..." complete={props.input.file_id} part={props.part}>
      LCM read {props.input.file_id}
    </InlineTool>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>({props.metadata.matches} matches)</Show>
    </InlineTool>
  )
}

function List(props: ToolProps<typeof ListTool>) {
  const dir = createMemo(() => {
    if (props.input.path) {
      return normalizePath(props.input.path)
    }
    return ""
  })
  return (
    <InlineTool icon="→" pending="Listing directory..." complete={props.input.path !== undefined} part={props.part}>
      List {dir()}
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={(props.input as any).url} part={props.part}>
      WebFetch {(props.input as any).url}
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={input.query} part={props.part}>
      Exa Code Search "{input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={input.query} part={props.part}>
      Exa Web Search "{input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

type TaskMetadata = {
  summary?: Array<{ id: string; tool: string; state: { status: string; title?: string } }>
  sessionId?: string
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const { navigate } = useRoute()
  const local = useLocal()

  const metadata = props.metadata as TaskMetadata
  const current = createMemo(() => metadata.summary?.findLast((x) => x.state.status !== "pending"))
  const color = createMemo(() => local.agent.color(props.input.subagent_type ?? "unknown"))

  return (
    <Switch>
      {/* Task with summary - show block view */}
      <Match when={metadata.summary?.length}>
        <BlockTool
          title={"# " + Locale.titlecase(props.input.subagent_type ?? "unknown") + " Task"}
          onClick={metadata.sessionId ? () => navigate({ type: "session", sessionID: metadata.sessionId! }) : undefined}
          part={props.part}
        >
          <box>
            <text style={{ fg: theme.textMuted }}>
              {props.input.description} ({metadata.summary?.length} toolcalls)
            </text>
            <Show when={current()}>
              <text style={{ fg: current()!.state.status === "error" ? theme.error : theme.textMuted }}>
                └ {Locale.titlecase(current()!.tool)}{" "}
                {current()!.state.status === "completed" ? current()!.state.title : ""}
              </text>
            </Show>
          </box>
          <text fg={theme.text}>
            {keybind.print("tasktree_open")}
            <span style={{ fg: theme.textMuted }}> view tasks</span>
          </text>
        </BlockTool>
      </Match>
      {/* Pending/inline view */}
      <Match when={true}>
        <InlineTool
          icon="◉"
          iconColor={color()}
          pending="Delegating..."
          complete={props.input.subagent_type ?? props.input.description}
          part={props.part}
        >
          <span style={{ fg: theme.text }}>{Locale.titlecase(props.input.subagent_type ?? "unknown")}</span>
          {` Task "${props.input.description}"`}
        </InlineTool>
      </Match>
    </Switch>
  )
}

type TasksMetadata = {
  tasks?: TaskMetadata[]
}

function Tasks(props: ToolProps<typeof TasksTool>) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const { navigate } = useRoute()
  const local = useLocal()
  const kv = useKV()
  const command = useCommandDialog()

  const metadata = () => props.metadata as TasksMetadata

  const parallelTasks = createMemo(() => {
    const inputs = props.input.tasks ?? []
    const tasks = metadata().tasks ?? []
    return tasks.map((taskMeta, i) => ({
      metadata: taskMeta,
      input: inputs[i],
      current: taskMeta.summary?.findLast((x) => x.state.status !== "pending"),
    }))
  })

  // Use metadata.tasks length as primary source (set by tool execution)
  // Fall back to input length if metadata not available yet
  const taskCount = createMemo(() => metadata().tasks?.length ?? (props.input.tasks ?? []).length)

  // Show block view when we have metadata OR when we have input with tasks
  const hasTaskInfo = createMemo(() => (metadata().tasks?.length ?? 0) > 0 || (props.input.tasks ?? []).length > 0)

  // Part status: "pending" = model generating JSON, "running" = tool executing
  const partStatus = props.part.state.status

  return (
    <Switch>
      {/* Show grouped view when we have task info */}
      <Match when={hasTaskInfo()}>
        <BlockTool
          title={`# ${taskCount()} Parallel Tasks`}
          onClick={() => command.trigger("session.tasktree.toggle")}
          part={props.part}
        >
          <Show
            when={parallelTasks().length > 0}
            fallback={
              <box flexDirection="row" gap={1}>
                <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>○</text>}>
                  <spinner
                    frames={["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]}
                    interval={80}
                    color={theme.textMuted}
                  />
                </Show>
                <text fg={theme.textMuted}>Starting {taskCount()} tasks...</text>
              </box>
            }
          >
            <box flexDirection="column">
              <For each={parallelTasks()}>
                {(task) => {
                  const taskColor = local.agent.color(task.input?.subagent_type ?? "unknown")
                  const toolCount = task.metadata.summary?.length ?? 0
                  const isRunning = !task.current || task.current.state.status === "running"
                  const statusIcon =
                    task.current?.state.status === "error"
                      ? "✗"
                      : task.current?.state.status === "completed"
                        ? "✓"
                        : "○"
                  const statusColor =
                    task.current?.state.status === "error"
                      ? theme.error
                      : task.current?.state.status === "completed"
                        ? theme.success
                        : theme.warning
                  return (
                    <box flexDirection="row" gap={1}>
                      <Show
                        when={!isRunning || !kv.get("animations_enabled", true)}
                        fallback={
                          <spinner
                            frames={["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]}
                            interval={80}
                            color={statusColor}
                          />
                        }
                      >
                        <text fg={statusColor}>{statusIcon}</text>
                      </Show>
                      <text>
                        <span style={{ fg: taskColor }}>
                          {Locale.titlecase(task.input?.subagent_type ?? "unknown")}
                        </span>
                        <span style={{ fg: theme.textMuted }}>
                          {" "}
                          {task.input?.description} [{toolCount}]
                        </span>
                        <Show when={task.current}>
                          <span style={{ fg: theme.textMuted }}>
                            {" "}
                            └{" "}
                            {task.current!.state.status === "completed"
                              ? task.current!.state.title
                              : task.current!.tool}
                          </span>
                        </Show>
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>
          </Show>
          <text fg={theme.text}>
            {keybind.print("tasktree_open")}
            <span style={{ fg: theme.textMuted }}> view tasks</span>
          </text>
        </BlockTool>
      </Match>
      {/* Pending view - model is still generating the tool call JSON */}
      <Match when={partStatus === "pending"}>
        <InlineTool
          icon="◉"
          iconColor={theme.textMuted}
          pending="Generating task definitions..."
          complete={false}
          part={props.part}
        >
          Generating task definitions...
        </InlineTool>
      </Match>
      {/* Running but no task info yet - tasks are starting up */}
      <Match when={true}>
        <InlineTool
          icon="◉"
          iconColor={theme.accent}
          pending="Starting parallel tasks..."
          complete={false}
          part={props.part}
        >
          Starting parallel tasks...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={"← Edit " + normalizePath(props.input.filePath!)} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
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
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          Edit {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
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
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.diff} filePath={file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing apply_patch..." complete={false} part={props.part}>
          apply_patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: string[]) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) {
    return path.relative(process.cwd(), input) || "."
  }
  return input
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

/**
 * Check if text would be truncated by truncateLongLines.
 */
function needsTruncation(text: string, maxLineLength = 300, maxLines = 20): boolean {
  const lines = text.split("\n")
  if (lines.length > maxLines) return true
  return lines.some((line) => line.length > maxLineLength)
}

/**
 * Truncate long lines in text to prevent huge single-line blobs from being displayed.
 * This handles cases where content (like JSON) has no newlines but is extremely long.
 * @param text - Input text
 * @param maxLineLength - Maximum characters per line before truncation (default 300)
 * @param maxLines - Maximum total lines to display (default 20)
 * @returns Truncated text with ellipsis indicators
 */
function truncateLongLines(text: string, maxLineLength = 300, maxLines = 20): string {
  const lines = text.split("\n")
  const truncatedLines: string[] = []
  let totalLineCount = 0

  for (const line of lines) {
    if (totalLineCount >= maxLines) {
      truncatedLines.push(`... (${lines.length - totalLineCount} more lines)`)
      break
    }

    if (line.length > maxLineLength) {
      truncatedLines.push(line.slice(0, maxLineLength) + "... (line truncated)")
    } else {
      truncatedLines.push(line)
    }
    totalLineCount++
  }

  return truncatedLines.join("\n")
}
