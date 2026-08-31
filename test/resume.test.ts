import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../src/tui/cass.ts";
import { deriveSessionId, resumeKind, resumeTarget } from "../src/tui/resume.ts";

const CLAUDE_PATH =
  "/Users/op/.claude/projects/-Users-op-code-alpha/d65ef6c1-8d74-4b1e-989e-d439bd432b9a.jsonl";
const CODEX_PATH =
  "/Users/op/.codex/sessions/2026/08/12/rollout-2026-08-12T02-54-55-019ff4c0-abcd-7ca1-afab-3a580f454840.jsonl";

function row(overrides: Partial<SessionRow>): SessionRow {
  return {
    agent: "claude_code",
    workspace: "/Users/op/code/alpha",
    path: CLAUDE_PATH,
    title: "fix the queue",
    when: "2026-08-12 02:54",
    snippet: null,
    line: null,
    slug: null,
    excerpt: null,
    ...overrides,
  };
}

const ALL_TRUE = { fileExists: () => true, directoryExists: () => true };

describe("resumeKind", () => {
  test("maps the resumable connectors to herdr kinds", () => {
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

describe("resumeTarget", () => {
  test("a healthy claude session resumes in its workspace", () => {
    const outcome = resumeTarget(row({}), ALL_TRUE);
    expect(outcome).toEqual({
      ok: true,
      target: {
        kind: "claude",
        sessionId: "d65ef6c1-8d74-4b1e-989e-d439bd432b9a",
        cwd: "/Users/op/code/alpha",
      },
    });
  });

  test("a non-resumable connector is fatal with the connector named", () => {
    const outcome = resumeTarget(row({ agent: "cursor" }), ALL_TRUE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("cursor");
  });

  test("an underivable session id is fatal", () => {
    const outcome = resumeTarget(row({ path: "/somewhere/notes.txt" }), ALL_TRUE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("no native session id");
  });

  test("a session file gone from the store is fatal and names the index", () => {
    const outcome = resumeTarget(row({}), { ...ALL_TRUE, fileExists: () => false });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("cass index");
  });

  test("a vanished workspace is fatal", () => {
    const outcome = resumeTarget(row({}), { ...ALL_TRUE, directoryExists: () => false });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("/Users/op/code/alpha");
  });

  test("an unrecorded workspace is fatal", () => {
    const outcome = resumeTarget(row({ workspace: "" }), ALL_TRUE);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("workspace");
  });
});
