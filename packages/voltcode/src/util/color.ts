import { Flag } from "@/flag/flag"

export namespace Color {
  export function isValidHex(hex?: string): hex is string {
    if (!hex) return false
    return /^#[0-9a-fA-F]{6}$/.test(hex)
  }

  export function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return { r, g, b }
  }

  /**
   * Converts an RGB color to the nearest 256-color palette index.
   * Uses the 6x6x6 color cube (indices 16-231) for colors,
   * and grayscale ramp (indices 232-255) for grays.
   */
  export function rgbTo256(r: number, g: number, b: number): number {
    // Check if it's close to grayscale
    const isGray = Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(r - b) < 10

    if (isGray) {
      // Use grayscale ramp (232-255) for 24 shades of gray
      // Each step is about 10 units (8, 18, 28, ..., 238)
      const gray = Math.round((r + g + b) / 3)
      if (gray < 4) return 16 // Near black, use black from color cube
      if (gray > 243) return 231 // Near white, use white from color cube
      // Map to grayscale ramp (232-255)
      const index = Math.round((gray - 8) / 10)
      return Math.min(255, Math.max(232, 232 + index))
    }

    // Map to 6x6x6 color cube (indices 16-231)
    // Each channel maps 0-255 to 0-5
    const toComponent = (v: number) => {
      if (v < 48) return 0
      if (v < 115) return 1
      return Math.min(5, Math.round((v - 35) / 40))
    }

    const ri = toComponent(r)
    const gi = toComponent(g)
    const bi = toComponent(b)

    return 16 + 36 * ri + 6 * gi + bi
  }

  /**
   * Returns true if the terminal supports truecolor (24-bit) mode.
   * Checks VOLTCODE_COLOR_DEPTH and COLORTERM environment variables.
   */
  export function supportsTruecolor(): boolean {
    // Explicit override takes precedence
    if (Flag.VOLTCODE_COLOR_DEPTH === "256" || Flag.VOLTCODE_COLOR_DEPTH === "16") {
      return false
    }
    if (Flag.VOLTCODE_COLOR_DEPTH === "truecolor") {
      return true
    }

    // Check for truecolor support via COLORTERM
    const colorTerm = process.env["COLORTERM"]
    if (colorTerm === "truecolor" || colorTerm === "24bit") {
      return true
    }

    // Apple Terminal doesn't support truecolor
    const termProgram = process.env["TERM_PROGRAM"]
    if (termProgram === "Apple_Terminal") {
      return false
    }

    // Default to truecolor for modern terminals
    return true
  }

  /**
   * Generates an ANSI escape sequence for bold text with the specified foreground color.
   * Automatically uses 256-color mode for terminals that don't support truecolor.
   */
  export function hexToAnsiBold(hex?: string): string | undefined {
    if (!isValidHex(hex)) return undefined
    const { r, g, b } = hexToRgb(hex)

    if (supportsTruecolor()) {
      return `\x1b[38;2;${r};${g};${b}m\x1b[1m`
    }

    // Fall back to 256-color mode
    const colorIndex = rgbTo256(r, g, b)
    return `\x1b[38;5;${colorIndex}m\x1b[1m`
  }

  /**
   * Generates an ANSI escape sequence for the specified foreground color.
   * Automatically uses 256-color mode for terminals that don't support truecolor.
   */
  export function hexToAnsi(hex?: string): string | undefined {
    if (!isValidHex(hex)) return undefined
    const { r, g, b } = hexToRgb(hex)

    if (supportsTruecolor()) {
      return `\x1b[38;2;${r};${g};${b}m`
    }

    // Fall back to 256-color mode
    const colorIndex = rgbTo256(r, g, b)
    return `\x1b[38;5;${colorIndex}m`
  }

  /**
   * Generates an ANSI escape sequence for the specified background color.
   * Automatically uses 256-color mode for terminals that don't support truecolor.
   */
  export function hexToAnsiBg(hex?: string): string | undefined {
    if (!isValidHex(hex)) return undefined
    const { r, g, b } = hexToRgb(hex)

    if (supportsTruecolor()) {
      return `\x1b[48;2;${r};${g};${b}m`
    }

    // Fall back to 256-color mode
    const colorIndex = rgbTo256(r, g, b)
    return `\x1b[48;5;${colorIndex}m`
  }
}
