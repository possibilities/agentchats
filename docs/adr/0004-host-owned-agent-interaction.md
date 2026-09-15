# 4. Host-owned Agent interaction

Status: Superseded for AgentChats by [ADR 0008](0008-retire-the-web-conversation-reader.md); previously partially superseded by [ADR 0007](0007-voice-inspection-and-optional-interruption.md)
Date: 2026-09-13

## Context

Mike requested a reusable Agent composer for agentvoice, matching Codex queue,
steer and interrupt semantics with desktop controls. The agentchats reader remains
read-only. A shared presentation package must not discover a session, open a socket
or become a second queue dispatcher.

## Evidence

The official [app-server documentation](https://learn.chatgpt.com/docs/app-server)
distinguishes `turn/start`, `turn/steer` and `turn/interrupt`. Steering requires
`expectedTurnId` matching the active turn and does not create a new turn.
Interrupt acknowledgment is `{}`; `turn/completed` with `interrupted` is the
terminal state. Steering is not stop-then-send.

The agentvoice integration sibling inspected the installed desktop application:
`/Applications/ChatGPT.app/Contents/Resources/app.asar`, version 26.901.51231,
build 8109. Relevant assets are `app-initial-cadb12d4a15e.js` (configuration,
submission coordinator and interrupt), `app-primary-6cd7b8b3f5e3.js` (composer
controls), and `queued-message-list-ad772586ca15.js` (queue actions). Its schema
defaults `followUpQueueMode` to `steer`; the IDE extension defaults to `queue`.
The shared default follows the requested desktop model. Local CLI source at
`codex-viewer/codex`, commit `d6ce3c6a70`, confirms distinct queued and pending
steering inputs in `codex-rs/tui/src/chatwidget/input_queue.rs`, submission in
`input_submission.rs`, and app-server integration in `app_server_session.rs`.

## Decision

Export `TranscriptComposer` from `@agentchats/transcript/react`, composed as a
sibling below `Transcript`. Keep the Human / Agent vocabulary and arthack styles.

| Context | Desktop-style control | Host action |
| --- | --- | --- |
| Idle, text entered | Send | Start a turn in the selected session |
| Active, text entered | Steer or Queue, selected in a menu | Steer the exact current turn, or append to the host FIFO |
| Active, empty composer | Stop | Interrupt the exact current turn; await terminal notification |
| Queued row | Steer, Edit, Remove | Apply now, edit in place, or remove the queued item |
| Paused queued row | Reason and explicit Resume when permitted | Resume only when delivery and session identity permit it |

Enter submits, Shift+Enter inserts a newline, and Cmd/Ctrl+Shift+Enter inverts the
active follow-up mode for one message. IME composition does not submit.
No TUI palette, terminal chrome, slash-command interpretation or global keyboard
binding is introduced.

`active`, `pending`, `stopping` and `disabled` are separate. The component blocks
duplicate requests, retains text on rejection, and clears it only after callback
acceptance. Changing `transcriptId` remounts local draft/error/edit state. Hosts
must use a view-incarnation identity and fence late transport results themselves.

The host owns ordered queue storage and dispatches at most one item when idle.
Stop and failures pause remaining queue entries; the component never drains or
retries a queue. Per-row disabled/steer/resume capabilities let the host expose
an uncertain-delivery explanation without enabling a duplicate submission.
Editing first awaits host acceptance so the dispatcher can pause the row. Save
updates its original position; cancel restores the previous composer draft.

## Host continuity amendment (2026-09-14)

Hosts that keep a fixed composer dock can opt into `alwaysShowSend`. The normal
composer action then remains **Send** while idle, active, empty, or pending; the
button disables when it cannot act, active work appears as a separate **Working**
status, and the steer/queue selector still chooses transport behavior. Explicit
queue editing remains **Save queued message** because it updates an existing row.

Hosts can separately opt into `optimisticSubmit`. The component clears submitted
text before awaiting transport, supplies a stable `{ clientId, mode }` submission
identity, and leaves the textarea writable while preventing duplicate dispatch.
A definite rejection restores the submitted text only when no newer draft exists;
otherwise recovery preserves both texts and never retries. Every later failure
remains available until the person explicitly restores or dismisses it. The provider-neutral
`deliveryStatus` message field lets the host describe an optimistic Human row
until that same client ID reconciles with the transcript source.

## Durable composer amendment (2026-09-14)

Hosts can opt into browser recovery with a stable opaque `persistenceScope` for
one workspace, thread, and lane. This identity is independent of transient reader
incarnations. The shared composer retains the main draft, local follow-up mode,
failed-submission recoveries, submitted text awaiting an authoritative echo, and
the current queued edit plus its saved main draft. `observedSubmissionIds`
removes only exact reconciled client IDs. A restored pending submission becomes
an explicit delivery-unknown recovery and is never sent automatically.

Browser storage is best effort. Security policy, quota, eviction, and manual
clearing can prevent recovery; the composer reports storage failure while keeping
the current in-memory text and allowing an authorized send. Writes are batched
during typing and flushed for submission and page hiding. Each tab writes a
separate slot. A new browser session exposes text from another slot as a recovery
instead of silently replacing its own draft. One mounted composer owns a scope
within a document. Hosts must supply distinct lane scopes.

A queued edit restored after a full reload rechecks the row hold through
`onEditingQueuedChange(id)` before Save. Cancel and successful Save release the
host hold with `onEditingQueuedChange(null)`. `actionsDisabled` gates transport
and queue controls during reconnect while leaving the textarea writable;
`disabled` retains the stronger whole-field behavior.

Visible Working copy is replaced by an accessible full-width activity divider at
the composer boundary. It occupies no layout height, animates only while active,
and becomes a still accent line under reduced-motion preference.

Package 0.3.6 adds an optional `persistenceInstanceId` for hosts that can prove a
stable single-window identity across web-process replacement. The instance and
scope address the same durable slot directly; ordinary browser tabs omit the
instance and remain isolated. A compact synchronous entry journal protects the
latest textarea change before the batched full-state write, including queued-edit
identity, text, and saved main draft. Pending submissions remain full-state
records and are never replayed after recovery.

## Consequences

Agentvoice wires native app-server transport and exact thread/turn identity.
Other hosts can supply their own transport or omit unsupported callbacks. The
package ships reusable controls, not a provider client. The product mounts the
composer only in agentvoice's Agent pane, never its Voice pane or the agentchats
reader. Agentchats exports the component without mounting it; its existing reader
endpoints, local-origin guard and committed-history boundary remain read-only.
