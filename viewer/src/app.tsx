// The viewer shell: chromeless per the fleet contract — the transcript owns
// the whole viewport, the session's identity is subject data at the top of the
// scroll (it scrolls away), live status is an in-body working row at the tail,
// and the one fixed row is the failure state. Every action lives in the
// ctrl+k palette; direct hotkeys stay live while it is closed.
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { CliRenderEvents, RGBA, TextAttributes, type ParsedKey, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { AssistantMessage as AssistantInfo, UserMessage as UserInfo } from "./vendor/types"
import { AssistantMessage, TranscriptContext, UserMessage } from "./vendor/renderer"
import { CustomSpeedScroll } from "./vendor/scroll"
import { Locale } from "./vendor/locale"
import { Spinner } from "./vendor/spinner"
import { nextThinkingMode } from "./vendor/thinking"
import { useSync } from "./store"
import { theme, SIGNAL_ROOM, useTheme } from "./theme"
import {
  conceal,
  diffWrapMode,
  setConceal,
  setDiffWrapMode,
  setShowDetails,
  setShowGenericToolOutput,
  setShowTimestamps,
  setThinkingMode,
  showDetails,
  showGenericToolOutput,
  showTimestamps,
  thinkingMode,
  tuiConfig,
} from "./config"
import { createPalette, type PaletteCommand } from "./palette"

const okColor = RGBA.fromHex(SIGNAL_ROOM.ok)
const dangerColor = RGBA.fromHex(SIGNAL_ROOM.danger)
const accentColor = RGBA.fromHex(SIGNAL_ROOM.accent)

export function App(props: { sessionID: string; live: boolean; gone: () => boolean; onQuit: () => void }) {
  const sync = useSync()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { syntax } = useTheme()
  void syntax()

  const session = createMemo(() => sync.session.get(props.sessionID))
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const status = createMemo(() => sync.data.session_status[props.sessionID])
  const working = createMemo(() => props.live && status()?.type === "busy")
  const lastAssistant = createMemo(() => messages().findLast((row) => row.role === "assistant"))
  const contentWidth = createMemo(() => dimensions().width - 4)

  const pending = createMemo(() => {
    const completed = messages().findLastIndex((row) => row.role === "assistant" && row.time.completed)
    const open = messages().findLastIndex(
      (row, index) => index > completed && row.role === "assistant" && !row.time.completed,
    )
    return open === -1 ? undefined : open
  })

  let scroll: ScrollBoxRenderable | undefined

  const commands: PaletteCommand[] = [
    { key: "G", label: () => "follow the tail", run: () => scroll?.scrollTo(scroll.scrollHeight) },
    { key: "g", label: () => "jump to the top", run: () => scroll?.scrollTo(0) },
    {
      key: "t",
      label: () => (thinkingMode() === "hide" ? "thinking — show" : "thinking — hide"),
      run: () => setThinkingMode(nextThinkingMode(thinkingMode())),
    },
    {
      key: "s",
      label: () => (showTimestamps() ? "timestamps — hide" : "timestamps — show"),
      run: () => setShowTimestamps((value) => !value),
    },
    {
      key: "d",
      label: () => (showDetails() ? "tool detail — hide" : "tool detail — show"),
      run: () => setShowDetails((value) => !value),
    },
    {
      key: "o",
      label: () => (showGenericToolOutput() ? "tool output — hide" : "tool output — show"),
      run: () => setShowGenericToolOutput((value) => !value),
    },
    {
      key: "c",
      label: () => (conceal() ? "markdown markers — show" : "markdown markers — conceal"),
      run: () => setConceal((value) => !value),
    },
    {
      key: "w",
      label: () => (diffWrapMode() === "word" ? "diff wrap — off" : "diff wrap — on"),
      run: () => setDiffWrapMode((value) => (value === "word" ? "none" : "word")),
    },
    { key: "q", label: () => "quit", run: () => props.onQuit() },
  ]
  const palette = createPalette(() => commands)

  useKeyboard((key: ParsedKey) => {
    if (key.ctrl && key.name === "k") {
      if (palette.open()) palette.hide()
      else palette.show()
      return
    }
    if (palette.handleKey(key)) return
    const page = Math.max(1, (scroll?.height ?? 10) - 1)
    if (key.name === "q") props.onQuit()
    else if (key.name === "j" || key.name === "down") scroll?.scrollBy(1)
    else if (key.name === "k" || key.name === "up") scroll?.scrollBy(-1)
    else if (key.name === "pagedown" || (key.ctrl && key.name === "d")) scroll?.scrollBy(Math.ceil(page / 2))
    else if (key.name === "pageup" || (key.ctrl && key.name === "u")) scroll?.scrollBy(-Math.ceil(page / 2))
    else if (key.name === "g" && key.shift) scroll?.scrollTo(scroll.scrollHeight)
    else if (key.name === "g") scroll?.scrollTo(0)
    else if (key.name === "t") setThinkingMode(nextThinkingMode(thinkingMode()))
    else if (key.name === "s") setShowTimestamps((value) => !value)
    else if (key.name === "d" && !key.ctrl) setShowDetails((value) => !value)
    else if (key.name === "o") setShowGenericToolOutput((value) => !value)
    else if (key.name === "c") setConceal((value) => !value)
    else if (key.name === "w") setDiffWrapMode((value) => (value === "word" ? "none" : "word"))
  })

  onMount(() => {
    const onSelection = (selection: { getSelectedText(): string }) => {
      const text = selection.getSelectedText()
      if (text) renderer.copyToClipboardOSC52(text)
    }
    renderer.on(CliRenderEvents.SELECTION, onSelection)
    onCleanup(() => renderer.off(CliRenderEvents.SELECTION, onSelection))
  })

  return (
    <TranscriptContext.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: props.sessionID,
        conceal,
        thinkingMode,
        showThinking: () => true,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        diffWrapMode,
        providers: () => new Map(),
        sync,
        tui: tuiConfig,
      }}
    >
      <box flexGrow={1} minHeight={0} backgroundColor={theme.background}>
        <scrollbox
          ref={(node: ScrollBoxRenderable) => (scroll = node)}
          stickyScroll={true}
          stickyStart="bottom"
          flexGrow={1}
          scrollAcceleration={new CustomSpeedScroll(3)}
          viewportOptions={{ paddingLeft: 2, paddingRight: 2 }}
          verticalScrollbarOptions={{ visible: false }}
        >
          <box height={1} />
          <Show when={session()}>
            {(current: () => NonNullable<ReturnType<typeof session>>) => (
              <box paddingBottom={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  <span style={{ fg: accentColor }}>▎ </span>
                  {current().title || current().id}
                </text>
                <text fg={theme.textMuted}>
                  {"  "}
                  {(lastAssistant() as AssistantInfo | undefined)?.mode ?? "session"} ·{" "}
                  {(lastAssistant() as AssistantInfo | undefined)?.modelID || "unknown model"} · {current().directory}
                </text>
                <text fg={theme.textMuted}>
                  {"  "}
                  {Locale.todayTimeOrDateTime(current().time.created)}
                </text>
              </box>
            )}
          </Show>
          <For each={messages()}>
            {(message, index) => (
              <Show
                when={message.role === "user"}
                fallback={
                  <AssistantMessage
                    last={lastAssistant()?.id === message.id}
                    message={message as AssistantInfo}
                    parts={sync.data.part[message.id] ?? []}
                  />
                }
              >
                <UserMessage
                  index={index()}
                  onMouseUp={() => {}}
                  message={message as UserInfo}
                  parts={sync.data.part[message.id] ?? []}
                  pending={pending()}
                />
              </Show>
            )}
          </For>
          <Show when={working()}>
            <box paddingLeft={3} marginTop={1}>
              <Spinner color={okColor}>WORKING</Spinner>
            </box>
          </Show>
          <box height={1} />
        </scrollbox>
        <Show when={props.gone()}>
          <box flexShrink={0} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
            <text fg={dangerColor}>○ SOURCE GONE · the session file was removed — [Q] QUIT</text>
          </box>
        </Show>
        <palette.Palette />
      </box>
    </TranscriptContext.Provider>
  )
}
