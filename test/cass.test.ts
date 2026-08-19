import { describe, expect, test } from "bun:test";
import { parseHits, parseSessions, searchArgs, sessionsArgs } from "../src/tui/cass.ts";

const WS = "/Users/op/code/alpha";

describe("searchArgs / sessionsArgs", () => {
  test("scope rides as --workspace only when present", () => {
    expect(searchArgs("queue", WS, 30)).toEqual([
      "search",
      "queue",
      "--json",
      "--limit",
      "30",
      "--mode",
      "hybrid",
      "--workspace",
      WS,
    ]);
    expect(searchArgs("queue", null, 30)).not.toContain("--workspace");
    expect(sessionsArgs(WS, 20)).toContain("--workspace");
    expect(sessionsArgs(null, 20)).not.toContain("--workspace");
  });

  test("the time window narrows both commands", () => {
    expect(searchArgs("q", null, 30, "today").join(" ")).toContain("--days 1");
    expect(searchArgs("q", null, 30, "week").join(" ")).toContain("--days 7");
    expect(searchArgs("q", null, 30, "all").join(" ")).not.toContain("--days");
    expect(sessionsArgs(null, 20, "today").join(" ")).toContain("--since 1d");
    expect(sessionsArgs(null, 20, "week").join(" ")).toContain("--since 7d");
    expect(sessionsArgs(null, 20, "all").join(" ")).not.toContain("--since");
  });
});

describe("parseHits", () => {
  const stdout = JSON.stringify({
    hits: [
      {
        title: "# Fix the queue",
        snippet: "the  queue\nwas broken",
        agent: "claude_code",
        workspace: WS,
        source_path: "/store/a.jsonl",
        created_at: 1786116422062,
        line_number: 51,
      },
      {
        title: "",
        agent: "codex",
        workspace: "/Users/op/code/beta",
        source_path: "/store/b.jsonl",
      },
    ],
  });

  test("keeps cass's order and normalizes whitespace", () => {
    const rows = parseHits(stdout, null);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.snippet).toBe("the queue was broken");
    expect(rows[0]?.when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(rows[0]?.line).toBe(51);
    expect(rows[1]?.title).toBe("(untitled)");
  });

  test("project scope drops other workspaces client-side", () => {
    const rows = parseHits(stdout, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace).toBe(WS);
  });

  test("garbage is an empty list, not a crash", () => {
    expect(parseHits("not json", null)).toEqual([]);
    expect(parseHits("{}", null)).toEqual([]);
  });
});

describe("parseSessions", () => {
  const stdout = JSON.stringify({
    sessions: [
      {
        path: "/store/a.jsonl",
        workspace: WS,
        agent: "claude_code",
        title: "older duplicate",
        modified: "2026-08-01T00:00:00+00:00",
      },
      {
        path: "/store/a.jsonl",
        workspace: WS,
        agent: "claude_code",
        title: "newer duplicate",
        modified: "2026-08-15T12:30:00+00:00",
      },
      {
        path: "/store/b.jsonl",
        workspace: "/Users/op/code/beta",
        agent: "codex",
        title: "elsewhere",
        modified: "2026-08-16T00:00:00+00:00",
      },
    ],
  });

  test("collapses duplicate index rows to the newest, newest first", () => {
    const rows = parseSessions(stdout, null);
    expect(rows.map((row) => row.title)).toEqual(["elsewhere", "newer duplicate"]);
    expect(rows[1]?.when).toBe("2026-08-15 12:30");
  });

  test("project scope drops the unscoped fallback rows", () => {
    const rows = parseSessions(stdout, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("newer duplicate");
  });
});
