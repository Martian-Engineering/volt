import { type Accessor, createMemo, createSignal, Match, Switch } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { Session } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"

const Title = (props: { session: Accessor<Session> }) => {
  const { theme } = useTheme()
  return (
    <text fg={theme.text}>
      <span style={{ bold: true }}>#</span> <span style={{ bold: true }}>{props.session().title}</span>
    </text>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <Switch>
          <Match when={session()?.parentID}>
            <box flexDirection="row" gap={2}>
              <text fg={theme.text}>
                <b>Subagent session</b>
              </text>
              <box
                onMouseOver={() => setHover("parent")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.parent")}
                backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("prev")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.previous")}
                backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                </text>
              </box>
              <box
                onMouseOver={() => setHover("next")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => command.trigger("session.child.next")}
                backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                </text>
              </box>
              <box flexGrow={1} flexShrink={1} />
            </box>
          </Match>
          <Match when={true}>
            <box flexDirection="row" justifyContent="space-between" gap={1}>
              <Title session={session} />
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
