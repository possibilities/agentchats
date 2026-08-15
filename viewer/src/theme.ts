// The one theme this viewer ships: Signal Room, the fleet's design language
// (wiki: arthack-tui-design-language-signal-room), expressed as an opencode
// ThemeJson and resolved through the vendored theme machinery so every
// vendored renderer component reads house tokens.
//
// Token law notes:
// - user speech carries `local` (amber) via the agent color shim, agent
//   output carries `remote` (blue); see vendor/shims.ts.
// - diff pane backgrounds are principled derivations: canvas tinted toward
//   ok/danger, because Signal Room defines no dedicated diff surfaces.
import { SyntaxStyle, RGBA } from "@opentui/core"
import {
  generateSubtleSyntax,
  generateSyntax,
  resolveTheme,
  tint,
  type Theme,
  type ThemeJson,
} from "./vendor/theme-core"

export const SIGNAL_ROOM = {
  canvas: "#090c0e",
  field: "#0d1215",
  panel: "#131a1e",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  local: "#e2b56f",
  remote: "#7fb9e8",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const

const canvas = RGBA.fromHex(SIGNAL_ROOM.canvas)
const ok = RGBA.fromHex(SIGNAL_ROOM.ok)
const danger = RGBA.fromHex(SIGNAL_ROOM.danger)

const signalRoomJson: ThemeJson = {
  defs: { ...SIGNAL_ROOM },
  theme: {
    primary: "accent",
    secondary: "remote",
    accent: "accent",
    error: "danger",
    warning: "local",
    success: "ok",
    info: "remote",
    text: "text",
    textMuted: "muted",
    background: "canvas",
    backgroundPanel: "field",
    backgroundElement: "panel",
    backgroundMenu: "panel",
    border: "line",
    borderActive: "faint",
    borderSubtle: "line",
    diffAdded: "ok",
    diffRemoved: "danger",
    diffContext: "muted",
    diffHunkHeader: "muted",
    diffHighlightAdded: "ok",
    diffHighlightRemoved: "danger",
    diffAddedBg: tint(canvas, ok, 0.14),
    diffRemovedBg: tint(canvas, danger, 0.14),
    diffContextBg: "field",
    diffLineNumber: "muted",
    diffAddedLineNumberBg: tint(canvas, ok, 0.09),
    diffRemovedLineNumberBg: tint(canvas, danger, 0.09),
    markdownText: "text",
    markdownHeading: "accent",
    markdownLink: "remote",
    markdownLinkText: "remote",
    markdownCode: "ok",
    markdownBlockQuote: "muted",
    markdownEmph: "local",
    markdownStrong: "text",
    markdownHorizontalRule: "faint",
    markdownListItem: "accent",
    markdownListEnumeration: "remote",
    markdownImage: "remote",
    markdownImageText: "muted",
    markdownCodeBlock: "text",
    syntaxComment: "muted",
    syntaxKeyword: "accent",
    syntaxFunction: "remote",
    syntaxVariable: "text",
    syntaxString: "ok",
    syntaxNumber: "local",
    syntaxType: "local",
    syntaxOperator: "muted",
    syntaxPunctuation: "muted",
    thinkingOpacity: 0.6,
  },
}

export const theme: Theme = resolveTheme(signalRoomJson, "dark")

let syntaxStyle: SyntaxStyle | undefined
let subtleSyntaxStyle: SyntaxStyle | undefined

// Same call shape the vendored renderer used upstream, backed by process-
// lifetime singletons because the viewer's theme never changes.
export function useTheme() {
  return {
    theme,
    syntax: () => (syntaxStyle ??= generateSyntax(theme)),
    subtleSyntax: () => (subtleSyntaxStyle ??= generateSubtleSyntax(theme)),
  }
}
