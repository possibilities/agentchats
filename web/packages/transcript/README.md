# @agentchats/transcript

Composable Human / Agent transcripts for React 19. This is the 0.2 API,
prepared for local packaging; it has not been published to a registry.

The reader in this repository uses the same `Transcript` component. The package
ships no app shell, session picker, command UI, database reader, or server process.

## Entry points

| Import | Surface |
| --- | --- |
| `@agentchats/transcript` | `TranscriptMessage`, `TranscriptBlock`, snapshot/update/source types, `groupTranscript`, `activitySummary`, `mergeTranscript` |
| `@agentchats/transcript/react` | `Transcript`, `TranscriptBlock`, `TranscriptComposer`, `useTranscript` and their props/state types |
| `@agentchats/transcript/codex` | `createCodexTranscriptSource`, `CodexTransportOptions` |
| `@agentchats/transcript/styles.css` | Optional compiled arthack styles; no consumer Tailwind setup needed |

The data entry has no React, browser, provider, or storage dependency. The React
entry requires React and React DOM 19.2+. Styles use CSS `@scope` (Chromium 118+,
Safari 17.4+, Firefox 146+), and affect only `.agentchats-transcript` containers.
Geist is used when the host supplies it; system sans/mono fonts are fallbacks.
Pierre loads only when a file diff opens. Raw HTML in Markdown is not rendered.

## Rendering host-owned data

```tsx
import { Transcript } from '@agentchats/transcript/react'
import type { TranscriptMessage } from '@agentchats/transcript'
import '@agentchats/transcript/styles.css'

export function Lane({ id, messages }: { id: string; messages: readonly TranscriptMessage[] }) {
  return <div style={{ height: 600, display: 'flex', minWidth: 0 }}>
    <Transcript transcriptId={id} messages={messages} />
  </div>
}
```

`Transcript` takes `detail="messages" | "full"` (default Messages), `loading`,
`follow` (default true), and optional `header`, `footer`, and `empty` React nodes.
The host owns loading/error copy, titles, and controls. `aria-label` names each
lane; `viewportId` supplies a unique DOM anchor if needed. Constrain the parent's
height so the transcript can scroll. Changing `transcriptId`, detail, or loading
completion resets to the bottom. Idle and working transcripts behave identically.
Within 64 pixels of the bottom, new messages and growing same-ID revisions stay
at the end. Scrolling farther away preserves the reader's place and shows
**1 new message** / **N new messages**, counting newly added visible message IDs
(including individual activities in Full). Revisions do not increase the count.
The chip jumps to the end immediately, clears the count, and resumes follow;
scrolling back to the bottom also clears it. Each transcript owns its count.
`showJumpToLatest` defaults to true; set false only when the host supplies its own
navigation. `follow={false}` disables automatic following while retaining the
manual jump and unread count. Rendering
a new array with stable IDs preserves tool and diff disclosures during updates.

For a host-owned list or virtualizer, render `TranscriptBlock` for each result of
`groupTranscript(messages)`. A block is either a prose message or a consecutive
activity run; its ID is the first message ID. Both components include their own
required providers. Human / Agent are the presentation labels; standard data
roles remain `user`, `assistant`, `tool`, and `system`.

## Agent composer

Render `TranscriptComposer` as a sibling below the scrollable `Transcript`, inside
the same height-constrained flex column. Do not put it in the scrolling `footer`.
Use it only in lanes where the host can send Human input to the Agent.

```tsx
import { Transcript, TranscriptComposer } from '@agentchats/transcript/react'

<section style={{ height: 700, display: 'flex', flexDirection: 'column' }}>
  <Transcript transcriptId={viewId} messages={messages} />
  <TranscriptComposer
    transcriptId={viewId}
    active={turnRunning}
    pending={requestPending}
    stopping={awaitingInterruptedTurn}
    disabled={!connected}
    onSend={startTurn}
    onSteer={steerCurrentTurn}
    onQueue={enqueueFollowUp}
    onInterrupt={interruptCurrentTurn}
    queue={queuedMessages}
    onSteerQueued={steerQueuedMessage}
    onEditQueued={saveQueuedMessage}
    onRemoveQueued={removeQueuedMessage}
    onResumeQueued={resumeQueuedMessage}
    onEditingQueuedChange={pauseQueueForEditing}
  />
</section>
```

Callbacks return `void | Promise<void>`. The component awaits acceptance,
prevents duplicate requests, preserves rejected drafts, and shows the rejection's
message. There are no automatic retries. Use `transcriptId` for the host's view
incarnation, not just a reusable display title; changing it clears local drafts,
errors and editing state. Hosts still fence all transport and queue updates to
the exact session/turn and view that accepted the action.

Idle submit is **Send**. While `active`, submit is **Steer** or **Queue**, selected
in the menu. `followUpMode` optionally controls that setting, with
`onFollowUpModeChange`; otherwise it is local and defaults to desktop Codex's
`steer`. Missing callbacks disable the corresponding capability. Enter submits,
Shift+Enter adds a newline, and Cmd/Ctrl+Shift+Enter temporarily inverts the active
mode. IME composition does not submit. `placeholder`, `defaultValue`, `className`
and `aria-label` are optional; the default label is **Message Agent**.

An empty active composer shows **Stop**, which only calls `onInterrupt`. Keep
`stopping` true after the interrupt acknowledgment until the terminal event.
`pending` describes an in-flight host request; `active` describes running agent
work. Active work permits further input; pending/stopping prevent duplicate
operations. Hosts can independently disable the whole surface when unavailable.

`queue` is a host-owned ordered array of `TranscriptQueuedMessage`:
`{ id, text, pausedReason?, disabled?, canSteer?, canResume? }`. Hosts dispatch one
at a time on idle and pause remaining entries after Stop or a failure. The UI
does not drain the queue. `canSteer={false}` and `canResume={false}` disable those
actions for uncertain or stale entries. Resume requires `canResume: true` and a
paused reason. Omit callbacks for controls the host does not support.

Edit awaits `onEditingQueuedChange(id)` before restoring the row to the composer;
the host should pause/exclude that row from dispatch and reject a raced already-
sent row. Saving calls `onEditQueued(id, text)` to update the original queue
position, then awaits `onEditingQueuedChange(null)`. Cancel only releases editing
and restores the draft that was present before editing. Rejections keep the edit
available. See [ADR 0004](../../../docs/adr/0004-host-owned-agent-interaction.md)
in the source repository for the Codex desktop and app-server evidence.

## Live sources

```tsx
import { useTranscript, Transcript } from '@agentchats/transcript/react'
import { createCodexTranscriptSource } from '@agentchats/transcript/codex'

// Keep source identity stable. Defaults to the host's same-origin /api endpoint.
const source = createCodexTranscriptSource({ baseUrl: '/agent-history' })

export function LiveLane({ threadId }: { threadId: string }) {
  const { snapshot, loading, error, retry } = useTranscript(source, threadId)
  return <>
    {error ? <p role="alert">{error.message} <button onClick={retry}>Retry</button></p> : null}
    <Transcript transcriptId={threadId} messages={snapshot?.messages ?? []}
      loading={loading} />
  </>
}
```

`useTranscript(source, id, options)` watches by default, including while idle.
Pass `null` as the ID to remain inactive, `watch: false` to stop polling, or
`detail` / `pollIntervalMs` (default 1000, minimum 100). It serializes reads,
aborts on source/ID/detail changes and unmount, ignores late responses, keeps the
last snapshot on a polling failure, and retries polling automatically. `retry()`
reloads history. It does not read browser storage or change the URL.

A source implements `load({ id, detail, signal })` and
`poll({ id, detail, cursor, signal })`. `load` returns a full ordered snapshot;
`poll` returns an ordered delta. Message `createdAt` is optional: omit it when the source does not report a time;
the renderer then shows the author without a clock. Never synthesize timestamps
for historical items. IDs must be unique within a transcript and stable
across updates. New IDs append; an existing ID replaces that message in place
(e.g. streaming voice text). Omitted IDs are retained. Deletion, insertion before
existing messages, and reordered history require a fresh full load. Return the
cursor even when a delta has no visible messages. Cursors are opaque strings,
scoped to a source, transcript ID, and detail level. Sources must honor the abort
signal and reject failed reads; the hook also guards against late resolutions.

The Codex adapter translates the existing `/threads/:id` and `/items` HTTP
responses into this contract. `baseUrl` changes the endpoint prefix; optional
`fetch` lets the host own authentication or transport. This does **not** bypass
agentchats' exact-origin guard. External UIs need a same-origin server proxy or a
host-owned source; importing the package does not grant cross-origin access.

## Agentvoice boundary

The intended consumer composes two independently labelled lanes with no toolbar:
voice transcript data on one side, agent transcript data on the other. Keep both
sources watching. An agentvoice adapter should connect to the already running
agentvoice server and map its records into this source contract. Its host should
show **“no agent voice server”** when that server is unavailable. Starting servers,
voice controls, server discovery, and guessing the agentvoice wire protocol do not
belong in this package. No agentvoice application is included in this foundation.

## Build and pack in this checkout

```sh
npm --prefix web ci
npm --prefix web run build:package
npm --prefix web run test:package  # isolated tarball install + strict consumer typecheck
(cd web && npm pack --workspace @agentchats/transcript --pack-destination /tmp)
```

The package manifest lives here; its shared implementation is in
`web/src/transcript/` and the private renderers it imports. The build emits only
public entry points, their private chunks/declarations, and scoped CSS into
`dist/`. Export maps exclude app and database internals. `bun run web:check` builds
both app and package; `bun run web:test` includes source-contract tests and a
browser consumer importing the built package without app styles.
