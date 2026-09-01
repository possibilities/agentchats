import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage, ParsedSession, Role } from "../src/parse/types.ts";
import { ingest, type ParserBinding } from "../src/store/ingest.ts";
import { indexPath, MEMORY_INDEX } from "../src/store/paths.ts";
import {
  aggregate,
  search,
  type SearchHit,
  type SearchOptions,
  sessions,
  status,
  toMatchQuery,
} from "../src/store/query.ts";
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
  return { ordinal, line: ordinal + 1, byteOffset: ordinal * 128, role, ts: "", body, truncated: false };
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

/** Both FTS5 indexes agree with their content tables, and no row was
 * orphaned in either. */
function ftsIsConsistent(db: Database): boolean {
  db.run("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')");
  db.run("INSERT INTO sessions_fts (sessions_fts) VALUES ('integrity-check')");
  const count = (table: string): number =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return count("messages_fts") === count("messages") && count("sessions_fts") === count("sessions");
}

/** Most assertions care only about the rows, not the envelope. */
function found(db: Database, options: SearchOptions): SearchHit[] {
  return search(db, options).hits;
}

interface SessionSpec {
  /** Also the session id and the transcript's basename. */
  name: string;
  workspace?: string;
  title?: string;
  updatedAt?: string;
  bodies: string[];
}

/** A whole index from a list of sessions, written through the real ingest
 * path so the FTS triggers do the work they do in production. */
async function indexed(specs: readonly SessionSpec[]): Promise<Database> {
  const root = storeRoot();
  const db = openIndex(MEMORY_INDEX);
  const outcomes = new Map<string, Outcome>();
  for (const spec of specs) {
    const path = write(join(root, `${spec.name}.jsonl`), "{}");
    outcomes.set(
      path,
      parsed({
        sourcePath: path,
        sessionId: spec.name,
        workspace: spec.workspace ?? "/ws/default",
        title: spec.title ?? `${spec.name} session`,
        updatedAt: spec.updatedAt ?? "2026-08-01T00:00:00.000Z",
        messages: spec.bodies.map((body, ordinal) =>
          line(ordinal, ordinal % 2 === 0 ? "user" : "assistant", body),
        ),
      }),
    );
  }
  await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
  return db;
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
    expect(found(db, { query: "obsolete", limit: 10 })).toHaveLength(1);

    write(join(root, "a.jsonl"), "{}{}", new Date(1_700_000_600_000));
    outcomes.set(
      path,
      parsed({ sourcePath: path, messages: [line(0, "user", "current widget")] }),
    );
    const result = await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(result).toMatchObject({ scanned: 1, indexed: 1, skipped: 0, removed: 0, failed: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
    expect(found(db, { query: "obsolete", limit: 10 })).toEqual([]);
    expect(found(db, { query: "current", limit: 10 })).toHaveLength(1);
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
    expect(found(db, { query: "widget", limit: 10 })).toHaveLength(1);
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
    expect(found(second, { query: "durable", limit: 5 })).toHaveLength(1);
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
    const hits = found(db, { query: "widget alpha", limit: 10 });
    expect(hits.map((hit) => `${hit.sessionId}:${hit.ordinal}`).slice(0, 3)).toEqual([
      "newer:0",
      "older:0",
      "older:1",
    ]);
    expect(found(db, { query: "widget alpha", limit: 10 })).toEqual(hits);
    expect(hits[0]?.score).toBeLessThan(0);
    db.close();
  });

  test("returns the citation a caller needs to open the transcript", async () => {
    const db = await corpus();
    const hit = found(db, { query: "backlog", limit: 5 })[0];
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
    const hit = found(db, { query: "backlog", limit: 1, marks })[0];
    expect(hit?.snippet).toContain("<b>backlog</b>");
    expect(hit?.snippet).toContain("...");
    db.close();
  });

  test("filters by workspace, agent and time window", async () => {
    const db = await corpus();
    expect(found(db, { query: "widget", limit: 10, workspace: "/ws/beta" })).toHaveLength(1);
    expect(
      found(db, { query: "widget", limit: 10, agent: "claude_code" }).map((hit) => hit.sessionId),
    ).toEqual(["newer", "older", "older"]);
    expect(
      found(db, { query: "widget", limit: 10, since: "2026-08-01" }).map((hit) => hit.sessionId),
    ).toEqual(["newer", "codex-one"]);
    expect(
      found(db, { query: "widget", limit: 10, until: "2026-07-31" }).map((hit) => hit.sessionId),
    ).toEqual(["older", "older"]);
    db.close();
  });

  test("limit and offset page through one stable ordering", async () => {
    const db = await corpus();
    const all = found(db, { query: "widget alpha", limit: 10 });
    expect(found(db, { query: "widget alpha", limit: 1, offset: 1 })).toEqual([all[1] as never]);
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
      expect(() => found(db, { query, limit: 5 })).not.toThrow();
    }
    expect(found(db, { query: "widget*", limit: 10 }).length).toBeGreaterThan(0);
    expect(found(db, { query: '"widget alpha"', limit: 10 })).toHaveLength(3);
    expect(found(db, { query: "backlog OR nothingmatches", limit: 10 })).toHaveLength(1);
    expect(found(db, { query: "widget NOT alpha", limit: 10 })).toHaveLength(1);
    db.close();
  });
});

describe("metadata search", () => {
  test("finds a session by its workspace when no message says the word", async () => {
    const db = await indexed([
      {
        name: "s1",
        workspace: "/Users/arthack/code/agentbrowse",
        title: "loader refactor",
        updatedAt: "2026-08-20T00:00:00.000Z",
        bodies: ["the loader is slow", "fixed it"],
      },
      {
        name: "s2",
        workspace: "/Users/arthack/code/other",
        title: "unrelated",
        updatedAt: "2026-08-10T00:00:00.000Z",
        bodies: ["nothing to see"],
      },
    ]);
    const result = search(db, { query: "agentbrowse", limit: 10 });

    expect(result.fallback).toBe(null);
    expect(result.hits).toHaveLength(1);
    // Anchored on the session's first message, so a citation still opens
    // the transcript somewhere real.
    expect(result.hits[0]).toMatchObject({
      sessionId: "s1",
      matchedOn: "metadata",
      ordinal: 0,
      line: 1,
      role: "user",
      workspace: "/Users/arthack/code/agentbrowse",
    });
    expect(result.hits[0]?.snippet).toBe("/Users/arthack/code/[agentbrowse]");
    db.close();
  });

  test("matches the transcript path, which is how filenames stay searchable", async () => {
    const db = await indexed([
      { name: "rollout-2026-08-20-deadbeef", title: "a", bodies: ["nothing relevant"] },
    ]);
    const hits = found(db, { query: "deadbeef", limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedOn).toBe("metadata");
    expect(hits[0]?.snippet).toContain("[deadbeef]");
    db.close();
  });

  test("message hits rank ahead of metadata hits, and a session appears once", async () => {
    const db = await indexed([
      {
        name: "s1",
        workspace: "/code/agentbrowse",
        updatedAt: "2026-08-20T00:00:00.000Z",
        bodies: ["no keyword in this body"],
      },
      {
        // Matches on both passes, and is the older session: it must still
        // come first, as a message hit, and must not repeat as metadata.
        name: "s2",
        workspace: "/code/agentbrowse",
        updatedAt: "2026-08-01T00:00:00.000Z",
        bodies: ["agentbrowse is named in the body"],
      },
    ]);
    const hits = found(db, { query: "agentbrowse", limit: 10 });
    expect(hits.map((hit) => [hit.sessionId, hit.matchedOn])).toEqual([
      ["s2", "message"],
      ["s1", "metadata"],
    ]);
    db.close();
  });

  test("metadata hits honor the session filters", async () => {
    const db = await indexed([
      { name: "s1", workspace: "/code/agentbrowse", updatedAt: "2026-08-20T00:00:00.000Z", bodies: ["x"] },
      { name: "s2", workspace: "/code/agentbrowse", updatedAt: "2026-01-01T00:00:00.000Z", bodies: ["x"] },
    ]);
    expect(
      found(db, { query: "agentbrowse", limit: 10, since: "2026-08-01" }).map((h) => h.sessionId),
    ).toEqual(["s1"]);
    expect(found(db, { query: "agentbrowse", limit: 1 })).toHaveLength(1);
    db.close();
  });

  test("a huge page still composes both passes", async () => {
    // The metadata pass has to exclude every session the message pass
    // returned. Naming them one bound parameter at a time is correct but
    // costs the page size in statement text: a 48,000-row page took 14.5s
    // that way against 179ms for the set operation now in its place.
    const bodies = Array.from({ length: 400 }, (_, i) => `widget line ${i}`);
    const db = await indexed([
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `s${i}`,
        workspace: "/code/plain",
        updatedAt: "2026-08-01T00:00:00.000Z",
        bodies,
      })),
      {
        name: "meta",
        workspace: "/code/widget",
        updatedAt: "2026-08-20T00:00:00.000Z",
        bodies: ["nothing relevant in this body"],
      },
    ]);
    const result = search(db, { query: "widget", limit: 50_000 });

    expect(result.hits).toHaveLength(40_001);
    expect(result.hits.filter((hit) => hit.matchedOn === "metadata")).toHaveLength(1);
    // The metadata hit is the one session with no matching message, and it
    // lands after all 40,000 message hits despite being the newest.
    expect(result.hits[40_000]).toMatchObject({ sessionId: "meta", matchedOn: "metadata" });
    db.close();
  });

  test("a reindexed session drops the metadata it used to carry", async () => {
    const root = storeRoot();
    const db = openIndex(MEMORY_INDEX);
    const path = write(join(root, "a.jsonl"), "{}", new Date(1_700_000_000_000));
    const outcomes = new Map<string, Outcome>([
      [path, parsed({ sourcePath: path, workspace: "/code/agentbrowse" })],
    ]);
    await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });
    expect(found(db, { query: "agentbrowse", limit: 5 })).toHaveLength(1);

    write(join(root, "a.jsonl"), "{}{}", new Date(1_700_000_600_000));
    outcomes.set(path, parsed({ sourcePath: path, workspace: "/code/elsewhere" }));
    await ingest(db, { roots: [root], parsers: bindings(root, outcomes) });

    expect(found(db, { query: "agentbrowse", limit: 5 })).toEqual([]);
    expect(found(db, { query: "elsewhere", limit: 5 })).toHaveLength(1);
    expect(ftsIsConsistent(db)).toBe(true);
    db.close();
  });
});

describe("session-scoped widening", () => {
  const split: readonly SessionSpec[] = [
    {
      name: "s1",
      updatedAt: "2026-08-20T00:00:00.000Z",
      bodies: ["fable is the default", "unrelated middle", "opus-1m for long context"],
    },
  ];

  test("finds a session whose terms are spread across messages", async () => {
    const db = await indexed(split);
    expect(found(db, { query: "fable opus-1m", limit: 10 })).toHaveLength(1);

    const result = search(db, { query: "fable opus-1m", limit: 10 });
    expect(result.fallback).toBe("session");
    expect(result.hits[0]).toMatchObject({ sessionId: "s1", matchedOn: "session" });
    // The anchor is a message that actually matched a term, not an
    // arbitrary one, so the citation lands somewhere worth reading.
    expect(result.hits[0]?.snippet).toMatch(/\[(fable|opus)/);
    expect([0, 2]).toContain(result.hits[0]?.ordinal ?? -1);
    db.close();
  });

  test("returns one hit per session however many messages match", async () => {
    const db = await indexed([
      {
        name: "s1",
        bodies: ["fable one", "fable two", "fable three", "opus-1m at the end"],
      },
    ]);
    const result = search(db, { query: "fable opus-1m", limit: 10 });
    expect(result.fallback).toBe("session");
    expect(result.hits).toHaveLength(1);
    db.close();
  });

  test("does not widen a single-term query — there is nothing to widen", async () => {
    const db = await indexed(split);
    const result = search(db, { query: "fable", limit: 10 });
    expect(result.fallback).toBe(null);
    expect(result.hits.map((hit) => hit.matchedOn)).toEqual(["message"]);
    db.close();
  });

  test("does not widen once the exact pass has enough to read", async () => {
    const db = await indexed([
      {
        name: "s1",
        updatedAt: "2026-08-20T00:00:00.000Z",
        bodies: ["fable opus-1m together", "fable opus-1m again", "fable opus-1m thrice"],
      },
      { name: "s2", updatedAt: "2026-08-10T00:00:00.000Z", bodies: ["fable alone", "opus-1m alone"] },
    ]);
    const result = search(db, { query: "fable opus-1m", limit: 10 });

    expect(result.fallback).toBe(null);
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(["s1", "s1", "s1"]);
    db.close();
  });

  test("a page the exact pass already filled is never widened", async () => {
    const db = await indexed([
      { name: "s1", updatedAt: "2026-08-20T00:00:00.000Z", bodies: ["fable and opus-1m in one line"] },
      { name: "s2", updatedAt: "2026-08-10T00:00:00.000Z", bodies: ["fable here", "opus-1m there"] },
    ]);
    // One exact hit fills a one-row page, so there is no room for a lead —
    // even though the corpus has fewer than three exact hits in total.
    const full = search(db, { query: "fable opus-1m", limit: 1 });
    expect(full.fallback).toBe(null);
    expect(full.hits.map((hit) => hit.sessionId)).toEqual(["s1"]);

    // The same query with room to spare does widen.
    expect(search(db, { query: "fable opus-1m", limit: 10 }).fallback).toBe("session");
    db.close();
  });

  test("never widens a query that used an operator", async () => {
    const db = await indexed(split);
    for (const query of ["fable OR opus-1m", "fable NOT opus-1m", "fable AND opus-1m"]) {
      const result = search(db, { query, limit: 10 });
      expect(result.fallback).toBe(null);
      expect(result.hits.every((hit) => hit.matchedOn !== "session")).toBe(true);
    }
    db.close();
  });

  test("widened hits skip sessions the exact pass already returned", async () => {
    const db = await indexed([
      { name: "s1", updatedAt: "2026-08-20T00:00:00.000Z", bodies: ["fable and opus-1m in one line"] },
      { name: "s2", updatedAt: "2026-08-10T00:00:00.000Z", bodies: ["fable here", "opus-1m there"] },
    ]);
    const result = search(db, { query: "fable opus-1m", limit: 10 });

    expect(result.fallback).toBe("session");
    expect(result.hits.map((hit) => [hit.sessionId, hit.matchedOn])).toEqual([
      ["s1", "message"],
      ["s2", "session"],
    ]);
    db.close();
  });

  test("a repeated word is one term, not a multi-term query", async () => {
    const db = await indexed(split);
    expect(search(db, { query: "fable fable", limit: 10 }).fallback).toBe(null);
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
    expect(found(db, { query: "widget", limit: 1, agent: "claude_code" })[0]).toMatchObject({
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
