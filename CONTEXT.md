# Context

**chats** — this repository's agent skill: the runbook that teaches agents
to search the session index. The skill is the guidance; `agentchats` is the
tool. _Avoid_: cass skill, history skill.

**session index** — the SQLite+FTS5 database at
`~/.local/state/agentchats/index.db` that `agentchats search`, `sessions`,
`view`, and `expand` query. Derived state, not the record of truth: delete
it and run `agentchats index` to rebuild it from the transcript stores at
any time. _Avoid_: the archive, the database (name what the file does, not
its format).

**ingest** — the step `agentchats index` performs: read each transcript in
the transcript stores, extract its messages, and write or refresh their
rows in the session index. Incremental by default — only transcripts
written or changed since the last run; `--full` reprocesses everything.
_Avoid_: crawl, scan (ingest names the read-and-index step specifically,
not a bare filesystem walk).

**message** — the atomic unit the session index stores one row per: a
single turn — user, assistant, or tool — inside a transcript. A search hit
resolves to one message's `source_path` and `line`. _Avoid_: turn,
entry, event (the index's own vocabulary is "message").

**transcript store** — an agent CLI's on-disk session history that the
session index mirrors: `~/.claude/projects` (Claude Code) and
`~/.codex/sessions` (Codex). _Avoid_: logs, session store (now ambiguous
with the session index — say transcript store).

**retention-by-mirroring** — the session index's retention policy: it has
none of its own. A message stays searchable exactly as long as its source
transcript remains in the transcript store; `agentchats index --retain-days
N` only bounds how far back ingest reaches, it doesn't prune anything
upstream. _Avoid_: index retention, index TTL (there is no independent
policy to name — retention happens upstream, in each agent CLI's own
transcript lifecycle).

**Full-harness session** — a top-level interactive harness session. A modern
Codex rollout identifies it with `thread_source: "user"`; legacy rollouts with
no thread source remain in this class. This is the default search view.
_Avoid_: primary session (ambiguous with ranking or account selection).

**Auxiliary session** — a session created below or beside a full harness by an
app-server, realtime surface, or child-agent facility. A Codex rollout with an
explicit non-`user` thread source is auxiliary and opt-in in the search picker;
configured originators extend that classification to legacy source-less
rollouts. Workspace never decides the class.
_Avoid_: producer-specific session, hidden session (the index still contains
it).

**Agentchats config** — the optional XDG JSON file whose auxiliary policy
names legacy Codex originators. It refines the picker without changing the
session index or rewriting a transcript store. _Avoid_: index config,
exclusion list (the sessions remain indexed and opt-in).

**prepare** — what the installer does beyond linking the CLI: build or
refresh the session index and verify the transcript stores are covered, so
the first agent search works. _Avoid_: configure, setup.

**agentchats CLI** — the CLI this repository owns end-to-end: `bin/agentchats`,
linked editable into `~/.local/bin` by the installer. `index` builds and
refreshes the session index; `search`, `sessions`, `view`, `expand`, and
`resume` query it; `state` prints bearings. _Avoid_: cass wrapper, chats CLI
(the CLI owns its index outright now; it wraps nothing).

**state dump** — the bearings section `agentchats state` prints for agents
re-orienting in a project: workspace-scoped, budget-capped, markdown a model
reads, silent when empty. The contract is shared across the `agent*` CLIs.
_Avoid_: status (that's the index health probe, a distinct agentchats
command).
