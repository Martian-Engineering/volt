export const TREE_CHARS = {
  vertical: "│",
  branch: "├",
  lastBranch: "└",
  horizontal: "─",
  space: " ",
}

export const STATUS_DOT = "●"

/**
 * Generate the tree prefix string for a node.
 * @param isLastAtLevel - Array where isLastAtLevel[i] indicates if the ancestor at depth i was the last child
 * @returns The prefix string like "│   ├── " or "    └── "
 */
export function getTreePrefix(isLastAtLevel: boolean[]): string {
  if (isLastAtLevel.length === 0) return ""

  // Each level is 4 chars
  // Ancestor levels: "│   " (has more children) or "    " (was last child)
  // Current level: "└── " (last child) or "├── " (has siblings after)
  const ancestorPrefixes = isLastAtLevel.slice(0, -1).map((wasLast) => (wasLast ? "    " : TREE_CHARS.vertical + "   "))

  const isLast = isLastAtLevel[isLastAtLevel.length - 1]
  const currentPrefix = isLast
    ? TREE_CHARS.lastBranch + TREE_CHARS.horizontal + TREE_CHARS.horizontal + " "
    : TREE_CHARS.branch + TREE_CHARS.horizontal + TREE_CHARS.horizontal + " "

  return ancestorPrefixes.join("") + currentPrefix
}

/**
 * Format a duration in human-readable form.
 * @param startTime - Start timestamp in ms
 * @param endTime - End timestamp in ms (defaults to now)
 * @returns Formatted string like "2s", "1m 23s", "1h 5m"
 */
export function formatDuration(startTime: number, endTime?: number): string {
  const elapsed = (endTime ?? Date.now()) - startTime
  const totalSeconds = Math.floor(elapsed / 1000)

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * Truncate text to max length, adding ellipsis if needed.
 * @param text - Text to truncate
 * @param maxLen - Maximum length including ellipsis
 * @returns Truncated text with "…" if it was truncated
 */
export function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 1) + "…"
}

/**
 * Format token count in compact form.
 * @param tokens - Number of tokens
 * @returns Formatted string like "1.2K" or "150K"
 */
export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? (tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1) + "K" : String(tokens)
}
