import { createMemo, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSync, type LcmFileLoadEvent } from "@/context/sync"
import { getFilename } from "@opencode-ai/util/path"

/**
 * Format bytes into a human-readable string.
 * @param bytes - The number of bytes
 * @returns Formatted string (e.g., "1.7MB", "256KB", "512B")
 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  }
  return `${bytes}B`
}

/**
 * Format duration in milliseconds into a human-readable string.
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "2.0s", "150ms", "1m 30s")
 */
function formatDuration(ms: number): string {
  if (ms >= 60000) {
    const minutes = Math.floor(ms / 60000)
    const seconds = ((ms % 60000) / 1000).toFixed(0)
    return `${minutes}m ${seconds}s`
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  return `${ms}ms`
}

interface SessionLcmFileIndicatorItemProps {
  event: LcmFileLoadEvent
}

function SessionLcmFileIndicatorItem(props: SessionLcmFileIndicatorItemProps) {
  const filename = createMemo(() => getFilename(props.event.filePath))
  const sizeFormatted = createMemo(() => formatSize(props.event.sizeBytes))
  const durationFormatted = createMemo(() => formatDuration(props.event.durationMs))

  return (
    <div class="flex items-center gap-1.5 text-12-regular text-text-weak px-4 py-1.5">
      <span class="text-icon-base">&#x25A3;</span>
      <span>Loaded File</span>
      <span class="text-text-strong truncate max-w-60" title={props.event.filePath}>
        {filename()}
      </span>
      <span class="text-text-weaker">·</span>
      <span>{sizeFormatted()}</span>
      <span class="text-text-weaker">·</span>
      <span>{durationFormatted()}</span>
    </div>
  )
}

export function SessionLcmFileIndicator() {
  const sync = useSync()
  const params = useParams()

  const fileLoads = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return []
    return sync.data.lcm_file_loads[sessionID] ?? []
  })

  return (
    <Show when={fileLoads().length > 0}>
      <div class="flex flex-col">
        <For each={fileLoads()}>{(event) => <SessionLcmFileIndicatorItem event={event} />}</For>
      </div>
    </Show>
  )
}
