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
  cass itself remains the search surface.
- `skills/chats/` — the source of the `chats` agent skill, the runbook that
  teaches agents to wield cass expertly. The `skills/<name>/` layout is the
  convention Funk's per-checkout skill scanner discovers.

Funk (`~/code/funk`) is the sole owner of AI-stack installation and invokes
both from `libexec/install-ai-tools`: the installer through this repository's
`scripts/install.sh --install`, the skill through the `agent*` checkout
skill scan (`libexec/install-code-skills`), which ships every
`skills/<name>/` directory globally. Do not add a second installation or
synchronization path here.

## Conventions

- The installer follows Funk's helper style: bash, `set -euo pipefail`, a
  `die` helper, `--check` prints the plan without changing the system.
  A machine without this checkout is a skip inside Funk, not a failure; a
  present checkout that fails to install is a real error and propagates.
- cass tracks the latest upstream release deliberately, like every agent CLI
  Funk installs. The release tag is resolved with the authenticated GitHub
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

## After changing this repository

- Installer changes: rerun `scripts/install.sh --install` here, then Funk's
  convergence check (`~/code/funk/libexec/install-ai-tools`).
- CLI changes: the `~/.local/bin/agentchats` link points into this checkout,
  so edits are live once the link exists; `scripts/install.sh --install`
  creates it. Exercise `bin/agentchats state` against a workspace with
  sessions, an empty one (must print nothing), and a PATH without cass.
- Skill changes: reinstall globally with Funk's scanner
  (`~/code/funk/libexec/install-code-skills`) or directly with
  `npx --yes skills add "$HOME/code/agentchats" --agent codex claude-code
  pi --skill chats --global --yes`, then confirm the installed copies match
  this checkout.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship globally through Agentdots' scan
  (`~/code/agentdots/scripts/sync-skills`, run six-hourly by Funk's
  updater): a SKILL.md edit is live within six hours, or on demand by
  running that script. Whether a new skill earns a TOOLS.md advertisement
  line is a deliberate decision — `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentdots/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, story, the resource skills — is
  `~/code/agentguidance`; tool-specific runbooks stay here.
