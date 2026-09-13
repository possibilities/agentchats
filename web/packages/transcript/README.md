# @agentchats/transcript

Composable Human / Agent transcripts for React 19. This is the initial 0.1 API,
prepared for local packaging; it has not been published to a registry.

The reader in this repository uses the same `Transcript` component. The package
ships no app shell, session picker, command UI, database reader, or server process.

## Entry points

| Import | Surface |
| --- | --- |
| `@agentchats/transcript` | `TranscriptMessage`, `TranscriptBlock`, snapshot/update/source types, `groupTranscript`, `activitySummary`, `mergeTranscript` |
| `@agentchats/transcript/react` | `Transcript`, `TranscriptBlock`, `useTranscript` and their props/state types |
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
