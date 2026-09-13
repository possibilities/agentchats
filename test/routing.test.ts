import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRouting, readRouting, routingView } from "../src/routing/read.ts";
import { parseReceipt, receiptResult } from "../src/routing/receipt.ts";
import { isSelfInvocation } from "../src/parse/self-invocation.ts";
import { runPrepared } from "../src/cli/commands.ts";
import { agentTools, invocationFor } from "../src/cli/mcp-tools.ts";

const parentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const childId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const path = (id: string) => `/tmp/rollout-stamp-${id}.jsonl`;
const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-09-13T00:00:00Z", payload });
const metadata = (parent?: string) => record("session_meta", { source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: "/root/research" } } } : "cli" });
const context = (id: string, model = "gpt-6-astra", effort = "low") => record("turn_context", { turn_id: id, model, effort });
const call = (id: string, name: string, args: unknown, turn: string | null = "p1") => record("response_item", { internal_chat_message_metadata_passthrough: { turn_id: turn }, type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const output = (id: string, value: unknown) => record("response_item", { type: "function_call_output", call_id: id, output: JSON.stringify(value) });
const activity = (id: string, thread: string, turn: string, child?: string) => record("event_msg", { type: "item_completed", thread_id: thread, turn_id: turn, item: { id, agent_thread_id: child } });
const decision = (action: "delegate" | "direct" = "delegate") => ({ schema_version: 1, kind: "decision", decision_id: "research-1", action,
  task: "Compare routing options", reason: "Independent source review requires deeper reasoning", target: "research",
  requested: { model: "gpt-6-astra", effort: "high", context: "none", service_tier: null }, evidence_refs: ["wiki:requirements"] });
const accepted = { schema_version: 1, kind: "acceptance", decision_id: "research-1", verdict: "accepted", reason: "Checked claims against sources", evidence_refs: ["wiki:report"], presentation: "pending" };
const note = (id: string, receipt: unknown) => [call(id, "mcp__agentchats__routing-receipt", { receipt: JSON.stringify(receipt) }), output(id, receiptResult(receipt)), activity(id, parentId, "p1")];
const source = (lines: string[], id = parentId) => parseRouting(lines.join("\n") + "\n", path(id));

test("joins requested settings, native ancestry and configuration while leaving acceptance to explicit parent evidence", () => {
  const parent = source([metadata(), context("p1"), ...note("note1", decision()),
    call("spawn1", "collaboration.spawn_agent", { task_name: "research", model: "gpt-6-astra", reasoning_effort: "high", fork_turns: "none", message: "PRIVATE BODY" }),
    activity("spawn1", parentId, "p1", childId), output("spawn1", { task_name: "/root/research" }),
    ...note("accept1", accepted)]);
  const child = source([metadata(parentId), context("c1", "gpt-5.6-luna", "medium"), activity("answer", childId, "c1"),
    record("event_msg", { type: "task_complete", turn_id: "c1", last_agent_message: "PRIVATE RESULT" })], childId);
  const view = routingView(parent, [child]);
  const row = view.attempts[0] as any;
  expect(view.total).toBe(1);
  expect(row.requested.model).toBe("gpt-6-astra");
  expect(row.child.configurations[0].value.model).toBe("gpt-5.6-luna");
  expect(row.child.ancestry).toBe("native_parent_verified");
  expect(row.child.terminal_observations[0].value.status).toBe("completed");
  expect(row.acceptance[0].value.verdict).toBe("accepted");
  expect(row.acceptance[0].value.presentation).toBe("pending");
  expect(row.source.line).toBe(6);
  expect(row.acceptance[0].actor_thread_id).toBe(parentId);
  expect(JSON.stringify(view)).not.toContain("PRIVATE");
});

test("reads the native programmatic CLI tool-output shape without relying on hidden reasoning", () => {
  const result = receiptResult(decision());
  const parent = source([metadata(), context("p1"),
    record("response_item", { type: "custom_tool_call", call_id: "note", name: "exec", internal_chat_message_metadata_passthrough: { turn_id: "p1" }, input: 'text(await tools.exec_command({cmd:"agentchats routing-receipt --receipt ..."}))' }),
    record("response_item", { type: "custom_tool_call_output", call_id: "note", output: [
      { type: "input_text", text: "Script completed\\nOutput:" },
      { type: "input_text", text: JSON.stringify({ exit_code: 0, output: JSON.stringify(result) + "\n" }) },
    ] }),
    call("spawn", "spawn_agent", { task_name: "research" }), activity("spawn", parentId, "p1")]);
  expect((routingView(parent, []).attempts[0]?.["decision"] as any).value.decision_id).toBe("research-1");
});

test("direct work has a receipt and configuration without inventing a worker", () => {
  const view = routingView(source([metadata(), context("p1"), ...note("n", decision("direct"))]), []);
  expect(view.attempts[0]?.["action"]).toBe("direct");
  expect(view.attempts[0]?.["acceptance"]).toEqual([]);
  expect(view.attempts[0]).not.toHaveProperty("child");
});

test("reused thread follow-ups remain separate attempts; no borrowed reason from a previous turn", () => {
  const parent = source([metadata(), context("p1"), ...note("n", decision()),
    call("s", "spawn_agent", { task_name: "research" }), output("s", { task_name: "/root/research" }),
    context("p2"), call("f", "followup_task", { target: "/root/research", message: "Continue" }, "p2")]);
  const view = routingView(parent, []);
  expect(view.total).toBe(2);
  expect(view.attempts[1]?.["action"]).toBe("reuse");
  expect(view.attempts[1]?.["decision"]).toBeNull();
  expect((view.attempts[1]?.["dispatch"] as any).status).toBe("unknown");
  expect((view.attempts[0]?.["requested"] as any).omitted).toContain("model");
});

test("does not join a child by name with different native ancestry or accept its self-review", () => {
  const parent = source([metadata(), context("p"), call("s", "spawn_agent", { task_name: "research" }), output("s", { task_name: "/root/research" })]);
  const child = source([metadata("unrelated"), context("c"), ...note("n", accepted)], childId);
  const row = routingView(parent, [child]).attempts[0] as any;
  expect(row.child.source_path).toBeNull();
  expect(row.acceptance).toEqual([]);
});

test("preserves unknown, ambiguous and interrupted evidence without reading raw prose as receipts", () => {
  const parent = source([metadata(), context("p"), ...note("n1", decision()), ...note("n2", decision()),
    call("s", "spawn_agent", { task_name: "research" }), output("s", { error: "failed" }),
    call("cat", "exec_command", { cmd: "cat unrelated-data.json" }), output("cat", receiptResult(decision("direct"))),
    record("response_item", { type: "message", role: "assistant", content: [{ text: JSON.stringify(receiptResult(decision("direct"))) }] }), "{unfinished"]);
  const view = routingView(parent, []);
  expect(view.total).toBe(3);
  const row = view.attempts.find((r) => r["call_id"] === "s") as any;
  expect(row.decision).toBeNull();
  expect(row.dispatch.status).toBe("failed");
  expect(view.gaps.at(-1)?.reason).toBe("malformed_record");
  expect(view.attempts.filter((r) => r["decision_join"] === "duplicate_decision_id")).toHaveLength(2);
});

test("excludes inherited parent calls and child configurations using native item ownership", () => {
  const parent = source([metadata("other-parent"), context("old"), ...note("n", decision("direct")), activity("n", "other-parent", "old"),
    call("s", "spawn_agent", { task_name: "inherited" }), activity("s", "other-parent", "old"),
    context("own"), ...note("own", { ...decision("direct"), decision_id: "own" })]);
  expect(routingView(parent, []).total).toBe(1);
});

test("formatter enforces bounded exact schema, nonempty accepted evidence and no retained state", async () => {
  expect(() => parseReceipt({ ...decision(), secret: "unexpected" })).toThrow();
  expect(() => parseReceipt({ ...accepted, evidence_refs: [] })).toThrow();
  expect(() => parseReceipt({ ...decision(), target: undefined })).toThrow();
  expect(() => parseReceipt("x".repeat(8193))).toThrow();
  const tool = agentTools().find((t) => t.name === "routing-receipt")!;
  const args = { receipt: JSON.stringify(decision()) };
  const output = await runPrepared(tool.name, invocationFor(tool, args), { HOME: "/path/that/does/not/exist" });
  expect(output.value).toEqual(receiptResult(decision()));
  expect(tool.annotations.readOnlyHint).toBe(true);
  expect(isSelfInvocation("agentchats routing /tmp/source", "")).toBe(true);
  expect(isSelfInvocation("agentchats routing-receipt --receipt {}", "")).toBe(false);
});

test("bounded exact-file read has no index or copy and reports missing/deleted evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routing-read-"));
  const file = join(dir, basenameFor(parentId));
  try {
    const text = [metadata(), context("p"), call("s", "spawn_agent", { task_name: "research" })].join("\n");
    await writeFile(file, text);
    expect((await readRouting([file], 1, 0)).count).toBe(1);
    expect(await readFile(file, "utf8")).toBe(text);
    await expect(readRouting([file, file], 1, 0)).rejects.toThrow("distinct");
    await expect(readRouting(["relative.jsonl"], 1, 0)).rejects.toThrow("absolute");
    await rm(file);
    await expect(readRouting([file], 1, 0)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function basenameFor(id: string) { return `rollout-stamp-${id}.jsonl`; }


test("unowned receipts are claims with unknown authorship and cannot automatically explain a dispatch", () => {
  const parent = source([metadata(), context("p1"), call("n", "mcp__agentchats__routing-receipt", {}, null), output("n", receiptResult(decision())),
    call("s", "spawn_agent", { task_name: "research" }, null),
    call("a", "mcp__agentchats__routing-receipt", {}, null), output("a", receiptResult(accepted))]);
  const view = routingView(parent, []);
  const dispatch = view.attempts.find((r) => r["call_id"] === "s") as any;
  const receipt = view.attempts.find((r) => r["decision"] !== null && r["decision"] !== undefined) as any;
  expect(dispatch.decision).toBeNull();
  expect(dispatch.parent_configuration).toBeNull();
  expect(receipt.acceptance[0].actor_thread_id).toBeNull();
  expect(receipt.acceptance[0].interpretation).toBe("authorship_unverified");
});

test("native item turn overrides stale context and CLI-looking output cannot claim verified formatter transport", () => {
  const parent = source([metadata(), context("p1"), ...note("n", decision()),
    call("s", "spawn_agent", { task_name: "research" }), activity("s", parentId, "p2"),
    call("fake", "exec", { cmd: "echo agentchats routing-receipt" }), output("fake", receiptResult({ ...decision("direct"), decision_id: "fake" }))]);
  const view = routingView(parent, []);
  const dispatch = view.attempts.find((r) => r["call_id"] === "s") as any;
  const receipt = view.attempts.find((r) => (r["decision"] as any)?.value.decision_id === "fake") as any;
  expect(dispatch.parent_turn_id).toBe("p2");
  expect(dispatch.parent_configuration).toBeNull();
  expect(dispatch.decision).toBeNull();
  expect(receipt.decision.transport).toBe("cli_output_unverified");
});

test("routing CLI rejects negative offsets and relative root paths", async () => {
  const tool = agentTools().find((t) => t.name === "routing")!;
  await expect(runPrepared(tool.name, invocationFor(tool, { source_path: path(parentId), offset: -1 }), {})).rejects.toThrow();
  await expect(runPrepared(tool.name, { positional: ["relative.jsonl"], values: {}, flags: new Set() }, {})).rejects.toThrow("absolute");
});


test("duplicate native call and item identities stay unresolved instead of mixing owners/settings", () => {
  for (const duplicate of [call("s", "spawn_agent", { task_name: "other", model: "other" }), activity("s", "other-thread", "other-turn", childId)]) {
    const parent = source([metadata(), context("p1"), ...note("n", decision()),
      call("s", "spawn_agent", { task_name: "research" }), activity("s", parentId, "p1"), duplicate]);
    const view = routingView(parent, []);
    const row = view.attempts.find((r) => r["call_id"] === "s") as any;
    expect(row.evidence_status).toBe("ambiguous_native_identity");
    expect(row.requested).toBeNull();
    expect(row.decision).toBeNull();
    expect(view.gaps).toHaveLength(1);
  }
  const receipt = source([metadata(), ...note("n", decision("direct")), call("n", "mcp__agentchats__routing-receipt", {} )]);
  expect(routingView(receipt, []).total).toBe(0);
});
