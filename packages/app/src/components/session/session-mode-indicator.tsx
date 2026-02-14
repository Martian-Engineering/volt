import { Show, createMemo } from "solid-js"
import { useSync } from "@/context/sync"
import type { AssistantMessage } from "@opencode-ai/sdk/v2/client"

interface SessionModeIndicatorProps {
  sessionID: string
  currentMessageID: string
  previousMessageID?: string
  classes?: {
    root?: string
  }
}

export function SessionModeIndicator(props: SessionModeIndicatorProps) {
  const sync = useSync()

  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const getLastAssistantMode = (userMessageID: string): string | undefined => {
    const allMessages = messages()
    const userIndex = allMessages.findIndex((m) => m.id === userMessageID)
    if (userIndex < 0) return undefined

    // Look at assistant messages that follow this user message
    for (let i = userIndex + 1; i < allMessages.length; i++) {
      const msg = allMessages[i]
      if (msg.role === "user") break
      if (msg.role === "assistant") {
        return (msg as AssistantMessage).mode
      }
    }
    return undefined
  }

  const previousMode = createMemo(() => {
    if (!props.previousMessageID) return undefined
    return getLastAssistantMode(props.previousMessageID)
  })

  const currentMode = createMemo(() => {
    return getLastAssistantMode(props.currentMessageID)
  })

  const modeChanged = createMemo(() => {
    const prev = previousMode()
    const curr = currentMode()
    // Only show indicator if:
    // 1. Current mode is defined
    // 2. Previous mode is also defined (not first message)
    // 3. They are different
    if (!curr) return false
    if (!prev) return false
    return prev !== curr
  })

  const modeLabel = createMemo(() => {
    const mode = currentMode()
    if (!mode) return ""
    if (mode === "plan") return "Entered Plan Mode"
    if (mode === "build") return "Entered Build Mode"
    return `Entered ${mode.charAt(0).toUpperCase() + mode.slice(1)} Mode`
  })

  return (
    <Show when={modeChanged()}>
      <div
        data-component="session-mode-indicator"
        classList={{
          "w-full flex items-center justify-center py-2": true,
          [props.classes?.root ?? ""]: !!props.classes?.root,
        }}
      >
        <div class="flex items-center gap-2 px-3 py-1 rounded-full bg-surface-base border border-border-base text-12-regular text-text-weak">
          <span>{modeLabel()}</span>
        </div>
      </div>
    </Show>
  )
}
