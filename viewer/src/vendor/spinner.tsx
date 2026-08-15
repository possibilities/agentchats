// Vendored from opencode @ 4643e65ad6 — component/spinner.tsx, with the KV
// animations toggle replaced by the viewer's config signal.
import { Show } from "solid-js"
import { animationsEnabled } from "../config"
import { useTheme } from "../theme"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

if (!getComponentCatalogue().spinner) registerSpinner()

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
