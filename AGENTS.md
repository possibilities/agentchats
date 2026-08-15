# Agentchats agent guidance

## What this repository is

Agentchats makes the local coding-agent session history searchable and
viewable. It owns four things and nothing else:

- `scripts/install.sh` — the installation contract for cass
  (Dicklesworthstone/coding_agent_session_search): install or upgrade the
  binary from the upstream checksummed release, link the `agentchats` CLI,
  prepare the viewer's bun dependencies, then build or refresh the index so
  Claude Code, Codex, and Pi sessions are searchable.
- `bin/agentchats` — the small CLI this repository owns on top of cass,
  linked editable into `~/.local/bin`. `agentchats state` is the
  workspace-scoped, budget-capped bearings dump agents run to re-orient;
  `agentchats view` opens the transcript viewer; cass itself remains the
  search surface.
- `viewer/` — the read-only live transcript viewer (`agentchats view`): a
  bun + @opentui/solid app that renders Claude Code, Codex, and Pi session
  files with opencode's session renderer, vendored. Normalizers turn each
  store's native JSONL into opencode's v1 message/part schema; cass supplies
  discovery (`cass sessions --json`), the native files supply fidelity, and
  a follow tail streams live sessions message by message.
- `skills/chats/` — the source of the `chats` agent skill, the runbook that
  teaches agents to wield cass expertly. The `skills/<name>/` layout is the
  convention AgentStart's per-checkout skill scan discovers.

AgentStart (`~/code/agentstart`) owns AI-stack installation and invokes both:
the installer through this repository's `scripts/install.sh --install`
(`scripts/install-agent-clis`), the skill through the `agent*` checkout skill
scan (`scripts/sync-skills`), which ships every `skills/<name>/` directory
globally. Do not add a second installation or synchronization path here.

## Conventions

- The installer follows the fleet's helper style: bash, `set -euo pipefail`,
  a `die` helper, `--check` prints the plan without changing the system.
  A machine without this checkout is a skip inside AgentStart, not a failure;
  a present checkout that fails to install is a real error and propagates.
- cass tracks the latest upstream release deliberately, like every agent CLI
  the fleet installs. The release tag is resolved with the authenticated GitHub
  CLI first so reruns never exhaust the anonymous API limit.
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
- The viewer is a fleet TUI under the revised (chromeless, command-palette)
  fleet-tui-design contract, skinned with Signal Room tokens through
  opencode's own theme type. `viewer/src/vendor/` is vendored from opencode
  at the commit named in each file's header — resync deliberately against
  that pin, never restyle in passing; deliberate divergences are marked
  `viewer:` inline. The normalizers are the durable core: they must keep
  decoding cleanly against opencode's v1 Effect schemas
  (`viewer/spike/validate.ts --newest` is the gate, run from a bun-installed
  ~/src/opencode checkout).

## After changing this repository

- Installer changes: rerun `scripts/install.sh --install` here, then
  AgentStart's convergence check (`~/code/agentstart/scripts/install.sh
  --install`).
- Viewer changes: `cd viewer && bun run typecheck && bun test` (normalizer
  fidelity plus char-frame contract tests against the real renderer), then
  exercise `agentchats view` on a real session per store. After a normalizer
  or vendored-type change, rerun the schema gate:
  `bun viewer/spike/validate.ts --newest`.
- CLI changes: the `~/.local/bin/agentchats` link points into this checkout,
  so edits are live once the link exists; `scripts/install.sh --install`
  creates it. Exercise `bin/agentchats state` against a workspace with
  sessions, an empty one (must print nothing), and a PATH without cass.
- Skill changes: reinstall globally with AgentStart's scan
  (`~/code/agentstart/scripts/sync-skills`) or directly with
  `npx --yes skills add "$HOME/code/agentchats" --agent codex claude-code
  pi --skill chats --global --yes`, then confirm the installed copies match
  this checkout.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship globally through AgentStart's scan
  (`~/code/agentstart/scripts/sync-skills`, run six-hourly by the scheduled
  updater): a SKILL.md edit is live within six hours, or on demand by
  running that script. Whether a new skill earns a TOOLS.md advertisement
  line is a deliberate decision — `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
