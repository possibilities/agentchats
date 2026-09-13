# 2. Own the web conversation reader

Status: Accepted
Date: 2026-09-13

## Context

Mike approved the single-pane Be Like Grok redesign, merged at
[`a7f0ae7`](https://github.com/possibilities/be-like-grok/commit/a7f0ae7d89ff3a3ca78a3d1d7a7b12476b73e9d1)
(design `74c8de6`), and requested its initial relocation into agentchats.
Agentchats should own its reading surfaces alongside transcript discovery.
This is a new decision, independent of the withdrawn OpenCode renderer experiment.

## Decision

Import the entire React/Vite reader into `web/`, including its existing UI
primitives, design brief, synthetic review images, and browser tests. Keep its
arthack web design: one transcript, Messages / Full, collapsed activity and
lazy Pierre diffs, and explicit Watch live with scroll preservation.

The server runs under Bun so it can call the same `sessions` query and
`indexPath` resolver as the CLI. It opens the existing index read-only, checks
its schema, and asks for recent non-archive Codex sessions. It does not add a
second discovery query, index, ingestion process, migration, or retention path.
Refresh sessions rereads the existing index; `agentchats index` owns freshness.

Codex `state_5.sqlite` still enriches those candidates with titles, model,
workspace, and non-archived eligibility. `thread_history_1.sqlite` still supplies
committed items, tool/file-change structures, turn status, and polling cursors.
The index's normalized message bodies do not preserve all that presentation
structure. Deep links can still open a known Codex thread before indexing it.
Read items and the cursor in one SQLite snapshot so concurrent commits cannot
skip messages. Every database connection is read-only and query-only.

The Codex-only filter belongs to this reader's discovery adapter. The shared
index still supports Claude Code, and the presentation types remain independent
of Codex storage. Claude UI support is future work, without a product placeholder
or a restriction in the shared query layer.

## Consequences

- `web/` has its own npm lockfile, DOM typecheck, lint, API tests, and Playwright
  suite. Root Bun dependencies and CLI installation remain independent. Root
  `bun run check` and CI verify both trees; each test runner has an explicit root.
- This is a local read-only app. Vite dev and preview bind loopback; the API
  rejects foreign hosts/origins. A static hosted build cannot read local history.
- The current rail filters the bounded recent-session list by title, workspace,
  and ID. Full-index text search, transcript-store fallback, and other provider
  readers can be added through agentchats' existing methods later.
- Sessions absent from Codex state, or marked archived there, are omitted from
  the recent index candidates. Some older indexed Codex transcripts may have no
  committed history; the reader does not reconstruct rich items from rollouts.
- Service ownership is agentchats. An `agentchats serve` command, launchd label
  `io.arthack.agentchats.serve`, and `agentchats.localhost` routing are deferred.
