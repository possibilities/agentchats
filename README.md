# AgentChats

[![CI](https://github.com/possibilities/agentchats/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentchats/actions/workflows/ci.yml)

Every coding agent on this machine leaves a session history — Claude Code
under `~/.claude/projects` and Codex under `~/.codex/sessions`.
Agentchats turns that scattered history into a searchable local index, and
teaches agents to use it.

Three pieces do that:

- **The session index.** `src/parse/` turns each Claude Code and Codex
  transcript into a common message shape; `src/store/` writes it into a
  local SQLite+FTS5 database at `~/.local/state/agentchats/index.db`.
  `agentchats index` builds or refreshes it — incremental by default,
  `--full` to rebuild from nothing.
- **The `agentchats` CLI.** `bin/agentchats`, linked editable into
  `~/.local/bin` by the installer. `state` prints a budget-capped bearings
  dump for agents re-orienting in a project; `search`, `sessions`, `view`,
  `expand`, and `resume` are the query surface; bare `search` with no
  `--json` is the Signal Room resume picker (`src/tui/`, bun + OpenTUI).
- **The `chats` skill.** `skills/chats/SKILL.md` is a runbook that teaches
  agents to wield the CLI: preflight, the search → view/expand → resume
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

The installer links the CLI, installs dependencies only when
`node_modules/@opentui/core` is missing, then builds or refreshes the index
through the newly linked CLI. Index-building subprocesses are time-bounded
(`scripts/run-with-timeout`) and reaped on timeout or installer termination,
so a stuck rebuild cannot hang AgentStart or leave an orphaned process
behind.

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
scripts/install.sh        installer (AgentStart calls this)
scripts/run-with-timeout  bounded subprocess runner used by the installer
bin/agentchats            the agentchats CLI entry point, linked into ~/.local/bin
skills/chats/SKILL.md     the chats skill (AgentStart's skill scan ships it)
skills/chats/agents/      per-agent skill manifest (openai.yaml)
docs/adr/                 architecture decision records
```
