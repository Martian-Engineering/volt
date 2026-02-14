import { Flag } from "@/flag/flag"

export type ColorDepth = "truecolor" | "256" | "16"

export interface TerminalColorCapability {
  depth: ColorDepth
  isAppleTerminal: boolean
  supportsColorTerm: boolean
  warning?: string
}

/**
 * Detects the terminal's color capabilities.
 *
 * Apple Terminal.app doesn't support truecolor (24-bit RGB) escape sequences.
 * macOS Tahoe (Summer 2025) introduces truecolor support to Terminal.app.
 *
 * Detection logic:
 * 1. If VOLTCODE_COLOR_DEPTH is set, use that override
 * 2. If COLORTERM=truecolor or 24bit, assume truecolor support
 * 3. If TERM_PROGRAM=Apple_Terminal, default to 256-color (no truecolor)
 * 4. Otherwise, assume truecolor support (modern terminals)
 */
export function detectTerminalColorCapability(): TerminalColorCapability {
  const termProgram = process.env["TERM_PROGRAM"]
  const colorTerm = process.env["COLORTERM"]
  const term = process.env["TERM"]

  const isAppleTerminal = termProgram === "Apple_Terminal"
  const supportsColorTerm = colorTerm === "truecolor" || colorTerm === "24bit"

  // Manual override takes precedence
  if (Flag.VOLTCODE_COLOR_DEPTH && Flag.VOLTCODE_COLOR_DEPTH !== "auto") {
    return {
      depth: Flag.VOLTCODE_COLOR_DEPTH,
      isAppleTerminal,
      supportsColorTerm,
    }
  }

  // COLORTERM=truecolor is a strong signal
  if (supportsColorTerm) {
    return {
      depth: "truecolor",
      isAppleTerminal,
      supportsColorTerm,
    }
  }

  // Apple Terminal doesn't support truecolor (until macOS Tahoe)
  if (isAppleTerminal) {
    return {
      depth: "256",
      isAppleTerminal,
      supportsColorTerm,
      warning: [
        "Apple Terminal.app doesn't support 24-bit (truecolor) colors.",
        "Colors may appear incorrect or missing.",
        "",
        "Options:",
        "  1. Use iTerm2 or another terminal with truecolor support",
        "  2. Upgrade to macOS Tahoe (includes truecolor Terminal.app)",
        "  3. Set VOLTCODE_COLOR_DEPTH=256 to suppress this warning",
        "",
        "More info: https://opencode.ai/docs/terminal-colors",
      ].join("\n"),
    }
  }

  // Check TERM for 256color support hint
  if (term?.includes("256color")) {
    // Terminal advertises 256-color but not truecolor
    // Most modern terminals still support truecolor even without COLORTERM
    return {
      depth: "truecolor",
      isAppleTerminal,
      supportsColorTerm,
    }
  }

  // Default: assume truecolor (most modern terminals support it)
  return {
    depth: "truecolor",
    isAppleTerminal,
    supportsColorTerm,
  }
}

/**
 * Returns true if the current terminal likely has limited color support.
 */
export function hasLimitedColorSupport(): boolean {
  const cap = detectTerminalColorCapability()
  return cap.depth !== "truecolor"
}

/**
 * Returns a warning message if the terminal has known color limitations,
 * or undefined if no warning is needed.
 */
export function getTerminalColorWarning(): string | undefined {
  // Don't warn if user has explicitly set color depth
  if (Flag.VOLTCODE_COLOR_DEPTH) {
    return undefined
  }

  const cap = detectTerminalColorCapability()
  return cap.warning
}
