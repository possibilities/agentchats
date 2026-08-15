// The small hook surface the vendored renderer expects from the opencode TUI,
// re-provided over the viewer's own modules. Each shim notes the upstream
// context it stands in for.
import { RGBA } from "@opentui/core"
import { paths } from "../config"
import { SIGNAL_ROOM } from "../theme"
import { formatPath } from "./path"

const localColor = RGBA.fromHex(SIGNAL_ROOM.local)
const remoteColor = RGBA.fromHex(SIGNAL_ROOM.remote)

// context/local.tsx — agent identity colors. Signal Room token law: user
// speech is `local` (amber), any agent's output is `remote` (blue).
// Normalizers stamp user messages with agent "you".
export function useLocal() {
  return {
    agent: {
      color(agent: string | undefined) {
        return agent === "you" ? localColor : remoteColor
      },
    },
  }
}

// context/path-format.tsx — paths relative to the viewed session's directory.
export function usePathFormatter() {
  return {
    path: () => paths.directory,
    format: (input?: string) => formatPath(input, paths.directory, paths.home),
  }
}

// context/runtime.tsx — platform for path normalization.
export function useTuiTerminalEnvironment() {
  return { platform: process.platform }
}

// keymap — key labels for hint lines. The viewer advertises actions only in
// its command palette, so hint labels resolve empty and their rows are gated
// off in the vendored renderer.
export function useCommandShortcut(_command: string) {
  return () => ""
}

// route/dialog — subagent drill-down is a harness affordance; inert here.
export function useRoute() {
  return { navigate(_route: unknown) {} }
}

export function useDialog() {
  return { stack: [] as unknown[], replace(_factory: unknown) {}, clear() {} }
}

export const DialogAlert = {
  show(_dialog: unknown, _title: string, _message: string) {
    return Promise.resolve()
  },
}
