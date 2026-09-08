# Search and evidence

## Query syntax and scope

Queries use FTS5: terms AND by default, case-insensitively, within one message.
Quote an exact phrase, use `OR` or `NOT`, or put `*` after a prefix. There is no
substring or suffix wildcard; a leading `*` is dropped. Short distinctive
terms usually work better than a whole error message with changing paths.
An empty `query` means all sessions in the selected scope.

| Argument | Use |
|---|---|
| `agent` | `claude_code` or `codex`, the only indexed harnesses |
| `workspace` | One project, using its reported absolute path |
| `days` | Last N days; an explicit `since` takes precedence |
| `since`, `until` | ISO dates or relative values such as `-7d` and `24h` |
| `limit`, `offset` | A bounded page of ranked sessions |
| `fields` | `minimal`, `summary`, or comma-joined hit fields |
| `max-content-length` | Cap snippet and title, preserving citation fields |
| `aggregate` | Comma-joined `agent`, `workspace`, or `date` facets |

`minimal` keeps `source_path`, `line`, and `agent`. `summary` adds `workspace`,
`title`, `snippet`, `score`, and `created_at`. The guide lists custom fields;
an unknown name is a usage error. Facets are independent counts, not a
cross-product. Pagination uses an offset, not a larger repeated query.

## Useful searches

- A familiar failure: a distinctive token such as `ECONNREFUSED redis`, a
  limit of five, summary fields, and a relevant time range.
- Project history: `sessions` with an absolute workspace and a small limit.
  The terminal's `current` flag is not an MCP parameter.
- Cross-harness history: search once across both, then filter `agent` when
  the distinction matters. Do not assume the other harness has no evidence.
- File history: search the basename or a distinctive path component, then
  inspect the actual tool call and surrounding discussion.
- A daily review: an empty query with `days:1` and `aggregate:"agent,workspace"`.
  Weekly trends can use `days:7` and `aggregate:"date,agent"`.

## Exact records and quotations

A search hit supplies its best message's physical transcript `line` and
`source_path`. `view` reads that indexed message; `expand` uses the same
anchor and a count of neighboring indexed messages. Neighbors may not be
adjacent physical lines because transcripts also contain metadata records.

Long bodies are capped in the index and explicitly marked `truncated`.
`view` with `full:true` seeks the original record by its stored byte offset.
`source_record` is present only if that record remains readable; it does not
replace `body`. A pruned or moved transcript may still have indexed evidence
until the next successful pass, so absence of the full record is meaningful.
Do not present a capped excerpt as a complete quotation.

`resume` returns `agent`, `session_id`, and `command`. Hand off the returned
command for the selected live session. An archived session is searchable
but not resumable, and guessing a new command does not restore it.

## Storage and freshness

The database is derived state at `~/.local/state/agentchats/index.db` by
default. It mirrors `~/.claude/projects` and `~/.codex/sessions`, plus any
archives explicitly configured in `~/.config/agentchats/config.json`.
The CLI honors its documented XDG environment. MCP uses its startup
environment; callers cannot supply per-call homes or database overrides.

`status` reports counts, freshness, pending and vanished transcripts, and
unavailable roots. An empty index reports `healthy:false`. A read that needs
indexed messages instead returns `missing-index`; `state` returns a short
preparation hint. An index can become stale again while agents are writing
transcripts, so a fresh pass is not a promise of permanent freshness.

Normal indexing is incremental. A full rebuild discards only the derived
database and can take longer; it is a recovery option, not a routine preflight.
`retain-days` also drops older indexed sessions without removing transcripts.
Ordinary mirroring removes a session only after its owning source root was
successfully walked. An unavailable volume never looks like an empty store.
Cancellation keeps completed session transactions and skips final pruning.
Progress notifications are available to MCP clients that supply a token.

Configured archives use objects such as
`{"archives":[{"path":"/Volumes/Archive/claude/projects","agent":"claude_code"}]}`.
When live and archived copies overlap, the live source wins. Archive setup is
an operator configuration choice; search does not require changing it.

Recorded AgentChats invocations and their tool output are excluded from the
index, including direct MCP and historical aggregator calls, so a search does not
rank its own prior excerpts. Ordinary conversation about the tool remains.

## Operator and installation paths

`agentchats search` without `--json` opens the human Signal Room picker,
optionally seeded by a query and scoped by `--workspace`. It shows full
harness sessions by default; `--include-auxiliary` also shows app-server,
realtime, and child sessions. A pick writes a resume directive consumed by
AgentSurface. MCP search always invokes the producer query, never this TUI.

Terminal scripts retain `--json` and their original output contracts:
command-specific JSON on stdout, errors as `{error:{code,message,hint}}` on
stderr, and Markdown for `state`. Exit 3 means no populated index, 64 a usage
fault, and 1 a domain/internal error or a wholly failed index pass. An index
with partial progress can exit zero with `success:false`; inspect its report.

The checkout's `scripts/install.sh --install` resolves frozen dependencies,
links the CLI, and prepares the index through a bounded child process.
AgentStart invokes it, registers `agentchats mcp`, and installs this skill.
Native filesystem and shell tools remain available for source inspection and
operator workflows that need them.
