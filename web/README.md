# Agentchats reader

An arthack reading room for local Codex conversations. Find a session, read the exchange, inspect tools and diffs, and follow new messages from one clean transcript.

## Run locally

Requires Node.js 22.5 or newer for built-in `node:sqlite`.

```bash
npm install
npm run dev
```

Vite prints the local URL. This starts the app and its read-only local API. A custom Codex directory can be supplied through the existing `CODEX_HOME` environment setting.

```bash
npm run check
npm run preview
```

Preview also includes the local API. This is a local application: a remote static deployment cannot read this machine's Codex databases.

## Read and inspect

- **Sessions** lists the 50 most recent non-archived threads. Search by title, workspace, or thread ID. The rail becomes a drawer on small screens and closes after selection.
- **Messages** shows only user and Codex messages. **Full** includes tool activity; consecutive runs fold into a summary with counts and visible failures. Expand a run for individually collapsed tools. File changes expose separate, initially collapsed Pierre diffs.
- **Watch live** polls committed items about once per second, appends unseen messages, and follows the live edge. Scrolling away releases following; **Jump to latest** returns. A failed read preserves the last conversation and offers Retry.
- **Commands**, opened with the sliders button or **Ctrl+K**, switches density, collapses activity, controls Watch, refreshes the session index, and switches sessions. Arrow keys, Enter, and Escape work in the palette.

The density preference survives reloads in the current browser session. This app reads and follows conversations; it does not send messages. There is one transcript, with no Voice split or placeholder integrations.

Deep links select a thread directly:

```text
http://localhost:5173/?thread=YOUR_THREAD_ID
```

## Local data

| Purpose | Default path |
| --- | --- |
| Session discovery and metadata | `~/.codex/state_5.sqlite` |
| Committed items and turn status | `~/.codex/thread_history_1.sqlite` |

SQLite connections are read-only with `PRAGMA query_only`. No migration or database write is performed. The API exposes:

- `GET /api/threads?limit=50`
- `GET /api/threads/:id?detail=messages|full`
- `GET /api/threads/:id/items?after_ordinal=N&detail=messages|full`

SQL parameters are bound, list limits capped, and archived threads excluded. Reasoning remains hidden in both transcript densities. Markdown renders without raw HTML. The incremental rollout ordinal advances even when Messages hides tool records.

## Verify and review

```bash
npm run check
npx playwright install chromium
npm test
```

The browser suite uses isolated synthetic API responses; it never writes the operator's history. It verifies the actual app components and captures review images in `docs/screenshots/`.

[Messages](docs/screenshots/messages.png) · [Full](docs/screenshots/full.png) · [File diff](docs/screenshots/diff.png) · [Mobile](docs/screenshots/mobile.png) · [Commands](docs/screenshots/commands.png)

These images contain **synthetic review conversations**, not private Codex history.

## Structure

- `server/codex-api.ts`: local Vite API and read-only SQLite queries.
- `src/lib/api/codex.ts`: Codex records mapped to presentation types.
- `src/lib/transcript.ts`: ordered grouping of consecutive activity.
- `src/components/chat/`: messages, markdown, disclosure, and lazy Pierre rendering.
- `src/components/layout/`: session navigation, toolbar controls, and command palette.
- `src/components/ui/`: shadcn / Base UI primitives; MessageScroller owns scrolling.
- `src/index.css`: arthack web tokens, typography, and responsive composition.

The source hierarchy and visual decisions are recorded in [the design brief](docs/arthack-aesthetic-brief.md).

## Relocation provenance

Imported from [possibilities/be-like-grok](https://github.com/possibilities/be-like-grok)
main at `a7f0ae7d89ff3a3ca78a3d1d7a7b12476b73e9d1` (approved design
`74c8de6`). The design brief and synthetic review images preserve the shipped
web design. Agentchats owns this reader going forward.
