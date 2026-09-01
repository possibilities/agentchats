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
agentchats status --json      # is the index present, and is it fresh
```

`status` always succeeds — reporting "zero sessions" is an answer, not a
failure — so branch on the payload, not the exit code:

- `healthy: false` → nothing is indexed yet. `agentchats index`.
- `stale: true` → `pending` transcripts are new or changed and `vanished`
  indexed sessions are gone. `agentchats index` reconciles both.
- `stale: false` → search directly.

Worth the extra call: `status` costs about half a second because it only
stats the stores, while an index run that finds nothing to do still costs
around six. Ask the cheap question before spending the expensive one.

`unavailableRoots` names any transcript store that could not be read this
run — an unmounted volume, a store this machine doesn't have. Sessions from
an unavailable root stay searchable and are never pruned, but nothing under
it was refreshed.

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

**One hit is one session.** Results are ranked sessions, not ranked
messages: a session scores by its best matching message plus a bonus for how
many matched, and the hit carries that best message as the citation. So
`--limit 10` means ten conversations, not ten lines from three of them. When
you want more evidence from a session you already have, `expand` it.

A hit carries `source_path` and `line` — feed both straight into
`view`/`expand`/`resume`, don't reconstruct them.

`view` and `expand` report `truncated`. Long tool output is stored capped, so
a message flagged `truncated: true` is cut mid-text. Don't quote it as
complete evidence — `agentchats view <path> --line N --full` reads the whole
record from the transcript and returns it as `source_record`. About 5% of
messages are capped, nearly all of them tool output. The positional query is
required but may be the empty string: `agentchats search "" --json` plus
filters/aggregates is the query-less idiom for "everything in scope."

### Know how a hit was matched

Every hit carries `matched_on`, and the response carries `fallback`. Read
them before leaning on a result:

- `matched_on: "message"` — the terms are in that session's cited message.
  The default, and the only kind to treat as proof.
- `matched_on: "session"` — a *widened* match. When a multi-term query finds
  fewer than three exact hits, the search retries for sessions containing
  every term *somewhere*, not in one message. `fallback` is then `"session"`.
  These are leads: open them before citing them.
- `matched_on: "metadata"` — matched the session's title, workspace, or file
  path rather than any message text.

## Query language

FTS5 syntax. Terms AND by default, case-insensitive. **AND is scoped to a
single message**: `deploy timeout` finds a message containing both words,
not a session that mentions them in different turns. Quote a phrase for an
exact sequence; split a broad question into two or three distinctive terms
rather than searching a whole sentence.

| Form | Example | Notes |
|---|---|---|
| Phrase | `"connection refused"` | exact sequence |
| OR / NOT | `error OR warning`, `panic NOT test` | |
| Prefix wildcard | `deploy*` | |

There is no substring or suffix wildcard: `*config*` and `*ction` are not
supported, and a leading `*` is simply dropped. Search a prefix instead.

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
| `--fields minimal` | `source_path`, `line`, `agent` — wide scans |
| `--fields summary` | the above plus `workspace`, `title`, `snippet`, `score`, `created_at` — the usual choice |
| `--fields <csv>` | any custom list of hit fields |
| `--max-content-length N` | shorten `snippet` and `title`; citation fields are never touched |
| `--aggregate agent,workspace,date` | counts instead of content; a comma list returns one facet per dimension |

An unknown name in `--fields` is a usage error, not an empty result — a
misspelling tells you so rather than looking like "no such data".

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

**Project archaeology.** For "which sessions touched this project", scope
rather than search — the workspace is a filter, not a term:

```bash
agentchats sessions --workspace ~/code/myproject --json --limit 10
```

**File archaeology.** Which sessions touched this file? Filenames appear in
tool calls, so they are searchable text:

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
| 3 | index holds nothing — `search`/`sessions`/`view` only | `agentchats index` |
| 64 | usage error | fix the invocation per `hint` |

## Environment and layout

- The index is derived state at `~/.local/state/agentchats/index.db` —
  roughly 1.8 GB for the whole corpus. Delete it and run
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
