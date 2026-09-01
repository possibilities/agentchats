import { afterAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanTurns, parseClaude } from "../src/parse/claude.ts";
import {
  classifySession,
  parseCodex,
  readRollout,
  rolloutMetadata,
  rolloutThreadSource,
} from "../src/parse/codex.ts";
import type { ParsedSession } from "../src/parse/types.ts";

const CLAUDE_PATH =
  "/Users/op/.claude/projects/-Users-op-code-alpha/d65ef6c1-8d74-4b1e-989e-d439bd432b9a.jsonl";
const CODEX_PATH =
  "/Users/op/.codex/sessions/2026/08/12/rollout-2026-08-12T02-54-55-019ff4c0-abcd-7ca1-afab-3a580f454840.jsonl";
const WS = "/Users/op/code/alpha";

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function claudeTurn(role: "user" | "assistant", content: unknown, ts: string): unknown {
  return { type: role, cwd: WS, timestamp: ts, message: { role, content } };
}

function codexItem(payload: unknown, ts: string): unknown {
  return { type: "response_item", timestamp: ts, payload };
}

/** The line a byte offset points at, read the way `view` would read it. */
function lineAt(source: string, byteOffset: number): string {
  return Buffer.from(source, "utf8").subarray(byteOffset).toString("utf8").split("\n")[0] ?? "";
}

describe("parseClaude", () => {
  test("tool results inside user records are output, not human turns", () => {
    const transcript = jsonl(
      claudeTurn("user", "fix the queue", "2026-08-12T02:54:55.000Z"),
      claudeTurn(
        "assistant",
        [
          { type: "thinking", thinking: "the drain is unbounded" },
          { type: "text", text: "Reading the worker." },
          { type: "tool_use", name: "Read", input: { file_path: "/queue.ts" } },
        ],
        "2026-08-12T02:55:01.000Z",
      ),
      claudeTurn(
        "user",
        [{ type: "tool_result", content: "export function drain() {}" }],
        "2026-08-12T02:55:02.000Z",
      ),
      claudeTurn("user", "now bound it", "2026-08-12T02:56:00.000Z"),
    );
    const session = parseClaude(transcript, CLAUDE_PATH) as ParsedSession;
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool_call",
      "tool_output",
      "user",
    ]);
    expect(humanTurns(session)).toBe(2);
    expect(session.messages[4]?.body).toBe("export function drain() {}");
  });

  test("a tool call keeps its name and its arguments", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn(
          "assistant",
          [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
          "2026-08-12T02:55:01.000Z",
        ),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.messages[0]?.body).toBe('Bash {"command":"bun test"}');
  });

  test("array tool results keep only their text blocks", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn(
          "user",
          [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "42 files" },
                { type: "image", source: { data: "AAAA" } },
                { type: "text", text: "3 skipped" },
              ],
            },
          ],
          "2026-08-12T02:55:02.000Z",
        ),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.messages[0]?.role).toBe("tool_output");
    expect(session.messages[0]?.body).toBe("42 files\n3 skipped");
    expect(humanTurns(session)).toBe(0);
  });

  test("the generated title beats the opening prompt, and the newest one wins", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn("user", "why is the queue slow", "2026-08-12T02:54:55.000Z"),
        { type: "ai-title", aiTitle: "Investigate queue latency", sessionId: "d65ef6c1" },
        claudeTurn("assistant", "Because the drain is unbounded.", "2026-08-12T02:55:01.000Z"),
        { type: "ai-title", aiTitle: "Bound the queue drain", sessionId: "d65ef6c1" },
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.title).toBe("Bound the queue drain");
  });

  test("without a generated title the first human turn is the excerpt", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn(
          "user",
          [{ type: "tool_result", content: "a resumed session opens with output" }],
          "2026-08-12T02:54:55.000Z",
        ),
        claudeTurn("user", `  why is the queue\n  slow ${"x".repeat(200)}`, "2026-08-12T02:55:00.000Z"),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.title.startsWith("why is the queue slow xxx")).toBe(true);
    expect(session.title.length).toBe(120);
  });

  test("the title looks past the wrappers the harness types for the user", () => {
    const command =
      "<command-message>collab</command-message> <command-name>/collab</command-name>";
    const caveat =
      "<local-command-caveat>Caveat: The messages below were generated while running local commands.</local-command-caveat>";
    const brief = '<teammate-message teammate_id="team-lead" summary="Build parsers"> Work ONLY in /code/alpha.';
    const session = parseClaude(
      jsonl(
        claudeTurn("user", command, "2026-08-12T02:54:55.000Z"),
        claudeTurn("user", caveat, "2026-08-12T02:54:56.000Z"),
        claudeTurn("user", brief, "2026-08-12T02:54:57.000Z"),
        claudeTurn("user", "<system-reminder>the plan mode is on</system-reminder>", "2026-08-12T02:54:58.000Z"),
        claudeTurn("user", "Caveat: this session was resumed", "2026-08-12T02:54:59.000Z"),
        claudeTurn("user", "why is the queue slow", "2026-08-12T02:55:00.000Z"),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.title).toBe("why is the queue slow");
    // Every wrapper is still indexed — a lead's brief is often exactly what a
    // search is looking for.
    expect(session.messages).toHaveLength(6);
    expect(humanTurns(session)).toBe(6);
  });

  test("a session that never got past its wrapper keeps it as the title", () => {
    const brief = '<teammate-message teammate_id="team-lead"> Audit the queue.';
    const session = parseClaude(
      jsonl(
        claudeTurn("user", brief, "2026-08-12T02:54:55.000Z"),
        claudeTurn("assistant", "On it.", "2026-08-12T02:55:00.000Z"),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.title.startsWith("<teammate-message")).toBe(true);
  });

  test("a generated title still beats every wrapper and prompt", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn("user", "<command-message>collab</command-message>", "2026-08-12T02:54:55.000Z"),
        claudeTurn("user", "why is the queue slow", "2026-08-12T02:55:00.000Z"),
        { type: "ai-title", aiTitle: "Bound the queue drain", sessionId: "d65ef6c1" },
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.title).toBe("Bound the queue drain");
  });

  test("session identity comes from the file name, workspace from the records", () => {
    const session = parseClaude(
      jsonl(claudeTurn("user", "hello", "2026-08-12T02:54:55.000Z")),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.agent).toBe("claude_code");
    expect(session.sessionId).toBe("d65ef6c1-8d74-4b1e-989e-d439bd432b9a");
    expect(session.sourcePath).toBe(CLAUDE_PATH);
    expect(session.workspace).toBe(WS);
    expect(session.threadSource).toBeNull();
    expect(session.originator).toBeNull();
  });

  test("timestamps bracket the indexed messages", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn("user", "first", "2026-08-12T02:54:55.000Z"),
        claudeTurn("assistant", "second", "2026-08-12T03:10:00.000Z"),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.createdAt).toBe("2026-08-12T02:54:55.000Z");
    expect(session.updatedAt).toBe("2026-08-12T03:10:00.000Z");
  });

  test("harness bookkeeping carries no content", () => {
    const transcript = jsonl(
      { type: "mode", mode: "acceptEdits" },
      { type: "file-history-snapshot", snapshot: { files: ["/queue.ts"] } },
      { type: "queue-operation", operation: "enqueue" },
      { type: "system", content: "a long system notice nobody typed" },
      { type: "attachment", attachment: { text: "pasted" } },
      { type: "last-prompt", prompt: "fix the queue" },
    );
    expect(parseClaude(transcript, CLAUDE_PATH)).toBeNull();
  });

  test("an empty transcript is a skip, not an error", () => {
    expect(parseClaude("", CLAUDE_PATH)).toBeNull();
    expect(parseClaude("\n\n\n", CLAUDE_PATH)).toBeNull();
  });

  test("blank bodies never reach the index", () => {
    const session = parseClaude(
      jsonl(
        claudeTurn("user", "   \n\t ", "2026-08-12T02:54:55.000Z"),
        claudeTurn("assistant", [{ type: "text", text: "" }], "2026-08-12T02:55:00.000Z"),
        claudeTurn("assistant", "real", "2026-08-12T02:55:10.000Z"),
      ),
      CLAUDE_PATH,
    ) as ParsedSession;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.ordinal).toBe(0);
  });
});

describe("parseCodex", () => {
  test("event_msg mirrors response_item and must not be counted twice", () => {
    const transcript = jsonl(
      { type: "session_meta", timestamp: "2026-08-12T02:54:50.000Z", payload: { session_id: "019ff4c0", cwd: WS } },
      { type: "turn_context", payload: { cwd: WS } },
      codexItem(
        { type: "message", role: "user", content: [{ type: "input_text", text: "fix the queue" }] },
        "2026-08-12T02:54:55.000Z",
      ),
      { type: "event_msg", timestamp: "2026-08-12T02:54:55.000Z", payload: { type: "user_message", message: "fix the queue" } },
      codexItem(
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Bounding the drain." }] },
        "2026-08-12T02:55:00.000Z",
      ),
      { type: "event_msg", timestamp: "2026-08-12T02:55:00.000Z", payload: { type: "agent_message", message: "Bounding the drain." } },
      { type: "world_state", payload: {} },
      { type: "compacted", payload: { message: "summary" } },
    );
    const session = parseCodex(transcript, CODEX_PATH) as ParsedSession;
    expect(session.messages.map((message) => message.body)).toEqual([
      "fix the queue",
      "Bounding the drain.",
    ]);
    expect(humanTurns(session)).toBe(1);
  });

  test("developer and system turns are instructions, not human turns", () => {
    const session = parseCodex(
      jsonl(
        codexItem(
          { type: "message", role: "developer", content: [{ type: "input_text", text: "always run bun test" }] },
          "2026-08-12T02:54:51.000Z",
        ),
        codexItem(
          { type: "message", role: "system", content: [{ type: "input_text", text: "you are codex" }] },
          "2026-08-12T02:54:52.000Z",
        ),
        codexItem(
          { type: "message", role: "user", content: [{ type: "input_text", text: "fix the queue" }] },
          "2026-08-12T02:54:55.000Z",
        ),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(session.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
    expect(humanTurns(session)).toBe(1);
  });

  test("tool call output arrives as a plain string, an array, or an envelope", () => {
    const session = parseCodex(
      jsonl(
        codexItem({ type: "custom_tool_call", name: "shell", input: '{"command":"bun test"}' }, "2026-08-12T02:55:00.000Z"),
        codexItem({ type: "custom_tool_call_output", call_id: "c1", output: "12 pass 0 fail" }, "2026-08-12T02:55:02.000Z"),
        codexItem({ type: "function_call", name: "apply_patch", arguments: '{"path":"/queue.ts"}' }, "2026-08-12T02:55:03.000Z"),
        codexItem(
          {
            type: "function_call_output",
            call_id: "c2",
            output: [
              { type: "input_text", text: "Script completed" },
              { type: "input_text", text: "Wall time 0.1 seconds" },
            ],
          },
          "2026-08-12T02:55:04.000Z",
        ),
        codexItem({ type: "custom_tool_call_output", call_id: "c3", output: { content: "legacy envelope" } }, "2026-08-12T02:55:05.000Z"),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(session.messages.map((message) => message.role)).toEqual([
      "tool_call",
      "tool_output",
      "tool_call",
      "tool_output",
      "tool_output",
    ]);
    expect(session.messages.map((message) => message.body)).toEqual([
      'shell {"command":"bun test"}',
      "12 pass 0 fail",
      'apply_patch {"path":"/queue.ts"}',
      "Script completed\nWall time 0.1 seconds",
      "legacy envelope",
    ]);
  });

  test("reasoning keeps the summary and the trace, never the ciphertext", () => {
    const session = parseCodex(
      jsonl(
        codexItem(
          {
            type: "reasoning",
            encrypted_content: "gAAAAABn-not-searchable",
            summary: [{ type: "summary_text", text: "The drain is unbounded." }],
            content: [{ type: "reasoning_text", text: "So each poll refills it." }],
          },
          "2026-08-12T02:55:00.000Z",
        ),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(session.messages[0]?.role).toBe("reasoning");
    expect(session.messages[0]?.body).toBe("The drain is unbounded.\nSo each poll refills it.");
  });

  test("session metadata rides on the parsed session", () => {
    const session = parseCodex(
      jsonl(
        {
          type: "session_meta",
          timestamp: "2026-08-12T02:54:50.000Z",
          payload: { session_id: "019ff4c0-abcd-7ca1-afab-3a580f454840", cwd: WS, originator: "agentvoice", thread_source: "worker" },
        },
        codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }, "2026-08-12T02:54:55.000Z"),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(session.agent).toBe("codex");
    expect(session.sessionId).toBe("019ff4c0-abcd-7ca1-afab-3a580f454840");
    expect(session.workspace).toBe(WS);
    expect(session.originator).toBe("agentvoice");
    expect(session.threadSource).toBe("worker");
  });

  test("a rollout with no metadata falls back to the filename uuid", () => {
    const session = parseCodex(
      jsonl(codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }, "")),
      `${CODEX_PATH}.zst`,
    ) as ParsedSession;
    expect(session.sessionId).toBe("019ff4c0-abcd-7ca1-afab-3a580f454840");
    expect(session.workspace).toBe("");
    expect(session.createdAt).toBe("");
  });

  test("the title looks past the preamble the harness types for the user", () => {
    const preamble = "<recommended_plugins>\nHere is a list of plugins that are available.\n</recommended_plugins>";
    const withHuman = parseCodex(
      jsonl(
        codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: preamble }] }, "2026-08-12T02:54:55.000Z"),
        codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "fix the queue" }] }, "2026-08-12T02:55:00.000Z"),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(withHuman.title).toBe("fix the queue");
    // The preamble is still indexed — it is only a poor name.
    expect(withHuman.messages).toHaveLength(2);

    const bare = parseCodex(
      jsonl(
        codexItem(
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions for /code/alpha\n\nRun bun test." }],
          },
          "2026-08-12T02:54:55.000Z",
        ),
        codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "fix the queue" }] }, "2026-08-12T02:55:00.000Z"),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(bare.title).toBe("fix the queue");

    const preambleOnly = parseCodex(
      jsonl(codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: preamble }] }, "2026-08-12T02:54:55.000Z")),
      CODEX_PATH,
    ) as ParsedSession;
    expect(preambleOnly.title.startsWith("<recommended_plugins>")).toBe(true);
  });

  test("an empty rollout is a skip, not an error", () => {
    expect(parseCodex("", CODEX_PATH)).toBeNull();
    expect(
      parseCodex(jsonl({ type: "session_meta", payload: { session_id: "019ff4c0", cwd: WS } }), CODEX_PATH),
    ).toBeNull();
  });
});

describe("citations", () => {
  const transcript = jsonl(
    { type: "mode", mode: "acceptEdits" },
    claudeTurn("user", "does the café queue drain", "2026-08-12T02:54:55.000Z"),
    { type: "system", content: "ignored" },
    claudeTurn(
      "assistant",
      [
        { type: "text", text: "Not while it refills." },
        { type: "tool_use", name: "Read", input: { file_path: "/queue.ts" } },
      ],
      "2026-08-12T02:55:00.000Z",
    ),
  );

  test("line numbers are 1-based over every line, content or not", () => {
    const session = parseClaude(transcript, CLAUDE_PATH) as ParsedSession;
    expect(session.messages.map((message) => message.line)).toEqual([2, 4, 4]);
    expect(session.messages.map((message) => message.ordinal)).toEqual([0, 1, 2]);
  });

  test("a byte offset seeks to the record's own first byte, past multibyte text", () => {
    const session = parseClaude(transcript, CLAUDE_PATH) as ParsedSession;
    const lines = transcript.split("\n");
    for (const message of session.messages) {
      expect(lineAt(transcript, message.byteOffset)).toBe(lines[message.line - 1] ?? "");
    }
    // "café" is one byte wider than it is long, so every offset after it
    // outruns the character index — a character offset would land one byte
    // short, inside the previous record's newline.
    const [, second] = session.messages;
    const target = lines[(second?.line ?? 1) - 1] ?? "";
    expect(second?.byteOffset).toBe(transcript.indexOf(target) + 1);
    expect(JSON.parse(lineAt(transcript, second?.byteOffset ?? 0)).type).toBe("assistant");
  });

  test("codex offsets seek the same way", () => {
    const rollout = jsonl(
      { type: "session_meta", timestamp: "2026-08-12T02:54:50.000Z", payload: { session_id: "019ff4c0", cwd: WS } },
      codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "où est la café" }] }, "2026-08-12T02:54:55.000Z"),
      { type: "event_msg", payload: { type: "user_message", message: "où est la café" } },
      codexItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "ici" }] }, "2026-08-12T02:55:00.000Z"),
    );
    const session = parseCodex(rollout, CODEX_PATH) as ParsedSession;
    const lines = rollout.split("\n");
    expect(session.messages.map((message) => message.line)).toEqual([2, 4]);
    for (const message of session.messages) {
      expect(lineAt(rollout, message.byteOffset)).toBe(lines[message.line - 1] ?? "");
    }
  });
});

describe("malformed input", () => {
  test("a truncated final line is skipped and the rest survives", () => {
    const transcript = `${jsonl(
      claudeTurn("user", "fix the queue", "2026-08-12T02:54:55.000Z"),
      claudeTurn("assistant", "on it", "2026-08-12T02:55:00.000Z"),
    )}{"type":"user","cwd":"${WS}","message":{"role":"user","cont`;
    const session = parseClaude(transcript, CLAUDE_PATH) as ParsedSession;
    expect(session.messages).toHaveLength(2);
    expect(humanTurns(session)).toBe(1);
  });

  test("a bad line in the middle costs only that line, and offsets stay true", () => {
    const rollout = [
      JSON.stringify({ type: "session_meta", payload: { session_id: "019ff4c0", cwd: WS } }),
      "{not json at all",
      JSON.stringify(codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "still here" }] }, "2026-08-12T02:54:55.000Z")),
      "",
      JSON.stringify(codexItem({ type: "message", role: "assistant", content: [{ type: "output_text", text: "so am i" }] }, "2026-08-12T02:55:00.000Z")),
    ].join("\n");
    const session = parseCodex(rollout, CODEX_PATH) as ParsedSession;
    expect(session.messages.map((message) => message.line)).toEqual([3, 5]);
    const lines = rollout.split("\n");
    for (const message of session.messages) {
      expect(lineAt(rollout, message.byteOffset)).toBe(lines[message.line - 1] ?? "");
    }
  });

  test("a record that is not an object at all is skipped", () => {
    expect(parseClaude('"just a string"\n42\nnull\n[]\n', CLAUDE_PATH)).toBeNull();
    expect(parseCodex('"just a string"\n42\nnull\n[]\n', CODEX_PATH)).toBeNull();
  });
});

describe("rollout metadata and classification", () => {
  function meta(threadSource: string | null, originator?: string): string {
    const payload: Record<string, string> = { session_id: "019ff4c0", cwd: WS };
    if (threadSource !== null) payload["thread_source"] = threadSource;
    if (originator !== undefined) payload["originator"] = originator;
    return jsonl({ type: "session_meta", payload }, { type: "response_item", payload: { role: "user" } });
  }

  test("the thread source decides, and `user` always wins", () => {
    expect(rolloutThreadSource(meta("user"))).toBe("user");
    expect(classifySession(rolloutMetadata(meta("user")))).toBe("full-harness");
    expect(classifySession(rolloutMetadata(meta("user")), new Set(["agentvoice"]))).toBe(
      "full-harness",
    );
  });

  test("any other explicit source is auxiliary", () => {
    expect(rolloutThreadSource(meta("worker"))).toBe("worker");
    expect(classifySession(rolloutMetadata(meta("worker")))).toBe("auxiliary");
    expect(classifySession(rolloutMetadata(meta("compaction")))).toBe("auxiliary");
  });

  test("legacy metadata with no source is judged by its originator alone", () => {
    expect(rolloutThreadSource(meta(null, "agentvoice"))).toBeNull();
    expect(classifySession(rolloutMetadata(meta(null, "agentvoice")))).toBe("full-harness");
    expect(classifySession(rolloutMetadata(meta(null, "agentvoice")), new Set(["agentvoice"]))).toBe(
      "auxiliary",
    );
    expect(classifySession(rolloutMetadata(meta(null, "codex_cli_rs")), new Set(["agentvoice"]))).toBe(
      "full-harness",
    );
  });

  test("unreadable metadata fails open to unknown, not to auxiliary", () => {
    expect(rolloutMetadata("")).toBeUndefined();
    expect(rolloutMetadata('{"type":"response_item","payload":{}}\n')).toBeUndefined();
    expect(rolloutThreadSource("{not json")).toBeUndefined();
    expect(classifySession(undefined)).toBe("unknown");
  });

  test("a parsed session classifies without reopening the file", () => {
    const session = parseCodex(
      jsonl(
        { type: "session_meta", payload: { session_id: "019ff4c0", cwd: WS, thread_source: "worker" } },
        codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }, ""),
      ),
      CODEX_PATH,
    ) as ParsedSession;
    expect(classifySession(session)).toBe("auxiliary");
  });
});

describe("readRollout", () => {
  const temp = mkdtempSync(join(tmpdir(), "agentchats-parse-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  const rollout = jsonl(
    { type: "session_meta", payload: { session_id: "019ff4c0", cwd: WS } },
    codexItem({ type: "message", role: "user", content: [{ type: "input_text", text: "fix the café queue" }] }, "2026-08-12T02:54:55.000Z"),
  );

  test("a compressed rollout parses to exactly what the plain one does", async () => {
    const plain = join(temp, "rollout-2026-08-12T02-54-55-019ff4c0-abcd-7ca1-afab-3a580f454840.jsonl");
    const packed = `${plain}.zst`;
    await Bun.write(plain, rollout);
    await Bun.write(packed, await Bun.zstdCompress(Buffer.from(rollout, "utf8")));
    expect(await readRollout(plain)).toBe(rollout);
    expect(await readRollout(packed)).toBe(rollout);
    expect(parseCodex(await readRollout(packed), packed)?.messages).toEqual(
      parseCodex(rollout, packed)?.messages ?? [],
    );
  });
});
