// Legacy compaction module — gutted. LCM handles all context management.
// Exports are preserved as no-op stubs for callers that haven't been updated yet.

export namespace SessionCompaction {
  export async function isOverflow(_input: { tokens: unknown; model: unknown }) {
    return false
  }

  export async function prune(_input: { sessionID: string }) {}

  export async function process(_input: {
    parentID: string
    messages: unknown[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    return "continue" as const
  }

  export async function create(_input: {
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
    auto: boolean
  }) {}
}
