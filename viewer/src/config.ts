// Viewer display state: the toggles the renderer context and palette share.
// Module-level signals — the viewer is one window over one session at a time.
import { createSignal } from "solid-js"
import type { ThinkingMode } from "./vendor/thinking"

export const [conceal, setConceal] = createSignal(true)
export const [thinkingMode, setThinkingMode] = createSignal<ThinkingMode>("hide")
export const [showTimestamps, setShowTimestamps] = createSignal(false)
export const [showDetails, setShowDetails] = createSignal(true)
export const [showGenericToolOutput, setShowGenericToolOutput] = createSignal(false)
export const [diffWrapMode, setDiffWrapMode] = createSignal<"word" | "none">("word")
export const [animationsEnabled] = createSignal(true)
export const [follow, setFollow] = createSignal(true)

// The session's own directory (for relative path display) and the caller's
// home; set once at startup, before render.
export const paths = {
  directory: process.cwd(),
  home: process.env.HOME ?? "",
}

// Shape the vendored renderer reads from useTuiConfig(): only diff_style and
// scroll settings survive into the viewer.
export const tuiConfig: { diff_style?: "auto" | "stacked"; scroll_speed?: number } = {}
