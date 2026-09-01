---
name: chats
description: Search past Claude Code and Codex sessions on this machine with the agentchats CLI — a local SQLite+FTS5 index of session transcripts, searchable offline. Use when an error, bug, or decision feels previously seen; when the user references a past session, conversation, or chat ("we did this before", "find that session where…"); when resuming or reconstructing context for a workspace; or before re-deriving anything a past session may already contain.
---

# Chats — search past coding-agent sessions

Every Claude Code and Codex session on this machine writes a transcript to
disk. `agentchats` indexes them into a small local SQLite+FTS5 database, and
this skill is the runbook for wielding it. Past sessions are a first-class
research source: before re-deriving a fix, re-debugging a familiar error, or
asking the user what happened, search the index.

## Non-negotiables

- **stdout is data, stderr is diagnostics.** A failed call prints an error
  envelope — `{"error":{"code","message","hint"}}` — to stderr and returns a
  nonzero exit; stdout stays empty. Parse stdout as JSON, never scrape prose.
- **Bound your output.** `--limit`, `--fields`, `--max-content-length`,
  `--aggregate`. A default-unbounded search in an agent loop is a mistake,
  not a convenience.
- **Don't grep the session stores by hand.** `~/.claude/projects` and
  `~/.codex/sessions` are the index's job: it dedups and ranks across both
  agents at once. Raw `grep` over those directories is slower and only ever
  sees one agent's history.
- **The index is derived, not authoritative.** It mirrors the live
  transcript stores. A session vanishes from search the moment its
  transcript is pruned, and the whole database can be thrown away and
  rebuilt from those stores at any time — see
  [Environment and layout](#environment-and-layout).

## Preflight

```bash
agentchats status --json      # is the index present and fresh
```

- **Missing index** (exit 3) → `agentchats index --full` — first build,
  scans every transcript.
- **Stale** → `agentchats index` — incremental: only sessions written or
  changed since the last run. Cheap enough to run before every search
  session.
- **Healthy** → search directly.

### Workspace bearings

`agentchats state [--workspace <dir>] [--budget <tokens>]` prints the
recent sessions for one project as a short markdown section, newest first,
silent when the workspace has none. It's the cheap re-orientation step —
"what has been happening here" — before reaching for `search`.

## The search loop

Discover broadly, then drill into the winner:

```bash
# 1. Scope the territory when the query is broad
agentchats search "authentication" --json --aggregate agent,workspace,date

# 2. Search bounded
agentchats search "authentication timeout" --json --limit 10 \
  --fields summary --max-content-length 400

# 3. Drill into a hit (source_path + line come from the hit)
agentchats view /path/to/session.jsonl --line 42 --json
agentchats expand /path/to/session.jsonl --line 42 --context 5 --json

# 4. Resume or hand off
agentchats resume /path/to/session.jsonl --shell
```

A hit carries `source_path` and `line` — feed both straight into
`view`/`expand`/`resume`, don't reconstruct them. The positional query is
required but may be the empty string: `agentchats search "" --json` plus
filters/aggregates is the query-less idiom for "everything in scope."

## Query language

FTS5 syntax. Terms AND by default, case-insensitive.

| Form | Example | Notes |
|---|---|---|
| Phrase | `"connection refused"` | exact sequence |
| OR / NOT | `error OR warning`, `panic NOT test` | |
| Prefix wildcard | `deploy*` | |

Filters compose with any query:

- `--agent claude_code` or `--agent codex` — the only two slugs; nothing
  else is indexed.
- `--workspace /path` — one project; use the workspace string exactly as a
  hit reports it.
- `--days N`, `--since S`, `--until S` — bound by time.
- `--offset N` with `--limit N` — pagination; there is no cursor.

## Token discipline

| Lever | Use |
|---|---|
| `--limit N` | Always set one |
| `--fields minimal` | narrowest columns — wide scans |
| `--fields summary` | a few more columns — the usual choice |
| `--fields <csv>` | any custom comma list |
| `--max-content-length N` | truncate long fields |
| `--aggregate agent,workspace,date` | counts instead of content |

Paginate with `--offset`, not by re-running a query wider.

## Recipes

**"I've seen this error before."** Search the distinctive token, not the
whole message; strip paths and line numbers that won't recur:

```bash
agentchats search "ECONNREFUSED redis" --json --limit 5 --fields summary --days 90
```

**Resume context for this workspace.** What was I (or another agent) doing
here?

```bash
agentchats sessions --current --json
agentchats sessions --workspace "$(pwd)" --json --limit 5
agentchats search "" --json --workspace "$(pwd)" --days 7 --aggregate date,agent
```

Then `agentchats resume <source_path> --shell` prints the native resume
command for that session's harness (`claude` or `codex`) — hand it to the
user rather than executing a nested agent yourself.

**Cross-agent archaeology.** What did the other agent conclude about X?

```bash
agentchats search "database migration strategy" --json --limit 8 --fields summary
# then narrow: --agent codex, or --agent claude_code
```

**File archaeology.** Which sessions touched this file? Filenames are
searchable text:

```bash
agentchats search "install-ai-tools" --json --limit 5 --fields summary
```

**Daily/weekly review.** Aggregate, don't enumerate:

```bash
agentchats search "" --json --days 1 --aggregate agent,workspace
agentchats search "" --json --days 7 --aggregate date,agent
```

## Errors and recovery

| Exit | Meaning | Move |
|---|---|---|
| 0 | success | parse stdout |
| 1 | error | read `hint` on stderr, act on it |
| 3 | missing index | `agentchats index --full` |
| 64 | usage error | fix the invocation per `hint` |

## Environment and layout

- The index is derived state at `~/.local/state/agentchats/index.db` —
  under a gigabyte for the whole corpus. Delete it and run
  `agentchats index` to rebuild from nothing; nothing is lost, because
  every fact in it is re-derivable from the live transcript stores.
- Those stores are `~/.claude/projects` (claude_code) and
  `~/.codex/sessions` (codex) — nothing else is indexed.
- `agentchats index` is incremental and cheap to rerun; `--retain-days N`
  bounds how far back it reaches, for accounts with long transcript
  history.
- Installed and index-prepared by `~/code/agentchats/scripts/install.sh
  --install` (AgentStart runs it); rerunning it is always safe.

## Anti-patterns

| Don't | Do |
|---|---|
| `grep -r ~/.claude/projects` | `agentchats search … --json` |
| Unbounded `agentchats search "error" --json` | `--limit`, `--fields` |
| Re-running a query wider for page 2 | `--offset` |
| Pasting full sessions into your context | `view`/`expand` the cited lines |
| Searching the whole error string verbatim | distinctive tokens, quoted phrases |

## For the human

`agentchats search` with no `--json` opens the Signal Room picker — a
live-search TUI over the same index, optionally seeded with a query
(`agentchats search "authentication"`). `--workspace` scopes it to one
project; `--include-auxiliary` widens beyond full-harness sessions. A pick
writes a resume directive that agentsurface realizes as a herdr resume.
