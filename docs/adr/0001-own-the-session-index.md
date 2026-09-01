# 1. Own the session index

Status: Accepted
Date: 2026-09-01

## Context

cass's data directory reached 47 GiB on this machine — 42 GiB of it a raw
mirror duplicating transcripts — on a volume that hit 99% full with 3.1 GiB
free. The live transcript stores it indexed are only 7.6 GB across 3,385
files, and just 532 MB of that is indexable conversational text: Codex
rollouts are ~4% conversation, the rest repeated system prompts and an
`event_msg` stream mirroring the real records. cass's `--mode hybrid` was
already failing open to lexical search — its MiniLM model was never
acquired — so no semantic capability was actually in use.

## Decision

Retire cass. Replace it with a SQLite+FTS5 index that agentchats owns and
builds directly from the Claude Code and Codex transcript stores. A
measured prototype indexed at 1.57x the text size, projecting ~0.83 GB for
the whole corpus — roughly 55x smaller than cass — answering queries in
0-2 ms.

## Consequences

Only Codex and Claude Code are supported; cass's other twenty connectors,
semantic search, raw mirror, archive, and export are given up deliberately.
Retention comes from mirroring the live stores rather than keeping an
independently retained copy, which also removes the need for the monthly
index reset cass required.
