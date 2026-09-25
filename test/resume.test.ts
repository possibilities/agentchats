import { describe, expect, test } from "bun:test";
import { deriveSessionId, resumeKind } from "../src/tui/resume.ts";

const CLAUDE_PATH =
  "/Users/op/.claude/projects/-Users-op-code-alpha/d65ef6c1-8d74-4b1e-989e-d439bd432b9a.jsonl";
const CODEX_PATH =
  "/Users/op/.codex/sessions/2026/08/12/rollout-2026-08-12T02-54-55-019ff4c0-abcd-7ca1-afab-3a580f454840.jsonl";

describe("resumeKind", () => {
  test("maps indexed connectors to native harnesses", () => {
    expect(resumeKind("claude_code")).toBe("claude");
    expect(resumeKind("codex")).toBe("codex");
  });

  test("every other connector is not resumable", () => {
    expect(resumeKind("cursor")).toBeNull();
    expect(resumeKind("gemini")).toBeNull();
    expect(resumeKind("pilot")).toBeNull();
    expect(resumeKind("")).toBeNull();
  });
});

describe("deriveSessionId", () => {
  test("claude: the file basename is the id", () => {
    expect(deriveSessionId("claude", CLAUDE_PATH)).toBe("d65ef6c1-8d74-4b1e-989e-d439bd432b9a");
  });

  test("codex: the trailing uuid of the rollout name", () => {
    expect(deriveSessionId("codex", CODEX_PATH)).toBe("019ff4c0-abcd-7ca1-afab-3a580f454840");
    expect(deriveSessionId("codex", `${CODEX_PATH}.zst`)).toBe(
      "019ff4c0-abcd-7ca1-afab-3a580f454840",
    );
  });

  test("an alien layout derives nothing", () => {
    expect(deriveSessionId("claude", "/somewhere/notes.txt")).toBeNull();
    expect(deriveSessionId("codex", "/somewhere/rollout.jsonl")).toBeNull();
  });
});
