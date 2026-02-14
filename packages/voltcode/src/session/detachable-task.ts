import { Instance } from "@/project/instance"

export namespace DetachableTask {
  interface DetachSignal {
    resolve: () => void
  }

  const state = Instance.state(() => {
    const signals: Map<string, DetachSignal> = new Map()
    return signals
  })

  /**
   * Register a session for potential detachment.
   * Returns a Promise that resolves when detach() is called for that session.
   */
  export function register(sessionID: string): Promise<void> {
    return new Promise((resolve) => {
      state().set(sessionID, { resolve })
    })
  }

  /**
   * Detach a running task by resolving its detach promise.
   * Returns true if there was a running task that was detached.
   */
  export function detach(sessionID: string): boolean {
    const signal = state().get(sessionID)
    if (!signal) return false
    signal.resolve()
    state().delete(sessionID)
    return true
  }

  /**
   * Clean up the detach signal for a session.
   * Should be called when a task completes normally (not detached).
   */
  export function unregister(sessionID: string): void {
    state().delete(sessionID)
  }
}
