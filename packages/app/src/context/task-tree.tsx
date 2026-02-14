import { createStore, produce } from "solid-js/store"
import { onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

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

export interface TaskTreeData {
  rootSessionID: string
  tree: TaskNode | null
  totalCount: number
  activeCount: number
}

function countNodes(node: TaskNode | null): number {
  return node ? 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0) : 0
}

function countActive(node: TaskNode | null): number {
  return node
    ? (node.status === "running" ? 1 : 0) + node.children.reduce((sum, child) => sum + countActive(child), 0)
    : 0
}

function updateNodeInTree(tree: TaskNode | null, sessionID: string, updates: Partial<TaskNode>): TaskNode | null {
  if (!tree) return null
  if (tree.sessionID === sessionID) {
    return { ...tree, ...updates }
  }
  const updatedChildren = tree.children
    .map((child) => updateNodeInTree(child, sessionID, updates))
    .filter(Boolean) as TaskNode[]
  return { ...tree, children: updatedChildren }
}

function findNodeInTree(tree: TaskNode | null, sessionID: string): TaskNode | null {
  if (!tree) return null
  if (tree.sessionID === sessionID) return tree
  for (const child of tree.children) {
    const found = findNodeInTree(child, sessionID)
    if (found) return found
  }
  return null
}

function isSessionInTree(tree: TaskNode | null, sessionID: string): boolean {
  return findNodeInTree(tree, sessionID) !== null
}

export const { use: useTaskTree, provider: TaskTreeProvider } = createSimpleContext({
  name: "TaskTree",
  gate: false,
  init: (props: { sessionID: string }) => {
    const sdk = useSDK()
    const sync = useSync()

    const [data, setData] = createStore<TaskTreeData>({
      rootSessionID: props.sessionID,
      tree: null,
      totalCount: 0,
      activeCount: 0,
    })

    async function buildTree(sessionID: string): Promise<TaskNode | null> {
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
      const messageCompleted = lastAssistantMsg?.role === "assistant" && lastAssistantMsg.time.completed !== undefined
      const hasRunningOrPending = toolParts.some(
        (p) => p.type === "tool" && (p.state.status === "running" || p.state.status === "pending"),
      )

      const tokens =
        lastAssistantMsg?.role === "assistant"
          ? (() => {
              const used =
                lastAssistantMsg.tokens.input + lastAssistantMsg.tokens.output + lastAssistantMsg.tokens.cache.read
              const providerID = lastAssistantMsg.providerID
              const modelID = lastAssistantMsg.modelID
              const provider = sync.data.provider.all.find((p) => p.id === providerID)
              const model = provider?.models?.[modelID]
              const max = model?.limit?.context ?? 200000
              const percentage = Math.round((used / max) * 100)
              return { used, max, percentage }
            })()
          : undefined

      const childSessions = sync.data.session
        .filter((s) => s.parentID === sessionID)
        .sort((a, b) => a.time.created - b.time.created)
      const children: TaskNode[] = []
      for (const childSession of childSessions) {
        const childNode = await buildTree(childSession.id)
        if (childNode) children.push(childNode)
      }

      const allChildrenDone = children.length > 0 && children.every((c) => c.status !== "running")

      const status: "running" | "completed" | "failed" = hasError
        ? "failed"
        : hasRunningOrPending
          ? "running"
          : messageCompleted || allChildrenDone
            ? "completed"
            : "running"

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

    async function rebuildTree() {
      const tree = await buildTree(props.sessionID)
      setData({
        tree,
        totalCount: countNodes(tree),
        activeCount: countActive(tree),
      })
    }

    async function updateSession(sessionID: string, triggerRebuild: () => void) {
      if (!isSessionInTree(data.tree, sessionID) && sessionID !== props.sessionID) {
        const session = sync.session.get(sessionID)
        if (session?.parentID) {
          let current: typeof session | undefined = session
          while (current?.parentID) {
            if (isSessionInTree(data.tree, current.parentID) || current.parentID === props.sessionID) {
              triggerRebuild()
              return
            }
            current = sync.session.get(current.parentID)
          }
        }
        return
      }

      const nodeUpdate = await buildTree(sessionID)
      if (!nodeUpdate) return

      setData(
        produce((draft) => {
          if (draft.tree?.sessionID === sessionID) {
            Object.assign(draft.tree, nodeUpdate)
          } else if (draft.tree) {
            draft.tree = updateNodeInTree(draft.tree, sessionID, nodeUpdate)
          }
          draft.totalCount = countNodes(draft.tree)
          draft.activeCount = countActive(draft.tree)
        }),
      )
    }

    onMount(() => {
      rebuildTree()
    })

    const pendingUpdates = new Set<string>()
    let rebuildPending = false
    let rebuildInProgress = false

    const triggerRebuild = () => debouncedRebuild()

    const debouncedFlush = debounce(async () => {
      if (rebuildPending) return

      const sessions = Array.from(pendingUpdates)
      pendingUpdates.clear()
      for (const sessionID of sessions) {
        updateSession(sessionID, triggerRebuild)
      }
    }, 250)

    const debouncedRebuild = debounce(async () => {
      if (rebuildInProgress) {
        rebuildPending = true
        return
      }

      rebuildInProgress = true
      rebuildPending = false
      pendingUpdates.clear()

      try {
        await rebuildTree()
      } finally {
        rebuildInProgress = false
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
      if (newSession.parentID) {
        const parentSession = sync.session.get(newSession.parentID)
        const isDirectChild = isSessionInTree(data.tree, newSession.parentID)
        const isGrandchild = parentSession?.parentID && isSessionInTree(data.tree, parentSession.parentID)
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
      findNode: (sessionID: string) => findNodeInTree(data.tree, sessionID),
    }
  },
})
