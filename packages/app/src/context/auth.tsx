import { createContext, createSignal, onMount, onCleanup, type ParentProps, useContext } from "solid-js"
import type { SupabaseClient } from "@supabase/supabase-js"

declare global {
  interface Window {
    __VOLTCODE_CONFIG__?: {
      LOCALHOST_MODE?: boolean
      SUPABASE_URL?: string
      SUPABASE_ANON_KEY?: string
    }
  }
}

export function isLocalhostMode(): boolean {
  return window.__VOLTCODE_CONFIG__?.LOCALHOST_MODE === true
}

export type MachineStatus = "idle" | "provisioning" | "polling" | "ready" | "error"

interface AuthState {
  user: { id: string; email?: string } | null
  loading: boolean
  error: string | null
  machineStatus: MachineStatus
}

interface AuthContextValue {
  state: () => AuthState
  signInWithGoogle: () => Promise<void>
  signInWithGitHub: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>()

async function loadSupabase(): Promise<SupabaseClient> {
  const config = window.__VOLTCODE_CONFIG__
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase configuration in window.__VOLTCODE_CONFIG__")
  }
  const { createClient } = await import("@supabase/supabase-js")
  return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)
}

async function setAuthCookie(accessToken: string): Promise<void> {
  const resp = await fetch("/api/auth/cookie", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || "Failed to set auth cookie")
  }
}

async function clearAuthCookie(): Promise<void> {
  await fetch("/api/auth/cookie", { method: "DELETE" }).catch(() => {})
}

export function AuthProvider(props: ParentProps) {
  const [state, setState] = createSignal<AuthState>({
    user: null,
    loading: true,
    error: null,
    machineStatus: "idle",
  })

  let supabase: SupabaseClient | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  async function ensureMachineReady(accessToken: string) {
    setState((prev) => ({ ...prev, machineStatus: "provisioning", error: null }))

    const resp = await fetch("/api/machine/ensure", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => null)

    if (!resp || !resp.ok) {
      setState((prev) => ({ ...prev, machineStatus: "error", error: "Failed to provision machine" }))
      return
    }

    await setAuthCookie(accessToken).catch(() => {})

    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(
      async () => {
        if (!supabase) return
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (session?.access_token) {
          setAuthCookie(session.access_token).catch((err) => console.error("Cookie refresh failed:", err))
        }
      },
      10 * 60 * 1000,
    )

    setState((prev) => ({ ...prev, machineStatus: "polling" }))
    for (let i = 0; i < 60; i++) {
      const healthResp = await fetch("/global/health").catch(() => null)
      if (healthResp?.ok) {
        const ct = healthResp.headers.get("content-type") || ""
        if (ct.includes("application/json")) {
          setState((prev) => ({ ...prev, machineStatus: "ready" }))
          return
        }
      }
      if (healthResp && healthResp.status !== 503) {
        setState((prev) => ({ ...prev, machineStatus: "error", error: `Server error: ${healthResp.status}` }))
        return
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    setState((prev) => ({ ...prev, machineStatus: "error", error: "Connection timed out" }))
  }

  onMount(async () => {
    try {
      supabase = await loadSupabase()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Auth initialization failed"
      setState({ user: null, loading: false, error: message, machineStatus: "error" })
      return
    }

    const result = await supabase.auth.getSession()
    if (result.error) {
      setState({ user: null, loading: false, error: result.error.message, machineStatus: "idle" })
      return
    }

    const session = result.data.session
    if (session?.user) {
      setState({
        user: { id: session.user.id, email: session.user.email },
        loading: false,
        error: null,
        machineStatus: "idle",
      })
      ensureMachineReady(session.access_token)
    } else {
      setState({ user: null, loading: false, error: null, machineStatus: "idle" })
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        if (refreshTimer) clearInterval(refreshTimer)
        refreshTimer = null
        clearAuthCookie()
        setState({ user: null, loading: false, error: null, machineStatus: "idle" })
        return
      }
      if (event === "TOKEN_REFRESHED" && session?.access_token) {
        setAuthCookie(session.access_token).catch((err) =>
          console.error("Cookie refresh on TOKEN_REFRESHED failed:", err),
        )
        return
      }
      if (event === "SIGNED_IN" && session?.user) {
        setState((prev) => ({
          ...prev,
          user: { id: session.user.id, email: session.user.email },
          loading: false,
          error: null,
        }))
        ensureMachineReady(session.access_token)
      }
    })
  })

  onCleanup(() => {
    if (refreshTimer) clearInterval(refreshTimer)
  })

  async function signInWithOAuth(provider: "google" | "github") {
    if (!supabase) return
    setState((prev) => ({ ...prev, loading: true, error: null }))
    const result = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    })
    if (result.error) {
      setState((prev) => ({ ...prev, loading: false, error: result.error.message }))
    }
  }

  async function signOut() {
    if (!supabase) return
    setState((prev) => ({ ...prev, loading: true, error: null }))
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
    await clearAuthCookie()
    const { error } = await supabase.auth.signOut()
    if (error) {
      setState((prev) => ({ ...prev, loading: false, error: error.message }))
    }
  }

  return (
    <AuthContext.Provider
      value={{
        state,
        signInWithGoogle: () => signInWithOAuth("google"),
        signInWithGitHub: () => signInWithOAuth("github"),
        signOut,
      }}
    >
      {props.children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error("useAuth must be used within an AuthProvider")
  return context
}
