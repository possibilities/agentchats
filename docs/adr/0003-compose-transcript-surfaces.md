# 3. Compose transcript surfaces

Status: Accepted
Date: 2026-09-13

## Context

Mike requested removing the reader's command UI, opening all conversations at the
latest message, consistent Human / Agent labels, and a publishable component and
transcript API for external UIs. Agentvoice is the first intended consumer: two
live transcript lanes with no additional controls.

## Decision

Remove the command palette, its icons, shortcut, and collapse-all mechanism.
Preserve Messages / Full, Watch live, initially collapsed tools and Pierre diffs,
and the arthack web design. Initial history and density/session changes start at
the bottom even when idle or Watch is off; deliberate scrolling still releases
following. Human / Agent are the UI labels, independent of provider identifiers.

Add `@agentchats/transcript` as a separately packable package in
`web/packages/transcript`. Keep the shared implementation alongside the reader
while its first public API settles. The reader consumes its presentation entry;
a test host consumes the built package with its own layout and no app styles.

The pure data entry owns normalized messages, consecutive activity blocks,
opaque source cursors, snapshots/deltas, and immutable ID-based merging. The
React entry owns transcript/block rendering and an abortable live-reading hook.
Sources own provider mapping and transport; the separate Codex HTTP adapter wraps
the existing reader endpoints. Components expose composition slots and never
import session navigation, browser preferences, a server, or database discovery.
The optional stylesheet scopes the existing design to transcript containers.

## Long transcript amendment (2026-09-14)

The React entry offers an opt-in `windowed` transcript renderer for histories
where mounting every activity and Markdown subtree makes scrolling miss frames.
It virtualizes variable-height grouped blocks, retains the first visible block
across prepends, and counts unread messages from exact visible message IDs rather
than block count. The existing renderer remains the default. Both renderers keep
the same host slots, follow and jump behavior, disclosure provider, DOM roles,
and transcript-incarnation reset boundary.

## Consequences

The package can be built, packed, and installed without exporting the application
or duplicating renderers. React remains a peer; the data entry does not import it.
The live contract supports append and same-ID revision, including streaming voice
text. Other history changes require a full reload. The committed-history and
read-only index boundaries in ADR 0002 remain unchanged, as do serve, portless,
and the exact-origin guard. The package grants no additional origin access.

Agentvoice integration follows when its existing server protocol is connected
through a source adapter. The consumer owns connection discovery and the
“no agent voice server” state; this change does not build or start agentvoice.
