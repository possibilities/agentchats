/**
 * The Claude Code transcript reader: one JSON record per line under
 * ~/.claude/projects/<slug>/<uuid>.jsonl, appended while the session runs.
 *
 * Only records typed "user" or "assistant" carry content. Every other type —
 * mode, permission-mode, bridge-session, file-history-*, last-prompt,
 * queue-operation, attachment, system, result, atis-latch — is harness
 * bookkeeping the index has no use for, and new ones appear without warning,
 * so the reader names what it wants rather than what it skips.
 *
 * The trap this file exists to avoid: tool results arrive inside records
 * typed "user". They are the transcript's largest role by far, and counting
 * them as human turns would misreport how much of every session a person
 * actually drove. Roles come from the content block, not the record.
 */

import { Buffer } from "node:buffer";
import { isSelfInvocation } from "./self-invocation.ts";
import {
  normalizeBody,
  type ParsedMessage,
  type ParsedSession,
  type Parser,
  type Role,
} from "./types.ts";

/** A title rides in one picker row; past this it is truncated anyway. */
const TITLE_CAP = 120;

/** Claude Code's first user record is as often a harness wrapper as anything
 * a person typed: a slash command's expansion, a resumed session's caveat, a
 * brief from a team lead, a hook's output. 361 of the 1555 sessions in the
 * local store opened with one, naming a quarter of the picker after the
 * harness rather than after the work; looking past them moves 165 of those
 * to a real prompt. The ~200 left are subagent sessions whose only human
 * turn is the brief, and the brief names them better than nothing does. The
 * index still holds every wrapper — what is inside a teammate message is
 * often exactly what a search is looking for; only the title skips them. */
const HARNESS_PREAMBLES = [
  "<command-message>",
  "<command-name>",
  "<local-command-caveat>",
  // A slash command's own output, which the harness replays as a user turn.
  "<local-command-stdout>",
  "<task-notification>",
  "<teammate-message",
  "<system-reminder>",
  "<user-prompt-submit-hook>",
  // The same caveat, injected without its tag.
  "Caveat:",
  // A skill invocation's injected header, which follows the command tags in
  // the same turn on newer harnesses and stands alone on older ones.
  "Base directory for this skill:",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Titles are single-line, so newlines and indentation are noise. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** claude stores the session under the file's own name, and that stem is the
 * id `claude --resume` takes. */
function sessionIdFromPath(sourcePath: string): string {
  const base = sourcePath.split("/").pop() ?? "";
  return base.endsWith(".jsonl") ? base.slice(0, -6) : base;
}

/** A tool result's content is usually the raw string a tool printed; the
 * array form is the block shape the API accepts, of which only text blocks
 * hold anything an index can search. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block === null || block["type"] !== "text") continue;
    parts.push(asString(block["text"]));
  }
  return parts.join("\n");
}

interface Candidate {
  role: Role;
  body: string;
}

/**
 * One content block becomes one message. A single assistant record can hold
 * a thought, a sentence and three tool calls; collapsing them would blur
 * which of the five a search actually hit, and the thinking would drown the
 * prose it was reasoning toward.
 */
/**
 * A command that runs this tool, or the one it replaced. Their output is the
 * index describing itself: a recorded search result contains the query terms
 * at maximum density and no dilution, which is bm25's ideal document, so it
 * wins the very query that produced it. Measured before this: 26.8% of
 * rank-one hits were the tool's own output — searching `handoff-import`
 * returned the saved output of a previous search for `handoff-import`.
 *
 * A subcommand is required, so a sentence discussing agentchats is not
 * mistaken for an invocation of it.
 */
function blockCandidate(
  block: Record<string, unknown>,
  recordRole: Role,
  selfCalls: Set<string>,
): Candidate | null {
  switch (block["type"]) {
    case "text":
      return { role: recordRole, body: asString(block["text"]) };
    case "thinking":
      return { role: "thinking", body: asString(block["thinking"]) };
    case "tool_use": {
      const input = block["input"];
      const rendered = input === undefined ? "" : (JSON.stringify(input) ?? "");
      const body = `${asString(block["name"])} ${rendered}`;
      if (isSelfInvocation(body, input)) {
        selfCalls.add(asString(block["id"]));
        return null;
      }
      return { role: "tool_call", body };
    }
    case "tool_result":
      if (selfCalls.has(asString(block["tool_use_id"]))) return null;
      return { role: "tool_output", body: toolResultText(block["content"]) };
    default:
      return null;
  }
}

/** `message.content` is a bare string for a plain turn and a block array for
 * everything richer. */
function candidates(content: unknown, recordRole: Role, selfCalls: Set<string>): Candidate[] {
  if (typeof content === "string") return [{ role: recordRole, body: content }];
  if (!Array.isArray(content)) return [];
  const found: Candidate[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block === null) continue;
    const candidate = blockCandidate(block, recordRole, selfCalls);
    if (candidate !== null) found.push(candidate);
  }
  return found;
}

export const parseClaude: Parser = (content, sourcePath) => {
  const messages: ParsedMessage[] = [];
  /** tool_use ids whose command runs this tool; their results are skipped. */
  const selfCalls = new Set<string>();
  let workspace = "";
  let aiTitle = "";
  let firstPrompt = "";
  let wrappedPrompt = "";
  let line = 0;
  let offset = 0;
  for (const raw of content.split("\n")) {
    line += 1;
    const byteOffset = offset;
    // The split ate one newline byte; the last line may not have had one,
    // but nothing is numbered after it either.
    offset += Buffer.byteLength(raw, "utf8") + 1;
    if (raw.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      // A session still being written ends in a half-flushed line. One bad
      // line is a skip, never the end of the file.
      continue;
    }
    const record = asRecord(entry);
    if (record === null) continue;
    const type = record["type"];
    if (type === "ai-title") {
      // The title is regenerated as a session grows, so the last one is the
      // one that describes what the session became.
      const title = collapse(asString(record["aiTitle"]));
      if (title !== "") aiTitle = title;
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const message = asRecord(record["message"]);
    if (message === null) continue;
    // The cwd a session opened in is the one the store filed it under, and
    // the one a resume has to land in; a later `cd` does not move it.
    if (workspace === "") workspace = asString(record["cwd"]);
    const ts = asString(record["timestamp"]);
    const recordRole: Role = type === "user" ? "user" : "assistant";
    for (const candidate of candidates(message["content"], recordRole, selfCalls)) {
      const { body, truncated } = normalizeBody(candidate.body);
      if (body === "") continue;
      if (candidate.role === "user") {
        const excerpt = collapse(body).slice(0, TITLE_CAP);
        if (HARNESS_PREAMBLES.some((prefix) => body.startsWith(prefix))) {
          if (wrappedPrompt === "") wrappedPrompt = excerpt;
        } else if (firstPrompt === "") {
          firstPrompt = excerpt;
        }
      }
      messages.push({ ordinal: messages.length, line, byteOffset, role: candidate.role, ts, body, truncated });
    }
  }
  if (messages.length === 0) return null;
  const stamps = messages.map((message) => message.ts).filter((ts) => ts !== "");
  return {
    agent: "claude_code",
    sessionId: sessionIdFromPath(sourcePath),
    sourcePath,
    workspace,
    // A generated title beats an excerpt of the opening prompt, which is as
    // often a pasted stack trace as a statement of intent. A session whose
    // every turn was a wrapper is still better named by that wrapper than
    // left untitled.
    title: aiTitle || firstPrompt || wrappedPrompt || "(untitled)",
    createdAt: stamps[0] ?? "",
    updatedAt: stamps[stamps.length - 1] ?? "",
    threadSource: null,
    originator: null,
    messages,
  };
};

/**
 * How much of a session a person actually drove. It lives beside the Claude
 * parser rather than beside the contract because types.ts is frozen and
 * because this is the number Claude's format is most able to get wrong: the
 * tool results hiding inside "user" records outnumber real prompts roughly
 * ten to one. src/parse/codex.ts re-exports it.
 */
export function humanTurns(session: ParsedSession): number {
  let count = 0;
  for (const message of session.messages) if (message.role === "user") count += 1;
  return count;
}
