# AgentChats

[![CI](https://github.com/possibilities/agentchats/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentchats/actions/workflows/ci.yml)

Every coding agent on this machine leaves a session history — Claude Code
under `~/.claude/projects` and Codex under `~/.codex/sessions`.
Agentchats turns that scattered history into a searchable local index, and
teaches agents to use it.

Four pieces do that:

- **The session index.** `src/parse/` turns each Claude Code and Codex
  transcript into a common message shape; `src/store/` writes it into a
  local SQLite+FTS5 database at `~/.local/state/agentchats/index.db`.
  `agentchats index` builds or refreshes it — incremental by default,
  `--full` to rebuild from nothing.
- **The `agentchats` command and MCP surface.** `bin/agentchats`, linked editable into
  `~/.local/bin` by the installer. `state` prints a budget-capped bearings
  dump for agents re-orienting in a project; `search`, `sessions`, `view`,
  `expand`, and `resume` are the query surface; bare `search` with no
  `--json` is the Signal Room resume picker (`src/tui/`, bun + OpenTUI).
  `agentchats mcp` serves the same typed producer handlers over stdio.
- **The local conversation reader.** `web/` contains the React/Vite reader
  relocated from the approved Be Like Grok design. It discovers Codex sessions
  through the shared index query layer and reads rich committed history from
  Codex. [Run and verify the reader](web/README.md).
- **The `chats` skill.** `skills/chats/SKILL.md` is a runbook that teaches
  agents to use MCP through the directly connected MCP server: freshness, the search → view/expand → resume
  drill-down loop, query language, token budgeting, and recovery.

## Installation

AgentStart owns installation. A full `~/code/agentstart/scripts/install.sh
--install` runs this repository's installer, and its per-checkout skill scan
(`scripts/sync-skills`) ships `skills/chats/` through the default `common` pack
for Codex and Claude Code.

Directly, from this checkout:

```sh
scripts/install.sh --install   # link the CLI, prepare the index
scripts/install.sh --check     # print the plan without changing anything
~/code/agentstart/scripts/sync-skills   # refresh the common capability pack
```

The installer resolves both frozen lockfiles and builds the production reader
before linking the CLI, then refreshes the index through the newly linked CLI. Index-building subprocesses are time-bounded
(`scripts/run-with-timeout`) and reaped on timeout or installer termination,
so a stuck rebuild cannot hang AgentStart or leave an orphaned process
behind.

## Run the conversation reader

From this checkout, with Bun 1.3.14+, Node 24+, and npm:

```sh
scripts/install.sh --install
agentchats serve
```

Open **https://agentchats.localhost**. The shared portless HTTPS proxy needs
one-time interactive setup (`portless service install`, or `portless proxy start`),
including sudo and CA trust. Messages / Full, expandable tools and diffs,
and Watch live all use the shipped arthack web design. This initial reader is
Codex-only; the index, CLI, and MCP continue to cover Claude Code too.

`bun run web:check` checks reader lint, types, and the production build.
After `cd web && npx playwright install chromium`, `bun run check` from the
repository root verifies both trees, including API and browser tests.

`agentchats serve` runs Vite dev with HMR and the Bun reader API under pinned
portless in the foreground. Installed dependencies are required; **dev does not
need `web/dist`**. Edits to the linked checkout appear without rebuilding or
redeploying. `agentchats serve --production` runs the prepared `web/dist` build
instead; rebuild it after code changes. The normal installer resolves both
lockfiles and still prepares production assets. Runtime restarts never install
packages, build production assets, or prompt for sudo.

AgentStart owns the `io.arthack.agentchats.serve` launchd job, invoking
`~/.local/bin/agentchats serve` with Bun and Node on PATH. To make the always-on
LaunchAgent editable from **main**, install from the canonical main checkout,
then restart the already-installed job:

```sh
cd ~/code/agentchats            # canonical checkout on main
scripts/install.sh --install
launchctl kickstart -k "gui/$(id -u)/io.arthack.agentchats.serve"
```

The CLI link determines which checkout is served, independent of launchd's
working directory. Reinstall when dependencies change; restart for server/API
changes. UI edits use HMR. The route name is fixed even in worktrees. Bind
failures and missing prerequisites exit nonzero; TERM/INT/HUP stop the child
and release the route. No launchd files are installed here. For a separate
loopback development URL, `bun run web:dev` still works.

This is the intended **fleet web UI pattern**: default Vite dev with HMR, an
AgentStart-owned launchd job, and a fixed portless `<app>.localhost` HTTPS name,
with `--production` optional. Agentchats is the first instance; the future
agentvoice web UI will follow the same setup at `https://agentvoice.localhost`.
Keep dependency installation outside runtime restarts and backends loopback-only
with strict ports and exact-origin guards. See the [service contract](web/README.md#foreground-service-contract)
for the reusable ownership and startup details. Agentvoice is not implemented here.

See [the reader guide](web/README.md) for data sources and limitations, and
[ADR 0002](docs/adr/0002-own-the-web-conversation-reader.md) for the boundary.

## MCP for agents

AgentStart supplies `agentchats mcp` directly to managed harness sessions. The nine tools are `index`,
`status`, `search`, `sessions`, `view`, `expand`, `resume`, `state`, and `guide`.
Their arguments and terminal help derive from `src/cli/contract.ts`; MCP calls
the shared handlers directly without shell commands or stdout capture.

Existing JSON objects remain unchanged in both `structuredContent` and a
standalone JSON text block. Errors set `isError` and retain
`{error:{code,message,hint}}`; an incomplete index pass retains its native
`success:false` report. The new `guide` uses the fleet guide envelope, and
`state` remains plain Markdown with empty output for an empty workspace.

MCP paths are absolute and `state` requires an explicit workspace. Terminal
formatting and current-directory flags are not tool arguments. Calls run
sequentially within each server; cancellation or stdio shutdown stops indexing
between completed session transactions and skips unfinished final pruning.
Clients can request progress notifications with a progress token. `resume`
only returns a human handoff command and never launches a session.

## The agentchats CLI

```sh
agentchats state [--workspace <dir>] [--budget <tokens>]
agentsurface host -- agentchats search [query…] [--workspace <dir>] [--include-auxiliary]
```

Prints the recent sessions for one workspace (the current git project by
default), newest first, bounded by `--budget` (approximate tokens, default
400):

```
## chats — recent sessions in $HOME/code/agentdemo
- 2026-08-06T21:18 · codex · 108 msgs (2 human) · <recommended_plugins>
- 2026-08-05T23:50 · codex · 84 msgs (2 human) · <recommended_plugins>
more: agentchats sessions --workspace $HOME/code/agentdemo --limit 10 --json · deeper: the chats skill
```

The contract, shared with the other `agent*` state dumps: workspace-scoped,
budget-capped, fast, offline, read-only, and silent when there is nothing to
say. Searching and reading the sessions themselves is `agentchats
search`/`sessions`/`view`/`expand` — the chats skill is that runbook.

The search picker shows full-harness sessions by default. Modern Codex
rollouts whose explicit `thread_source` is not `user` — app-server, realtime,
and child-agent sessions — are auxiliary. Include them for one invocation with
`--include-auxiliary`, or toggle them from the ctrl+k command palette. The
session index holds both classes regardless; only the picker's default view
narrows to full-harness.

Search starts in the current git project (or cwd outside Git). The project row
beneath the search field makes that scope a first-class control: Tab focuses
it, Space or Enter opens its fuzzy chooser, and the arrows step through its
values. The chooser offers all projects, the opening project, then `~/code`
and `~/source` one level deep—the same bounded, transcript-independent discovery
rule as AgentLaunch. Ctrl+g still toggles between the selected project and all
projects, and **choose project** remains in the ctrl+k palette.

Legacy producers that predate `thread_source` can be classified by their
Codex `originator` in the optional XDG config at
`~/.config/agentchats/config.json` (`$XDG_CONFIG_HOME` honored):

```json
{
  "auxiliary": {
    "codex-originators": ["automation-worker"]
  }
}
```

This fallback applies only when `thread_source` is absent. An explicit
`thread_source: "user"` is always a full-harness session, regardless of its
workspace, so ordinary Codex CLI work inside an auxiliary producer's project
remains searchable. A missing config file means no legacy originators are
classified as auxiliary; unknown keys or malformed values fail visibly.

## Layout

```
src/parse/                transcript parsers (Claude Code, Codex)
src/store/                SQLite+FTS5 schema, ingest, and query
src/cli/                  the agentchats command surface
src/tui/                  the Signal Room resume picker
web/                     React/Vite reader, local API, and browser tests
scripts/install.sh        installer (AgentStart calls this)
scripts/run-with-timeout  bounded subprocess runner used by the installer
bin/agentchats            the agentchats CLI entry point, linked into ~/.local/bin
skills/chats/SKILL.md     the chats skill (AgentStart's skill scan ships it)
skills/chats/agents/      per-agent skill manifest (openai.yaml)
docs/adr/                 architecture decision records
```
