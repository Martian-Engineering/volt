import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"

export interface FileAttachment {
  id: string
  file: File
  filename: string
  progress: number
  status: "pending" | "uploading" | "done" | "error"
  result?: { filename: string; path: string; size: number }
  error?: string
}

interface ChatInputProps {
  onSend: (content: string, files?: FileAttachment[]) => void | Promise<void>
  disabled?: boolean
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ChatInput(props: ChatInputProps) {
  const [input, setInput] = createSignal("")
  const [attachedFiles, setAttachedFiles] = createSignal<FileAttachment[]>([])
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const [submitting, setSubmitting] = createSignal(false)

  const handleSubmit = async () => {
    const content = input().trim()
    const files = attachedFiles()
    if ((!content && files.length === 0) || props.disabled) return
    // Don't submit if files are still uploading or already submitting
    if (files.some((f) => f.status === "uploading") || submitting()) return

    // Clear text immediately but keep file chips visible during upload
    setInput("")
    if (textareaRef) {
      textareaRef.style.height = "auto"
    }

    // Mark files as uploading so the user sees progress indicators
    if (files.length > 0) {
      setSubmitting(true)
      setAttachedFiles((prev) => prev.map((f) => ({ ...f, status: "uploading" as const })))
    }

    await Promise.resolve(props.onSend(content, files.length > 0 ? files : undefined)).finally(() => {
      setAttachedFiles([])
      setSubmitting(false)
    })
  }

  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement
    target.style.height = "auto"
    target.style.height = `${target.scrollHeight}px`
    setInput(target.value)
  }

  const handleAttachClick = () => {
    fileInputRef?.click()
  }

  const handleFileSelect = (e: Event) => {
    const target = e.target as HTMLInputElement
    const files = target.files
    if (!files) return
    const newAttachments: FileAttachment[] = Array.from(files).map((file) => ({
      id: generateId(),
      file,
      filename: file.name,
      progress: 0,
      status: "pending" as const,
    }))
    setAttachedFiles((prev) => [...prev, ...newAttachments])
    // Reset input so the same file can be selected again
    target.value = ""
  }

  const removeFile = (id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const isUploading = () => attachedFiles().some((f) => f.status === "uploading")
  const hasFiles = () => attachedFiles().length > 0
  const canSubmit = () => {
    const content = input().trim()
    const files = attachedFiles()
    const hasContent = content.length > 0 || files.length > 0
    return hasContent && !isUploading() && !submitting() && !props.disabled
  }

  return (
    <div class="border-t border-border p-4">
      <div>
        {/* Attached files display */}
        <Show when={hasFiles()}>
          <div class="flex flex-wrap gap-2 mb-2">
            <For each={attachedFiles()}>
              {(attachment) => (
                <div class="flex items-center gap-1.5 bg-surface-inset border border-border rounded-md px-2 py-1 text-xs max-w-[200px]">
                  <span class="truncate text-text" title={attachment.filename}>
                    {attachment.filename}
                  </span>
                  <span class="text-text-weak shrink-0">{formatFileSize(attachment.file.size)}</span>
                  <Show when={attachment.status === "uploading"}>
                    <div class="w-12 h-1 bg-border rounded-full overflow-hidden shrink-0">
                      <div
                        class="h-full bg-accent rounded-full transition-all duration-200"
                        style={{ width: `${attachment.progress}%` }}
                      />
                    </div>
                  </Show>
                  <Show when={attachment.status === "error"}>
                    <span class="text-danger shrink-0" title={attachment.error}>
                      !
                    </span>
                  </Show>
                  <Show when={attachment.status === "done"}>
                    <Icon name="check" class="text-positive shrink-0" />
                  </Show>
                  <button
                    type="button"
                    class="text-text-weak hover:text-text shrink-0 ml-0.5"
                    onClick={() => removeFile(attachment.id)}
                    disabled={attachment.status === "uploading"}
                  >
                    <Icon name="close" size="small" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="bg-surface border border-border rounded-lg p-2 flex gap-2">
          <input ref={fileInputRef} type="file" multiple class="hidden" onChange={handleFileSelect} />
          <IconButton
            icon="plus"
            variant="ghost"
            size="large"
            onClick={handleAttachClick}
            disabled={props.disabled}
            title="Attach files"
            style={{ "--icon-base": "var(--text-strong)" }}
          />
          <textarea
            ref={textareaRef}
            value={input()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Message VoltCode..."
            disabled={props.disabled}
            class="flex-1 resize-none bg-transparent border-none outline-none text-sm min-h-[24px] max-h-[200px] py-2 px-2"
            rows={1}
          />
          <Button onClick={handleSubmit} disabled={!canSubmit()}>
            <Icon name="arrow-up" />
          </Button>
        </div>
        <div class="text-xs text-text-weak mt-2 text-center">Enter to send, Shift+Enter for new line</div>
      </div>
    </div>
  )
}
