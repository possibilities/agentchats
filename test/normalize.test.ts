import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MESSAGE_BODY_CAP, normalizeBody } from "../src/parse/types.ts";

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
    expect(tokenizesTo(normalizeBody(CITATION), "severity")).toBe(true);
  });

  test("invisible separators become spaces rather than vanishing", () => {
    // Deleting the marker would merge these into one unfindable token.
    expect(normalizeBody("alpha​beta")).toBe("alpha beta");
    expect(tokenizesTo(normalizeBody("alpha​beta"), "beta")).toBe(true);
  });

  test("zero width, bidi, soft hyphen, and BOM are all stripped", () => {
    for (const marker of ["​", "‎", "‭", "­", "﻿", "⁠", ""]) {
      expect(normalizeBody(`one${marker}two`)).toBe("one two");
    }
  });

  test("ordinary text and its interior newlines survive untouched", () => {
    expect(normalizeBody("  hello\nworld  ")).toBe("hello\nworld");
    expect(normalizeBody("C++ and café")).toBe("C++ and café");
  });

  test("empty and whitespace-only bodies normalize away", () => {
    expect(normalizeBody("   \n\t ")).toBe("");
    expect(normalizeBody("")).toBe("");
  });

  test("bodies are capped", () => {
    expect(normalizeBody("x".repeat(MESSAGE_BODY_CAP + 500))).toHaveLength(MESSAGE_BODY_CAP);
  });
});
