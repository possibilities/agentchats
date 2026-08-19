import { describe, expect, test } from "bun:test";
import {
  buildResumeDirective,
  DIRECTIVE_SCHEMA_VERSION,
  directiveLine,
  assertHostedStdout,
} from "../src/tui/directive.ts";

const TARGET = {
  kind: "claude" as const,
  sessionId: "d65ef6c1-8d74-4b1e-989e-d439bd432b9a",
  cwd: "/Users/op/code/alpha",
};

describe("buildResumeDirective", () => {
  test("speaks schema_version 1 with exactly the schema's keys", () => {
    const directive = buildResumeDirective(TARGET, {
      query: "queue fix",
      source_path: "/store/session.jsonl",
    });
    expect(Object.keys(directive).sort()).toEqual([
      "agent",
      "cwd",
      "focus",
      "intent",
      "record",
      "schema_version",
      "worktree",
    ]);
    expect(directive.schema_version).toBe(DIRECTIVE_SCHEMA_VERSION);
    expect(Object.keys(directive.agent).sort()).toEqual(["args", "kind"]);
  });

  test("resumes in the session's own workspace, never a fresh worktree", () => {
    const directive = buildResumeDirective(TARGET, { query: "", source_path: "/s.jsonl" });
    expect(directive.cwd).toBe("/Users/op/code/alpha");
    expect(directive.worktree).toBe(false);
    expect(directive.focus).toBe(true);
  });

  test("args are the shim's --x-resume spelling and nothing else", () => {
    const directive = buildResumeDirective(TARGET, { query: "", source_path: "/s.jsonl" });
    expect(directive.agent.kind).toBe("claude");
    expect(directive.agent.args).toEqual(["--x-resume", TARGET.sessionId]);
  });

  test("carries no intent and no model or effort anywhere: continuity is the harness's", () => {
    const directive = buildResumeDirective(TARGET, { query: "q", source_path: "/s.jsonl" });
    expect(directive.intent).toBeNull();
    const serialized = JSON.stringify(directive);
    expect(serialized).not.toContain("model");
    expect(serialized).not.toContain("effort");
  });

  test("one directive is one newline-terminated JSON line", () => {
    const line = directiveLine(buildResumeDirective(TARGET, { query: "", source_path: "/s" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line).cwd).toBe("/Users/op/code/alpha");
  });
});

describe("assertHostedStdout", () => {
  test("a terminal stdout refuses, naming the host invocation", () => {
    const refusal = assertHostedStdout({ isTTY: true });
    expect(refusal).toContain("agentsurface host -- agentchats search");
  });

  test("a pipe is a host", () => {
    expect(assertHostedStdout({ isTTY: undefined })).toBeNull();
    expect(assertHostedStdout({ isTTY: false })).toBeNull();
  });
});

describe("against the published schema", () => {
  test("matches agentsurface/directive.schema.json when the checkout is present", async () => {
    const schemaFile = Bun.file(
      `${process.env["HOME"]}/code/agentsurface/directive.schema.json`,
    );
    if (!(await schemaFile.exists())) return;
    const schema = (await schemaFile.json()) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const directive = buildResumeDirective(TARGET, { query: "q", source_path: "/s.jsonl" });
    for (const key of schema.required) {
      expect(Object.keys(directive)).toContain(key);
    }
    for (const key of Object.keys(directive)) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });
});
