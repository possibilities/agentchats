import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../src/tui/cass.ts";
import {
  applyDescriptions,
  describeRequests,
  parseDescriptions,
} from "../src/tui/describe.ts";

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    agent: "claude_code",
    workspace: "/w",
    path: "/store/a.jsonl",
    title: "raw title",
    when: "",
    snippet: null,
    line: null,
    slug: null,
    excerpt: null,
    ...overrides,
  };
}

describe("describeRequests", () => {
  test("asks about fleet-named harnesses only, in the fleet's vocabulary", () => {
    const requests = describeRequests([
      row({ agent: "claude_code", path: "/a.jsonl" }),
      row({ agent: "cursor", path: "/b.jsonl" }),
      row({ agent: "pi_agent", path: "/c.jsonl" }),
    ]);
    const lines = requests.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { harness: "claude", path: "/a.jsonl" },
      { harness: "pi", path: "/c.jsonl" },
    ]);
  });

  test("nothing to ask is an empty string, not a blank line", () => {
    expect(describeRequests([row({ agent: "cursor" })])).toBe("");
  });
});

describe("parseDescriptions + applyDescriptions", () => {
  test("answers merge by path; unanswered rows keep cass's text", () => {
    const rows = [row({ path: "/a.jsonl" }), row({ path: "/b.jsonl" })];
    const descriptions = parseDescriptions(
      `${JSON.stringify({ path: "/a.jsonl", slug: "fix the queue", excerpt: "the queue drops" })}\nnot json\n`,
    );
    applyDescriptions(rows, descriptions);
    expect(rows[0]?.slug).toBe("fix the queue");
    expect(rows[0]?.excerpt).toBe("the queue drops");
    expect(rows[1]?.slug).toBeNull();
    expect(rows[1]?.title).toBe("raw title");
  });
});
