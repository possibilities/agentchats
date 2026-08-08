# Agentchats

Every coding agent on this machine leaves a session history — Claude Code
under `~/.claude/projects`, Codex under `~/.codex/sessions`, Pi under
`~/.pi/agent/sessions`. Agentchats turns that scattered history into a
searchable archive and teaches agents to use it.

It does this with two pieces:

- **A cass installation contract.** [cass][cass] (coding agent session
  search) is the CLI/TUI that indexes and searches local coding-agent
  history across 23 agents. `scripts/install.sh --install` installs the
  upstream checksummed release into `~/.local/bin`, builds or refreshes the
  index, and verifies the Claude Code, Codex, and Pi session stores are
  actually covered.
- **The `chats` skill.** `skills/chats/SKILL.md` is a comprehensive runbook
  that lets agents wield cass expertly: robot-mode discipline, the triage
  preflight, search and query language, token budgeting, cited handoff
  packs, and recovery.

[cass]: https://github.com/Dicklesworthstone/coding_agent_session_search

## Installation

Funk owns installation. A full `~/code/funk/install` (or
`~/code/funk/libexec/install-ai-tools`) runs the cass installer, and Funk's
per-checkout skill scan ships `skills/chats/` globally for Codex, Claude
Code, OpenCode, and Pi.

Directly, from this checkout:

```sh
scripts/install.sh --install   # install/upgrade cass, prepare the index
scripts/install.sh --check     # print the plan without changing anything

npx --yes skills add "$HOME/code/agentchats" \
    --agent codex claude-code opencode pi \
    --skill chats --global --yes
```

## Layout

```
scripts/install.sh     cass installation contract (Funk calls this)
skills/chats/SKILL.md  the chats skill (Funk's skill scan ships this)
skills/chats/agents/   per-agent skill manifest (openai.yaml)
```
