# 0006: Derive routing evidence from native history

Accepted for implementation September 13, 2026. Extends
[0001](0001-own-the-session-index.md) without changing index retention or storage.
The human requested detailed model/effort/task decisions and their outcomes for
future routing evaluation. Current searchable tool text lacks a structured join
to native configuration and acceptance; private model reasoning is not a source
of durable decision rationale.

Add two bounded operations: `routing-receipt` validates and returns short authored
decision/acceptance JSON; `routing` reads exact original Codex rollouts and joins
their calls, native ownership/ancestry, recorded settings and receipt references.
The formatter writes no data. The reader opens no index and stores no copy.
Existing native transcript retention remains the source of truth. AgentStart
manager/worker guidance owns when agents make those receipts.

Requested settings, native configuration and backend execution are distinct.
Substantive direct work and reused-child assignments receive decisions too;
the child's completion does not establish parent acceptance or human delivery.
Missing facts, duplicate identities, source races and ambiguous joins remain
explicit. Child-thread history is not inferred per-assignment telemetry. No
usage aggregation or subscription-price inference is added in this first slice.

MCP and CLI share handlers and validation. The result is inspectable on demand;
there is no observer service, broad backfill, index migration, training archive,
automatic execution, inference probe or native credential access. Unknown native
formats fail or retain an evidence gap instead of silently filling from requests.
See [the routing contract](../routing.md) for fields, bounds and current limits.
