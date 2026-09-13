# Agentchats reader

An arthack reading room for local Codex conversations, owned by agentchats.
Find a session, read the exchange, inspect tools and diffs, and follow committed
messages from one transcript.

## Run locally

Requires Bun 1.3.14+ and Node.js 22.12+. From the repository root:

```sh
bun install --frozen-lockfile
npm --prefix web ci
./bin/agentchats index
bun run web:dev
```

Open the loopback URL Vite prints (normally `http://127.0.0.1:5173`). The Vite
process runs under Bun to share agentchats' SQLite query layer. Both development
and production preview include the read-only local API:

```sh
bun run web:build
npm --prefix web run preview
```

Inside `web/`, `npm run dev`, `npm run check`, and `npm run preview` work too.
This is a local application: static deployment cannot read local databases.
No launchd job, portless route, or always-on service is installed by this move.
The normal CLI installer does not install or start the reader.

## Read and inspect

- **Sessions** starts with the 50 most recent non-archive Codex sessions from
  the agentchats index, then omits candidates missing or archived in Codex state.
  Find filters this list by title, workspace, or thread ID. The rail becomes a
  drawer on small screens and closes after selection.
- **Messages** shows user and Codex messages. **Full** includes tool activity;
  consecutive runs fold into summaries with counts and failures. Expand a run
  for individually collapsed tools. Each file has an initially collapsed, lazy
  Pierre diff. Reasoning stays hidden in both densities.
- **Watch live** polls committed items about once per second, appends unseen
  messages, and follows the live edge. Scrolling away releases following;
  **Jump to latest** returns. Disclosure state and scroll position survive
  polling. A failed read keeps the last conversation and offers Retry.
- **Commands**, opened with the sliders button or **Ctrl+K**, switches density,
  collapses activity, controls Watch, reloads the session list, and switches
  sessions. Arrow keys, Enter, and Escape work in the palette.

The density preference survives reloads in the current browser session. This app
reads conversations; it does not send messages. Claude UI support is out of scope
for this initial relocation; the shared index still covers Claude Code.

**Refresh sessions rereads the index; it does not run ingest.** After new sessions
are created, run `./bin/agentchats index` from the repository root, then refresh.
Watch reads Codex directly and does not require repeated indexing.

Known thread IDs can open directly, including before a session is indexed:

```text
http://127.0.0.1:5173/?thread=YOUR_THREAD_ID
```

## Local data

| Purpose | Source | Configuration |
| --- | --- | --- |
| Session discovery and ordering | Agentchats `sessions` query, `~/.local/state/agentchats/index.db` | `AGENTCHATS_INDEX`, or `XDG_STATE_HOME` |
| Codex metadata, archived eligibility, deep links | `~/.codex/state_5.sqlite` | Existing `CODEX_HOME` setting |
| Committed messages, tools, diffs, turn status, live cursor | `~/.codex/thread_history_1.sqlite` | Existing `CODEX_HOME` setting |

The shared `src/store/paths.ts` resolver owns index location. No parallel
filesystem discovery or Codex database listing is used. If a custom Codex home
contains sessions absent from the agentchats index, open them by thread ID;
the reader does not change the CLI's transcript-store configuration.

SQLite connections are read-only with `PRAGMA query_only`; the reader never
creates or rebuilds a missing or incompatible index. It reports recovery advice.
The API exposes:

- `GET /api/threads?limit=50` (capped at 100 index candidates)
- `GET /api/threads/:id?detail=messages|full`
- `GET /api/threads/:id/items?after_ordinal=N&detail=messages|full`

Queries use bound parameters. Items and their latest ordinal share one read
snapshot; the ordinal advances even when Messages hides tool records. Markdown
renders without raw HTML. Responses are non-cacheable and restricted to the
local origin in both Vite dev and preview.

Older index entries may lack Codex committed items. This first move preserves
the shipped Codex reader; it does not reconstruct tool structures from indexed
bodies or fall back to rollout files. Search currently filters recent candidates,
not full-index message text. [ADR 0002](../docs/adr/0002-own-the-web-conversation-reader.md)
records these boundaries and the future extension path.

## Verify and review

From the repository root:

```sh
bun run web:check                 # lint, typecheck both web/server, build
(cd web && npx playwright install chromium)
bun run web:test                  # isolated SQLite API tests + browser specs
bun run check                     # root CLI/index/MCP checks + reader checks
```

`bun test` at the root runs only `test/`; `npm --prefix web run test:api` runs
`web/server-tests/`. `npm --prefix web run test:browser` runs Playwright with its
own Vite process on loopback port 5197 (`AGENTCHATS_TEST_PORT` overrides it). Browser tests use synthetic API responses;
API tests create temporary SQLite fixtures. Neither touches the operator's history.
The browser suite checks actual components and writes screenshots/traces to
ignored `web/test-results/`, so routine checks do not rewrite tracked evidence.

The imported, approved review images contain **synthetic conversations**:
[Messages](docs/screenshots/messages.png) · [Full](docs/screenshots/full.png) ·
[File diff](docs/screenshots/diff.png) · [Mobile](docs/screenshots/mobile.png) ·
[Commands](docs/screenshots/commands.png).

## Structure and provenance

- `server/session-index.ts`: read-only adapter to agentchats' session query.
- `server/reader-api.ts`: local API, Codex metadata, and committed-history reader.
- `src/lib/api/codex.ts`: Codex records mapped to presentation types.
- `src/lib/transcript.ts`: ordered grouping of consecutive activity.
- `src/components/chat/`: messages, markdown, disclosures, lazy Pierre rendering.
- `src/components/layout/`: sessions, toolbar controls, command palette.
- `src/components/ui/`: shadcn / Base UI primitives; MessageScroller owns scrolling.
- `src/index.css`: arthack web tokens, typography, responsive composition.

Imported from [possibilities/be-like-grok](https://github.com/possibilities/be-like-grok)
main at `a7f0ae7d89ff3a3ca78a3d1d7a7b12476b73e9d1` (approved design `74c8de6`).
The [original design brief](docs/arthack-aesthetic-brief.md) and review images
preserve the shipped design; this guide supersedes its original runtime/data notes.
Agentchats owns this reader going forward.
