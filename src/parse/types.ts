/**
 * The contract between a transcript parser and the session index: one
 * transcript file in, one session with its messages out. Parsers own every
 * quirk of a provider's on-disk format; the store below them sees only this
 * shape, and the CLI above it never learns which provider it came from.
 */

/** Bodies are capped so one pathological tool output cannot dominate the
 * index. Measured against the live corpus: capping buys little (532 MB of
 * text becomes 349 MB at 2 KB), so the cap is generous and exists only to
 * bound the worst case. */
export const MESSAGE_BODY_CAP = 16_000;

/** The two providers in scope. The retired index's other connectors are
 * deliberately not reproduced. */
export type Agent = "claude_code" | "codex";

/**
 * A message's kind, normalized across providers. `tool_output` matters
 * most: Claude Code delivers tool results inside records typed "user", and
 * counting those as human turns would misreport every session.
 */
export type Role =
  | "user"
  | "assistant"
  | "thinking"
  | "reasoning"
  | "tool_call"
  | "tool_output"
  | "system";

export interface ParsedMessage {
  /** Position within the session, 0-based, in file order. */
  ordinal: number;
  /** 1-based line number in the source file — what a citation points at. */
  line: number;
  /** Byte offset of that line's first byte, so `view` can seek instead of
   * scanning a multi-megabyte transcript. Valid while the file is
   * append-only, which both stores are; a rewrite changes size/mtime and
   * forces a reparse. */
  byteOffset: number;
  role: Role;
  /** ISO 8601, or "" when the record carries no timestamp. */
  ts: string;
  /** Already capped at MESSAGE_BODY_CAP; never empty after trimming. */
  body: string;
  /**
   * Whether the cap cut this body. Recorded at write time rather than
   * inferred later from its stored length: `slice` counts UTF-16 code units
   * and SQLite's `length()` counts code points, so a body holding an emoji
   * stores fewer characters than the cap and an inference reads it as
   * complete — 349 of them in this corpus, every one failing toward
   * "nothing was lost".
   */
  truncated: boolean;
}

export interface ParsedSession {
  agent: Agent;
  /** The native session id the harness resumes by. */
  sessionId: string;
  sourcePath: string;
  /** The recorded working directory, or "" when unrecorded. */
  workspace: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Codex rollout metadata, used to classify auxiliary sessions without
   * re-reading the file at query time. Always null for Claude Code. */
  threadSource: string | null;
  originator: string | null;
  messages: ParsedMessage[];
}

/** A parser returns null for a file with no indexable content — an empty
 * transcript, a truncated write, a format it does not recognize. That is a
 * skip, never an error: one unreadable file must not fail an index run. */
export type Parser = (content: string, sourcePath: string) => ParsedSession | null;

/**
 * Codepoints that carry no searchable meaning and actively corrupt indexing.
 *
 * Private Use Area characters are the reason this exists. A web-search tool
 * wraps its citations in U+E200-U+E202, and FTS5's unicode61 tokenizer treats
 * private-use codepoints as *token* characters rather than separators — so
 * "…Severity\uE201" is indexed as one token and the word "severity" can never
 * be found in that transcript. Zero-width spaces, bidi controls, and the byte
 * order mark glue tokens together the same way.
 *
 * They are replaced with a space rather than deleted: an invisible character
 * is often the only thing separating two real words, and deleting it would
 * merge them into a token that is equally unfindable.
 */
const UNSEARCHABLE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uE000-\uF8FF\uFEFF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;

/** Strip what cannot be searched, collapse the whitespace that leaves behind,
 * trim, and cap — reporting whether the cap actually cut anything, because
 * only the writer can know that for certain. */
export function normalizeBody(text: string): { body: string; truncated: boolean } {
  const cleaned = text.replace(UNSEARCHABLE, " ").replace(/[ \t]{2,}/g, " ").trim();
  if (cleaned === "") return { body: "", truncated: false };
  if (cleaned.length <= MESSAGE_BODY_CAP) return { body: cleaned, truncated: false };
  let cut = cleaned.slice(0, MESSAGE_BODY_CAP);
  // `slice` counts UTF-16 code units, so the cap can land between the halves
  // of a surrogate pair and leave a lone high surrogate — text that no longer
  // round-trips through UTF-8. Drop the orphan rather than store something
  // that is not a string.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { body: cut, truncated: true };
}
