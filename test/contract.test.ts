import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../src/store/schema.ts";
import { ingest, pendingWork } from "../src/store/ingest.ts";
import { search } from "../src/store/query.ts";
import type { ParsedSession } from "../src/parse/types.ts";

/**
 * The promises `skills/chats/SKILL.md` makes to agents, pinned as tests.
 *
 * These are cheap and they exist because one of them was already broken
 * once: the query-less idiom stopped returning rows during a refactor, and
 * nothing caught it — the skill kept telling agents to use a search that
 * silently answered "nothing". A documented capability that returns an
 * empty result is worse than one that errors, because an agent believes it.
 */

function fixture(root: string) {
  const session: ParsedSession = {
    agent: "claude_code",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    sourcePath: join(root, "store", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
    workspace: "/tmp/project",
    title: "Fix the deploy timeout",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    threadSource: null,
    originator: null,
    messages: [
      { ordinal: 0, line: 1, byteOffset: 0, role: "user", ts: "", body: "the deploy timeout keeps firing", truncated: false },
      { ordinal: 1, line: 2, byteOffset: 40, role: "assistant", ts: "", body: "ECONNREFUSED from redis", truncated: false },
    ],
  };
  return session;
}

async function indexed() {
  const root = mkdtempSync(join(tmpdir(), "agentchats-contract-"));
  const store = join(root, "store");
  const db = openIndex(join(root, "index.db"));
  const session = fixture(root);
  // ingest walks the filesystem, so the transcript has to exist; its bytes
  // do not matter because the parser is injected.
  await Bun.write(session.sourcePath, "{}\n");
  await ingest(db, {
    roots: [store],
    parsers: { claude_code: { root: store, parse: () => session, read: async () => "{}" } },
  });
  return { db, root, session };
}

describe("the contract the chats skill documents", () => {
  test("the query-less idiom returns rows, not silence", async () => {
    const { db, root } = await indexed();
    try {
      expect(search(db, { query: "", limit: 10, offset: 0 }).hits.length).toBeGreaterThan(0);
      expect(search(db, { query: "", limit: 10, offset: 0, workspace: "/tmp/project" }).hits.length)
        .toBeGreaterThan(0);
      // A query that sanitizes down to nothing is the same case.
      expect(search(db, { query: "~!@#$%", limit: 10, offset: 0 }).hits.length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a query-less scan still honours its filters", async () => {
    const { db, root } = await indexed();
    try {
      expect(search(db, { query: "", limit: 10, offset: 0, workspace: "/tmp/elsewhere" }).hits)
        .toEqual([]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hit carries the citation and the flags a caller branches on", async () => {
    const { db, root } = await indexed();
    try {
      const result = search(db, { query: "ECONNREFUSED", limit: 10, offset: 0 });
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(hit.sourcePath).not.toBe("");
        expect(hit.line).toBeGreaterThan(0);
        expect(typeof hit.truncated).toBe("boolean");
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hostile query strings never throw", async () => {
    const { db, root } = await indexed();
    try {
      for (const query of ['foo(bar', "C++", '"', "*", "**", "NOT", "a AND", "*config*", "deploy*"]) {
        expect(() => search(db, { query, limit: 5, offset: 0 })).not.toThrow();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unavailable root keeps its sessions instead of pruning them", async () => {
    // The failure this prevents: an external volume holding archived
    // transcripts is unmounted, the walk finds nothing under it, and the
    // mirror rule reads that as "every session there was deleted" — silently
    // emptying the index of an entire archive.
    const root = mkdtempSync(join(tmpdir(), "agentchats-roots-"));
    const live = join(root, "live");
    const removable = join(root, "removable");
    mkdirSync(live, { recursive: true });
    mkdirSync(removable, { recursive: true });
    try {
      const paths = [join(live, "a.jsonl"), join(removable, "b.jsonl"), join(removable, "c.jsonl")];
      for (const path of paths) await Bun.write(path, "{}\n");
      const parse = (_content: string, path: string): ParsedSession => ({
        agent: "claude_code",
        sessionId: path,
        sourcePath: path,
        workspace: "/w",
        title: path,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        threadSource: null,
        originator: null,
        messages: [{ ordinal: 0, line: 1, byteOffset: 0, role: "user", ts: "", body: `body ${path}`, truncated: false }],
      });
      const read = async (): Promise<string> => "{}";
      const sources = {
        roots: [live, removable],
        parsers: {
          claude_code: { root: live, parse, read },
          codex: { root: removable, parse, read },
        },
      };
      const db = openIndex(join(root, "index.db"));
      const rows = (): number =>
        (db.query("select count(*) c from sessions").get() as { c: number }).c;
      try {
        await ingest(db, sources);
        expect(rows()).toBe(3);

        renameSync(removable, `${removable}-gone`);
        const offline = await ingest(db, sources);
        expect(offline.removed).toBe(0);
        expect(offline.unavailableRoots).toEqual([removable]);
        expect(rows()).toBe(3);

        // And a file genuinely deleted from a root that IS readable still goes.
        rmSync(join(live, "a.jsonl"));
        const pruned = await ingest(db, sources);
        expect(pruned.removed).toBe(1);
        expect(rows()).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(`${removable}-gone`, { recursive: true, force: true });
    }
  });

  test("pendingWork reports what an index run would do, without doing it", async () => {
    // This had no test, and shipped as infinite recursion: a refactor pointed
    // the helper at itself and every caller hung. The freshness probe is the
    // cheap question asked before a 6.5s index run, so it has to answer.
    const root = mkdtempSync(join(tmpdir(), "agentchats-pending-"));
    const store = join(root, "store");
    mkdirSync(store, { recursive: true });
    try {
      const path = join(store, "a.jsonl");
      await Bun.write(path, "{}\n");
      const parse = (_c: string, p: string): ParsedSession => ({
        agent: "claude_code", sessionId: p, sourcePath: p, workspace: "/w", title: p,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        threadSource: null, originator: null,
        messages: [{ ordinal: 0, line: 1, byteOffset: 0, role: "user", ts: "", body: "hello", truncated: false }],
      });
      const sources = {
        roots: [store],
        parsers: { claude_code: { root: store, parse, read: async (): Promise<string> => "{}" } },
      };
      const db = openIndex(join(root, "index.db"));
      try {
        const before = pendingWork(db, sources);
        expect(before).toEqual({ scanned: 1, pending: 1, vanished: 0, unavailableRoots: [] });

        await ingest(db, sources);
        expect(pendingWork(db, sources)).toEqual({
          scanned: 1, pending: 0, vanished: 0, unavailableRoots: [],
        });

        rmSync(path);
        expect(pendingWork(db, sources).vanished).toBe(1);

        // An unreadable root is not "everything under it vanished" here either.
        rmSync(store, { recursive: true, force: true });
        const offline = pendingWork(db, sources);
        expect(offline.vanished).toBe(0);
        expect(offline.unavailableRoots).toEqual([store]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an archived copy never duplicates the live session it copies", async () => {
    // The archive is an rsync copy, so the same conversation exists at two
    // paths under one filename, with identical size and mtime because -a
    // preserves them. Indexing both would double every session in the state
    // dump and the picker.
    const root = mkdtempSync(join(tmpdir(), "agentchats-archive-"));
    const live = join(root, "live");
    const archive = join(root, "archive");
    mkdirSync(live, { recursive: true });
    mkdirSync(archive, { recursive: true });
    try {
      const name = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
      for (const dir of [live, archive]) await Bun.write(join(dir, name), "{}\n");
      const parse = (_c: string, p: string): ParsedSession => ({
        agent: "claude_code", sessionId: name.replace(".jsonl", ""), sourcePath: p,
        workspace: "/w", title: "one conversation",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        threadSource: null, originator: null,
        messages: [{ ordinal: 0, line: 1, byteOffset: 0, role: "user", ts: "", body: "hello", truncated: false }],
      });
      const read = async (): Promise<string> => "{}";
      const db = openIndex(join(root, "index.db"));
      try {
        // Live root listed first, as callers must.
        await ingest(db, {
          roots: [live, archive],
          parsers: {
            claude_code: { root: live, parse, read },
            archive: { root: archive, parse, read, archived: true },
          },
        });
        const rows = db.query("select source_path, archived from sessions").all() as
          { source_path: string; archived: number }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.source_path).toBe(join(live, name));
        expect(rows[0]!.archived).toBe(0);

        // With the live copy pruned by the harness, the archive supplies it —
        // searchable, and marked as no longer resumable.
        rmSync(join(live, name));
        await ingest(db, {
          roots: [live, archive],
          parsers: {
            claude_code: { root: live, parse, read },
            archive: { root: archive, parse, read, archived: true },
          },
        });
        const after = db.query("select source_path, archived from sessions").all() as
          { source_path: string; archived: number }[];
        expect(after).toHaveLength(1);
        expect(after[0]!.source_path).toBe(join(archive, name));
        expect(after[0]!.archived).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
