import { createStore, produce } from "solid-js/store"
import { onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

// Debounce helper to prevent overwhelming updates
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay)
  }) as T
}

export interface TaskNode {
  sessionID: string
  parentSessionID?: string
  title: string
  status: "running" | "completed" | "failed"
  startTime: number
  endTime?: number
  toolCallCount: number
  currentTool?: {
    name: string
    description: string
    status: "running" | "completed" | "failed"
  }
  tokens?: {
    used: number
    max: number
    percentage: number
  }
  children: TaskNode[]
}

// A "Job" is a main-thread tool call that may spawn child sessions
export interface JobTree {
  // Root tool call info
  toolCallID: string
  toolName: string
  toolTitle: string
  toolStatus: "pending" | "running" | "completed" | "error"
  toolInput: Record<string, unknown>
  toolOutput?: string
  toolStartTime?: number
  toolEndTime?: number
  messageID: string

  // Child sessions spawned by this tool call
  children: TaskNode[]
}

export interface TaskTreeData {
  rootSessionID: string
  jobs: JobTree[]
  totalCount: number
  activeCount: number
}

function countNodesInTaskNode(node: TaskNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodesInTaskNode(child), 0)
}

function countActiveInTaskNode(node: TaskNode): number {
  return (
    (node.status === "running" ? 1 : 0) + node.children.reduce((sum, child) => sum + countActiveInTaskNode(child), 0)
  )
}

function countNodes(jobs: JobTree[]): number {
  return jobs.reduce((sum, job) => sum + job.children.reduce((s, child) => s + countNodesInTaskNode(child), 0), 0)
}

function countActive(jobs: JobTree[]): number {
  let count = 0
  for (const job of jobs) {
    if (job.toolStatus === "pending" || job.toolStatus === "running") count++
    count += job.children.reduce((s, child) => s + countActiveInTaskNode(child), 0)
  }
  return count
}

function findNodeInTree(node: TaskNode, sessionID: string): TaskNode | null {
  if (node.sessionID === sessionID) return node
  for (const child of node.children) {
    const found = findNodeInTree(child, sessionID)
    if (found) return found
  }
  return null
}

function isSessionInJobs(jobs: JobTree[], sessionID: string): boolean {
  for (const job of jobs) {
    for (const child of job.children) {
      if (findNodeInTree(child, sessionID)) return true
    }
  }
  return false
}

// Tools that spawn child sessions
const SPAWNING_TOOLS = ["task", "tasks", "agentic_map", "llm_map"]

function isSpawningTool(toolName: string): boolean {
  return SPAWNING_TOOLS.includes(toolName)
}

export const { use: useTaskTree, provider: TaskTreeProvider } = createSimpleContext({
  name: "TaskTree",
  init: (props: { sessionID: string }) => {
    const sdk = useSDK()
    const sync = useSync()

    const [data, setData] = createStore<TaskTreeData>({
      rootSessionID: props.sessionID,
      jobs: [],
      totalCount: 0,
      activeCount: 0,
    })

    // Build a TaskNode tree for a given session (used for child sessions)
    async function buildTaskNode(sessionID: string): Promise<TaskNode | null> {
      const session = sync.session.get(sessionID)
      if (!session) return null

      const messages = sync.data.message[sessionID] ?? []
      const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant")

      const parts = lastAssistantMsg ? (sync.data.part[lastAssistantMsg.id] ?? []) : []
      const toolParts = parts.filter((p) => p.type === "tool")

      const toolCallCount = toolParts.length

      const runningTool = toolParts.find(
        (p) => p.type === "tool" && (p.state.status === "running" || p.state.status === "pending"),
      )

      const currentTool =
        runningTool && runningTool.type === "tool"
          ? {
              name: runningTool.tool,
              description:
                runningTool.state.status === "running"
                  ? (runningTool.state.title ?? runningTool.tool)
                  : runningTool.tool,
              status:
                runningTool.state.status === "pending"
                  ? ("running" as const)
                  : (runningTool.state.status as "running" | "completed" | "failed"),
            }
          : undefined

      const hasError = toolParts.some((p) => p.type === "tool" && p.state.status === "error")
      const allCompleted = lastAssistantMsg?.role === "assistant" && lastAssistantMsg.time.completed !== undefined
      const hasRunningOrPending = toolParts.some(
        (p) => p.type === "tool" && (p.state.status === "running" || p.state.status === "pending"),
      )

      const status: "running" | "completed" | "failed" = hasError
        ? "failed"
        : !lastAssistantMsg || hasRunningOrPending || !allCompleted
          ? "running"
          : "completed"

      const tokens =
        lastAssistantMsg?.role === "assistant"
          ? (() => {
              const used =
                lastAssistantMsg.tokens.input + lastAssistantMsg.tokens.output + lastAssistantMsg.tokens.cache.read
              const providerID = lastAssistantMsg.providerID
              const modelID = lastAssistantMsg.modelID
              const provider = sync.data.provider_next.all.find((p) => p.id === providerID)
              const model = provider?.models?.[modelID]
              const max = model?.limit?.context ?? 200000
              const percentage = Math.round((used / max) * 100)
              return { used, max, percentage }
            })()
          : undefined

      // Recursively build child nodes for sessions that have this as parent
      const childSessions = sync.data.session.filter((s) => s.parentID === sessionID)
      const children: TaskNode[] = []
      for (const childSession of childSessions) {
        const childNode = await buildTaskNode(childSession.id)
        if (childNode) children.push(childNode)
      }

      return {
        sessionID: session.id,
        parentSessionID: session.parentID,
        title: session.title,
        status,
        startTime: session.time.created,
        endTime: status !== "running" ? session.time.updated : undefined,
        toolCallCount,
        currentTool,
        tokens,
        children,
      }
    }

    // Extract session IDs spawned by a tool call from its metadata
    function getSpawnedSessionIds(toolPart: { tool: string; state: { metadata?: Record<string, unknown> } }): string[] {
      const metadata = toolPart.state.metadata
      if (!metadata) return []

      // task tool: metadata.sessionId
      if (toolPart.tool === "task" && typeof metadata.sessionId === "string") {
        return [metadata.sessionId]
      }

      // tasks tool: metadata.tasks[].sessionId
      if (toolPart.tool === "tasks" && Array.isArray(metadata.tasks)) {
        return metadata.tasks
          .filter(
            (t: unknown) =>
              t &&
              typeof t === "object" &&
              "sessionId" in t &&
              typeof (t as Record<string, unknown>).sessionId === "string",
          )
          .map((t: unknown) => (t as { sessionId: string }).sessionId)
      }

      // agentic_map / llm_map: sessions are linked via parentID, not metadata
      // We'll find them by querying sessions with parentID = rootSessionID
      return []
    }

    // Build jobs list from root session's tool calls
    async function buildJobs(): Promise<JobTree[]> {
      const messages = sync.data.message[props.sessionID] ?? []
      const jobs: JobTree[] = []

      // Set of session IDs we've already associated with a job (via metadata)
      const claimedSessionIds = new Set<string>()

      // First pass: find tool calls that have sessionId in metadata
      for (const msg of messages) {
        if (msg.role !== "assistant") continue

        const parts = sync.data.part[msg.id] ?? []
        for (const part of parts) {
          if (part.type !== "tool") continue
          if (!isSpawningTool(part.tool)) continue

          const toolPart = part as {
            type: "tool"
            tool: string
            id: string
            state: {
              status: string
              input: Record<string, unknown>
              title?: string
              output?: string
              metadata?: Record<string, unknown>
              time?: { start: number; end?: number }
            }
          }

          // Get spawned session IDs from metadata
          const spawnedIds = getSpawnedSessionIds(toolPart)

          // Build child TaskNode trees for each spawned session
          const children: TaskNode[] = []
          for (const sessionId of spawnedIds) {
            claimedSessionIds.add(sessionId)
            const node = await buildTaskNode(sessionId)
            if (node) children.push(node)
          }

          // For agentic_map/llm_map without metadata session IDs,
          // find child sessions by parentID that aren't claimed yet
          if ((toolPart.tool === "agentic_map" || toolPart.tool === "llm_map") && spawnedIds.length === 0) {
            // Get map_id from metadata if available to filter
            const mapId = toolPart.state.metadata?.map_id as string | undefined

            // Find all child sessions of root that might belong to this map
            const childSessions = sync.data.session.filter(
              (s) => s.parentID === props.sessionID && !claimedSessionIds.has(s.id),
            )

            // For agentic_map, sessions have titles like "agentic_map item X (map YYYY)"
            // Match by map_id prefix if available
            for (const childSession of childSessions) {
              const matchesMap =
                !mapId ||
                (childSession.title.includes("agentic_map") && childSession.title.includes(mapId.slice(0, 8))) ||
                (childSession.title.includes("llm_map") && childSession.title.includes(mapId.slice(0, 8)))

              if (matchesMap) {
                claimedSessionIds.add(childSession.id)
                const node = await buildTaskNode(childSession.id)
                if (node) children.push(node)
              }
            }
          }

          jobs.push({
            toolCallID: toolPart.id,
            toolName: toolPart.tool,
            toolTitle: toolPart.state.title ?? toolPart.tool,
            toolStatus: toolPart.state.status as "pending" | "running" | "completed" | "error",
            toolInput: toolPart.state.input,
            toolOutput: toolPart.state.output,
            toolStartTime: toolPart.state.time?.start,
            toolEndTime: toolPart.state.time?.end,
            messageID: msg.id,
            children,
          })
        }
      }

      return jobs
    }

    async function rebuildTree() {
      const jobs = await buildJobs()
      setData({
        jobs,
        totalCount: countNodes(jobs),
        activeCount: countActive(jobs),
      })
    }

    async function updateSession(sessionID: string, triggerRebuild: () => void) {
      // For root session updates, always rebuild (tool calls may have changed)
      if (sessionID === props.sessionID) {
        triggerRebuild()
        return
      }

      // For child session updates, check if it's in our jobs tree
      if (!isSessionInJobs(data.jobs, sessionID)) {
        const session = sync.session.get(sessionID)
        if (session?.parentID) {
          // Check if any ancestor is in the tree - if so, we need a rebuild
          let current: typeof session | undefined = session
          while (current?.parentID) {
            if (isSessionInJobs(data.jobs, current.parentID) || current.parentID === props.sessionID) {
              triggerRebuild()
              return
            }
            current = sync.session.get(current.parentID)
          }
        }
        return
      }

      // Session is in our tree, rebuild to update it
      triggerRebuild()
    }

    onMount(() => {
      rebuildTree()
    })

    // Debounce updates to prevent overwhelming the UI with many concurrent tasks
    // Use per-session debouncing to batch rapid updates for the same session
    const pendingUpdates = new Set<string>()
    let rebuildPending = false
    let rebuildInProgress = false

    // debouncedRebuild is defined below but we need to reference it here
    // Use a wrapper function to avoid hoisting issues
    const triggerRebuild = () => debouncedRebuild()

    const debouncedFlush = debounce(async () => {
      // If a rebuild is pending, skip individual updates - rebuild will handle everything
      if (rebuildPending) return

      const sessions = Array.from(pendingUpdates)
      pendingUpdates.clear()
      for (const sessionID of sessions) {
        updateSession(sessionID, triggerRebuild)
      }
    }, 250)

    // Debounced rebuild that coalesces multiple rapid session.created events
    const debouncedRebuild = debounce(async () => {
      if (rebuildInProgress) {
        // If rebuild is running, mark that another is pending
        rebuildPending = true
        return
      }

      rebuildInProgress = true
      rebuildPending = false
      pendingUpdates.clear() // Clear pending updates since rebuild will cover them

      try {
        await rebuildTree()
      } finally {
        rebuildInProgress = false
        // If another rebuild was requested while we were rebuilding, do it now
        if (rebuildPending) {
          rebuildPending = false
          debouncedRebuild()
        }
      }
    }, 100)

    const queueUpdate = (sessionID: string) => {
      pendingUpdates.add(sessionID)
      debouncedFlush()
    }

    const unsubSessionCreated = sdk.event.on("session.created", (event) => {
      const newSession = event.properties.info
      // For any new session that might be related to our jobs, queue a rebuild
      // Check both direct children and potential grandchildren by checking if parent exists
      if (newSession.parentID) {
        const parentSession = sync.session.get(newSession.parentID)
        const isDirectChild = isSessionInJobs(data.jobs, newSession.parentID)
        const isGrandchild = parentSession?.parentID && isSessionInJobs(data.jobs, parentSession.parentID)
        if (isDirectChild || isGrandchild || newSession.parentID === props.sessionID) {
          debouncedRebuild()
        }
      }
    })

    const unsubSessionUpdated = sdk.event.on("session.updated", (event) => {
      queueUpdate(event.properties.info.id)
    })

    const unsubMessageUpdated = sdk.event.on("message.updated", (event) => {
      queueUpdate(event.properties.info.sessionID)
    })

    const unsubPartUpdated = sdk.event.on("message.part.updated", (event) => {
      queueUpdate(event.properties.part.sessionID)
    })

    onCleanup(() => {
      unsubSessionCreated()
      unsubSessionUpdated()
      unsubMessageUpdated()
      unsubPartUpdated()
    })

    return {
      data,
      rebuildTree,
    }
  },
})
