import { batch, createEffect, For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { type Message, type TextPart } from "@opencode-ai/sdk/v2/client"
import { ChatMessage } from "./chat-message"
import { ChatInput, type FileAttachment } from "./chat-input"
import { ChatTaskTree } from "./chat-task-tree"
import { TaskTreeProvider, useTaskTree } from "@/context/task-tree"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon } from "@opencode-ai/ui/icon"

interface ChatMainProps {
  sessionID: () => string | undefined
  onSendMessage: (content: string, files?: FileAttachment[]) => void | Promise<void>
}

export function ChatMain(props: ChatMainProps) {
  const sync = useSync()
  const [mounted, setMounted] = createSignal(false)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [pendingSend, setPendingSend] = createSignal(false)
  let scrollRef: HTMLDivElement | undefined

  const sessionID = () => props.sessionID()
  const session = () => (sessionID() ? sync.session.get(sessionID()!) : undefined)

  const messages = createMemo(() => {
    const sid = sessionID()
    if (!sid) return []
    return sync.data.message[sid] ?? []
  })

  const parts = createMemo(() => {
    return sync.data.part
  })

  onMount(() => {
    setMounted(true)
  })

  let msgCountAtSend = 0

  const handleSend = (content: string, files?: FileAttachment[]) => {
    msgCountAtSend = messages().length
    setPendingSend(true)
    setAutoScroll(true)
    props.onSendMessage(content, files)
  }

  const scrollToBottom = () => {
    if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
  }

  createEffect(() => {
    if (pendingSend()) {
      queueMicrotask(scrollToBottom)
    }
  })

  createEffect(() => {
    const msgs = messages()
    const len = msgs.length
    if (len > msgCountAtSend && len > 0 && msgs[len - 1]?.role === "assistant") {
      setPendingSend(false)
    }
    if (autoScroll()) {
      queueMicrotask(scrollToBottom)
    }
  })

  createEffect(() => {
    const _ = parts()
    if (autoScroll()) {
      queueMicrotask(scrollToBottom)
    }
  })

  const handleScroll = (e: Event) => {
    const target = e.target as HTMLElement
    const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 50
    setAutoScroll(isAtBottom)
  }

  return (
    <main class="flex-1 flex flex-col overflow-hidden">
      <Show when={mounted() && session()}>
        <TaskTreeProvider sessionID={sessionID()!}>
          <TaskTreeOverlay>
            <div ref={scrollRef} class="flex-1 overflow-y-auto min-w-0" onScroll={handleScroll}>
              <div class="px-4 py-8">
                <div class="space-y-6">
                  <For each={messages()}>
                    {(message) => <ChatMessage message={message} parts={() => parts()[message.id] ?? []} />}
                  </For>
                  <Show
                    when={
                      pendingSend() || (messages().length > 0 && messages()[messages().length - 1]?.role === "user")
                    }
                  >
                    <div class="flex gap-4 group">
                      <div class="flex-shrink-0">
                        <Avatar fallback="VC" size="normal" />
                      </div>
                      <div class="flex-1 min-w-0">
                        <div class="flex items-baseline gap-2 mb-1">
                          <span class="font-semibold text-text-strong">VoltCode</span>
                        </div>
                        <div class="flex items-center gap-2 py-2 text-sm text-text-weak">
                          <span
                            class="inline-block w-4 h-4 border-2 border-text-weak border-t-transparent rounded-full flex-shrink-0"
                            style={{ animation: "spin 1s linear infinite" }}
                          />
                          <span>Working...</span>
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </TaskTreeOverlay>
        </TaskTreeProvider>

        <ChatInput onSend={handleSend} disabled={!sessionID()} />
      </Show>

      <Show when={mounted() && !session() && !sync.ready && sessionID()}>
        <div class="flex-1 flex items-center justify-center">
          <Spinner />
        </div>
      </Show>
    </main>
  )
}

function TaskTreeOverlay(props: { children: JSX.Element }) {
  const taskTree = useTaskTree()
  const [showTree, setShowTree] = createSignal(false)
  const [userDismissed, setUserDismissed] = createSignal(false)
  const [prevActiveCount, setPrevActiveCount] = createSignal(0)

  const hasSubtasks = createMemo(() => {
    const tree = taskTree.data.tree
    if (!tree) return false
    return tree.children.length > 0
  })

  const subtaskCount = createMemo(() => {
    const total = taskTree.data.totalCount
    return Math.max(0, total - 1)
  })

  // Auto-show when subtasks first appear
  createEffect(() => {
    const count = subtaskCount()
    if (count > 0 && !showTree() && !userDismissed()) {
      setShowTree(true)
    }
  })

  // Auto-hide when all subtasks complete
  createEffect(() => {
    const active = taskTree.data.activeCount
    const prev = prevActiveCount()
    setPrevActiveCount(active)
    if (prev > 0 && active === 0 && showTree()) {
      batch(() => {
        setShowTree(false)
        setUserDismissed(false)
      })
    }
  })

  const handleClose = () => {
    batch(() => {
      setShowTree(false)
      setUserDismissed(true)
    })
  }

  const handleOpen = () => {
    batch(() => {
      setShowTree(true)
      setUserDismissed(false)
    })
  }

  return (
    <div class="flex-1 flex overflow-hidden relative">
      {/* Chat content */}
      {props.children}

      {/* Tasks button - shown when subtasks exist but tree is hidden */}
      <Show when={hasSubtasks() && !showTree()}>
        <div class="absolute top-3 right-3 z-40">
          <button
            onClick={handleOpen}
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface border border-border hover:bg-surface-hover transition-colors shadow-sm"
          >
            <Icon name="brain" size="small" />
            <span class="text-sm text-text">Tasks</span>
            <span class="text-xs text-text-weak font-mono">{subtaskCount()}</span>
            <Show when={taskTree.data.activeCount > 0}>
              <span class="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            </Show>
          </button>
        </div>
      </Show>

      {/* Task tree side panel */}
      <Show when={showTree()}>
        <ChatTaskTree onClose={handleClose} />
      </Show>
    </div>
  )
}
