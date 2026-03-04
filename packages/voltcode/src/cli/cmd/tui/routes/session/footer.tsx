import { createMemo, Match, onCleanup, onMount, Show, Switch, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/dialog-model"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useArgs } from "../../context/args"
import { Volt01 } from "@/volt01/backend"
import { useSDK } from "../../context/sdk"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

type InitState = Volt01.InitState

export function Footer(props: { contextOverride?: () => { tokens: number; maxTokens: number } | null }) {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const args = useArgs()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()

  // Context usage for dev mode
  const messages = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.message[route.data.sessionID] ?? []
  })

  const context = createMemo(() => {
    if (!args.dev) return null
    // Use override from /compact if available (immediate feedback)
    const override = props.contextOverride?.()
    if (override) {
      return {
        tokens: override.tokens.toLocaleString(),
        percentage: Math.round((override.tokens / override.maxTokens) * 100),
      }
    }
    const last = messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage
    if (!last) return null
    const total =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      tokens: total.toLocaleString(),
      percentage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  const [volt01State, setVolt01State] = createSignal<InitState | undefined>(undefined)
  const [volt01Configured, setVolt01Configured] = createSignal<boolean>(false)

  onMount(async () => {
    // Volt01 init state monitoring
    const configured = await Volt01.isConfigured()
    setVolt01Configured(configured)
    if (!configured) return

    Volt01.getCachedInitState().then((state) => {
      setVolt01State(state)
      if (state && state.state !== "ready" && state.state !== "failed") {
        Volt01.startPolling()
      }
    })

    const cleanup = setInterval(async () => {
      const newState = await Volt01.getCachedInitState()
      setVolt01State(newState)
    }, 5_000)

    onCleanup(() => {
      clearInterval(cleanup)
      Volt01.stopPolling()
    })
  })

  const trainingProgress = createMemo(() => {
    if (!volt01Configured() || !volt01State()) return null
    const state = volt01State()
    if (!state) return null
    if (state.state === "ready") return "Model: ready"
    if (state.state === "failed") return "Model: failed"
    if (state.state === "missing") return null
    const pct = Math.round(state.progress * 100)
    return `Model: init ${pct}%`
  })

  // Compaction indicator (in-memory state via events, keyed by sessionID)
  const sdk = useSDK()
  const [compactionStates, setCompactionStates] = createSignal<
    Record<string, { startedAt: number; blocking: boolean }>
  >({})

  // Get compaction state for the current session only
  const compactionState = createMemo(() => {
    if (route.data.type !== "session") return null
    return compactionStates()[route.data.sessionID] ?? null
  })

  onMount(() => {
    // Subscribe to compaction events
    // Note: We only learn about compaction via events - no initial state check needed.
    // On fresh startup, the server's in-memory state is empty, and the TUI starts clean.
    const unsubStarted = sdk.event.on("lcm.compaction.started", (event) => {
      setCompactionStates((prev) => ({
        ...prev,
        [event.properties.sessionID]: { startedAt: Date.now(), blocking: event.properties.blocking },
      }))
    })

    const unsubEnded = sdk.event.on("lcm.compaction.ended", (event) => {
      setCompactionStates((prev) => {
        const next = { ...prev }
        delete next[event.properties.sessionID]
        return next
      })
    })

    onCleanup(() => {
      unsubStarted()
      unsubEnded()
    })
  })

  const [elapsed, setElapsed] = createSignal(0)

  onMount(() => {
    const timer = setInterval(() => {
      const info = compactionState()
      if (info) {
        setElapsed(Math.floor((Date.now() - info.startedAt) / 1000))
      } else {
        setElapsed(0)
      }
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5_000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={trainingProgress()}>
              <text fg={theme.text}>{trainingProgress()}</text>
            </Show>
            <Show when={compactionState()}>
              <text fg={theme.warning}>
                {compactionState()!.blocking ? "Waiting for compaction..." : "Compacting..."} {elapsed()}s
              </text>
            </Show>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <Show when={context()}>
              <text fg={theme.accent}>
                {context()!.tokens} ({context()!.percentage ?? 0}%)
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
