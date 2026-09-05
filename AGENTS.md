# Agentchats agent guidance

## What this repository is

Agentchats makes the local coding-agent session history searchable. It owns
the whole path from transcript to search result, and nothing else:

- `src/parse/` — transcript parsers for Claude Code and Codex, normalizing
  each into a common message shape.
- `src/store/` — the SQLite+FTS5 schema, ingest (parse, normalize, write;
  incremental and retention-aware), and the query layer search reads from.
- `src/cli/` — the `agentchats` command surface: `index`, `status`,
  `search`, `sessions`, `view`, `expand`, `resume`, `state`.
- `src/tui/` — the Signal Room resume picker (bun + OpenTUI) behind
  `agentchats search` with no `--json`.
- `scripts/install.sh` — links the `agentchats` CLI into `~/.local/bin` and
  builds or refreshes the index so Claude Code and Codex sessions are
  searchable.
- `skills/chats/` — the source of the `chats` agent skill, the runbook that
  teaches agents to wield `agentchats`. The `skills/<name>/` layout is the
  convention AgentStart's per-checkout skill scan discovers.

Only Claude Code and Codex are in scope. This repository used to wrap a
third-party tool, cass, that covered twenty-odd more agents plus semantic
search, archive, and export; `docs/adr/0001-own-the-session-index.md`
records why that was retired and what was deliberately given up.

AgentStart (`~/code/agentstart`) owns AI-stack installation and invokes both:
the installer through this repository's `scripts/install.sh --install`
(`scripts/install-agent-clis`), the skill through the `agent*` checkout skill
scan (`scripts/sync-skills`), which ships every `skills/<name>/` directory
into the fixed private fleet resources. Do not add a second installation or
synchronization path here.

## Conventions

- The installer follows the fleet's helper style: bash, `set -euo pipefail`,
  a `die` helper, `--check` prints the plan without changing the system.
  A machine without this checkout is a skip inside AgentStart, not a failure;
  a present checkout that fails to install is a real error and propagates.
- The installer links the CLI, installs dependencies only when
  `node_modules/@opentui/core` is missing (bun's marker for "already
  installed"), then builds or refreshes the index through the newly linked
  CLI — every step idempotent, so a rerun after a failure just resumes.
- The index prepares incrementally when healthy and rebuilds fully via
  `agentchats index --full` when missing, unhealthy, or after a failed
  incremental refresh. Freshness between installs is the skill's job
  (`agentchats status`), not a daemon's.
- Index-building subprocesses are time-bounded (`scripts/run-with-timeout`)
  and fully reaped on timeout or installer termination — the installer's
  TERM/INT/HUP traps kill the child and wait for it, so a stuck rebuild
  cannot hang the installer or leave an orphaned process behind.
- `skills/chats/SKILL.md` documents the CLI as implemented, grounded in
  real command output. After a change to `src/cli/` changes command
  behavior, reverify the skill's claims against the live CLI before
  editing prose.
- `agentchats state` follows the shared `agent*` state-dump contract:
  scoped to one workspace, bounded by `--budget` (approximate tokens),
  fast, offline, read-only, markdown a model reads directly, and silent
  when the workspace has nothing — an empty section is never printed.
- Message bodies pass through `normalizeBody` (`src/parse/types.ts`)
  before they reach the index. FTS5's `unicode61` tokenizer treats Unicode
  Private Use Area and zero-width characters as token characters, not
  separators, so a citation marker glued to a word makes that word
  permanently unsearchable; `normalizeBody` strips them.
  `test/normalize.test.ts` is the regression test — don't write raw
  message text into the index anywhere else in the pipeline.
- Retention is by mirroring, not by a separate policy: ingest deletes any
  indexed row whose source transcript is gone, and that is the only
  pruning that happens. There is no separate pruning job, and there must
  not be one — a second deletion path would drift from what the
  transcript stores actually contain. The one exception is a root that
  could not be read: an unmounted volume looks exactly like a store whose
  every session was deleted, so removal is gated on the owning root having
  actually been walked (`ingest.ts`, `unavailableRoots`).
- Roots are walked in the order given and the first to claim a transcript
  keeps it, identified by filename. That is what keeps an archive from
  duplicating the live store it copies — `rsync -a` preserves mtime, so
  size and mtime cannot tell two copies apart. Callers list live stores
  before archives, because only the live copy can be resumed.

## After changing this repository

- Before pushing: `python3 .githooks/pre-push --check` runs CI's shell syntax
  and ShellCheck checks without loading the app or indexing sessions. Install
  the exact-commit hook once with `scripts/install-hooks.sh` from the canonical
  checkout. All worktrees share it; all opted-in repos share one per-user lock
  (15-second wait, 30-second checking deadline). It requires Python 3.9+, Bash,
  and ShellCheck, performs no installs, and retains existing hooks.
- `src/parse/`, `src/store/`, or `src/cli/` changes: `bun test` and
  `bunx tsc --noEmit` here, then `./bin/agentchats index` against a real
  `HOME` to confirm ingest still runs end-to-end. The
  `~/.local/bin/agentchats` link points into this checkout, so a CLI edit
  is live once the link exists; `scripts/install.sh --install` creates it.
- `src/tui/` changes: `bun test` and `bunx tsc --noEmit` here, then a pty
  smoke — the picker under `expect` with stdout captured must emit a valid
  resume directive on enter and nothing on escape. The TUI follows the
  `fleet-tui-design` wiki contract (chromeless, ctrl+k palette, Signal
  Room tokens in `src/tui/theme.ts`).
- Installer changes: `./scripts/install.sh --check` here to see the plan,
  then `--install` to apply it, then AgentStart's convergence check
  (`~/code/agentstart/scripts/install.sh --install`).
- Skill changes: rerun AgentStart's fixed fleet-resource scan
  (`~/code/agentstart/scripts/sync-skills`), then confirm the installed
  resource copy matches this checkout.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, and Codex uses
  `$agent:<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
