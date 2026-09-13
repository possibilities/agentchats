# Agentchats reader

An arthack reading room for local Codex conversations, owned by agentchats.
Find a session, read the exchange, inspect tools and diffs, and follow committed
messages from one transcript.

## Run locally

Requires Bun 1.3.14+, Node.js 24+, and npm. From the repository root:

```sh
scripts/install.sh --install
agentchats serve
```

Open **https://agentchats.localhost**. `serve` uses this fixed name even from a
Git worktree, independent of the caller's working directory. By default it runs
Vite dev with HMR under Bun, retaining the session-index and Codex reader API.
Installed dependencies are required; dev does not need `web/dist`.
`agentchats serve --production` uses Vite preview and requires `web/dist`.
The installer resolves the root Bun lockfile and `web/package-lock.json`
(including pinned portless), builds the reader, then updates the CLI link and
refreshes the index. Reinstall when dependencies change; restart for server/API
changes. UI edits use HMR without a build or redeploy. Production assets need
rebuilding after code changes. `serve` itself never installs packages or builds
production assets on service restarts.

### Shared proxy prerequisite

The portless HTTPS proxy must already be running on loopback port 443. Set it up
once in an interactive terminal, completing sudo and local CA trust:

```sh
portless service install       # shared proxy starts with the machine
# Or, for the current login:
portless proxy start
portless doctor
```

These commands require a global portless installation supplied by the machine's
stack setup. `serve` uses its own locked portless dependency. If the global
command is unavailable, use `web/node_modules/.bin/portless` from this checkout.
Safari may also need `portless hosts sync` after the route is registered.
The foreground service disables automatic hosts-file edits and never prompts
for sudo. Missing proxy, dependency, or requested production-build prerequisites produce an error and nonzero exit.

### Foreground service contract

The launchd entry point is `~/.local/bin/agentchats serve`. KeepAlive supervision
belongs to AgentStart's `io.arthack.agentchats.serve` job; this repository does not
install that job or change the shared proxy. Supply the target user's `HOME`
and a `PATH` containing Bun and Node.js 24+ (typically `~/.bun/bin`,
`~/.local/bin`, `/opt/homebrew/bin`, and the standard system paths). No working
directory is required. Keep stdout/stderr attached to the supervisor's logs.

`serve` stays in the foreground. TERM, INT, or HUP wait for portless to stop its
reader process tree and release the route; child failures preserve a nonzero
exit. Duplicate routes are refused without taking over the existing reader.
The backend binds `127.0.0.1` on portless's assigned `PORT` with strict binding,
so it fails instead of selecting an unregistered port. The public origin is
fixed to `https://agentchats.localhost`; LAN, tunnels, wildcard routing, and
inherited proxy-bypass settings are disabled. The API permits the exact HTTPS
origin forwarded by portless and direct loopback reads, with foreign origins
and hosts still rejected. The shared proxy must also run in loopback mode.

Install from `~/code/agentchats` on **main**, then run
`launchctl kickstart -k "gui/$(id -u)/io.arthack.agentchats.serve"` to make the
already-installed LaunchAgent editable from main. The CLI symlink selects the
checkout; the launchd command stays `agentchats serve` (default dev).

This is the intended fleet web UI pattern. Agentchats is the first instance;
the future agentvoice web UI must follow it at `https://agentvoice.localhost`
with default Vite dev, launchd, portless, and optional `--production`.
Reuse this ownership pattern:
AgentStart prepares the shared HTTPS proxy and supervises a foreground `serve`;
the app owns its installed dependencies, fixed portless name, and Vite dev/API
entry point. Consume portless's `PORT`, bind strictly to `127.0.0.1`, allow the
app's exact named origin, and send HMR over the same HTTPS proxy. Keep production
an explicit option and installs outside runtime restarts. This change adds no
agentvoice implementation.

### Development and direct preview

```sh
agentchats serve               # always-on pattern: named HTTPS + HMR
agentchats serve --production  # named HTTPS, requires web/dist
bun run web:dev                # ordinary Vite development, loopback URL
bun run web:build
npm --prefix web run preview   # direct loopback production preview
```

Inside `web/`, `npm run dev`, `npm run check`, and `npm run preview` also work.
Both preview paths include the local API. A static hosted build cannot read
this machine's history.

## Read and inspect

- **Sessions** starts with the 50 most recent non-archive Codex sessions from
  the agentchats index, then omits candidates missing or archived in Codex state.
  Find filters this list by title, workspace, or thread ID. The rail becomes a
  drawer on small screens and closes after selection.
- **Messages** shows user and Codex messages. **Full** includes tool activity;
  consecutive runs fold into summaries with counts and failures. Expand a run
  for individually collapsed tools. Each file has an initially collapsed, lazy
  Pierre diff. Reasoning stays hidden in both densities.
- Conversations open at the latest message, including idle agents and with Watch
  off. **Watch live** polls committed items about once per second, appends unseen
  messages, and follows the live edge. Scrolling away releases following;
  **Jump to latest** returns. Disclosure state and scroll position survive
  polling. A failed read keeps the last conversation and offers Retry.


The density preference survives reloads in the current browser session. This app
reads conversations; it does not send messages. Claude UI support is out of scope
for this initial relocation; the shared index still covers Claude Code.

**Refresh sessions rereads the index; it does not run ingest.** After new sessions
are created, run `./bin/agentchats index` from the repository root, then refresh.
Watch reads Codex directly and does not require repeated indexing.

Known thread IDs can open directly, including before a session is indexed:

```text
https://agentchats.localhost/?thread=YOUR_THREAD_ID
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
local origin in Vite dev and preview, including the exact HTTPS portless host.

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
API tests create temporary SQLite fixtures; dev and production tests use the actual
portless HTTPS proxy library with a temporary certificate and unprivileged ports. Neither touches the operator's history.
The browser suite checks actual components and writes screenshots/traces to
ignored `web/test-results/`, so routine checks do not rewrite tracked evidence.

The imported, approved review images contain **synthetic conversations**:
[Messages](docs/screenshots/messages.png) · [Full](docs/screenshots/full.png) ·
[File diff](docs/screenshots/diff.png) · [Mobile](docs/screenshots/mobile.png).

## Components and transcript API

`@agentchats/transcript` is a separately packable foundation for external UIs.
Its data, React, Codex HTTP adapter, and opt-in scoped styles have separate entry
points. The reader uses the same Transcript component; the package exports no
app shell or database reader. See the [package guide](packages/transcript/README.md)
for composition, live-source semantics, building, and agentvoice boundaries.

## Structure and provenance

- `server/dev.ts`: default Vite dev + HMR launched by `agentchats serve`.
- `server/preview.ts`: production preview launched by `agentchats serve --production`.
- `server/local-origin.ts`: loopback and exact-origin request guard.
- `server/session-index.ts`: read-only adapter to agentchats' session query.
- `server/reader-api.ts`: local API, Codex metadata, and committed-history reader.
- `src/lib/api/codex.ts`: Codex records mapped to presentation types.
- `src/lib/transcript.ts`: ordered grouping of consecutive activity.
- `src/transcript/`: public data/source and React component API.
- `src/components/chat/`: reader pane and private markdown/disclosure/Pierre renderers.
- `src/components/layout/`: sessions and toolbar controls.
- `src/components/ui/`: shadcn / Base UI primitives; MessageScroller owns scrolling.
- `src/index.css`: arthack web tokens, typography, responsive composition.

Imported from [possibilities/be-like-grok](https://github.com/possibilities/be-like-grok)
main at `a7f0ae7d89ff3a3ca78a3d1d7a7b12476b73e9d1` (approved design `74c8de6`).
The [original design brief](docs/arthack-aesthetic-brief.md) and review images
preserve the shipped design; this guide supersedes its original runtime/data notes.
Agentchats owns this reader going forward.
