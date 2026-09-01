import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../src/store/schema.ts";
import { ingest } from "../src/store/ingest.ts";
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

  test("every hit says how it matched, and the envelope reports widening", async () => {
    const { db, root } = await indexed();
    try {
      const result = search(db, { query: "ECONNREFUSED", limit: 10, offset: 0 });
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) {
        expect(["message", "session", "metadata"]).toContain(hit.matchedOn);
      }
      expect([null, "session"]).toContain(result.fallback);
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
});
