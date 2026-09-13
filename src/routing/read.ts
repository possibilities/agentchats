import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { parseReceipt, type RoutingReceipt } from "./receipt.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string | null => typeof value === "string" && value.length <= 1024 ? value : null;
const decode = (value: unknown): unknown => {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
};
export type Citation = { source_path: string; line: number; timestamp: string | null };
type Located<T> = { value: T; source: Citation };
type Call = Located<{ id: string; name: string; args: ObjectValue; turn_id: string | null }>;
type Context = Located<{ turn_id: string | null; model: string | null; effort: string | null }>;
type Activity = Located<{ thread_id: string | null; turn_id: string | null; child_id: string | null }>;
type Terminal = Located<{ turn_id: string; status: string }>;
type Note = Located<RoutingReceipt> & { call_id: string; turn_id: string | null; transport: "named_receipt_tool" | "cli_output_unverified"; actor_thread_id: string | null; ownership: string };
type Parsed = {
  invalidIds: Set<string>; path: string; id: string; parent_id: string | null; task_path: string | null;
  calls: Call[]; outputs: Map<string, Located<unknown>>; activities: Map<string, Activity>;
  contexts: Context[]; terminals: Terminal[]; notes: Note[]; gaps: Array<{ line: number; reason: string }>;
};
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const routeName = (name: string) => /^(?:(?:functions|collaboration)\.)?(spawn_agent|followup_task)$/.exec(name)?.[1] ?? null;

/** Read a receipt only from a standalone tool result, never from prose, arguments or code examples. */
function receiptFromOutput(value: unknown, depth = 0): RoutingReceipt | null {
  if (depth > 4) return null;
  const raw = decode(value);
  const item = object(raw);
  if (item["isError"] === true || (Object.hasOwn(item, "exit_code") && item["exit_code"] !== 0)) return null;
  if (Object.hasOwn(item, "routing_receipt")) {
    try { return parseReceipt(item["routing_receipt"]); } catch { return null; }
  }
  if (item["structuredContent"]) return receiptFromOutput(item["structuredContent"], depth + 1);
  if (typeof item["output"] === "string") return receiptFromOutput(item["output"], depth + 1);
  const blocks = Array.isArray(raw) ? raw : item["content"];
  if (Array.isArray(blocks)) {
    const notes = blocks.flatMap((entry) => {
      const block = object(entry);
      const note = ["text", "input_text"].includes(String(block["type"])) ? receiptFromOutput(block["text"], depth + 1) : null;
      return note ? [note] : [];
    });
    // MCP can return the same content twice; conflicting receipts are not one observation.
    return notes.length > 0 && notes.every((note) => JSON.stringify(note) === JSON.stringify(notes[0])) ? notes[0]! : null;
  }
  return null;
}

/** Pure parser. Native history is evidence, not an instruction source. */
export function parseRouting(text: string, path: string): Parsed {
  const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(path))?.[1];
  if (!id) throw new Error("Routing requires an exact uncompressed Codex rollout path");
  const parsed: Parsed = { invalidIds: new Set(), path, id, parent_id: null, task_path: null, calls: [], outputs: new Map(), activities: new Map(), contexts: [], terminals: [], notes: [], gaps: [] };
  let turnId: string | null = null;
  let hasMetadata = false;
  const seenInputs = new Set<string>();
  const receiptCalls = new Map<string, { turn_id: string | null; transport: Note["transport"] }>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) { parsed.gaps.push({ line: i + 1, reason: "oversized_record" }); continue; }
    const record = object(decode(line));
    if (typeof record["type"] !== "string") { parsed.gaps.push({ line: i + 1, reason: "malformed_record" }); continue; }
    const payload = object(record["payload"]);
    const source = { source_path: path, line: i + 1, timestamp: string(record["timestamp"]) };
    if (record["type"] === "session_meta") {
      if (hasMetadata) { parsed.gaps.push({ line: i + 1, reason: "duplicate_session_metadata" }); continue; }
      hasMetadata = true;
      const spawn = object(object(object(payload["source"])["subagent"])["thread_spawn"]);
      parsed.parent_id = string(spawn["parent_thread_id"]);
      parsed.task_path = string(spawn["agent_path"]);
    } else if (record["type"] === "turn_context") {
      turnId = string(payload["turn_id"]);
      parsed.contexts.push({ source, value: { turn_id: turnId, model: string(payload["model"]), effort: string(payload["effort"]) } });
    } else if (record["type"] === "response_item") {
      const type = payload["type"];
      const callId = string(payload["call_id"]);
      if ((type === "function_call" || type === "custom_tool_call") && callId) {
        if (seenInputs.has(callId)) { parsed.invalidIds.add(callId); parsed.gaps.push({ line: i + 1, reason: "duplicate_tool_call_identity" }); continue; }
        seenInputs.add(callId);
        const name = string(payload["name"]) ?? "";
        const rawInput = payload["arguments"] ?? payload["input"];
        const nativeTurn = string(object(payload["internal_chat_message_metadata_passthrough"])["turn_id"]);
        if (/^(?:mcp__agentchats__)?routing[-_]receipt$/.test(name) ||
          (typeof rawInput === "string" && /(?:\bagentchats\s+routing-receipt\b|\bmcp__agentchats__routing[-_]receipt\b)/.test(rawInput))) receiptCalls.set(callId, { turn_id: nativeTurn, transport: /^(?:mcp__agentchats__)?routing[-_]receipt$/.test(name) ? "named_receipt_tool" : "cli_output_unverified" });
        if (routeName(name)) parsed.calls.push({ source, value: { id: callId, name: routeName(name)!, args: object(decode(payload["arguments"] ?? payload["input"])), turn_id: nativeTurn } });
      } else if ((type === "function_call_output" || type === "custom_tool_call_output") && callId) {
        if (parsed.outputs.has(callId)) { parsed.invalidIds.add(callId); parsed.gaps.push({ line: i + 1, reason: "duplicate_tool_output" }); continue; }
        parsed.outputs.set(callId, { source, value: payload["output"] });
        const note = receiptCalls.has(callId) ? receiptFromOutput(payload["output"]) : null;
        if (note) parsed.notes.push({ source, value: note, call_id: callId, ...receiptCalls.get(callId)!, actor_thread_id: null, ownership: "source_file_only_unverified" });
      }
    } else if (record["type"] === "event_msg") {
      if (payload["type"] === "item_completed") {
        const item = object(payload["item"]);
        const itemId = string(item["id"]);
        if (itemId && parsed.activities.has(itemId)) { parsed.invalidIds.add(itemId); parsed.gaps.push({ line: i + 1, reason: "duplicate_native_item_identity" }); continue; }
        if (itemId) parsed.activities.set(itemId, { source, value: {
          thread_id: string(payload["thread_id"]), turn_id: string(payload["turn_id"]),
          child_id: string(item["agent_thread_id"]) ?? string((item["receiver_thread_ids"] as unknown[] | undefined)?.[0]),
        } });
      } else if (["task_complete", "turn_aborted"].includes(String(payload["type"]))) {
        const id = string(payload["turn_id"]);
        if (id) parsed.terminals.push({ source, value: { turn_id: id, status: payload["type"] === "task_complete" ? "completed" : "interrupted" } });
      }
    }
  }
  // Forked histories can contain parent items. Native item ownership excludes those
  // from authored receipts; missing ownership remains an explicitly limited source read.
  for (const id of parsed.invalidIds) parsed.activities.delete(id);
  parsed.notes = parsed.notes.filter((note) => !parsed.invalidIds.has(note.call_id)).map((note) => ({ ...note, ...attribution(parsed, note.call_id, note.turn_id) }))
    .filter((note) => !note.actor_thread_id || note.actor_thread_id === parsed.id);
  if (!hasMetadata) throw new Error("Source has no Codex session metadata");
  return parsed;
}

/** Exact native item ownership wins; a native turn ID can use unique item ownership for that turn. */
function attribution(parsed: Parsed, callId: string, nativeTurn: string | null) {
  const item = parsed.activities.get(callId)?.value;
  const turn = item?.turn_id ?? nativeTurn;
  const owners = new Set([...parsed.activities.values()].filter((a) => turn !== null && a.value.turn_id === turn && a.value.thread_id).map((a) => a.value.thread_id!));
  const actor = item?.thread_id ?? (owners.size === 1 ? [...owners][0]! : null);
  return { turn_id: turn, actor_thread_id: actor, ownership: item?.thread_id ? "native_item_thread" : actor ? "native_turn_items" : "source_file_only_unverified" };
}
function configuration(parsed: Parsed, turn: string | null, before: number) {
  return turn ? parsed.contexts.filter((c) => c.source.line < before && c.value.turn_id === turn).at(-1) ?? null : null;
}

const requested = (args: ObjectValue) => ({
  model: string(args["model"]), effort: string(args["reasoning_effort"]),
  context: string(args["fork_turns"]), service_tier: string(args["service_tier"]),
  omitted: ["model", "reasoning_effort", "fork_turns", "service_tier"].filter((key) => !Object.hasOwn(args, key)),
});

function canonicalTarget(parent: Parsed, call: Call): string | null {
  const target = string(call.value.args[call.value.name === "spawn_agent" ? "task_name" : "target"]);
  if (!target) return null;
  return target.startsWith("/") ? target : `${parent.task_path ?? "/root"}/${target}`;
}

/** Requested values, native configuration and parent-authored acceptance never overwrite each other. */
export function routingView(parent: Parsed, related: Parsed[], limit = 20, offset = 0) {
  const rows: ObjectValue[] = [];
  const used = new Set<Note>();
  const duplicates = new Set<string>();
  const notesById = new Map<string, Note[]>();
  for (const note of parent.notes) {
    const all = notesById.get(note.value.decision_id) ?? [];
    all.push(note); notesById.set(note.value.decision_id, all);
    if (all.filter((n) => n.value.kind === "decision").length > 1) duplicates.add(note.value.decision_id);
  }
  const acceptance = (note: Note | undefined) => {
    const all = note ? notesById.get(note.value.decision_id) ?? [] : [];
    return all.filter((n) => n.value.kind === "acceptance" && n.source.line > note!.source.line).map((n) => ({
      ...n, interpretation: n.actor_thread_id === parent.id ? "parent_authored_claim_not_independent_verification" : "authorship_unverified",
    }));
  };
  const seenCalls = new Set<string>();
  for (const call of parent.calls) {
    if (seenCalls.has(call.value.id)) continue;
    seenCalls.add(call.value.id);
    if (parent.invalidIds.has(call.value.id)) {
      rows.push({ attempt_id: `${parent.id}:${call.value.id}`, parent_thread_id: parent.id,
        source: call.source, call_id: call.value.id, evidence_status: "ambiguous_native_identity",
        action: null, requested: null, decision: null, acceptance: [] });
      continue;
    }
    const activity = parent.activities.get(call.value.id);
    const owner = attribution(parent, call.value.id, call.value.turn_id);
    if (owner.actor_thread_id && owner.actor_thread_id !== parent.id) continue;
    const target = canonicalTarget(parent, call);
    const candidates = parent.notes.filter((note) => note.value.kind === "decision" && note.value.action !== "direct" &&
      !used.has(note) && !duplicates.has(note.value.decision_id) && note.source.line < call.source.line &&
      owner.actor_thread_id === parent.id && note.actor_thread_id === parent.id &&
      owner.turn_id !== null && note.turn_id === owner.turn_id &&
      (note.value.target === target || note.value.target === call.value.args[call.value.name === "spawn_agent" ? "task_name" : "target"]));
    // A later retry without its own receipt does not inherit an earlier reason.
    const note = candidates.length === 1 ? candidates[0] : undefined;
    if (note) used.add(note);
    const output = parent.outputs.get(call.value.id);
    const result = object(decode(output?.value));
    const outputChild = string(result["agent_id"]);
    const childId = activity?.value.child_id ?? outputChild;
    const childCandidates = related.filter((child) => child.parent_id === parent.id &&
      (childId ? child.id === childId : target !== null && child.task_path === target));
    const child = childCandidates.length === 1 ? childCandidates[0] : undefined;
    const knownTurns = child ? new Set([...child.activities.values()].filter((a) => a.value.thread_id === child.id).map((a) => a.value.turn_id)) : new Set();
    const contexts = child?.contexts.filter((c) => knownTurns.has(c.value.turn_id)) ?? [];
    const parentContext = configuration(parent, owner.turn_id, call.source.line);
    rows.push({
      attempt_id: `${parent.id}:${call.value.id}`, parent_thread_id: parent.id,
      parent_turn_id: owner.turn_id,
      source: call.source, call_id: call.value.id, action: call.value.name === "spawn_agent" ? "delegate" : "reuse",
      target, requested: requested(call.value.args), parent_configuration: parentContext ?? null,
      ownership: owner.ownership,
      dispatch: { status: output ? (result["error"] ? "failed" : typeof result["task_name"] === "string" || outputChild ? "accepted" : "unclassified_output") : "unknown", source: output?.source ?? null },
      decision: note ?? null, decision_join: note ? "unique_prior_target_receipt" : candidates.length > 1 ? "ambiguous" : "unavailable",
      child: { thread_id: childId ?? child?.id ?? null, source_path: child?.path ?? null,
        ancestry: child ? "native_parent_verified" : childCandidates.length > 1 ? "ambiguous" : "unavailable",
        configurations: contexts, terminal_observations: child?.terminals.filter((t) => knownTurns.has(t.value.turn_id)) ?? [],
        attribution: "child_thread_history_not_assignment_or_backend_execution_proof" },
      acceptance: acceptance(note),
    });
  }
  for (const note of parent.notes.filter((n) => n.value.kind === "decision" && !used.has(n))) {
    rows.push({ attempt_id: `${parent.id}:receipt:${note.source.line}`, parent_thread_id: parent.id,
      action: note.value.kind === "decision" ? note.value.action : null, source: note.source,
      decision: note, decision_join: duplicates.has(note.value.decision_id) ? "duplicate_decision_id" : "no_native_call_join",
      parent_configuration: configuration(parent, note.turn_id, note.source.line),
      acceptance: duplicates.has(note.value.decision_id) ? [] : acceptance(note) });
  }
  rows.sort((a, b) => (a["source"] as Citation).line - (b["source"] as Citation).line);
  const selected = rows.slice(offset, offset + limit);
  const result = { schema_version: 1, source_path: parent.path, parent_thread_id: parent.id,
    total: rows.length, count: selected.length, offset, next_offset: offset + selected.length < rows.length ? offset + selected.length : null,
    attempts: selected, gaps: [parent, ...related].flatMap((p) => p.gaps.map((g) => ({ source_path: p.path, ...g }))),
    coverage: { related_sources_supplied: related.length, automatic_descendant_discovery: false, backend_execution: "unobserved", usage: "not_projected", retention: "native_sources_only", acceptance: "explicit_receipts_only" },
    orphan_acceptance: parent.notes.filter((n) => n.value.kind === "acceptance" && !(notesById.get(n.value.decision_id) ?? []).some((d) => d.value.kind === "decision" && d.source.line < n.source.line)).map((n) => n.source),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new Error("Routing result exceeds 1 MiB; reduce --limit or related sources");
  return result;
}

/** Exact paths only; no index initialization, filesystem inventory or native RPC. */
export async function readRouting(paths: string[], limit: number, offset: number, signal?: AbortSignal) {
  if (paths.length < 1 || paths.length > 17 || new Set(paths).size !== paths.length) throw new Error("Supply one root and at most 16 distinct related sources");
  const sources: Parsed[] = [];
  let bytes = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    if (!isAbsolute(path)) throw new Error("Routing source paths must be absolute");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES || bytes + before.size > MAX_BYTES) throw new Error("Routing source exceeds bounds (32 MiB each, 64 MiB total)");
      const buffer = Buffer.alloc(before.size);
      let received = 0;
      while (received < buffer.length) {
        signal?.throwIfAborted();
        const read = await file.read(buffer, received, buffer.length - received, received);
        if (!read.bytesRead) break;
        received += read.bytesRead;
      }
      bytes += received;
      const parsed = parseRouting(buffer.subarray(0, received).toString("utf8"), path);
      const after = await file.stat();
      if (received !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) parsed.gaps.push({ line: 0, reason: "source_changed_during_read" });
      sources.push(parsed);
    } finally { await file.close(); }
  }
  if (new Set(sources.map((s) => s.id)).size !== sources.length) throw new Error("Duplicate native session identities; choose one source per session");
  return routingView(sources[0]!, sources.slice(1), limit, offset);
}
