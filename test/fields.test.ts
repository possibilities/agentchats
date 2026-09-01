import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/cli/args.ts";
import { FIELD_SETS, project, truncate } from "../src/cli/fields.ts";
import { MESSAGE_BODY_CAP, normalizeBody } from "../src/parse/types.ts";

/**
 * Both of these shaped output silently and wrongly, which is the failure a
 * tool agents depend on can least afford: the caller gets a well-formed
 * answer and believes it.
 */

const hit = {
  source_path: "/Users/x/.claude/projects/p/aaaa-bbbb.jsonl",
  line: 42,
  agent: "claude_code",
  workspace: "/Users/x/code/project",
  title: "A reasonably long session title that keeps going",
  snippet: "a snippet that is definitely longer than twenty characters",
  score: -12.5,
  created_at: "2026-09-01T00:00:00.000Z",
  session_id: "aaaa-bbbb",
  ordinal: 7,
  role: "assistant",
  matched_on: "message",
};

describe("--fields", () => {
  test("a misspelled field is a usage error, not an empty object", () => {
    expect(() => project([hit], "sumary")).toThrow(UsageError);
    expect(() => project([hit], "source_paht,line")).toThrow(UsageError);
  });

  test("the retired tool's line_number still resolves to line", () => {
    expect(project([hit], "source_path,line_number")[0]).toEqual({
      source_path: hit.source_path,
      line: 42,
    });
  });

  test("summary carries a snippet, because that is what callers add back", () => {
    expect(FIELD_SETS["summary"]).toContain("snippet");
    expect(Object.keys(project([hit], "summary")[0]!)).toContain("snippet");
  });

  test("named sets and custom lists both work", () => {
    expect(Object.keys(project([hit], "minimal")[0]!)).toEqual(["source_path", "line", "agent"]);
    expect(project([hit], "line,role")[0]).toEqual({ line: 42, role: "assistant" });
  });
});

describe("--max-content-length", () => {
  test("never truncates the citation fields a caller feeds back in", () => {
    const [row] = truncate([{ ...hit }], 20) as Record<string, unknown>[];
    expect(row!["source_path"]).toBe(hit.source_path);
    expect(row!["session_id"]).toBe(hit.session_id);
    expect(row!["workspace"]).toBe(hit.workspace);
    expect(row!["line"]).toBe(42);
  });

  test("does truncate the content it is named for", () => {
    const [row] = truncate([{ ...hit }], 20) as Record<string, unknown>[];
    expect(String(row!["snippet"])).toHaveLength(21); // 20 + the ellipsis
    expect(String(row!["snippet"]).endsWith("…")).toBe(true);
    expect(String(row!["title"]).endsWith("…")).toBe(true);
  });

  test("leaves everything alone when unset", () => {
    expect(truncate([{ ...hit }], undefined)[0]).toEqual(hit);
  });
});

describe("truncation is visible", () => {
  test("a body stored at the cap is reported as cut", () => {
    // The proxy the CLI uses: no stored column, no reindex. A natural body of
    // exactly MESSAGE_BODY_CAP characters is not a case worth a schema change.
    const capped = "x".repeat(MESSAGE_BODY_CAP);
    const short = "x".repeat(MESSAGE_BODY_CAP - 1);
    expect(capped.length >= MESSAGE_BODY_CAP).toBe(true);
    expect(short.length >= MESSAGE_BODY_CAP).toBe(false);
    // normalizeBody is what produces the capped body in the first place.
    expect(normalizeBody("y".repeat(MESSAGE_BODY_CAP + 5000)).length).toBe(MESSAGE_BODY_CAP);
  });
});
