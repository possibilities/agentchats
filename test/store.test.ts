import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage, ParsedSession, Role } from "../src/parse/types.ts";
import { ingest, type ParserBinding } from "../src/store/ingest.ts";
import { indexPath, MEMORY_INDEX } from "../src/store/paths.ts";
import { aggregate, search, sessions, status, toMatchQuery } from "../src/store/query.ts";
import { openIndex, SCHEMA_VERSION, storedSchemaVersion } from "../src/store/schema.ts";

const temp = mkdtempSync(join(tmpdir(), "agentchats-store-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

let serial = 0;
function storeRoot(): string {
  const root = join(temp, `store-${serial++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function line(ordinal: number, role: Role, body: string): ParsedMessage {
  return { ordinal, line: ordinal + 1, byteOffset: ordinal * 128, role, ts: "", body };
}

function parsed(overrides: Partial<ParsedSession> & { sourcePath: string }): ParsedSession {
  return {
    agent: "claude_code",
    sessionId: "session-a",
    workspace: "/ws/alpha",
    title: "a session",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    threadSource: null,
    originator: null,
    messages: [line(0, "user", "hello widget")],
    ...overrides,
  };
}

/** What a fake parser should do with one file: hand back a session, decline
 * it, or blow up. */
type Outcome = ParsedSession | null | "throw";

/** One store, one parser, and a lookup table the test controls — so ingest
 * is exercised over real files and real stats without any real format. */
function bindings(
  root: string,
  outcomes: Map<string, Outcome>,
  agent = "claude_code",
): Record<string, ParserBinding> {
  return {
    [agent]: {
      root,
      read: async (path) => path,
      parse: (_content, sourcePath) => {
        const outcome = outcomes.get(sourcePath);
        if (outcome === "throw") throw new Error("unreadable transcript");
        return outcome ?? null;
      },
    },
  };
}

function write(path: string, content: string, mtime?: Date): string {
  writeFileSync(path, content);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
  return path;
}

/** The FTS5 index and its content table agree, and no row was orphaned. */
function ftsIsConsistent(db: Database): boolean {
  db.run("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')");
  const indexed = db.query("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number };
  const stored = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return indexed.n === stored.n;
}

describe("index path", () => {
  test("the explicit override wins, then XDG state, then the spec default", () => {
    expect(indexPath({ AGENTCHATS_INDEX: "/vol/scratch/i.db", HOME: "/home/op" })).toBe(
      "/vol/scratch/i.db",
    );
    expect(indexPath({ AGENTCHATS_INDEX: MEMORY_INDEX, HOME: "/home/op" })).toBe(MEMORY_INDEX);
    expect(indexPath({ AGENTCHATS_INDEX: "~/i.db", HOME: "/home/op" })).toBe("/home/op/i.db");
    expect(indexPath({ XDG_STATE_HOME: "/state", HOME: "/home/op" })).toBe(
      "/state/agentchats/index.db",
    );
    expect(indexPath({ HOME: "/home/op" })).toBe("/home/op/.local/state/agentchats/index.db");
  });

  test("a relative XDG override is ignored, not honored badly", () => {
    expect(indexPath({ XDG_STATE_HOME: "relative/state", HOME: "/home/op" })).toBe(
      "/home/op/.local/state/agentchats/index.db",
    );
  });

  test("no HOME and no override is an error, not a path under undefined", () => {
    expect(() => indexPath({})).toThrow(/HOME/);
  });
});

describe("schema", () => {
  test("creates the index and is idempotent across reopens", () => {
    const path = join(storeRoot(), "index.db");
    const first = openIndex(path);
    expect(storedSchemaVersion(first)).toBe(SCHEMA_VERSION);
    expect(first.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    first.run("INSERT INTO meta (key, value) VALUES ('probe', 'kept')");
    first.close();

    const second = openIndex(path);
    expect(storedSchemaVersion(second)).toBe(SCHEMA_VERSION);
    expect(second.query("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({
      value: "kept",
    });
    second.close();
  });

  test("a foreign schema version is discarded and rebuilt, not migrated", () => {
    const path = join(storeRoot(), "index.db");
    const first = openIndex(path);
    first.run("INSERT INTO meta (key, value) VALUES ('probe', 'stale')");
    first.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '99')");
    first.close();

    const second = openIndex(path);
    expect(storedSchemaVersion(second)).toBe(SCHEMA_VERSION);
    expect(second.query("SELECT value FROM meta WHERE key = 'probe'").get()).toBe(null);
    second.close();
  });
});

describe("ingest", () => {
  test("indexes new transcripts and reruns as a no-op", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const alpha = write(join(root, "alpha.jsonl"), "{}");
    const beta = write(join(root, "beta.jsonl.zst"), "{}");
    const outcomes = new Map<string, Outcome>([
      [alpha, parsed({ sourcePath: alpha, messages: [line(0, "user", "one widget")] })],
      [
        beta,
        parsed({
          sourcePath: beta,
          sessionId: "session-b",
          messages: [line(0, "user", "two widget"), line(1, "assistant", "reply")],
        }),
      ],
    ]);

    const first = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
    expect(first).toMatchObject({ scanned: 2, indexed: 2, skipped: 0, removed: 0, failed: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 3 });
    expect(ftsIsConsistent(db)).toBe(true);

    const second = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
    expect(second).toMatchObject({ scanned: 2, indexed: 0, skipped: 2, removed: 0, failed: 0 });
    db.close();
  });

  test("progress reports every file exactly once", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const path = write(join(root, "a.jsonl"), "{}");
    const outcomes = new Map<string, Outcome>([[path, parsed({ sourcePath: path })]]);
    const seen: string[] = [];
    await ingest(db, {
      roots: [root],
      parsers: bindings(root, outcomes),
      onProgress: (event) => {
        expect(event.total).toBe(1);
        expect(event.handled).toBe(1);
        seen.push(`${event.outcome}:${event.path}`);
      },
    });
    expect(seen).toEqual([`indexed:${path}`]);
    db.close();
  });

  test("a changed transcript replaces its messages and leaves no FTS orphans", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const path = write(join(root, "a.jsonl"), "{}", new Date(1_700_000_000_000));
    const outcomes = new Map<string, Outcome>([
      [
        path,
        parsed({
          sourcePath: path,
          messages: [line(0, "user", "obsolete widget"), line(1, "assistant", "gone")],
        }),
      ],
    ]);
    await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
    expect(search(db, { query: "obsolete", limit: 10 })).toHaveLength(1);

    write(join(root, "a.jsonl"), "{}{}", new Date(1_700_000_600_000));
    outcomes.set(
      path,
      parsed({ sourcePath: path, messages: [line(0, "user", "current widget")] }),
    );
    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(result).toMatchObject({ scanned: 1, indexed: 1, skipped: 0, removed: 0, failed: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
    expect(search(db, { query: "obsolete", limit: 10 })).toEqual([]);
    expect(search(db, { query: "current", limit: 10 })).toHaveLength(1);
    expect(ftsIsConsistent(db)).toBe(true);
    db.close();
  });

  test("a vanished source file takes its session with it", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const kept = write(join(root, "kept.jsonl"), "{}");
    const doomed = write(join(root, "doomed.jsonl"), "{}");
    const outcomes = new Map<string, Outcome>([
      [kept, parsed({ sourcePath: kept })],
      [doomed, parsed({ sourcePath: doomed, sessionId: "doomed" })],
    ]);
    await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });

    rmSync(doomed);
    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(result).toMatchObject({ scanned: 1, indexed: 0, skipped: 1, removed: 1, failed: 0 });
    expect(sessions(db, { limit: 10 }).map((row) => row.sessionId)).toEqual(["session-a"]);
    expect(ftsIsConsistent(db)).toBe(true);
    db.close();
  });

  test("a parser that throws is counted, and the run finishes", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const bad = write(join(root, "bad.jsonl"), "{}");
    const good = write(join(root, "good.jsonl"), "{}");
    const outcomes = new Map<string, Outcome>([
      [bad, "throw"],
      [good, parsed({ sourcePath: good, sessionId: "good" })],
    ]);

    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(result).toMatchObject({ scanned: 2, indexed: 1, failed: 1, removed: 0 });
    expect(result.failures).toEqual([{ path: bad, error: "unreadable transcript" }]);
    expect(sessions(db, { limit: 10 }).map((row) => row.sessionId)).toEqual(["good"]);
    db.close();
  });

  test("a failed reparse keeps the session that is already searchable", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const path = write(join(root, "a.jsonl"), "{}", new Date(1_700_000_000_000));
    const outcomes = new Map<string, Outcome>([[path, parsed({ sourcePath: path })]]);
    await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    write(join(root, "a.jsonl"), "{}{}", new Date(1_700_000_600_000));
    outcomes.set(path, "throw");
    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(result).toMatchObject({ indexed: 0, failed: 1, removed: 0 });
    expect(search(db, { query: "widget", limit: 10 })).toHaveLength(1);
    db.close();
  });

  test("a transcript with nothing indexable is a skip, and drops any stale row", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const path = write(join(root, "a.jsonl"), "{}", new Date(1_700_000_000_000));
    const outcomes = new Map<string, Outcome>([[path, parsed({ sourcePath: path })]]);
    await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    write(join(root, "a.jsonl"), "", new Date(1_700_000_600_000));
    outcomes.set(path, null);
    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(result).toMatchObject({ scanned: 1, indexed: 0, skipped: 1, removed: 1, failed: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(ftsIsConsistent(db)).toBe(true);
    db.close();
  });

  test("retainDays drops what is older than the window without reindexing it", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const now = new Date("2026-09-01T00:00:00.000Z");
    const fresh = write(join(root, "fresh.jsonl"), "{}", new Date("2026-08-30T00:00:00.000Z"));
    const stale = write(join(root, "stale.jsonl"), "{}", new Date("2026-05-01T00:00:00.000Z"));
    const outcomes = new Map<string, Outcome>([
      [fresh, parsed({ sourcePath: fresh, sessionId: "fresh", updatedAt: "2026-08-30T00:00:00.000Z" })],
      [stale, parsed({ sourcePath: stale, sessionId: "stale", updatedAt: "2026-05-01T00:00:00.000Z" })],
    ]);
    const parsers = bindings(root, outcomes);

    const unbounded = await ingest(db, { roots: [root], parsers, now: () => now });
    expect(unbounded.indexed).toBe(2);

    const bounded = await ingest(db, { roots: [root], parsers, retainDays: 30, now: () => now });
    expect(bounded).toMatchObject({ scanned: 2, indexed: 0, skipped: 2, removed: 1, failed: 0 });
    expect(sessions(db, { limit: 10 }).map((row) => row.sessionId)).toEqual(["fresh"]);

    // The dropped transcript is not re-ingested on the next bounded run.
    const again = await ingest(db, { roots: [root], parsers, retainDays: 30, now: () => now });
    expect(again).toMatchObject({ indexed: 0, removed: 0 });
    db.close();
  });

  test("a root no parser owns is a configuration error, raised before any work", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    await expect(
      ingest(db, { roots: ["/nowhere"], parsers: bindings(root, new Map()) }),
    ).rejects.toThrow(/no parser owns/);
    db.close();
  });

  test("a store that is not installed on this machine is empty, not broken", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const missing = join(root, "not-installed");
    const parsers: Record<string, ParserBinding> = {
      codex: { root: missing, read: async () => "", parse: () => null },
    };
    const result = await ingest(db, { roots: [missing], parsers });
    expect(result).toMatchObject({ scanned: 0, indexed: 0, failed: 0 });
    db.close();
  });

  test("survives a close and reopen of the database on disk", async () => {
    const root = storeRoot();
    const path = join(root, "index.db");
    const transcript = write(join(root, "a.jsonl"), "{}");
    const outcomes = new Map<string, Outcome>([
      [transcript, parsed({ sourcePath: transcript, messages: [line(0, "user", "durable widget")] })],
    ]);

    const first = openIndex(path);
    await ingest(first, { roots: [root], parsers: bindings(root, outcomes) });
    first.close();

    const second = openIndex(path);
    expect(search(second, { query: "durable", limit: 5 })).toHaveLength(1);
    const rerun = await ingest(second, { roots: [root], parsers: bindings(root, outcomes) });
    expect(rerun).toMatchObject({ indexed: 0, skipped: 1 });
    second.close();
  });

  test("walks nested directories and both transcript extensions", async () => {
    const root = storeRoot();
    const nested = join(root, "projects", "deep");
    mkdirSync(nested, { recursive: true });
    const db = openIndex(MEMORY_INDEX);
    const plain = write(join(nested, "a.jsonl"), "{}");
    const zstd = write(join(nested, "b.jsonl.zst"), "{}");
    write(join(nested, "notes.md"), "ignored");
    const outcomes = new Map<string, Outcome>([
      [plain, parsed({ sourcePath: plain })],
      [zstd, parsed({ sourcePath: zstd, sessionId: "b" })],
    ]);
    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
    expect(result).toMatchObject({ scanned: 2, indexed: 2 });
    db.close();
  });
});

/** A populated index shared by the read-side tests. */
async function corpus(): Promise<Database> {
  const root = storeRoot();
  const db = openIndex(MEMORY_INDEX);
  const outcomes = new Map<string, Outcome>();
  const add = (name: string, session: Omit<ParsedSession, "sourcePath">): string => {
    const path = write(join(root, name), "{}");
    outcomes.set(path, { ...session, sourcePath: path });
    return path;
  };

  add("older.jsonl", {
    agent: "claude_code",
    sessionId: "older",
    workspace: "/ws/alpha",
    title: "older session",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    threadSource: null,
    originator: null,
    messages: [line(0, "user", "widget alpha"), line(1, "assistant", "widget alpha")],
  });
  add("newer.jsonl", {
    agent: "claude_code",
    sessionId: "newer",
    workspace: "/ws/alpha",
    title: "newer session",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    threadSource: null,
    originator: null,
    messages: [line(0, "user", "widget alpha")],
  });
  add("codex.jsonl.zst", {
    agent: "codex",
    sessionId: "codex-one",
    workspace: "/ws/beta",
    title: "codex session",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    threadSource: "user",
    originator: "codex_cli_rs",
    messages: [
      line(0, "user", "the queue drains slowly when the widget backlog is deep"),
      line(1, "tool_output", "exit 0"),
      line(2, "user", "another human turn"),
    ],
  });

  await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
  return db;
}

describe("search", () => {
  test("ranks by bm25 and breaks ties deterministically", async () => {
    const db = await corpus();
    // Three message rows carry the identical body "widget alpha", so bm25
    // cannot separate them: the order below is entirely the tie-break.
    const hits = search(db, { query: "widget alpha", limit: 10 });
    expect(hits.map((hit) => `${hit.sessionId}:${hit.ordinal}`).slice(0, 3)).toEqual([
      "newer:0",
      "older:0",
      "older:1",
    ]);
    expect(search(db, { query: "widget alpha", limit: 10 })).toEqual(hits);
    expect(hits[0]?.score).toBeLessThan(0);
    db.close();
  });

  test("returns the citation a caller needs to open the transcript", async () => {
    const db = await corpus();
    const hit = search(db, { query: "backlog", limit: 5 })[0];
    expect(hit).toMatchObject({
      agent: "codex",
      workspace: "/ws/beta",
      title: "codex session",
      sessionId: "codex-one",
      ordinal: 0,
      line: 1,
      role: "user",
      createdAt: "2026-08-10T00:00:00.000Z",
      // Carried on the hit so the picker classifies auxiliary sessions
      // without reopening the rollout.
      threadSource: "user",
      originator: "codex_cli_rs",
    });
    expect(hit?.sourcePath).toMatch(/codex\.jsonl\.zst$/);
    expect(hit?.snippet).toContain("[backlog]");
    db.close();
  });

  test("snippet marks are the caller's to choose", async () => {
    const db = await corpus();
    const marks = { start: "<b>", end: "</b>", ellipsis: "...", tokens: 4 };
    const hit = search(db, { query: "backlog", limit: 1, marks })[0];
    expect(hit?.snippet).toContain("<b>backlog</b>");
    expect(hit?.snippet).toContain("...");
    db.close();
  });

  test("filters by workspace, agent and time window", async () => {
    const db = await corpus();
    expect(search(db, { query: "widget", limit: 10, workspace: "/ws/beta" })).toHaveLength(1);
    expect(
      search(db, { query: "widget", limit: 10, agent: "claude_code" }).map((hit) => hit.sessionId),
    ).toEqual(["newer", "older", "older"]);
    expect(
      search(db, { query: "widget", limit: 10, since: "2026-08-01" }).map((hit) => hit.sessionId),
    ).toEqual(["newer", "codex-one"]);
    expect(
      search(db, { query: "widget", limit: 10, until: "2026-07-31" }).map((hit) => hit.sessionId),
    ).toEqual(["older", "older"]);
    db.close();
  });

  test("limit and offset page through one stable ordering", async () => {
    const db = await corpus();
    const all = search(db, { query: "widget alpha", limit: 10 });
    expect(search(db, { query: "widget alpha", limit: 1, offset: 1 })).toEqual([all[1] as never]);
    db.close();
  });

  test("hostile query strings return results or nothing, never a syntax error", async () => {
    const db = await corpus();
    for (const query of [
      "foo(bar",
      "C++",
      '"',
      "*",
      "**",
      "a AND",
      "NOT widget",
      "AND OR NOT",
      "widget)",
      "{body} : widget",
      "^widget",
      "NEAR",
      "widget NEAR",
      "😀",
      "",
      "   ",
    ]) {
      expect(() => search(db, { query, limit: 5 })).not.toThrow();
    }
    expect(search(db, { query: "widget*", limit: 10 }).length).toBeGreaterThan(0);
    expect(search(db, { query: '"widget alpha"', limit: 10 })).toHaveLength(3);
    expect(search(db, { query: "backlog OR nothingmatches", limit: 10 })).toHaveLength(1);
    expect(search(db, { query: "widget NOT alpha", limit: 10 })).toHaveLength(1);
    db.close();
  });
});

describe("toMatchQuery", () => {
  test("quotes every term and keeps the three operators worth keeping", () => {
    expect(toMatchQuery("foo bar")).toBe('"foo" "bar"');
    expect(toMatchQuery("foo(bar")).toBe('"foo(bar"');
    expect(toMatchQuery("C++")).toBe('"C++"');
    expect(toMatchQuery("foo OR bar")).toBe('"foo" OR "bar"');
    expect(toMatchQuery("foo NOT bar")).toBe('"foo" NOT "bar"');
    expect(toMatchQuery("wid*")).toBe('"wid"*');
    expect(toMatchQuery('"hello world"')).toBe('"hello world"');
    expect(toMatchQuery('"hello world"*')).toBe('"hello world"*');
    expect(toMatchQuery("near NEAR")).toBe('"near" "NEAR"');
  });

  test("drops what FTS5 would refuse rather than passing it through", () => {
    expect(toMatchQuery("a AND")).toBe('"a"');
    expect(toMatchQuery("NOT a")).toBe('"a"');
    expect(toMatchQuery("a AND OR b")).toBe('"a" AND "b"');
    expect(toMatchQuery('unterminated "quote')).toBe('"unterminated" "quote"');
    expect(toMatchQuery("*")).toBe(null);
    expect(toMatchQuery('"')).toBe(null);
    expect(toMatchQuery("AND OR NOT")).toBe(null);
    expect(toMatchQuery("   ")).toBe(null);
    expect(toMatchQuery("😀")).toBe(null);
  });
});

describe("sessions", () => {
  test("lists newest first with the counts state needs", async () => {
    const db = await corpus();
    const rows = sessions(db, { limit: 10 });
    expect(rows.map((row) => row.sessionId)).toEqual(["newer", "codex-one", "older"]);
    expect(rows[1]).toMatchObject({
      agent: "codex",
      workspace: "/ws/beta",
      title: "codex session",
      modified: "2026-08-11T00:00:00.000Z",
      messageCount: 3,
      // Two user turns; the tool_output between them is not a human turn.
      humanTurns: 2,
      threadSource: "user",
      originator: "codex_cli_rs",
    });
    expect(rows[1]?.path).toMatch(/codex\.jsonl\.zst$/);
    // Claude Code records neither, and null must survive the round trip
    // rather than arriving as "" — the picker distinguishes the two.
    expect(rows[0]).toMatchObject({ threadSource: null, originator: null });
    expect(search(db, { query: "widget", limit: 1, agent: "claude_code" })[0]).toMatchObject({
      threadSource: null,
      originator: null,
    });
    db.close();
  });

  test("applies the same filters as search", async () => {
    const db = await corpus();
    expect(sessions(db, { limit: 10, workspace: "/ws/alpha" }).map((row) => row.sessionId)).toEqual(
      ["newer", "older"],
    );
    expect(sessions(db, { limit: 10, agent: "codex" }).map((row) => row.sessionId)).toEqual([
      "codex-one",
    ]);
    expect(
      sessions(db, { limit: 10, since: "2026-08-01", until: "2026-08-15" }).map(
        (row) => row.sessionId,
      ),
    ).toEqual(["codex-one"]);
    expect(sessions(db, { limit: 1 })).toHaveLength(1);
    db.close();
  });
});

describe("aggregate", () => {
  test("counts matches by agent, workspace and date", async () => {
    const db = await corpus();
    expect(aggregate(db, { by: "agent", query: "widget" })).toEqual([
      { key: "claude_code", sessions: 2, messages: 3 },
      { key: "codex", sessions: 1, messages: 1 },
    ]);
    expect(aggregate(db, { by: "workspace", query: "widget" })).toEqual([
      { key: "/ws/alpha", sessions: 2, messages: 3 },
      { key: "/ws/beta", sessions: 1, messages: 1 },
    ]);
    expect(aggregate(db, { by: "date", query: "widget" })).toEqual([
      { key: "2026-07-02", sessions: 1, messages: 2 },
      { key: "2026-08-11", sessions: 1, messages: 1 },
      { key: "2026-08-20", sessions: 1, messages: 1 },
    ]);
    db.close();
  });

  test("without a query it counts the whole index", async () => {
    const db = await corpus();
    expect(aggregate(db, { by: "agent" })).toEqual([
      { key: "claude_code", sessions: 2, messages: 3 },
      { key: "codex", sessions: 1, messages: 3 },
    ]);
    expect(aggregate(db, { by: "agent", query: "  " })).toEqual(aggregate(db, { by: "agent" }));
    expect(aggregate(db, { by: "agent", query: "*" })).toEqual([]);
    db.close();
  });

  test("honors the session filters", async () => {
    const db = await corpus();
    expect(aggregate(db, { by: "workspace", query: "widget", agent: "codex" })).toEqual([
      { key: "/ws/beta", sessions: 1, messages: 1 },
    ]);
    db.close();
  });
});

describe("status", () => {
  test("reports what the index holds and how it was built", async () => {
    const db = await corpus();
    const report = status(db);
    expect(report).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      expectedSchemaVersion: SCHEMA_VERSION,
      sessions: 3,
      messages: 6,
      newestSession: "2026-08-20T00:00:00.000Z",
    });
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.lastIndexedAt).not.toBe(null);
    expect(report.agents).toEqual([
      { agent: "claude_code", sessions: 2, messages: 3 },
      { agent: "codex", sessions: 1, messages: 3 },
    ]);
    db.close();
  });

  test("an empty index reports zeroes rather than nulls in the counts", () => {
    const db = openIndex(MEMORY_INDEX);
    expect(status(db)).toMatchObject({
      sessions: 0,
      messages: 0,
      newestSession: null,
      lastIndexedAt: null,
      agents: [],
    });
    db.close();
  });
});
