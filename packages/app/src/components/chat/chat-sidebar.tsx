import { createEffect, For, Show, createMemo } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLayout } from "@/context/layout"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal } from "solid-js"

interface ChatSidebarProps {
  sessionID: () => string | undefined
  onNewChat: () => void
  onSessionSelect: (id: string) => void
}

function formatTime(date: Date): string {
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

export function ChatSidebar(props: ChatSidebarProps) {
  const sync = useSync()
  const sdk = useSDK()
  const layout = useLayout()
  const dialog = useDialog()
  const expanded = () => layout.sidebar.opened()
  const [renamingID, setRenamingID] = createSignal<string | undefined>(undefined)
  const [renameValue, setRenameValue] = createSignal("")

  const sessions = createMemo(() => sync.data.session.filter((s) => !s.time?.archived && !s.parentID))

  const handleDelete = async (id: string) => {
    await sync.session.archive(id)
  }

  const handleRename = async (id: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) {
      setRenamingID(undefined)
      setRenameValue("")
      return
    }
    await sdk.client.session.update({ sessionID: id, title: trimmed })
    setRenamingID(undefined)
    setRenameValue("")
  }

  const startRename = (id: string, currentTitle: string) => {
    setRenamingID(id)
    setRenameValue(currentTitle)
  }

  const cancelRename = () => {
    setRenamingID(undefined)
    setRenameValue("")
  }

  const confirmDelete = (id: string) => {
    dialog.show(() => (
      <Dialog title="Delete chat" fit>
        <div class="flex flex-col gap-4 px-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">Are you sure you want to delete this chat?</span>
            <span class="text-12-regular text-text-weak">This action cannot be undone.</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                handleDelete(id)
                dialog.close()
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  return (
    <Show when={expanded()}>
      <aside class="w-72 flex flex-col bg-surface border-r border-border overflow-hidden">
        <div class="p-4 border-b border-border">
          <Button onClick={props.onNewChat} class="w-full justify-start gap-2" variant="ghost">
            <Icon name="plus" />
            <span>New Chat</span>
          </Button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <Show when={sync.ready && sessions().length > 0}>
            <div class="p-2 space-y-1">
              <For each={sessions()}>
                {(session) => {
                  const isActive = () => session.id === props.sessionID()
                  const isRenaming = () => renamingID() === session.id

                  return (
                    <button
                      onClick={() => {
                        if (!isRenaming()) props.onSessionSelect(session.id)
                      }}
                      class={`group/item w-full p-3 rounded-lg text-left transition-colors ${
                        isActive() ? "bg-surface-hover text-text-strong" : "text-text hover:bg-surface-hover"
                      }`}
                    >
                      <div class="flex items-start justify-between gap-2">
                        <div class="flex-1 min-w-0">
                          <Show
                            when={isRenaming()}
                            fallback={<div class="truncate text-sm font-medium">{session.title ?? "Untitled"}</div>}
                          >
                            <div class="flex items-center gap-1">
                              <input
                                ref={(el) => {
                                  queueMicrotask(() => {
                                    el.focus()
                                    el.select()
                                  })
                                }}
                                type="text"
                                value={renameValue()}
                                onInput={(e) => setRenameValue(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault()
                                    handleRename(session.id, renameValue())
                                  }
                                  if (e.key === "Escape") {
                                    e.preventDefault()
                                    cancelRename()
                                  }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                class="flex-1 min-w-0 text-sm font-medium bg-transparent border border-border rounded px-1.5 py-0.5 outline-none focus:border-text-interactive-base text-text-strong"
                              />
                              <IconButton
                                icon="check"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRename(session.id, renameValue())
                                }}
                              />
                              <IconButton
                                icon="close"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  cancelRename()
                                }}
                              />
                            </div>
                          </Show>
                          <Show when={!isRenaming()}>
                            <div class="text-xs text-text-weak mt-0.5">
                              {formatTime(new Date(session.time.created))}
                            </div>
                          </Show>
                        </div>
                        <Show when={!isRenaming()}>
                          <div class="opacity-0 group-hover/item:opacity-100 transition-opacity">
                            <DropdownMenu>
                              <DropdownMenu.Trigger
                                as={IconButton}
                                icon="dot-grid"
                                variant="ghost"
                                onClick={(e: MouseEvent) => e.stopPropagation()}
                              />
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content>
                                  <DropdownMenu.Item
                                    onSelect={() => startRename(session.id, session.title ?? "Untitled")}
                                  >
                                    <DropdownMenu.ItemLabel>Rename</DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item onSelect={() => confirmDelete(session.id)}>
                                    <DropdownMenu.ItemLabel>Delete</DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu>
                          </div>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>

        <div class="p-4 border-t border-border">
          <div class="text-xs text-text-weak">{sync.directory}</div>
        </div>
      </aside>
    </Show>
  )
}
