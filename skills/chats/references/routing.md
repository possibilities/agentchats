# Routing evidence

Use the installed AgentChats `guide` or `routing-receipt` tool description for
the exact schema. The formatter returns validated `routing_receipt` JSON and
writes no file or index. Native tool-result retention is the only capture path.

Before a substantive direct-work/delegation/reuse/escalation decision, supply a
unique decision ID, short task and reason, requested model/effort/context/tier,
and evidence references. Delegated work names the exact native task or target.
The parent later emits an acceptance receipt under that ID after checking the
result. A child stopping is not acceptance, and acceptance is not presentation.
Do not capture hidden reasoning, private source bodies, credentials or audio.

`routing` takes the exact root rollout `source_path`, optional `related` JSON
array of at most 16 exact child paths, `limit` (1–50) and `offset`. It reads
uncompressed Codex rollouts without an index, filesystem scan or native RPC.
Sources are capped at 32 MiB each/64 MiB combined, output at 1 MiB. Preserve gaps,
unknown settings, unmatched receipts and parent-acceptance claims as labelled.
Child configuration and terminal observations are thread history, not automatic
per-assignment or backend execution attribution. Usage is not projected.

Use native source paths from prior evidence, `sessions`, or `search`. Missing or
deleted evidence is unavailable; the reader stores no archive. These tools do
not train, export datasets, change models, resume threads or start inference.
