# Context

**cass** — the third-party CLI/TUI (coding_agent_session_search) that indexes
and searches local coding-agent session history. Installed by this
repository's `scripts/install.sh`, always invoked by agents in robot mode.
_Avoid_: CASS-the-service, session search engine.

**chats** — this repository's agent skill (`/chats`): the runbook that
teaches agents to wield cass. The skill is the guidance; cass is the tool.
_Avoid_: cass skill, history skill.

**session store** — an agent CLI's on-disk session history that cass
indexes: `~/.claude/projects` (Claude Code), `~/.codex/sessions` (Codex),
`~/.pi/agent/sessions` (Pi). _Avoid_: logs, transcripts directory.

**prepare** — what the installer does beyond installing the binary: build or
refresh the index and verify the session stores are covered, so the first
agent search works. _Avoid_: configure, setup.
