import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MESSAGE_BODY_CAP, normalizeBody } from "../src/parse/types.ts";
import { parseCodex } from "../src/parse/codex.ts";
import { parseClaude } from "../src/parse/claude.ts";
import { deriveSessionId } from "../src/tui/resume.ts";

/**
 * Regression cover for the tokenization trap that made real transcript
 * content unsearchable: a web-search tool wraps citations in Private Use
 * Area codepoints, and FTS5's unicode61 treats those as token characters, so
 * a word touching one is indexed with the marker glued on and can never be
 * matched. Found by the ground-truth parity fixture against the live corpus.
 */

/** The real fragment, from
 * ~/.codex/sessions/2026/08/02/rollout-...-019fc538-....jsonl line 203. */
const CITATION = "L108: cite28†Severity Normal";

function tokenizesTo(body: string, term: string): boolean {
  const db = new Database(":memory:");
  db.run("create virtual table t using fts5(body, tokenize='unicode61 remove_diacritics 2')");
  db.run("insert into t(rowid, body) values (1, ?)", [body]);
  const found = (db.query("select count(*) c from t where t match ?").get(term) as { c: number }).c;
  db.close();
  return found > 0;
}

describe("normalizeBody", () => {
  test("private use area citation markers do not swallow the word beside them", () => {
    expect(tokenizesTo(CITATION, "severity")).toBe(false);
    expect(tokenizesTo(normalizeBody(CITATION).body, "severity")).toBe(true);
  });

  test("invisible separators become spaces rather than vanishing", () => {
    // Deleting the marker would merge these into one unfindable token.
    expect(normalizeBody("alpha​beta").body).toBe("alpha beta");
    expect(tokenizesTo(normalizeBody("alpha​beta").body, "beta")).toBe(true);
  });

  test("zero width, bidi, soft hyphen, and BOM are all stripped", () => {
    for (const marker of ["​", "‎", "‭", "­", "﻿", "⁠", ""]) {
      expect(normalizeBody(`one${marker}two`).body).toBe("one two");
    }
  });

  test("ordinary text and its interior newlines survive untouched", () => {
    expect(normalizeBody("  hello\nworld  ").body).toBe("hello\nworld");
    expect(normalizeBody("C++ and café").body).toBe("C++ and café");
  });

  test("empty and whitespace-only bodies normalize away", () => {
    expect(normalizeBody("   \n\t ").body).toBe("");
    expect(normalizeBody("").body).toBe("");
  });

  test("truncation is reported by the writer, not inferred from length", () => {
    const long = "y".repeat(MESSAGE_BODY_CAP + 500);
    expect(normalizeBody(long).truncated).toBe(true);
    expect(normalizeBody("short").truncated).toBe(false);
    expect(normalizeBody("").truncated).toBe(false);
  });

  test("an emoji makes stored length disagree with the cap, which is why the flag exists", () => {
    // slice() counts UTF-16 code units; SQLite's length() counts code points.
    // A body of astral characters stores fewer characters than the cap, so
    // `length(body) >= CAP` reads it as complete. It is not.
    const astral = "😀".repeat(MESSAGE_BODY_CAP);
    const { body, truncated } = normalizeBody(astral);
    expect(truncated).toBe(true);
    expect(body.length).toBe(MESSAGE_BODY_CAP);
    expect([...body].length).toBeLessThan(MESSAGE_BODY_CAP);
  });

  test("the cap never splits a character", () => {
    // Constructed so the cap lands exactly between the halves of a pair —
    // the case a plain slice gets wrong, producing text that does not
    // round-trip through UTF-8. The live corpus avoided this by luck.
    const splitting = `${"a".repeat(MESSAGE_BODY_CAP - 1)}\u{1F600}tail`;
    expect(splitting.slice(0, MESSAGE_BODY_CAP).charCodeAt(MESSAGE_BODY_CAP - 1)).toBeGreaterThanOrEqual(0xd800);
    const { body, truncated } = normalizeBody(splitting);
    expect(truncated).toBe(true);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
  });

  test("bodies are capped", () => {
    expect(normalizeBody("x".repeat(MESSAGE_BODY_CAP + 500)).body).toHaveLength(MESSAGE_BODY_CAP);
  });
});

describe("Codex session identity", () => {
  test("comes from the filename, not the inherited session_meta id", () => {
    // A forked or resumed Codex thread carries its parent's session_id in
    // session_meta. In the live store 527 rows shared one, a single value
    // covered 184 files, and 26% of rollouts disagreed with their own
    // filename. Publishing that as `session_id` hands an agent an id that
    // resumes a different conversation.
    const path =
      "/Users/x/.codex/sessions/2026/08/02/rollout-2026-08-02T21-24-26-019fc538-de47-7012-87dd-31ca0fe9890a.jsonl";
    const inherited = "01a05008-e4a1-7ec3-bf57-9a8d7f32875c";
    const rollout = [
      JSON.stringify({
        timestamp: "2026-08-02T21:24:26.000Z",
        type: "session_meta",
        payload: { session_id: inherited, cwd: "/w", thread_source: "user" },
      }),
      JSON.stringify({
        timestamp: "2026-08-02T21:24:30.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      }),
    ].join("\n");
    const parsed = parseCodex(rollout, path);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe("019fc538-de47-7012-87dd-31ca0fe9890a");
    expect(parsed!.sessionId).not.toBe(inherited);
    // And the id we publish is the one resume derives from the path.
    expect(deriveSessionId("codex", path)).toBe(parsed!.sessionId);
  });
});

describe("the index does not index itself", () => {
  const call = (id: string, cmd: string) =>
    JSON.stringify({
      type: "assistant", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/w",
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] },
    });
  const result = (id: string, text: string) =>
    JSON.stringify({
      type: "user", timestamp: "2026-09-01T00:00:01.000Z", cwd: "/w",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    });

  test("a recorded search and its output are both skipped", () => {
    // A saved search result holds the query terms at maximum density with no
    // dilution — bm25's ideal document — so it wins the very query that
    // produced it. Measured before this rule: 26.8% of rank-one hits were
    // this tool's own output.
    const transcript = [
      call("t1", 'agentchats search "handoff-import" --json --limit 5'),
      result("t1", '{"query":"handoff-import","hits":[{"source_path":"/x.jsonl","line":3}]}'),
      call("t2", "rg handoff-import src/"),
      result("t2", "src/handoff.ts:12: handoff-import"),
    ].join("\n");
    const parsed = parseClaude(transcript, "/Users/x/.claude/projects/p/s.jsonl");
    expect(parsed).not.toBeNull();
    const bodies = parsed!.messages.map((m) => m.body);
    expect(bodies.some((b) => b.includes("agentchats search"))).toBe(false);
    expect(bodies.some((b) => b.includes('"hits"'))).toBe(false);
    // An unrelated tool call in the same session is untouched.
    expect(bodies.some((b) => b.includes("rg handoff-import"))).toBe(true);
    expect(bodies.some((b) => b.includes("src/handoff.ts"))).toBe(true);
  });

  test("a command after a line break and its output are skipped in both formats", () => {
    const command = 'echo ready\nagentchats search "handoff-import" --json';
    const claude = parseClaude(
      [
        call("t1", command),
        result("t1", '{"hits":[{"snippet":"handoff-import"}]}'),
        call("t2", "echo unrelated"),
        result("t2", "unrelated output"),
      ].join("\n"),
      "/Users/x/.claude/projects/p/s.jsonl",
    );
    expect(claude).not.toBeNull();
    expect(claude!.messages.map((message) => message.body)).toEqual([
      'Bash {"command":"echo unrelated"}',
      "unrelated output",
    ]);

    const codexRecord = (payload: Record<string, unknown>) =>
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-09-01T00:00:00.000Z",
        payload,
      });
    const codex = parseCodex(
      [
        codexRecord({
          type: "function_call",
          call_id: "c1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command }),
        }),
        codexRecord({ type: "function_call_output", call_id: "c1", output: "handoff-import" }),
        codexRecord({
          type: "function_call",
          call_id: "c2",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "echo unrelated" }),
        }),
        codexRecord({ type: "function_call_output", call_id: "c2", output: "unrelated output" }),
      ].join("\n"),
      "/Users/x/.codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-019fc538-de47-7012-87dd-31ca0fe9890a.jsonl",
    );
    expect(codex).not.toBeNull();
    expect(codex!.messages.map((message) => message.body)).toEqual([
      'exec_command {"cmd":"echo unrelated"}',
      "unrelated output",
    ]);
  });

  test("prose about the tool is still indexed", () => {
    // Only an invocation is dropped. A conversation discussing agentchats is
    // exactly the history someone will search for later.
    const transcript = JSON.stringify({
      type: "user", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/w",
      message: { role: "user", content: "should agentchats index the archive too?" },
    });
    const parsed = parseClaude(transcript, "/Users/x/.claude/projects/p/s.jsonl");
    expect(parsed!.messages[0]!.body).toContain("agentchats index the archive");
  });
});
