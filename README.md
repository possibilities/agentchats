# AgentChats

[![CI](https://github.com/possibilities/agentchats/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentchats/actions/workflows/ci.yml)

Every coding agent on this machine leaves a session history — Claude Code
under `~/.claude/projects`, Codex under `~/.codex/sessions`, Pi under
`~/.pi/agent/sessions`. Agentchats turns that scattered history into a
searchable archive, and teaches agents to use it.

Three pieces do that:

- **A cass installation contract.** [cass][cass] (coding agent session
  search) is the CLI and TUI that indexes and searches local coding-agent
  history across 23 agents. `scripts/install.sh --install` installs the
  upstream checksummed release into `~/.local/bin`, builds or refreshes the
  index, and verifies that the Claude Code, Codex, and Pi session stores are
  covered.
- **The `agentchats` CLI.** `bin/agentchats`, linked editable into
  `~/.local/bin` by the installer. One subcommand today: `agentchats state`
  prints a budget-capped bearings dump — the recent coding-agent sessions
  for one workspace — for agents (an orchestrator, a fresh session)
  re-orienting in a project. Markdown for a model to read; silent when the
  workspace has none.
- **The `chats` skill.** `skills/chats/SKILL.md` is a comprehensive runbook
  that lets agents wield cass expertly: robot-mode discipline, the triage
  preflight, search and query language, token budgeting, cited handoff
  packs, and recovery.

[cass]: https://github.com/Dicklesworthstone/coding_agent_session_search

## Installation

AgentStart owns installation. A full `~/code/agentstart/scripts/install.sh
--install` runs the cass installer, and its per-checkout skill scan
(`scripts/sync-skills`) ships `skills/chats/` globally for Codex, Claude
Code, and Pi.

Directly, from this checkout:

```sh
scripts/install.sh --install   # install/upgrade cass, prepare the index
scripts/install.sh --check     # print the plan without changing anything

npx --yes skills add "$HOME/code/agentchats" \
    --agent codex claude-code pi \
    --skill chats --global --yes
```

## The agentchats CLI

```sh
agentchats state [--workspace <dir>] [--budget <tokens>]
```

Prints the recent sessions for one workspace (the current git project by
default), newest first, bounded by `--budget` (approximate tokens, default
400):

```
## chats — recent sessions in $HOME/code/agentvoice
- 2026-08-06T21:18 · codex · 108 msgs (2 human) · <recommended_plugins>
- 2026-08-05T23:50 · codex · 84 msgs (2 human) · <recommended_plugins>
more: cass sessions --workspace $HOME/code/agentvoice --limit 10 --json · deeper: the chats skill
```

The contract, shared with the other `agent*` state dumps: workspace-scoped,
budget-capped, fast, offline, read-only, and silent when there is nothing to
say (one line when cass cannot serve). Searching and reading the sessions
themselves is cass in robot mode — the chats skill is that runbook.

## Layout

```
scripts/install.sh     cass installation contract (AgentStart calls this)
bin/agentchats         the agentchats CLI (state), linked into ~/.local/bin
skills/chats/SKILL.md  the chats skill (AgentStart's skill scan ships it)
skills/chats/agents/   per-agent skill manifest (openai.yaml)
```
