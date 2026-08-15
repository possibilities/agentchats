# Context

**cass** — the third-party CLI/TUI (coding_agent_session_search) that indexes
and searches local coding-agent session history. Installed by this
repository's `scripts/install.sh`, always invoked by agents in robot mode.
_Avoid_: CASS-the-service, session search engine.

**chats** — this repository's agent skill: the runbook that
teaches agents to wield cass. The skill is the guidance; cass is the tool.
_Avoid_: cass skill, history skill.

**session store** — an agent CLI's on-disk session history that cass
indexes: `~/.claude/projects` (Claude Code), `~/.codex/sessions` (Codex),
`~/.pi/agent/sessions` (Pi). _Avoid_: logs, transcripts directory.

**prepare** — what the installer does beyond installing the binary: build or
refresh the index and verify the session stores are covered, so the first
agent search works. _Avoid_: configure, setup.

**agentchats CLI** — the small surface this repository owns on top of cass:
`bin/agentchats`, linked editable into `~/.local/bin` by the installer. Two
subcommands, `state` and `view`. _Avoid_: cass wrapper, chats CLI.

**state dump** — the bearings section `agentchats state` prints for agents
re-orienting in a project: workspace-scoped, budget-capped, markdown a model
reads, silent when empty. The contract is shared across the `agent*` CLIs.
_Avoid_: status, health check (both are cass's own commands).

**viewer** — the `agentchats view` TUI in `viewer/`: chromeless transcript
surface, ctrl+k palette, Signal Room skin, read-only. _Avoid_: browser,
player.

**normalizer** — the per-store translator (claude, codex, pi) from a
harness's native session JSONL to opencode's v1 session/message/part schema,
incremental so live tails stream through it. _Avoid_: parser, adapter,
importer.

**vendored renderer** — the pure renderer half of opencode's session route
(message components, part dispatch, tool registry) copied into
`viewer/src/vendor/` at a pinned commit with divergences marked `viewer:`.
_Avoid_: fork, port.

**follow** — the viewer's live mode: a byte-offset tail of the session file
feeding the normalizer, sticky-bottom scroll, and an in-body WORKING row
while the harness is mid-turn. _Avoid_: watch, replay.

**working window** — the span a normalizer reports `busy()`: from a user
prompt until an assistant message finishes for a reason other than
tool-calls. _Avoid_: streaming (that is a renderer concern).
