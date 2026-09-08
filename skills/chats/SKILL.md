---
name: chats
description: >-
  Find past Claude Code and Codex conversations with agentchats. Use to
  recover previous decisions, debugging work, or session context and inspect
  exact transcript evidence; use brain for saved articles and wiki for
  authored documents.
---

# Chats

Use Chats when earlier decisions, debugging, or session context would help the
current task. It searches local Claude Code and Codex transcripts through a
derived index. Brain covers saved sources; Wiki covers authored documents.
Native file tools remain useful for investigating an exact source record.

## Discover and call

Read Executor's own `skills({name:"execute"})` for its current calling workflow.
Inside `execute`, discover `tools.search({namespace:"agentchats"})`, inspect
`tools.describe.tool({path})`, then call `tools[path](args)` with that returned
full path. Follow `hasMore` and `nextOffset` for further discovery pages.
The installed `guide` provides current parameters and result contracts.

For project bearings, call `state` with an explicit absolute `workspace` and a
small `budget`. It returns Markdown and no text when that workspace has no
sessions. Shared MCP processes cannot infer the caller's current directory.

When freshness matters, inspect `status`: `healthy:false` means the index
needs preparation; `stale:true` means transcripts changed or disappeared.
An incremental `index` reconciles them. Inspect its `success` and `failures`,
including when some sessions were indexed. `unavailableRoots` were not
refreshed, and their existing sessions remain searchable. Cancellation stops
an unfinished pass without final pruning and keeps completed transactions.

## Search, then inspect evidence

Start with distinctive terms and a bounded result. These `search` arguments
return at most five conversations:

```json
{"query":"authentication timeout","limit":5,"fields":"summary","max-content-length":400}
```

Use the exact reported workspace as a filter when the project is known.
One hit represents one session, ranked by its matching messages, and cites the
best message. Terms AND within one message; they do not match words scattered
across a whole conversation. Use `offset` to paginate.

Pass the hit's exact `source_path` and `line` to `view`, or to `expand` with a
small `context`. `sessions` instead returns its citation path as `path`.
Do not reconstruct either path. MCP paths must be absolute.

A message with `truncated:true` is incomplete evidence. `view` with `full:true`
adds the original `source_record` when it is still readable. Confirm that field
exists before treating the text as complete. Read neighboring messages to
check what was decided, then report the finding with its source context.
Keep technical session IDs in tool calls and use descriptive names in prose.

For a broad inventory, use an empty query with filters and `aggregate` such as
`agent,workspace` or `date,agent`. Facets give counts without transcript bodies.
For query syntax, field choices, recipes, and storage behavior, read
[search and evidence](references/search-and-evidence.md).

## Results and handoff

Most tools preserve their existing command-specific JSON object in
`structuredContent` and standalone JSON text; they have no common success
wrapper. `guide` alone returns the fleet `{schema_version,ok,error,data}`
envelope, and `state` stays plain text. Inspect the inner MCP result inside
Executor's success wrapper.

For a failed call, parse the standalone JSON in `error.details.content`:
Executor may omit structured error data. The original error object is
`{error:{code,message,hint}}`. A failed index pass instead keeps its native
`success:false` report and failure details. Diagnostic prose is separate.
`missing-index` calls for an incremental refresh; `not-found` calls for checking
the citation or freshness; `usage` calls for corrected arguments. An error
is not evidence that no prior conversation exists.

`resume` returns the native command for a human handoff; it does not launch a
session. Archived copies remain readable but return `archived` on resume.
The operator CLI and bare `agentchats search` picker remain available for
human use. Starting another agent still depends on the task's authorization.
