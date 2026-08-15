// The command palette — the fleet contract's one action surface (wiki:
// fleet-tui-design). ctrl+k opens; while open it owns the keyboard: printable
// keys filter, arrows move, enter runs, esc/ctrl+k closes. Rows are pointer
// targets; the selected row carries the accent ▎ rail, never color alone.
// Each fleet repo owns its palette implementation; this one follows the
// agentusage/agentvoice anatomy on OpenTUI 0.4.
import { createMemo, createSignal, For, Show } from "solid-js"
import { RGBA } from "@opentui/core"
import type { ParsedKey } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { theme, SIGNAL_ROOM } from "./theme"

export type PaletteCommand = {
  key: string
  label: () => string
  run: () => void
}

const accent = RGBA.fromHex(SIGNAL_ROOM.accent)

export function createPalette(commands: () => PaletteCommand[]) {
  const [open, setOpen] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)

  const visible = createMemo(() => {
    const query = filter().toLowerCase()
    const all = commands()
    if (!query) return all
    return all.filter(
      (command) => command.label().toLowerCase().includes(query) || command.key.toLowerCase().includes(query),
    )
  })

  function show() {
    setFilter("")
    setSelected(0)
    setOpen(true)
  }

  function hide() {
    setOpen(false)
  }

  function move(delta: number) {
    const count = visible().length
    if (count === 0) return
    setSelected((current) => (current + delta + count) % count)
  }

  function runSelected() {
    const command = visible()[selected()]
    hide()
    command?.run()
  }

  // Returns true when the key was consumed (palette open owns the keyboard).
  function handleKey(key: ParsedKey): boolean {
    if (!open()) return false
    if (key.name === "escape" || (key.ctrl && key.name === "k")) {
      hide()
      return true
    }
    if (key.name === "return") {
      runSelected()
      return true
    }
    if (key.name === "up") {
      move(-1)
      return true
    }
    if (key.name === "down") {
      move(1)
      return true
    }
    if (key.name === "backspace") {
      setFilter((current) => current.slice(0, -1))
      setSelected(0)
      return true
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= " ") {
      setFilter((current) => current + key.sequence)
      setSelected(0)
      return true
    }
    return true
  }

  function Palette() {
    const dimensions = useTerminalDimensions()
    const width = createMemo(() => Math.min(44, dimensions().width - 4))
    // Window long lists around the selection so the box stays in the viewport.
    const windowed = createMemo(() => {
      const rows = Math.max(3, Math.min(visible().length, dimensions().height - 8))
      const start = Math.max(0, Math.min(selected() - Math.floor(rows / 2), visible().length - rows))
      return { start, rows }
    })
    return (
      <Show when={open()}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="center"
          justifyContent="center"
        >
          <box
            width={width()}
            border={true}
            borderColor={theme.border}
            backgroundColor={theme.backgroundElement}
            title=" COMMANDS "
            paddingLeft={1}
            paddingRight={1}
            onMouseScroll={(event: { scroll?: { direction?: string } }) => {
              move(event.scroll?.direction === "up" ? -1 : 1)
            }}
          >
            <text fg={theme.textMuted}>{"> "}{filter() || "type to filter"}</text>
            <box height={1} />
            <For each={visible().slice(windowed().start, windowed().start + windowed().rows)}>
              {(command, index) => {
                const at = createMemo(() => windowed().start + index())
                const isSelected = createMemo(() => at() === selected())
                return (
                  <box
                    flexDirection="row"
                    onMouseUp={() => {
                      setSelected(at())
                      runSelected()
                    }}
                  >
                    <text fg={accent}>{isSelected() ? "▎" : " "}</text>
                    <text fg={accent} attributes={1}>
                      {" [" + command.key + "] "}
                    </text>
                    <text fg={isSelected() ? theme.text : theme.textMuted}>{command.label()}</text>
                  </box>
                )
              }}
            </For>
            <Show when={visible().length === 0}>
              <text fg={theme.textMuted}>no matching command</text>
            </Show>
          </box>
        </box>
      </Show>
    )
  }

  return { open, show, hide, handleKey, Palette }
}
