import { TextAttributes, RGBA } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"

// Shadow markers (rendered chars in parens):
// _ = full shadow cell (space with bg=shadow)
// ^ = letter top, shadow bottom (▀ with fg=letter, bg=shadow)
// ~ = shadow top only (▀ with fg=shadow)
const SHADOW_MARKER = /[_^~]/
const BOX_CHARS = "┌┐└┘─│"

const LOGO = [
  `┌─────────────────────────────────────────────────────────────────┐`,
  `│██╗   ██╗ ██████╗ ██╗  ████████╗ ██████╗ ██████╗ ██████╗ ███████╗│`,
  `│██║   ██║██╔═══██╗██║  ╚══██╔══╝██╔════╝██╔═══██╗██╔══██╗██╔════╝│`,
  `│██║   ██║██║   ██║██║     ██║   ██║     ██║   ██║██║  ██║█████╗  │`,
  `│╚██╗ ██╔╝██║   ██║██║     ██║   ██║     ██║   ██║██║  ██║██╔══╝  │`,
  `│ ╚████╔╝ ╚██████╔╝███████╗██║   ╚██████╗╚██████╔╝██████╔╝███████╗│`,
  `│  ╚═══╝   ╚═════╝ ╚══════╝╚═╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝│`,
  `└─────────────────────────────────────────────────────────────────┘`,
]

const SPLIT = 33
const LOGO_LEFT = LOGO.map((line) => line.slice(0, SPLIT))
const LOGO_RIGHT = LOGO.map((line) => line.slice(SPLIT))

export function Logo() {
  const { theme } = useTheme()

  const renderLine = (line: string, fg: RGBA, bold: boolean, boxFg: RGBA): JSX.Element[] => {
    const shadow = tint(theme.background, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    const elements: JSX.Element[] = []
    let buffer = ""
    let bufferFg = fg
    const flush = () => {
      if (!buffer) return
      elements.push(
        <text fg={bufferFg} attributes={attrs} selectable={false}>
          {buffer}
        </text>,
      )
      buffer = ""
    }

    for (let i = 0; i < line.length; i++) {
      const char = line[i] ?? ""
      if (SHADOW_MARKER.test(char)) {
        flush()
        switch (char) {
          case "_":
            elements.push(
              <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
                {" "}
              </text>,
            )
            break
          case "^":
            elements.push(
              <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
                ▀
              </text>,
            )
            break
          case "~":
            elements.push(
              <text fg={shadow} attributes={attrs} selectable={false}>
                ▀
              </text>,
            )
            break
        }
        continue
      }

      const charFg = BOX_CHARS.includes(char) ? boxFg : fg
      if (buffer && bufferFg !== charFg) {
        flush()
      }
      bufferFg = charFg
      buffer += char
    }
    flush()

    return elements
  }

  return (
    <box>
      <For each={LOGO_LEFT}>
        {(line, index) => (
          <box flexDirection="row" gap={0}>
            <box flexDirection="row">{renderLine(line, theme.textMuted, false, theme.text)}</box>
            <box flexDirection="row">{renderLine(LOGO_RIGHT[index()], theme.text, true, theme.text)}</box>
          </box>
        )}
      </For>
    </box>
  )
}
