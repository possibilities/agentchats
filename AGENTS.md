# Agentchats agent guidance

## What this repository is

Agentchats makes the local coding-agent session history searchable. It owns
two things and nothing else:

- `scripts/install.sh` — the installation contract for cass
  (Dicklesworthstone/coding_agent_session_search): install or upgrade the
  binary from the upstream checksummed release, then build or refresh the
  index so Claude Code, Codex, and Pi sessions are searchable.
- `chats/` — the source of the `chats` agent skill, the runbook that teaches
  agents to wield cass expertly.

Funk (`~/code/funk`) is the sole owner of AI-stack installation and invokes
both from `libexec/install-ai-tools`: the installer through this repository's
`scripts/install.sh --install`, the skill through `npx skills add` against
this checkout for every configured global agent skill location. Do not add a
second installation or synchronization path here.

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
- `chats/SKILL.md` documents the CLI as installed, grounded in real command
  output. After a cass upgrade changes behavior, reverify the skill's claims
  against the live CLI (`cass triage --json`, `cass capabilities --json`,
  `cass robot-docs commands`) before editing prose.
- The upstream source is cloned for reference at
  `~/src/coding_agent_session_search`. Read it before guessing at behavior;
  never edit it from here.

## After changing this repository

- Installer changes: rerun `scripts/install.sh --install` here, then Funk's
  convergence check (`~/code/funk/libexec/install-ai-tools`).
- Skill changes: reinstall globally with
  `npx --yes skills add "$HOME/code/agentchats" --agent codex claude-code
  opencode pi --skill chats --global --yes`, then confirm the installed
  copies match this checkout.
