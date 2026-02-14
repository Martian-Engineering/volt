import { Show, createSignal, onMount, createEffect } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { ChatMain, ChatSidebar } from "@/components/chat"
import { useParams, useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import type { FileAttachment } from "@/components/chat/chat-input"

const CHUNK_SIZE = 512 * 1024 // 512KB chunks

interface ChatLayoutProps {
  defaultUrl?: string
}

function uploadFileChunked(
  baseUrl: string,
  sessionID: string,
  file: File,
  directory: string,
  onProgress: (progress: number) => void,
): Promise<{ filename: string; path: string; size: number }> {
  return new Promise((resolve, reject) => {
    const totalSize = file.size

    // For small files, upload in one shot
    if (totalSize <= CHUNK_SIZE) {
      const formData = new FormData()
      formData.append("file", file)

      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${baseUrl}/session/${sessionID}/upload`)
      xhr.setRequestHeader("x-voltcode-directory", directory)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText))
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`))
        }
      }

      xhr.onerror = () => reject(new Error("Upload network error"))
      xhr.send(formData)
      return
    }

    // Chunked upload for larger files
    const sendChunk = (offset: number) => {
      const end = Math.min(offset + CHUNK_SIZE, totalSize)
      const chunk = file.slice(offset, end)

      const formData = new FormData()
      formData.append("file", new File([chunk], file.name, { type: file.type }))

      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${baseUrl}/session/${sessionID}/upload`)
      xhr.setRequestHeader("x-voltcode-directory", directory)
      xhr.setRequestHeader("Content-Range", `bytes ${offset}-${end - 1}/${totalSize}`)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const chunkProgress = e.loaded / e.total
          const overallProgress = ((offset + chunkProgress * (end - offset)) / totalSize) * 100
          onProgress(Math.round(overallProgress))
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const result = JSON.parse(xhr.responseText)
          if (end >= totalSize) {
            onProgress(100)
            resolve(result)
          } else {
            sendChunk(end)
          }
        } else {
          reject(new Error(`Chunk upload failed: ${xhr.status} ${xhr.statusText}`))
        }
      }

      xhr.onerror = () => reject(new Error("Chunk upload network error"))
      xhr.send(formData)
    }

    sendChunk(0)
  })
}

export function ChatLayout(props: ChatLayoutProps) {
  const params = useParams()
  const navigate = useNavigate()
  const sync = useSync()
  const sdk = useSDK()
  const [mounted, setMounted] = createSignal(false)

  const sessionID = () => params.id as string | undefined
  const hasSession = () => !!sessionID()

  // Use the already-encoded directory from params, or encode it if not available
  const encodedDir = () => params.dir || base64Encode(sync.directory)

  // Sync session data when sessionID changes
  createEffect(() => {
    const sid = sessionID()
    if (sid) {
      sync.session.sync(sid)
    }
  })

  onMount(async () => {
    setMounted(true)
    await sync.session.fetch()
    if (!hasSession()) {
      if (sync.data.session.length > 0) {
        navigate(`/${encodedDir()}/session/${sync.data.session[0].id}`)
      } else {
        const newSession = await sdk.client.session.create({})
        if (newSession.data) {
          navigate(`/${encodedDir()}/session/${newSession.data.id}`)
        }
      }
    }
  })

  const handleSendMessage = async (content: string, files?: FileAttachment[]) => {
    const sid = sessionID()
    if (!sid) return

    const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename: string }> =
      []

    // Add text part if there's content
    if (content.trim()) {
      parts.push({ type: "text", text: content })
    }

    // Upload files if attached
    if (files && files.length > 0) {
      const uploadResults = await Promise.all(
        files
          .filter((f) => f.status !== "error")
          .map((attachment) =>
            uploadFileChunked(sdk.url, sid, attachment.file, sdk.directory, () => {}).catch((err) => {
              console.error("Failed to upload file:", attachment.filename, err)
              return null
            }),
          ),
      )

      for (const result of uploadResults) {
        if (!result) continue
        parts.push({
          type: "file",
          mime: "text/plain",
          url: `file://${result.path}`,
          filename: result.filename,
        })
      }
    }

    // Don't send if we ended up with no parts
    if (parts.length === 0) return

    sdk.client.session
      .promptAsync({
        sessionID: sid,
        parts,
      })
      .catch((err: unknown) => {
        console.error("Failed to send message:", err)
      })
  }

  const handleNewChat = async () => {
    const newSession = await sdk.client.session.create({})
    if (newSession.data) {
      navigate(`/${encodedDir()}/session/${newSession.data.id}`)
    }
  }

  return (
    <div class="flex w-full h-full overflow-hidden bg-base">
      <Show when={mounted()}>
        <ChatSidebar
          sessionID={sessionID}
          onNewChat={handleNewChat}
          onSessionSelect={(id: string) => navigate(`/${encodedDir()}/session/${id}`)}
        />
        <ChatMain sessionID={sessionID} onSendMessage={handleSendMessage} />
      </Show>
    </div>
  )
}
