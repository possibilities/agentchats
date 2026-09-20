# 0009: Contain legacy ingest before streaming

Status: Accepted
Date: 2026-09-20

## Context

The legacy incremental indexer skips unchanged transcripts, but reparses a
changed transcript as one complete string and replaces its session in one
transaction. A small append to a giant active rollout can therefore allocate
and parse the entire file. SQLite's writer lock does not prevent another CLI,
MCP server, or installer from doing the same read concurrently. Discovery also
treated some incomplete subtree/stat results as deletion evidence, and an
empty parser result removed the last searchable row.

The sustainable indexing design splits the full fix into stages. Streaming,
append checkpoints, source generations, compressed replay, and giant-record
handling require later schema and parser work. Immediate containment must make
the current whole-file parser safe enough for bounded small sources while
preserving the useful old index.

## Decision

Every `index` entry point acquires one canonical-index writer lease before it
opens a mutating session-index connection or reads source bodies. A separate
tiny SQLite lock file holds an exclusive transaction, so process exit releases
ownership without PID-file stale-lock recovery. CLI, MCP, and installer calls
all use the shared command handler.

After ownership, resource preflight checks at least 10 GiB of local disk
headroom, 256 MiB of free system memory, a 256 MiB process-RSS ceiling, and 32
process slots of measured headroom. Missing process telemetry defers unattended
installer preparation. A failed preflight returns exit 75 and a truthful
`success:false`, `outcome:"deferred"` report before the session index is opened.
The owning process atomically writes one bounded sidecar attempt summary so a
later `status` can expose that pre-open outcome. A busy contender cannot write
the sidecar or replace the active owner's eventual summary.

The legacy parser reads only changed plain JSONL sources at most 16 MiB.
Changed `.zst` sources and larger sources defer before their reader is called.
A source that changes during its bounded read, returns an empty parse, or fails
to parse retains its prior searchable row. Diagnostics and telemetry samples
are capped and contain no transcript bodies.

Pruning is all-or-nothing per pass. Root absence, any nested directory or stat
failure, source deferral, parser failure, or cancellation withholds every
disappearance, duplicate, and age-based deletion. Narrow injected root lists
can only prune rows under those roots. `--full` now forces safe sources through
the same atomic replacement path; it does not delete the existing index first.

The installer treats exit 75 as a successful CLI installation with
"index preparation incomplete/deferred" rather than claiming the index is
ready or failing the installation.

## Consequences

Search remains available over the last complete rows while status reports
partial or stale coverage. Freshness can deliberately lag for compressed,
large, actively changing, or resource-constrained sources. The 16 MiB cap and
resource thresholds are conservative containment values, not throughput or
hard kernel memory guarantees.

This decision preserves the current schema, query semantics, FTS behavior, and
legacy parsers for safe small fixtures. It does not add streaming reads,
checkpoint cursors, generations, decompression, giant-record parsing,
background scheduling, or a new freshness service. Those remain the next
stages of the accepted sustainable indexing design.
