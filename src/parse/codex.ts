/**
 * The Codex rollout reader: ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl,
 * sometimes zstd-compressed, one JSON record per line.
 *
 * Only `response_item` records are read. A rollout also carries `event_msg`
 * records, which mirror the very same items for the UI and account for 54%
 * of the store's bytes — indexing both would count every message twice and
 * make each session look like two. `turn_context`, `world_state` and
 * `compacted` are harness state, not conversation.
 *
 * This file also owns rollout metadata and the auxiliary/full-harness
 * classification, which the picker used to derive by reading files: a rollout written by
 * some other producer (a worker, a voice bridge) is a real session on disk
 * but not one a human would ever want offered as "resume where I left off".
 */

import { Buffer } from "node:buffer";
import {
  normalizeBody,
  type ParsedMessage,
  type ParsedSession,
  type Parser,
  type Role,
} from "./types.ts";

export { humanTurns } from "./claude.ts";

/** A title rides in one picker row; past this it is truncated anyway. */
const TITLE_CAP = 120;

/** session_meta is the first record of a rollout, so classification never
 * needs more than the head of the file. */
const ROLLOUT_PREFIX_BYTES = 64 * 1024;

const NO_AUXILIARY_ORIGINATORS = new Set<string>();

/** The harness speaks first, in the user's voice: plugin inventories,
 * environment dumps and project instructions injected before the human types
 * anything. Two thirds of the rollouts on this machine open with one, so
 * taking the first user turn as the title would give hundreds of sessions
 * the same meaningless name. A title looks past them; the index never
 * discards them, since they are searchable content like any other. */
const HARNESS_PREAMBLES = [
  "<recommended_plugins>",
  "<environment_context>",
  "<user_instructions>",
  // Injected bare, without a wrapping tag, when a project has an AGENTS.md.
  "# AGENTS.md instructions for ",
];

const ROLLOUT_ID =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

export type SessionClass = "full-harness" | "auxiliary" | "unknown";

export interface RolloutMetadata {
  threadSource: string | null;
  originator: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The rollout filename carries the session id Codex resumes by, which is
 * the only source when a legacy rollout has no session_meta. */
function sessionIdFromPath(sourcePath: string): string {
  const base = sourcePath.split("/").pop() ?? "";
  const match = base.match(ROLLOUT_ID);
  if (match?.[1] !== undefined) return match[1];
  return base.replace(/\.jsonl(\.zst)?$/i, "");
}

/** Concatenate the `text` of a content array — the shape every Codex payload
 * uses for prose, whether the entries call themselves input_text or
 * output_text. */
function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    const block = asRecord(entry);
    if (block === null) continue;
    const text = asString(block["text"]);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

/** Tool output is a plain string for most tools and a content array for the
 * ones that return several chunks; the `{ content }` envelope is tolerated
 * because older rollouts are not worth proving absent. */
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return contentText(value);
  const record = asRecord(value);
  if (record === null) return "";
  const content = record["content"];
  return typeof content === "string" ? content : contentText(content);
}

/** Developer and system turns are the same thing to a reader: instructions
 * nobody typed. An unrecognized role joins them rather than being counted as
 * a human turn. */
function messageRole(role: unknown): Role {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

interface Candidate {
  role: Role;
  body: string;
}

function payloadCandidate(payload: Record<string, unknown>): Candidate | null {
  switch (payload["type"]) {
    case "message":
      return { role: messageRole(payload["role"]), body: contentText(payload["content"]) };
    case "reasoning": {
      // The summary is the visible thought; `content` is the fuller trace
      // when the model was asked to keep one. `encrypted_content` never is,
      // and on current rollouts it is all there is — 11,082 of 11,084
      // reasoning items in the local store carry an empty summary, so
      // reasoning contributes almost nothing to the index. That is the
      // format, not a miss: there is no plaintext to keep.
      const summary = contentText(payload["summary"]);
      const detail = contentText(payload["content"]);
      return { role: "reasoning", body: [summary, detail].filter((part) => part !== "").join("\n") };
    }
    case "custom_tool_call":
    case "function_call": {
      // Custom tools take a raw string, function tools a JSON string; both
      // arrive already serialized.
      const argument = asString(payload["input"]) || asString(payload["arguments"]);
      return { role: "tool_call", body: `${asString(payload["name"])} ${argument}` };
    }
    case "custom_tool_call_output":
    case "function_call_output":
      return { role: "tool_output", body: outputText(payload["output"]) };
    default:
      return null;
  }
}

export const parseCodex: Parser = (content, sourcePath) => {
  const messages: ParsedMessage[] = [];
  let workspace = "";
  let sessionId = "";
  let threadSource: string | null = null;
  let originator: string | null = null;
  let title = "";
  let preambleTitle = "";
  let line = 0;
  let offset = 0;
  for (const raw of content.split("\n")) {
    line += 1;
    const byteOffset = offset;
    offset += Buffer.byteLength(raw, "utf8") + 1;
    if (raw.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      // A rollout still being written ends in a half-flushed line.
      continue;
    }
    const record = asRecord(entry);
    if (record === null) continue;
    const type = record["type"];
    if (type === "session_meta") {
      const meta = asRecord(record["payload"]);
      if (meta === null) continue;
      sessionId = asString(meta["session_id"]) || asString(meta["id"]);
      workspace = asString(meta["cwd"]);
      const source = asString(meta["thread_source"] ?? meta["threadSource"]);
      threadSource = source === "" ? null : source;
      const producer = asString(meta["originator"]);
      originator = producer === "" ? null : producer;
      continue;
    }
    if (type !== "response_item") continue;
    const payload = asRecord(record["payload"]);
    if (payload === null) continue;
    const candidate = payloadCandidate(payload);
    if (candidate === null) continue;
    const body = normalizeBody(candidate.body);
    if (body === "") continue;
    if (candidate.role === "user") {
      const excerpt = collapse(body).slice(0, TITLE_CAP);
      const preamble = HARNESS_PREAMBLES.some((tag) => body.startsWith(tag));
      if (preamble) {
        if (preambleTitle === "") preambleTitle = excerpt;
      } else if (title === "") {
        title = excerpt;
      }
    }
    messages.push({
      ordinal: messages.length,
      line,
      byteOffset,
      role: candidate.role,
      ts: asString(record["timestamp"]),
      body,
    });
  }
  if (messages.length === 0) return null;
  const stamps = messages.map((message) => message.ts).filter((ts) => ts !== "");
  return {
    agent: "codex",
    sessionId: sessionId !== "" ? sessionId : sessionIdFromPath(sourcePath),
    sourcePath,
    workspace,
    // A session that never got past its preamble is still better named by
    // that preamble than by nothing.
    title: title !== "" ? title : preambleTitle !== "" ? preambleTitle : "(untitled)",
    createdAt: stamps[0] ?? "",
    updatedAt: stamps[stamps.length - 1] ?? "",
    threadSource,
    originator,
    messages,
  };
};

/**
 * The metadata a rollout announces itself with. `undefined` means no
 * readable session_meta at all — a legacy or truncated rollout — which is a
 * different answer from a session_meta that simply names no thread source.
 */
export function rolloutMetadata(text: string): RolloutMetadata | undefined {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(entry);
    if (record === null || record["type"] !== "session_meta") continue;
    const payload = asRecord(record["payload"]);
    if (payload === null) return undefined;
    const source = asString(payload["thread_source"] ?? payload["threadSource"]);
    const originator = asString(payload["originator"]);
    return {
      threadSource: source === "" ? null : source,
      originator: originator === "" ? null : originator,
    };
  }
  return undefined;
}

/** `undefined` means no readable session metadata; `null` is a legacy
 * session_meta with no thread source. */
export function rolloutThreadSource(text: string): string | null | undefined {
  return rolloutMetadata(text)?.threadSource;
}

/**
 * Full harness sessions identify themselves as `user`, which always wins —
 * including in a workspace also used by an auxiliary producer. Any other
 * explicit source is auxiliary. Configured originators classify only legacy
 * metadata with no source, and unreadable metadata fails open to "unknown"
 * so a rollout caught mid-write gets judged again after the next index run.
 *
 * A ParsedSession carries both fields, so an already-parsed session can be
 * classified without touching the file again.
 */
export function classifySession(
  metadata: RolloutMetadata | undefined,
  auxiliaryOriginators: ReadonlySet<string> = NO_AUXILIARY_ORIGINATORS,
): SessionClass {
  if (metadata === undefined) return "unknown";
  if (metadata.threadSource === "user") return "full-harness";
  if (metadata.threadSource !== null) return "auxiliary";
  return metadata.originator !== null && auxiliaryOriginators.has(metadata.originator)
    ? "auxiliary"
    : "full-harness";
}

/** The Parser is pure over a string, so decoding is a separate step: zstd is
 * whole-file, which is why a compressed rollout cannot be read by the head
 * the way a plain one can. */
export async function readRollout(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!path.endsWith(".zst")) return await file.text();
  const compressed = new Uint8Array(await file.arrayBuffer());
  return new TextDecoder().decode(await Bun.zstdDecompress(compressed));
}

/** Enough of a rollout to answer the classification question, which lives in
 * its first record. */
export async function readRolloutPrefix(path: string): Promise<string> {
  if (path.endsWith(".zst")) return await readRollout(path);
  return await Bun.file(path).slice(0, ROLLOUT_PREFIX_BYTES).text();
}

/** Classify a rollout on disk. A file that is gone or unreadable is
 * "unknown", never an exception: one bad file must not fail an index run. */
export async function classifyRollout(
  path: string,
  auxiliaryOriginators: ReadonlySet<string> = NO_AUXILIARY_ORIGINATORS,
): Promise<SessionClass> {
  try {
    return classifySession(rolloutMetadata(await readRolloutPrefix(path)), auxiliaryOriginators);
  } catch {
    return "unknown";
  }
}
