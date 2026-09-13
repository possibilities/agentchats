# Routing decisions and native evidence

`routing-receipt` validates a short decision or acceptance and returns
`{"routing_receipt": {...}}`. It writes no file, index or archive. The caller's
native transcript can retain the tool result under its existing retention policy.
This is an explicit rationale, never a request for hidden reasoning. Receipts are
authored claims, not proof that the model executed the route or that work is good.

Use the discovered MCP tool with a `receipt` JSON string, or the CLI. Emit the
receipt in its own tool call; a CLI/programmatic wrapper must return only that
result, without batching other commands or printing extra text. Mixed output is
not a standalone receipt and remains unjoined. For example:

```sh
agentchats routing-receipt --receipt '{"schema_version":1,"kind":"decision","decision_id":"source-review-1","action":"delegate","task":"Check the report sources","reason":"Independent evidence review benefits from a fresh context","target":"source_review","requested":{"model":"gpt-6-astra","effort":"high","context":"none","service_tier":null},"evidence_refs":["wiki:report"]}'
```

Emit before the action in the same native turn. `target` is the exact spawn
`task_name` or follow-up `target`; it is required except for `direct` work.
`action` is `direct`, `delegate`, `reuse` or `escalate`. Each substantive decision,
including a follow-up on a reused child, gets a unique `decision_id`. Requested
settings use strings, or null when unset/inherited. They never claim telemetry.
Optional `policy_ref` names the instruction revision. Task and reason are capped
at 600 characters; up to eight evidence refs at 256 characters each; receipt JSON
at 8 KiB. Unknown fields are rejected. Do not include source bodies or secrets.

After inspecting its evidence, the assignment's parent records acceptance:

```json
{"schema_version":1,"kind":"acceptance","decision_id":"source-review-1","verdict":"accepted","reason":"Checked the cited claims against their sources","evidence_refs":["wiki:reviewed-report"],"presentation":"pending"}
```

Verdicts are `pending`, `accepted` or `rejected`; accepted requires an evidence
ref. `presentation` is `unknown`, `pending` or `presented`. Native completion,
acceptance and presentation are independent. A child's self-review does not become
parent acceptance. Later corrections append another acceptance receipt under the
same decision ID; history is retained rather than overwritten.

## Read a bounded scope

```sh
agentchats routing /absolute/rollout-stamp-UUID.jsonl \
  --related '["/absolute/rollout-stamp-CHILD-UUID.jsonl"]' --limit 20
```

Use exact source paths from `sessions`, `search`, or already-known evidence.
`related` is a JSON array of at most 16 explicitly supplied child rollout paths.
No directory scan, index initialization, native RPC, inference, or automatic
descendant discovery occurs. This initial reader supports uncompressed Codex
rollouts only. Each file is capped at 32 MiB, combined input at 64 MiB, records at
2 MiB and output at 1 MiB. `limit` is 1–50; use `next_offset` to continue. Reads of
growing sources are observation cuts, not atomic snapshots across files/pages.

The result contains assignment attempts, exact source lines/timestamps, original
requested settings and omission information, parent turn configuration, native
child identity/ancestry, explicit receipts and terminal observations. Assignment
messages, raw results, credentials, audio and hidden reasoning are not projected.
Duplicate/malformed/oversized evidence creates a gap or unresolved join. A deleted
or unreadable source fails visibly; there is no retained copy to fall back to.

Decisions join to one subsequent native call with the matching target only when
native item/turn evidence identifies the same parent and turn for both. Rolling
context alone cannot establish the join; configuration must match that native turn. Repeated decision IDs or multiple candidates remain unresolved.
Unjoined and direct-work decisions remain visible; acceptance without a decision
is reported as an orphan citation. Names alone never prove child ancestry. Native
item ownership excludes known inherited calls/receipts in forked histories;
missing ownership is labelled as unverified source-file evidence, with a null
actor and acceptance interpretation `authorship_unverified`. Acceptance must follow
its decision. Direct named receipt tools have `named_receipt_tool` transport;
CLI/programmatic wrappers are `cli_output_unverified` because command text can
mention the formatter without executing it. Schema validation is not proof of
formatter provenance. Both transports retain authored claims, never quality proof.

Child configurations and terminal observations are **child-thread history**,
filtered by native item ownership. They are not automatically attributed to a
particular follow-up and do not prove the backend model used for every response.
The initial reader deliberately reports no usage totals, API costs, subscription
savings or inferred acceptance. These limits appear in the output coverage.
Native source formats vary; unknown output remains unclassified. Receipt emission
can be checked in history but prompt loading cannot guarantee model compliance.

This supplies inspectable evidence for future evaluation. It does not create a
training dataset/export path, change retention, tune a router or switch a live
model. A successful strong-model route is a candidate example, not a golden label.
