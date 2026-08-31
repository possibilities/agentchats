---
name: chats
description: Search every past coding-agent session on this machine with the cass CLI — Claude Code, Codex, Cursor, Gemini, and twenty more agents' histories in one index. Use when an error, bug, or decision feels previously seen; when the user references a past session, conversation, or chat ("we did this before", "find that session where…"); when resuming or reconstructing context for a workspace; when preparing a cited handoff of prior work to another agent; or before re-deriving anything a past session may already contain.
---

# Chats — search past coding-agent sessions

Every coding agent on this machine writes a session log. cass (coding agent
session search) indexes all of them — Claude Code, Codex, and twenty
more connectors — into one local, searchable archive. This skill is the
runbook for wielding it. Past sessions are a first-class research source:
before re-deriving a fix, re-debugging a familiar error, or asking the user
what happened, search the archive.

Verified against cass 0.6.23. The CLI is self-describing — when this
document and the installed binary disagree, the binary wins; see
[Discovery and drift](#discovery-and-drift).

## Non-negotiables

- **Never run bare `cass`.** It launches a full-screen TUI that blocks your
  session. Every invocation carries a subcommand plus `--robot` or `--json`.
  (If you ever do get stuck, the TUI quits with `Ctrl+C`.)
- **stdout is data, stderr is diagnostics.** Robot mode auto-suppresses INFO
  logs; parse stdout as JSON, never scrape prose.
- **Read `_meta` when it matters.** Add `--robot-meta` whenever freshness,
  pagination, or search-mode fallback would change what you do next.
- **Bound your output.** You are the token budget: `--limit`, `--fields`,
  `--max-tokens`, `--max-content-length`, `--aggregate`. Unbounded search
  (`--limit 0`) is legal and a mistake in an agent loop.
- **Don't grep the session stores by hand.** `~/.claude/projects`,
  `~/.codex/sessions`, and friends are cass's job: it dedups, ranks, filters
  noise, and spans all agents at once. Raw `grep` over those directories is
  slower, noisier, and misses every other agent's history.

## Preflight

Health is a sub-50ms probe; triage is the one-shot readiness contract:

```bash
cass health --json          # exit 0 healthy, 1 unhealthy
cass triage --json          # readiness + the exact next command
```

Triage returns `status`, `healthy`, `initialized`, `next_command`,
`recommended_commands[]`, `starter_workflows[]`, and `mistake_recoveries[]`.
When `next_command` is present, run exactly that — it is the contract, not a
suggestion. Typical states:

- **Not initialized / missing index** → `cass index --full` (first build
  takes minutes on a large history; from another shell `cass status --json`
  shows live progress, and `status.rebuild.active` says a rebuild is already
  running — don't start a second one).
- **Stale index** (`_warning` on search, `index_freshness.stale`) →
  `cass index` (incremental, sub-second to seconds). Sessions written since
  the last index — including the one you are in — are invisible until then.
- **Rebuilding** → wait and retry; don't stack rebuilds.
- **Healthy** → search.

The archive is shared state: sibling agents and background installs run
cass concurrently. `index-busy`/`lock-busy` (exit 7) is normal traffic —
poll `status.rebuild.active` and take your turn; another actor's rebuild
is your index getting fresher for free. Health probes can also report
transient degraded states while writers are active; a served search is
the ground truth that the archive works.

`cass index --full` is for first setup, explicit recommendation, or schema
drift — not a reflexive repair loop. Aliases `cass ready --json` and
`cass preflight --json` work; so does bare `cass --json` (defaults to
triage).

### Workspace bearings

`agentchats state [--workspace <dir>] [--budget <tokens>]` (this
repository's own CLI, beside cass in `~/.local/bin`) prints the recent
sessions for one project as a short markdown section, newest first, silent
when the workspace has none. It is the cheap re-orientation step — "what
has been happening here" — before any search; the moment you need content,
switch to `cass search`/`cass sessions` in robot mode.

## The search loop

Discover broadly with tight fields, then drill into the winner:

```bash
# 1. Scope the territory when the query is broad (~99% token reduction)
cass search "authentication" --robot --aggregate agent,workspace,date

# 2. Search bounded
cass search "authentication timeout" --robot --limit 10 \
  --fields summary --max-content-length 400 --robot-meta

# 3. Drill into a hit (source_path + line_number come from the hit)
cass view /path/to/session.jsonl -n 42 --json
cass expand /path/to/session.jsonl --line 42 -C 5 --json   # ±5 messages

# 4. Cite or hand off
cass pack "authentication timeout root cause" --robot --max-tokens 4000
```

A search hit's essential fields: `source_path`, `line_number`, `agent`,
`workspace`, `title`, `snippet`, `score`, `match_type`, `created_at`, plus
a `trust` block (`trust_tier`, `confidence`, `stale_reason`,
`recommended_followup`) grading how much to lean on the hit — an
`unverified` tier means corroborate before reuse. `match_type` grades
match quality: `exact` > `prefix` > `suffix` > `substring` > `fuzzy`. When
results are sparse (<3), cass silently retries with wildcards and flags it
via `wildcard_fallback: true` — treat those hits as leads, not proof.

The positional query is required but may be the empty string: `cass search
"" --robot` plus filters/aggregates is the query-less idiom for "everything
in scope" (fast — it is an index scan, not a grep).

## Query language

Terms AND by default. Case-insensitive.

| Form | Example | Notes |
|---|---|---|
| Phrase | `"connection refused"` | exact sequence |
| OR / NOT | `error OR warning`, `panic NOT test` | `-term` = NOT |
| Grouping | `auth AND (jwt OR oauth) NOT expired` | full boolean nesting |
| Prefix wildcard | `deploy*` | fast (edge n-grams) |
| Suffix / substring | `*ction`, `*config*` | slower (regex scan) |

Filters compose with any query:

- `--agent claude_code` — one agent's history only. Slugs are exact:
  `claude_code`, `codex`, `gemini`, `cursor`, `aider`,
  `amp`, `cline`, `chatgpt`, `factory`, `copilot`, `copilot_cli`,
  … (`cass capabilities --json | jq .connectors` for all 23).
- `--workspace /path` — one project. Use the workspace string exactly as
  hits report it.
- Time: `--today`, `--yesterday`, `--week`, `--days N`,
  `--since 2026-08-01`, `--until 2026-08-07`. Since/until also accept
  relative (`-7d`, `-24h`) and timestamp forms.

Search modes (`--mode lexical|semantic|hybrid`): default is
hybrid-preferred. Semantic is opportunistic enrichment — hybrid **fails
open to lexical** whenever the local MiniLM model isn't installed or
backfilled, which is normal and not an error. With `--robot-meta`, the
truth is in `_meta.search_mode`, `_meta.semantic_refinement`,
`_meta.fallback_tier`, `_meta.fallback_reason`. Force `--mode lexical` for
exact code/error tokens; try `--mode semantic` for conceptual "how did we
approach X" queries when models are installed (`cass models status --json`).

## Token discipline

| Lever | Use |
|---|---|
| `--limit N` | Always set one; default `0` means unbounded |
| `--fields minimal` | `source_path,line_number,agent` — wide scans |
| `--fields summary` | + `title`, `score` — the usual choice |
| `--fields provenance` | + `source_id,origin_kind,origin_host` — multi-machine |
| `--fields score,title,snippet` | any custom comma list |
| `--max-content-length N` | truncate long fields, UTF-8-safe, sets `*_truncated` |
| `--max-tokens N` | soft whole-response budget (~4 chars/token) |
| `--aggregate agent,workspace,date,match_type` | counts instead of content |
| `--robot-format compact` | single-line JSON; `jsonl` streams one hit per line |

Paginate with the cursor, never by re-running wider:

```bash
cass search "TODO" --robot --robot-meta --limit 20
# then: --cursor "<_meta.next_cursor>" (keep --robot-meta to get the next cursor)
```

Correlate retries and logs with `--request-id <id>`. Preview cost with
`--explain` (parsed query + cost class) or validate with `--dry-run`.

## Recipes

**"I've seen this error before."** Search the distinctive token, not the
whole message; strip paths/line numbers that won't recur:

```bash
cass search "ECONNREFUSED redis" --robot --limit 5 --fields summary --days 90
```

**Resume context for this workspace.** What was I (or any agent) doing
here?

```bash
cass sessions --current --json            # best match for cwd, most recent
cass sessions --workspace "$(pwd)" --json --limit 5
cass search "" --robot --workspace "$(pwd)" --days 7 --aggregate date,agent
```

Then `cass resume <source_path> --shell` prints the native resume command
for that session's harness — claude, codex, or another — hand it to the
user rather than executing a nested agent yourself.

**Cross-agent archaeology.** What did *any* agent conclude about X?

```bash
cass search "database migration strategy" --robot --limit 8 --fields summary
# then narrow: --agent codex, --agent claude_code, --agent gemini …
```

**File archaeology.** Which sessions touched this file? Filenames are
searchable text:

```bash
cass search "install-ai-tools" --robot --limit 5 --fields summary
```

(`cass context <session.jsonl> --json` finds sessions *related to a
session* you already have — it rejects source-file paths, and at
large archive sizes it can take minutes; prefer search.)

**Daily/weekly review.** Aggregate, don't enumerate:

```bash
cass search "" --robot --days 1 --aggregate agent,workspace
cass search "" --robot --week --aggregate date,agent
```

(`cass timeline --since <date> --json` exists but walks the whole archive
— at ~200k messages it runs minutes, not seconds. Reach for aggregation
first.)

**Drill-down pipeline.** Narrow a corpus, then search within it:

```bash
cass search "authentication" --robot-format sessions \
  | cass search "refresh token" --sessions-from - --robot --limit 10
# --robot-format sessions emits one session path per line; also works into pack
cass search "" --today --robot-format sessions > /tmp/today.txt
cass search "bug fix" --sessions-from /tmp/today.txt --robot
```

**Full session export** (browsable artifact, not token-budgeted):

```bash
cass export /path/to/session.jsonl --format markdown -o conversation.md
cass export-html /path/to/session.jsonl --json     # self-contained HTML
```

**Usage analytics.** `cass stats --json` (index-wide counts:
`conversations`, `messages`, `by_agent[]`, `top_workspaces[]`),
`cass analytics tokens|tools|models --json` (token/tool/model usage mined
from history; envelope is `{command, data, _meta}`).

## Handoff packs

When another agent (or the user) needs *evidence*, not raw hits, build a
pack: deterministic, extractive, cited, redacted, token-budgeted. It never
calls an external model and never mutates logs.

```bash
cass pack "why did checkout fail after the redirect change" --robot \
  --max-tokens 4000 --max-evidence 8 --max-sessions 3 --max-excerpt-chars 600

# Freshness-sensitive: only recent evidence, error if none qualifies
cass pack "flaky CI timeout" --robot --freshness-policy strict \
  --freshness-window-seconds 604800 --require-evidence

# Restrict evidence to a corpus you already narrowed
cass search "checkout timeout" --robot-format sessions \
  | cass pack "checkout timeout root cause" --robot --sessions-from -
```

Pack queries follow search's AND semantics: every term must co-occur, so a
prose question ("how was X installed and prepared") often selects zero
evidence under lexical fallback while two or three distinctive terms
select plenty. `no_evidence_found` usually means "shorten the query", not
"nothing exists". Citations redact absolute paths by default
(`[REDACTED_PATH]`) and carry hashes plus `verified` — evidence stays
verifiable without leaking the filesystem.

Before pasting a pack anywhere, read its contract fields — they are
branchable, not decoration:

- `warnings[]` — `privacy_redactions_applied` (check
  `privacy.redaction_counts`), `semantic_fallback_lexical` (lexical-only
  evidence), `no_evidence_found`.
- `health.recommended_action` — refresh the index first if it says so.
- `freshness.stale_evidence_count` — nonzero means old evidence made it in.
- `omitted[]` — what didn't fit the budget; `--explain-selection` audits
  scoring.
- `--require-evidence` with no matches returns an error envelope with
  `err.kind = "not-found"` — broaden the query or drop the flag.

Pack vs search: search explores and paginates; pack commits to a bounded,
citable bundle. Pack vs export-html: export is complete and unbudgeted.

## Health, errors, recovery

Errors are structured: `{"error": {"code", "kind", "message", "hint",
"retryable"}}` (some surfaces use `err.kind`). On failure stdout stays
empty and the envelope arrives on **stderr** — so capture both streams and
branch on exit code, then `kind`. Kinds are kebab-case and canonical
(`missing-index`, `index-busy`, `lock-busy`, `timeout`,
`semantic-unavailable`, …); `hint` is written to be followed. Exit codes:

| Exit | Meaning | Move |
|---|---|---|
| 0 | success | parse stdout |
| 1 | unhealthy | `cass triage --json`, follow `next_command` |
| 2 | usage error | fix per `hint`; syntax is forgiving but don't lean on it |
| 3 | missing index/db | `cass index --full` |
| 4 | network | remote-source ops only; check connectivity |
| 5 | data corruption | `cass index --full --force-rebuild` |
| 6 | incompatible version | update cass |
| 7 | lock/busy | another cass holds the write lock — wait, retry |
| 8 | partial result | narrow the query or raise `--timeout` |
| 9 | unknown | check `retryable` |
| ≥10 | domain-specific | branch on `err.kind`, not the number |

Recovery discipline: triage first, then its `next_command`. Escalate a
stubbornly broken derived index through `cass doctor check --json`
(read-only truth) → `cass doctor repair --dry-run --json` → apply with the
returned `--plan-fingerprint`. Doctor is archive-first: it repairs derived
assets, quarantines rather than deletes, and every mutation has receipts
and `cass doctor --undo`. Never hand-delete index files.

Mistakes cass forgives (auto-normalized, so a slightly-wrong call still
lands): typo'd subcommands (`serach`), single-dash long flags, misplaced
globals (`cass --json search q`), `--query`/`--path` named forms,
`--max-results`/`--top-k`/`-n` → `--limit`, `--format json` →
`--robot-format json`, and aliases (`find|query|grep` → search, `show|get`
→ view, `st` → status). Write the canonical form anyway.

## Discovery and drift

cass teaches itself; prefer asking it over trusting memory:

```bash
cass capabilities --json      # connectors, features, limits, workflows, recoveries
cass introspect --json        # full response schemas per command
cass robot-docs commands      # every command + flag (also: guide, schemas,
                              # examples, exit-codes, contracts, sources, doctor)
cass --robot-help             # one-screen agent quickstart
cass api-version --json       # crate + api + contract version
```

Contract v1 guarantees exit codes, robot JSON shapes, flag names, and
`_meta` stability. After a cass upgrade, `cass capabilities --json` is the
five-second re-sync.

## Environment and layout

- Index + DB live under `~/Library/Application Support/
  com.coding-agent-search.coding-agent-search/` (macOS); override with
  `CASS_DATA_DIR` or `--data-dir`. Budget disk at roughly 2–3× the raw
  session stores; a full index on a starved disk fails mid-build with
  `No space left on device` (retryable after freeing space — the archive
  is never the casualty).
- Session stores indexed here: `~/.claude/projects` (claude_code),
  `~/.codex/sessions` (codex), plus
  every other detected agent.
- Harness-level defaults exist as env vars when you can't edit the
  command: `CASS_SEARCH_LIMIT`, `CASS_SEARCH_TIMEOUT_MS`,
  `CASS_SEARCH_MODE`, `CASS_OUTPUT_FORMAT` (flags always win).
  `cass robot-docs env` lists them all.
- `cass index --watch` follows changes live (the TUI does this for
  humans); agents normally just run `cass index` when triage says stale.
- Remote machines: `cass sources setup` wizard, `cass sources list|sync
  --json`, then filter searches with `--source <name>` and read
  provenance fields. `cass robot-docs sources` is the runbook.
- Semantic search is opt-in: `cass models install --model minilm`, then
  `cass models backfill`; `cass models status --json` reports state.
  Everything works lexically without it.
- Installed and index-prepared by `~/code/agentchats/scripts/install.sh
  --install` (AgentStart runs it); rerunning it is always safe.

## Anti-patterns

| Don't | Do |
|---|---|
| `cass` bare, or piping TUI output | subcommand + `--robot` |
| `grep -r ~/.claude/projects` | `cass search … --robot` |
| Unbounded `cass search "error" --robot` | `--limit`, `--fields`, budgets |
| Re-running a query wider for page 2 | `--cursor` from `_meta.next_cursor` |
| Pasting full sessions into your context | `view`/`expand` the cited lines; `pack` for handoffs |
| `cass index --full` as a reflex | triage → `next_command`; incremental `cass index` |
| Treating lexical fallback as breakage | it's the designed degrade; check `_meta.fallback_reason` |
| Copying pack text while ignoring `warnings[]` | branch on redaction/freshness warnings first |
| Searching the whole error string verbatim | distinctive tokens, quoted phrases, boolean |

## For the human

When the user wants to browse rather than delegate: plain `cass` opens the
TUI — type-to-search with live results, `F1` help, `Enter` opens a hit in
`$EDITOR`, `b` bookmarks, themes and saved views included. Suggest it when
interactive exploration beats query crafting.
