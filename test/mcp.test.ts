import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CONTRACT } from "../src/cli/contract.ts";
import { openIndex } from "../src/store/schema.ts";

const MAIN = resolve(import.meta.dir, "../src/cli/main.ts");

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** A real stdio peer. Every stdout line must parse as JSON-RPC. */
class Wire {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: RpcMessage[] = [];
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  readonly reading: Promise<void>;
  stderr = "";
  private nextId = 1;

  constructor(env: Record<string, string | undefined>, json = false) {
    this.child = spawn(process.execPath, [MAIN, "mcp", ...(json ? ["--json"] : [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.exit = new Promise((resolveExit, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
    const child = this.child;
    this.reading = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        const message = JSON.parse(line) as RpcMessage;
        expect(message.jsonrpc).toBe("2.0");
        this.messages.push(message);
      }
    })();
  }

  send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  start(method: string, params: unknown = {}): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.start(method, params);
    await until(() => this.messages.some((message) => message.id === id));
    const response = this.messages.find((message) => message.id === id);
    if (response?.error) throw new Error(JSON.stringify(response.error));
    return response?.result as T;
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "chats-wire-test", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.request("tools/call", { name, arguments: args });
  }

  async stop(signal?: "SIGTERM"): Promise<void> {
    if (signal) this.child.kill(signal);
    else this.child.stdin.end();
    let forced = false;
    const timeout = setTimeout(() => {
      forced = true;
      this.child.kill("SIGKILL");
    }, 4000);
    try {
      expect(await this.exit).toEqual({ code: 0, signal: null });
      await this.reading;
      expect(forced).toBe(false);
      expect(this.stderr).toBe("");
    } finally {
      clearTimeout(timeout);
    }
  }

  async cleanup(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exit;
    await this.reading;
  }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the MCP peer");
    await Bun.sleep(10);
  }
}

function value(result: CallToolResult): Record<string, any> {
  const block = result.content.find((entry) => entry.type === "text" && entry.text.startsWith("{"));
  if (block?.type !== "text") throw new Error("Missing standalone JSON value");
  const parsed = JSON.parse(block.text);
  expect(parsed).toEqual(result.structuredContent);
  return parsed;
}

function transcript(body = "Solve the widget timeout", workspace = "/tmp/chats-fixture-project"): string {
  return [
    { type: "user", timestamp: "2026-09-01T00:00:00.000Z", cwd: workspace, message: { role: "user", content: body } },
    { type: "assistant", timestamp: "2026-09-01T00:00:01.000Z", cwd: workspace, message: { role: "assistant", content: "The widget retry fixed the timeout." } },
    { type: "assistant", timestamp: "2026-09-01T00:00:02.000Z", cwd: workspace, message: { role: "assistant", content: "long evidence ".repeat(1800) + "full-record-tail" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

describe("Chats producer MCP", () => {
  let directory: string;
  let env: Record<string, string | undefined>;
  let source: string;
  const peers: Wire[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentchats-mcp-"));
    env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_STATE_HOME: join(directory, "state"), AGENTCHATS_INDEX: join(directory, "index.db") };
    source = join(directory, ".claude/projects/p/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    mkdirSync(join(directory, ".claude/projects/p"), { recursive: true });
    mkdirSync(join(directory, ".codex/sessions"), { recursive: true });
    writeFileSync(source, transcript());
  });
  afterEach(async () => {
    for (const wire of peers.splice(0)) await wire.cleanup();
    rmSync(directory, { recursive: true, force: true });
  });
  async function peer(): Promise<Wire> {
    const wire = new Wire(env);
    peers.push(wire);
    await wire.initialize();
    return wire;
  }
  async function cli(args: string[]) {
    const child = Bun.spawn([process.execPath, MAIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  async function populate(wire: Wire): Promise<void> {
    const indexed = await wire.call("index");
    expect(indexed.isError).not.toBe(true);
    expect(value(indexed).indexed).toBe(1);
  }

  test("discovers nine producer tools and the authored guide without opening the index", async () => {
    const wire = await peer();
    const { tools } = await wire.request<{ tools: Tool[] }>("tools/list");
    expect(tools.map((tool) => tool.name)).toEqual(CONTRACT.commands.filter((command) => command.audience === "agent").map((command) => command.name));
    expect(tools).toHaveLength(9);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const hidden of ["json", "current", "include-auxiliary", "HOME", "db", "shell"]) expect(tool.inputSchema.properties).not.toHaveProperty(hidden);
    }
    expect(tools.find((tool) => tool.name === "state")?.inputSchema.required).toEqual(["workspace"]);
    expect(tools.find((tool) => tool.name === "index")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "status")?.annotations?.readOnlyHint).toBe(false);
    expect(value(await wire.call("guide")).data).toEqual(CONTRACT);
    expect(existsSync(join(directory, "index.db"))).toBe(false);
    expect((await wire.call("mcp")).isError).toBe(true);
    await wire.stop();
  });

  test("preserves missing-index and not-found envelopes and their CLI exit codes", async () => {
    const wire = await peer();
    const missing = await wire.call("search", { query: "widget" });
    expect(missing.isError).toBe(true);
    expect(value(missing).error.code).toBe("missing-index");
    const legacy = await cli(["search", "widget", "--json"]);
    expect(legacy.code).toBe(3);
    expect(legacy.stdout).toBe("");
    expect(JSON.parse(legacy.stderr)).toEqual(value(missing));
    const diagnosis = value(await wire.call("status"));
    expect(diagnosis.healthy).toBe(false);
    expect(diagnosis.stale).toBe(true);
    await populate(wire);
    const missingMessage = await wire.call("view", { source_path: source, line: 999 });
    expect(missingMessage.isError).toBe(true);
    expect(value(missingMessage).error.code).toBe("not-found");
    await wire.stop();
  });

  test("keeps JSON search, citations, facets, and neighboring messages identical to the CLI", async () => {
    const wire = await peer();
    await populate(wire);
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["search", { query: "widget", limit: 5, fields: "summary", "max-content-length": 40 }, ["widget", "--limit", "5", "--fields", "summary", "--max-content-length", "40"]],
      ["search", { query: "", workspace: "/tmp/chats-fixture-project", aggregate: "agent,workspace,date" }, ["", "--workspace", "/tmp/chats-fixture-project", "--aggregate", "agent,workspace,date"]],
      ["sessions", { workspace: "/tmp/chats-fixture-project", limit: 2 }, ["--workspace", "/tmp/chats-fixture-project", "--limit", "2"]],
      ["view", { source_path: source, line: 1 }, [source, "--line", "1"]],
      ["expand", { source_path: source, line: 2, context: 1 }, [source, "--line", "2", "--context", "1"]],
      ["resume", { source_path: source }, [source]],
    ];
    for (const [name, input, argv] of cases) {
      const expected = await cli([name, ...argv, "--json"]);
      expect(expected.code).toBe(0);
      expect(expected.stderr).toBe("");
      expect(value(await wire.call(name, input))).toEqual(JSON.parse(expected.stdout));
    }
    const hit = value(await wire.call("search", { query: "widget", limit: 1 })).hits[0];
    expect(hit.source_path).toBe(source);
    expect(hit.line).toBeGreaterThan(0);
    expect(value(await wire.call("search", { query: "widget", offset: 1 })).hits).toEqual([]);
    const repeat = value(await wire.call("index"));
    expect(repeat.indexed).toBe(0);
    expect(repeat.skipped).toBe(1);
    await wire.stop();
  });

  test("full source evidence and plain Markdown retain their existing formats", async () => {
    const wire = await peer();
    await populate(wire);
    const full = value(await wire.call("view", { source_path: source, line: 3, full: true }));
    expect(full.truncated).toBe(true);
    expect(full.body).not.toContain("full-record-tail");
    expect(full.source_record).toContain("full-record-tail");
    const state = await wire.call("state", { workspace: "/tmp/chats-fixture-project", budget: 100 });
    expect(state.structuredContent).toBeUndefined();
    expect(state.content).toEqual([{ type: "text", text: (await cli(["state", "--workspace", "/tmp/chats-fixture-project", "--budget", "100"])).stdout }]);
    expect((await wire.call("state", { workspace: "/tmp/no-such-project" })).content).toEqual([]);
    await wire.stop();
  });

  test("requires explicit paths and keeps query text out of the shell", async () => {
    const wire = await peer();
    await populate(wire);
    expect((await wire.call("state")).isError).toBe(true);
    expect((await wire.call("sessions", { current: true })).isError).toBe(true);
    const relative = await wire.call("sessions", { workspace: "relative" });
    expect(value(relative).error.code).toBe("usage");
    const marker = join(directory, "injected");
    const query = `--help\n$(touch ${marker})`;
    expect(value(await wire.call("search", { query, limit: 1 })).query).toBe(query);
    expect(existsSync(marker)).toBe(false);
    expect((await wire.call("search", { query: "widget", limit: -1 })).isError).toBe(true);
    await wire.stop();
  });

  test("returns the original partial-index report as an error without losing successful work", async () => {
    const malformed = join(directory, ".codex/sessions/broken.jsonl.zst");
    writeFileSync(malformed, "not-zstd");
    const wire = await peer();
    const indexed = await wire.call("index");
    expect(indexed.isError).toBe(true);
    const report = value(indexed);
    expect(report.success).toBe(false);
    expect(report.indexed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.failures[0].path).toBe(malformed);
    expect(value(await wire.call("search", { query: "widget" })).count).toBe(1);
    await wire.stop();
  });

  test("an archived transcript stays readable and refuses a resume command", async () => {
    const archive = join(directory, "archive");
    mkdirSync(archive);
    const archived = join(archive, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    writeFileSync(archived, transcript("Archived widget work"));
    mkdirSync(join(directory, "config/agentchats"), { recursive: true });
    writeFileSync(join(directory, "config/agentchats/config.json"), JSON.stringify({ archives: [{ path: archive, agent: "claude_code" }] }));
    const wire = await peer();
    expect(value(await wire.call("index")).indexed).toBe(2);
    const resume = await wire.call("resume", { source_path: archived });
    expect(resume.isError).toBe(true);
    expect(value(resume).error.code).toBe("archived");
    expect(value(await wire.call("view", { source_path: archived, line: 1 })).body).toContain("Archived widget");
    await wire.stop();
  });

  async function startLongIndex(wire: Wire): Promise<number> {
    // Real files and real incremental transactions, with protocol progress as
    // the synchronization point; no production-only test flags or fake delay.
    const root = join(directory, ".claude/projects/p");
    const minimal = transcript("Index cancellation fixture").split("\n")[0] + "\n";
    for (let index = 0; index < 1000; index++) writeFileSync(join(root, `fixture-${index}.jsonl`), minimal);
    const id = wire.start("tools/call", { name: "index", arguments: {}, _meta: { progressToken: "index-test" } });
    await until(() => wire.messages.some((message) => message.method === "notifications/progress"));
    expect(wire.messages.some((message) => message.id === id)).toBe(false);
    return id;
  }

  test("request cancellation stops indexing and leaves the connection usable", async () => {
    const wire = await peer();
    const id = await startLongIndex(wire);
    wire.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "fixture cancellation" } });
    expect(value(await wire.call("guide")).ok).toBe(true);
    const db = openIndex(join(directory, "index.db"));
    try {
      const count = (): number => (db.query("select count(*) as count from sessions").get() as { count: number }).count;
      const stopped = count();
      expect(stopped).toBeGreaterThan(0);
      expect(stopped).toBeLessThan(1001);
      await Bun.sleep(30);
      expect(count()).toBe(stopped);
    } finally { db.close(); }
    await wire.stop();
  });

  for (const mode of ["preinitialize", "idle", "indexing", "signal"] as const) {
    test(`exits without forced termination on ${mode}`, async () => {
      const wire = new Wire(env);
      peers.push(wire);
      if (mode !== "preinitialize") await wire.initialize();
      if (mode === "indexing" || mode === "signal") await startLongIndex(wire);
      await wire.stop(mode === "signal" ? "SIGTERM" : undefined);
    });
  }
});
