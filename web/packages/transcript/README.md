# @agentchats/transcript

Composable Human / Agent transcripts for React 19. This is the 0.3 API,
prepared for local packaging; it has not been published to a registry.

The reader in this repository uses the same `Transcript` component. The package
ships no app shell, session picker, command UI, database reader, or server process.

## Entry points

| Import | Surface |
| --- | --- |
| `@agentchats/transcript` | `TranscriptMessage`, `TranscriptBlock`, snapshot/update/source types, `groupTranscript`, `activitySummary`, `mergeTranscript` |
| `@agentchats/transcript/react` | `Transcript`, `TranscriptBlock`, `TranscriptComposer`, `DocumentViewerProvider`, `useTranscript` and their props/state types |
| `@agentchats/transcript/codex` | `createCodexTranscriptSource`, `parseCodexMessagePresentation`, `mapCodexSubagentActivity`, `CodexTransportOptions` |
| `@agentchats/transcript/styles.css` | Optional compiled arthack styles; no consumer Tailwind setup needed |

The data entry has no React, browser, provider, or storage dependency. The React
entry requires React and React DOM 19.2+. Styles use CSS `@scope` (Chromium 118+,
Safari 17.4+, Firefox 146+), and affect only `.agentchats-transcript` containers.
Geist Mono is used for prose, labels, tools and the composer when the host supplies
it (for example, `import '@fontsource-variable/geist-mono'`). Otherwise the system
monospace stack is used. The stylesheet does not download fonts or restyle the host.
Pierre loads only when a file diff opens. Raw HTML in Markdown is not rendered.

The 0.3.8 presentation puts Human input and Agent replies on the same left edge,
using a flat inset for Human input and open space for replies. Reading text is
18px with 28px leading, message gaps are 24px (20px in narrow lanes), and prose
is capped at 80ch.
Code, tables and diffs can use the wider 1120px outer column. Transcript and composer
share that column. Container queries compact each lane independently, including
two narrow lanes in a wide window. Gutters shrink from 32px to 20px below 800px,
and 16px below 400px. Coarse pointers retain 44px controls.
`--transcript-column` and `--transcript-measure` can be overridden
on `.agentchats-transcript` in a host stylesheet. Remove older host overrides of
`.chat-transcript` padding/gap to adopt the shared density unchanged.

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
at the end. The first deliberate upward wheel, touch, or keyboard input releases
following immediately, including a one-pixel move within that threshold.
Scrolling away preserves the reader's place and shows
**1 new message** / **N new messages**, counting newly added visible message IDs
(including individual activities in Full). Revisions do not increase the count.
The chip jumps to the end immediately, clears the count, and resumes follow;
scrolling back to the bottom with deliberate downward input also clears it. Layout
and measurement scroll corrections do not change reading intent. Each transcript
owns its count.
`showJumpToLatest` defaults to true; set false only when the host supplies its own
navigation. `follow={false}` disables automatic following while retaining the
manual jump and unread count. Rendering a new array with stable IDs preserves
tool, group, and diff disclosures during updates, including a single activity
becoming a group or a group receiving prepended history. Disclosure state resets
only when `transcriptId` changes.

Set `windowed` for long transcripts. The opt-in renderer mounts only the visible
variable-height blocks plus a small overscan, preserves the first visible block
across prepended snapshots, and keeps exact per-message unread counts even when
several activities share one block. Its header, footer, empty state, follow,
jump, disclosure, viewport ID, and accessibility contracts match the default
renderer. The default remains available for small transcripts and compatibility.

Supply full text in `toolActivity.detail` and complete payloads in `sections`.
The collapsed row applies visual ellipsis; expansion exposes both the detail
and the sections, without duplicating detail already present in a section.
Tools without sections can still expand to read their detail and message content.
Expanded text preserves whitespace, wraps long lines, and scrolls within each
section. The Codex source retains full commands, search queries, and MCP payloads
returned by the reader API.

For a host-owned list or virtualizer, render `TranscriptBlock` for each result of
`groupTranscript(messages)`. A block is either a prose message or a consecutive
activity run; its ID is the first message ID. Both components include their own
required providers. Human / Agent are the presentation labels; standard data
roles remain `user`, `assistant`, `tool`, and `system`.

## Structured message presentation

User and assistant messages can carry `TranscriptMessage.presentation`, a provider-neutral
`TranscriptMessagePresentation`: `{ title, body, details?: [{ label, content }] }`.
Title, body and detail contents are plain text. `Transcript` and `TranscriptBlock`
show the body and preserve the exact `message.content`. Human **Via Voice**
messages use an upper-right inspection button opening a modal with **Displayed
text**, **Voice context**, and **Original message**. Other structured presentations
retain their inline disclosures. This metadata never overwrites the source record or changes
the Human / Agent author label.

For optimistic Human input, `TranscriptMessage.deliveryStatus` adds subdued,
provider-neutral status text to the message header. The host can show states such
as **Sending…**, **Accepted · waiting for transcript**, or **Delivery unknown**,
then omit the field when its stable message ID reconciles with the source record.

For Codex voice envelopes, the reader's adapter uses the exported helper:

```ts
import { parseCodexMessagePresentation } from '@agentchats/transcript/codex'

const message = {
  ...original,
  presentation: parseCodexMessagePresentation(original.content),
}
```

Complete canonical `<realtime_delegation>` envelopes show the actual `input`
under **Via Voice**, with `transcript_delta` retained in the inspection modal,
including context that repeats the displayed request. `transcript_tail_flush`
is labeled **Voice session ended**, with context and handoff instructions kept
in separate disclosures. Standard `<realtime_conversation>` start/end notices
also have readable summaries. XML entities are decoded once; no HTML is executed.

The parser returns `undefined` for partial/malformed envelopes, unknown fields
or sources, code examples, mixed prose, and custom conversation instructions.
Those messages retain normal rendering. Parsing belongs in the provider adapter;
the React components only consume presentation metadata. See
[the presentation decision](../../../docs/adr/0005-structured-transcript-presentation.md)
for source evidence and fallback boundaries.

Codex `subAgentActivity` records can use `mapCodexSubagentActivity`. It retains
each lifecycle record as a separate activity while presenting the agent path and
action in the collapsed row, with the path, thread, action, event ID, and original
record available in its disclosure. This keeps separate lifecycle events readable
when a host groups consecutive activity.

## Local Markdown documents

`DocumentViewerProvider` is an opt-in reader for local Markdown links rendered
inside its descendants. The shared package recognizes relative and absolute
`.md` and `.markdown` paths, including `:line[:column]` citations, plus local
`file:` and `wiki:` targets.
Ordinary `http(s)`, `mailto`, and other links keep the transcript's normal anchor
behavior. Recognition is only a UI routing decision: the host loader remains the
authority for readable roots and must reject untrusted or unavailable paths.

```tsx
import {
  DocumentViewerProvider,
  Transcript,
  type DocumentLoader,
} from '@agentchats/transcript/react'

const loadDocument: DocumentLoader = async ({ href, base, signal }) => {
  const response = await fetch('/api/document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ href, base }),
    signal,
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Document unavailable')
  return body // { title, path, content }
}

<DocumentViewerProvider load={loadDocument} resetKey={threadId}>
  <Transcript transcriptId={threadId} messages={messages} />
</DocumentViewerProvider>
```

`DocumentRequest` is `{ href, base? }`; the loader receives the same fields plus
an `AbortSignal` and returns `LoadedDocument` as `{ title, path, content }`.
Relative links inside a loaded document use the returned canonical `path` as
their next `base`. `canOpen` may further restrict candidates before opening.
`resetKey` closes and aborts the viewer on a real host reading-scope change while
leaving descendant transcript and composer state mounted; keep it stable across
polls and connection changes. Navigation retains at most 32 loaded documents and
ignores a repeated request for the current target. The viewer provides loading, errors with Retry,
document history with Back, Escape/Close, trapped focus with focus return,
heading anchors, tables, and highlighted code using the transcript's Markdown
renderer. Bounded leading YAML frontmatter stays available in a quiet raw
metadata disclosure while the Markdown body remains the reading focus. The
viewer displays both the returned canonical path and a differing source
href. Narrow layouts keep both complete values in a compact Source disclosure.
It never reads the filesystem, embeds remote content, or enables raw HTML.

## Agent composer

This is a package export for hosts. The product mounts it only in agentvoice's
Agent pane, never its Voice pane or the agentchats reader UI.

Render `TranscriptComposer` as a sibling of the scrollable `Transcript`. A host
can place it below the transcript or overlay it with measured footer clearance
and a raised jump-to-latest control. Do not put the composer inside the scrolling
`footer`.
Use it only in lanes where the host can send Human input to the Agent.
The placeholder identifies the field visually; `aria-label` names it accessibly.
There is no repeated label above the box. Keyboard focus belongs to the whole
input group, with no nested textarea ring.

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
    actionsDisabled={reconnecting}
    alwaysShowSend
    optimisticSubmit
    persistenceScope={workspaceThreadLaneKey}
    persistenceInstanceId={nativeWindowPersistenceId}
    observedSubmissionIds={reconciledClientIds}
    onSend={(text, submission) => startTurn(text, submission.clientId)}
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
message. There are no automatic retries. Without `persistenceScope`, use
`transcriptId` for the host's view incarnation; changing it clears local drafts,
errors and editing state. With persistence enabled, transient `transcriptId`
changes retain entry data and the host must change the stable scope for a real
thread or lane replacement. Hosts still fence transport and queue updates to the
exact session, turn, and view that accepted the action.

Idle submit is **Send**. While `active`, submit is **Steer** or **Queue**, selected
in the menu. `followUpMode` optionally controls that setting, with
`onFollowUpModeChange`; otherwise it is local and defaults to desktop Codex's
`steer`. Missing callbacks disable the corresponding capability. Enter submits,
Shift+Enter adds a newline, and Cmd/Ctrl+Shift+Enter temporarily inverts the active
mode. IME composition does not submit. `placeholder`, `defaultValue`, `className`
and `aria-label` are optional; the default label is **Message Agent**.

An empty active composer shows **Stop** when `onInterrupt` is supplied. Without
that callback, the shared activity divider conveys ongoing work while preserving
follow-up input. Keep `stopping` true after the interrupt acknowledgment until
the terminal event.
`pending` describes an in-flight host request; `active` describes running agent
work. Active work permits further input; pending/stopping prevent duplicate
operations. `actionsDisabled` disables host actions while keeping the draft
writable during reconnect. `disabled` disables the whole field.

`alwaysShowSend` is an opt-in host layout. It keeps the **Send** control in the
same bottom-right position for idle, active, empty, and pending states, disables
it when no action is available, and never substitutes Stop. While active, the
full-width activity divider reports **Agent is working** to assistive technology;
reduced-motion preferences replace its indeterminate movement with a still accent
line. The follow-up selector continues to choose the steer or queue callback even
though the action label stays **Send**.

`optimisticSubmit` clears the submitted draft before awaiting its callback and
keeps the textarea writable while the action remains disabled. Every send
callback receives `{ clientId, mode }` as its second argument so a host can key an
optimistic message and reconcile the exact transport result. A rejection restores
the submitted text when the new draft is empty. If the person has already typed
another draft, the error retains the submitted text with **Restore sent text**,
which appends it without overwriting the new draft. Each additional failure is
retained separately until the person restores or dismisses it; a later submit
never silently discards earlier text. Recovery never retries delivery.

`persistenceScope` enables best-effort browser recovery for the main draft, local
steer/queue choice, failed-submission recovery, submitted text awaiting exact
reconciliation, and queued-edit text plus the saved main draft. Supply one stable
opaque workspace + thread + lane identity per mounted composer; do not derive it
from a reader view UUID. Pass native client IDs already observed in the transcript
through `observedSubmissionIds`. Exact matches remove pending or recovered text
without clearing a newer draft.

`persistenceInstanceId` is an optional stable identity for a confirmed
single-window native host. Together with the scope, it restores that window's
draft directly after its web process is recreated. Ordinary browser hosts must
omit it so tabs keep separate slots. Supplying one shared instance ID to multiple
live windows makes them writers to the same slot and is unsupported.

Pending text restored after a reload is shown as delivery unknown and is never
resent automatically. Browser storage can be unavailable, full, evicted, or
cleared; the composer keeps working and reports that durable recovery is
unavailable. A compact entry journal records each textarea input synchronously;
the complete state remains batched and critical transitions flush immediately.
Input-method text is recoverable once the browser emits its input change. Tabs
use separate storage slots. When a newly created browser
session finds another slot, its text is offered as an explicit recovery instead
of copied into the active draft. Some browsers clone session storage when a tab
is duplicated; those two tabs can share a slot, where the latest write wins.
Separately, hosts should mount only one composer for a scope in each document.

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
available. A restored edit rechecks the host hold before Save; Cancel and a
successful Save release it. See [ADR 0004](../../../docs/adr/0004-host-owned-agent-interaction.md)
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

Hosts may pass `reachable` to `TranscriptComposer` for a three-pixel status
divider: bright ready, dim unavailable, and indeterminate working. Reachability
is independent of voice attachment and action pending state. Explicit false
suppresses stale working activity; it does not change action or draft policy.
Omitting the prop preserves the generic idle treatment. Status has accessible
text, and reduced motion keeps working still with unchanged geometry.

Voice inspection uses a square dialog with an accessible title and an inset
trigger, without a redundant comparison hint. Native form controls explicitly
inherit the transcript's monospace face.

Grouped activity children paint and measure normally inside the windowed outer
row. Nested content-visibility placeholders must not hide semantic tool entries
or reserve blank space in an expanded group. Activity IDs and raw payloads remain
distinct; grouping does not turn a second tool into lifecycle bookkeeping.
