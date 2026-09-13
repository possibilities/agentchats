# 2. Own the web conversation reader

Status: Accepted
Date: 2026-09-13
Updated: 2026-09-13 — Mike approved default editable Vite dev for the always-on service.

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
  suite. The normal installer now resolves both frozen lockfiles and builds
  production assets before linking the CLI. Core and web dependencies retain
  separate lockfiles. Root `bun run check` and CI verify both trees; each test
  runner has an explicit root.
- This is a local read-only app. Vite dev and preview bind loopback; the API
  rejects foreign hosts/origins. A static hosted build cannot read local history.
- The current rail filters the bounded recent-session list by title, workspace,
  and ID. Full-index text search, transcript-store fallback, and other provider
  readers can be added through agentchats' existing methods later.
- Sessions absent from Codex state, or marked archived there, are omitted from
  the recent index candidates. Some older indexed Codex transcripts may have no
  committed history; the reader does not reconstruct rich items from rollouts.
- The initial service deferral is lifted by Mike's follow-up approval.
  `agentchats serve` runs Bun's Vite dev server with HMR and reader API under
  pinned portless at exactly `https://agentchats.localhost`. It runs in the
  foreground, requires installed dependencies but no `web/dist`, refuses duplicate/busy binds,
  and forwards TERM/INT/HUP until portless has reaped the reader and removed
  its route. `serve --production` retains Vite preview and requires the installer's
  build. Install from main and kickstart the existing LaunchAgent to serve an
  editable main checkout. It is an operator command, outside the MCP producer tools.
- The shared HTTPS proxy must be prepared interactively (sudo and CA trust)
  through `portless service install` or `portless proxy start`. Serve probes
  loopback port 443 and fails with recovery advice when absent; it does not
  prompt, install the proxy, or fall back to another URL. Both backend and
  proxy stay loopback-only, with no inherited LAN/tunnel/bypass modes. The
  API accepts only direct loopback origins or its exact forwarded HTTPS host.
- AgentStart owns `io.arthack.agentchats.serve`, invoking the installed CLI
  with the user's HOME and Bun/Node PATH. Launchd and shared proxy setup are
  separate from this repository's installer and remain sibling-thread work.
