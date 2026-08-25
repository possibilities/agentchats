# Agentchats agent guidance

## What this repository is

Agentchats makes the local coding-agent session history searchable. It owns
three things and nothing else:

- `scripts/install.sh` — the installation contract for cass
  (Dicklesworthstone/coding_agent_session_search): install or upgrade the
  binary from the upstream checksummed release, link the `agentchats` CLI,
  then build or refresh the index so Claude Code, Codex, and Pi sessions are
  searchable.
- `bin/agentchats` — the small CLI this repository owns on top of cass,
  linked editable into `~/.local/bin`. `agentchats state` is the
  workspace-scoped, budget-capped bearings dump agents run to re-orient;
  cass itself remains the search surface. `agentchats search` is the
  surface-hosted resume picker (`src/tui/`, bun + OpenTUI): a Signal Room
  TUI that live-searches sessions via cass and, per pick, writes one
  session directive to stdout for agentsurface to realize as a herdr
  resume — the `surface-handoff-protocol` wiki page is that contract, and
  a pick that cannot resume faithfully is a fatal error, never a fallback.
- `skills/chats/` — the source of the `chats` agent skill, the runbook that
  teaches agents to wield cass expertly. The `skills/<name>/` layout is the
  convention AgentStart's per-checkout skill scan discovers.

AgentStart (`~/code/agentstart`) owns AI-stack installation and invokes both:
the installer through this repository's `scripts/install.sh --install`
(`scripts/install-agent-clis`), the skill through the `agent*` checkout skill
scan (`scripts/sync-skills`), which ships every `skills/<name>/` directory
through the default `common` capability pack. Do not add a second installation or
synchronization path here.

## Conventions

- The installer follows the fleet's helper style: bash, `set -euo pipefail`,
  a `die` helper, `--check` prints the plan without changing the system.
  A machine without this checkout is a skip inside AgentStart, not a failure;
  a present checkout that fails to install is a real error and propagates.
- cass tracks the latest upstream release deliberately, like every agent CLI
  the fleet installs. The release tag is resolved with the authenticated GitHub
  CLI first so reruns never exhaust the anonymous API limit. An exact release
  proven to wedge this machine may be quarantined in the installer with the
  last known-good release as its narrow fallback; name the upstream fix and
  make every later release eligible automatically rather than turning the
  exception into a standing pin.
- The index prepares incrementally when healthy and rebuilds fully when
  missing, unhealthy, or after a failed incremental refresh. Freshness
  between installs is the skill's job (`cass triage`), not a daemon's.
- `skills/chats/SKILL.md` documents the CLI as installed, grounded in real
  command output. After a cass upgrade changes behavior, reverify the
  skill's claims against the live CLI (`cass triage --json`,
  `cass capabilities --json`, `cass robot-docs commands`) before editing
  prose.
- The upstream source is cloned for reference at
  `~/src/coding_agent_session_search`. Read it before guessing at behavior;
  never edit it from here.
- `agentchats state` follows the shared `agent*` state-dump contract:
  scoped to one workspace, bounded by `--budget` (approximate tokens),
  fast, offline, read-only, markdown a model reads directly, and silent
  when the workspace has nothing — an empty section is never printed. It
  scopes and dedups client-side because cass falls back to an unscoped
  listing for an unmatched workspace and an index can carry duplicate rows
  for one session file.

## After changing this repository

- Installer changes: rerun `scripts/install.sh --install` here, then
  AgentStart's convergence check (`~/code/agentstart/scripts/install.sh
  --install`).
- CLI changes: the `~/.local/bin/agentchats` link points into this checkout,
  so edits are live once the link exists; `scripts/install.sh --install`
  creates it. Exercise `bin/agentchats state` against a workspace with
  sessions, an empty one (must print nothing), and a PATH without cass.
- TUI changes: `bun test` and `bunx tsc --noEmit` here, then a pty smoke —
  the picker under `expect` with stdout captured must emit a valid resume
  directive on enter and nothing on escape. The TUI follows the
  `fleet-tui-design` wiki contract (chromeless, ctrl+k palette, Signal
  Room tokens in `src/tui/theme.ts`).
- Skill changes: rerun AgentStart's default common capability-pack scan
  (`~/code/agentstart/scripts/sync-skills`), then confirm the installed pack
  copy matches this checkout.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's default `common`
  capability pack (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch composes the pack into managed
  sessions: Claude Code exposes `/agent:<name>`, while Codex uses `$<name>`
  and Pi uses `/<name>`. A SKILL.md edit is live within six hours, or on
  demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
