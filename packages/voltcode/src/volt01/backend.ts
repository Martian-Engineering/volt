import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { $ } from "bun"

export namespace Volt01 {
  const log = Log.create({ service: "volt01" })

  export type InitStatus = "missing" | "pending" | "queued" | "cloning" | "training" | "ready" | "failed"

  export interface InitState {
    repoID: string
    state: InitStatus
    progress: number
    detail?: string
    lastUpdate: number
    gitRemote?: string
  }

  const INIT_STATE_KEY = ["volt01", "init_state"]

  async function getInitState(repoID: string): Promise<InitState | undefined> {
    try {
      const allStates = await Storage.read<Record<string, InitState>>(INIT_STATE_KEY)
      return allStates?.[repoID]
    } catch {
      return undefined
    }
  }

  async function setInitState(repoID: string, state: Partial<InitState>): Promise<InitState> {
    const allStates = (await Storage.read<Record<string, InitState>>(INIT_STATE_KEY)) || {}
    const existing = allStates[repoID] || {
      repoID,
      state: "missing" as InitStatus,
      progress: 0,
      lastUpdate: Date.now(),
    }
    const updated = {
      ...existing,
      ...state,
      lastUpdate: Date.now(),
    }
    allStates[repoID] = updated
    await Storage.write(INIT_STATE_KEY, allStates)
    return updated
  }

  async function clearInitState(repoID: string): Promise<void> {
    const allStates = (await Storage.read<Record<string, InitState>>(INIT_STATE_KEY)) || {}
    delete allStates[repoID]
    await Storage.write(INIT_STATE_KEY, allStates)
  }

  export interface InitRequest {
    repo_id: string
    vcs: "git"
    name?: string
  }

  export interface InitResponse {
    repo_id: string
    git_remote: string
    state: InitStatus
  }

  export interface StatusResponse {
    repo_id: string
    state: InitStatus
    progress: number
    detail?: string
  }

  export interface FeedbackRequest {
    repo_id: string
    session_id: string
    message_id: string
    rating: "up" | "down"
    notes?: string
  }

  export interface RememberRequest {
    repo_id: string
    session_id: string
    text: string
    scope: "repo" | "user"
    tags?: string[]
  }

  interface ToolResultRequest {
    repo_id: string
    session_id: string
    tool_call_id: string
    stdout: string
    stderr: string
    exit_code: number
    meta?: Record<string, any>
  }

  async function getBaseURL(): Promise<string | undefined> {
    const config = await Config.get()
    const provider = config.provider?.["voltcode"] || config.provider?.["br"]
    if (!provider?.options?.baseURL) return undefined
    return provider.options.baseURL
  }

  async function getAPIKey(): Promise<string | undefined> {
    const config = await Config.get()
    const provider = config.provider?.["voltcode"] || config.provider?.["br"]
    if (provider?.options?.apiKey) return provider.options.apiKey

    const { Auth } = await import("@/auth")
    const auth = (await Auth.get("voltcode")) || (await Auth.get("br"))
    if (auth?.type === "api") return auth.key

    return undefined
  }

  async function fetchAPI<T>(path: string, sessionID?: string, options: RequestInit = {}): Promise<T> {
    const baseURL = await getBaseURL()
    const apiKey = await getAPIKey()

    if (!baseURL) {
      throw new Error("Volt01 backend not configured. Set provider.br.options.baseURL in voltcode.json")
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    }

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    headers["x-voltcode-project"] = Instance.project.id

    if (sessionID) {
      headers["x-voltcode-session"] = sessionID
    }

    const url = `${baseURL}${path}`
    log.debug("fetchAPI", { url, method: options.method })

    const response = await fetch(url, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error")
      log.error("fetchAPI failed", { url, status: response.status, error })
      throw new Error(`Volt01 API error: ${response.status} ${error}`)
    }

    return response.json() as Promise<T>
  }

  export async function initRepo(input: { repoID?: string; name?: string } = {}): Promise<InitResponse> {
    const repoID = input.repoID || Instance.project.id
    log.info("initRepo", { repoID })

    const request: InitRequest = {
      repo_id: repoID,
      vcs: "git",
      name: input.name,
    }

    const response = await fetchAPI<InitResponse>("/v1/repo/init", undefined, {
      method: "POST",
      body: JSON.stringify(request),
    })

    await setInitState(repoID, {
      state: response.state,
      progress: 0,
      gitRemote: response.git_remote,
    })

    return response
  }

  export async function getInitStatus(repoID?: string): Promise<StatusResponse> {
    const id = repoID || Instance.project.id
    log.debug("getInitStatus", { repoID: id })

    const response = await fetchAPI<StatusResponse>(`/v1/repo/${id}/init/status`)

    await setInitState(id, {
      state: response.state,
      progress: response.progress,
      detail: response.detail,
    })

    return response
  }

  export async function getCachedInitState(repoID?: string): Promise<InitState | undefined> {
    const id = repoID || Instance.project.id
    return getInitState(id)
  }

  export async function sendFeedback(input: FeedbackRequest): Promise<void> {
    log.info("sendFeedback", { session_id: input.session_id, rating: input.rating })

    await fetchAPI<void>(`/v1/session/${input.session_id}/feedback`, input.session_id, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  export async function sendRemember(input: RememberRequest): Promise<void> {
    log.info("sendRemember", { session_id: input.session_id, scope: input.scope })

    await fetchAPI<void>(`/v1/session/${input.session_id}/remember`, input.session_id, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  export async function sendToolResult(input: ToolResultRequest): Promise<void> {
    log.debug("sendToolResult", { tool_call_id: input.tool_call_id })

    await fetchAPI<void>(`/v1/session/${input.session_id}/tool-result`, input.session_id, {
      method: "POST",
      body: JSON.stringify(input),
    }).catch((error) => {
      log.warn("Failed to send tool result", { error })
    })
  }

  export async function mirrorPush(gitRemote: string): Promise<void> {
    log.info("mirrorPush", { gitRemote })

    const result = await $`git push --mirror ${gitRemote}`.cwd(Instance.worktree).quiet().nothrow()

    if (result.exitCode !== 0) {
      const error = result.stderr?.toString().trim() || "Unknown error"
      log.error("mirrorPush failed", { error })
      throw new Error(`Failed to mirror-push git repo: ${error}`)
    }

    log.info("mirrorPush completed successfully")
  }

  export async function isConfigured(): Promise<boolean> {
    try {
      const url = await getBaseURL()
      return url !== undefined
    } catch {
      // If Instance context isn't available yet, we're not configured
      return false
    }
  }

  const pollers = new Map<string, NodeJS.Timeout>()

  export async function startPolling(repoID?: string): Promise<void> {
    const id = repoID || Instance.project.id
    if (pollers.has(id)) {
      log.debug("Already polling", { repoID: id })
      return
    }

    log.info("Starting init status polling", { repoID: id })

    const poll = async () => {
      try {
        const status = await getInitStatus(id)
        log.debug("Polling status", { repoID: id, state: status.state, progress: status.progress })

        if (status.state === "ready" || status.state === "failed") {
          log.info("Polling complete", { repoID: id, state: status.state })
          stopPolling(id)
          return
        }
      } catch (error) {
        log.error("Polling error", { repoID: id, error })
        stopPolling(id)
        return
      }
    }

    await poll()
    pollers.set(id, setInterval(poll, 10_000))
  }

  export function stopPolling(repoID?: string): void {
    const id = repoID || Instance.project.id
    const intervalId = pollers.get(id)
    if (intervalId) {
      clearInterval(intervalId)
      pollers.delete(id)
      log.debug("Stopped polling", { repoID: id })
    }
  }
}
