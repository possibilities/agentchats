/**
 * Everything read out of the index: full-text search, the recent-sessions
 * listing the picker and `agentchats state` stand on, counts, and status.
 *
 * Two decisions run through all of it. Ordering is total — bm25 ties are
 * broken by session recency, then by two more columns that cannot tie — so
 * a query run twice returns the same rows in the same order, which is what
 * makes paging and a live-search TUI trustworthy. And time filters read
 * `sessions.updated_at`, not `messages.ts`: a message's own timestamp is
 * often absent in both stores, while a session's is not.
 */

import type { Database } from "bun:sqlite";
import type { Role } from "../parse/types.ts";
import { SCHEMA_VERSION, storedSchemaVersion } from "./schema.ts";

export interface SessionFilters {
  workspace?: string;
  agent?: string;
  /** Inclusive ISO 8601 bounds on the session's last activity. Compared as
   * text, which is exactly what ISO 8601 was designed for. */
  since?: string;
  until?: string;
}

export interface SearchOptions extends SessionFilters {
  query: string;
  limit: number;
  offset?: number;
  marks?: SnippetMarks;
}

export interface SnippetMarks {
  start: string;
  end: string;
  ellipsis: string;
  /** Tokens of context; FTS5 caps this at 64. */
  tokens: number;
}

const DEFAULT_MARKS: SnippetMarks = { start: "[", end: "]", ellipsis: " … ", tokens: 20 };

export interface SearchHit {
  sourcePath: string;
  line: number;
  agent: string;
  workspace: string;
  title: string;
  snippet: string;
  /** Raw bm25: negative, and *lower is better*. Passed through rather than
   * normalized so a caller can compare hits across two queries. */
  score: number;
  createdAt: string;
  sessionId: string;
  ordinal: number;
  role: Role;
  /** Codex rollout metadata, carried on every result row so the picker can
   * tell an auxiliary session (app-server, realtime, a child thread) from a
   * real one without reopening the transcript. Null for Claude Code. */
  threadSource: string | null;
  originator: string | null;
}

export interface SessionSummary {
  path: string;
  agent: string;
  workspace: string;
  title: string;
  /** The session's last activity, ISO 8601 or "". */
  modified: string;
  messageCount: number;
  /** Messages the human actually typed. Tool results arrive as role "user"
   * records in Claude's transcripts, so this is not the same as counting
   * user rows in the raw file. */
  humanTurns: number;
  sessionId: string;
  /** As on `SearchHit`: the classification the picker needs, already on the
   * row. Null for Claude Code. */
  threadSource: string | null;
  originator: string | null;
}

export type AggregateDimension = "agent" | "workspace" | "date";

export interface AggregateRow {
  key: string;
  sessions: number;
  /** Matching messages when a query is given; the session's total message
   * count when one is not. */
  messages: number;
}

export interface AggregateOptions extends SessionFilters {
  by: AggregateDimension;
  /** Absent or blank aggregates the whole index. */
  query?: string;
}

export interface IndexStatus {
  schemaVersion: number | null;
  expectedSchemaVersion: number;
  sessions: number;
  messages: number;
  /** Pages times page size: the database proper, not its WAL. */
  bytes: number;
  /** Last activity across every indexed session, ISO 8601. */
  newestSession: string | null;
  /** When this index last wrote a session. */
  lastIndexedAt: string | null;
  agents: { agent: string; sessions: number; messages: number }[];
}

const OPERATORS = new Set(["AND", "OR", "NOT"]);

/** A term FTS5 will accept for any text at all, or null when the text holds
 * nothing searchable. Quoting is the whole trick: inside a phrase every
 * character FTS5 would otherwise read as syntax — parentheses, colons,
 * carets, braces, plus signs — is just a token separator. */
function phrase(text: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Prose in, an FTS5 expression out. Users type search boxes, not query
 * languages, and FTS5 answers `C++`, `foo(bar`, a stray `"` or a lone `*`
 * with a syntax error rather than with results — the single most likely way
 * this store fails at runtime. So every word becomes a quoted phrase, which
 * cannot be a syntax error, and only three things survive as syntax: an
 * uppercase AND / OR / NOT between terms, a quoted phrase the user wrote
 * themselves, and a trailing `*` for prefix search. Dangling and doubled
 * operators are dropped rather than passed through to fail.
 *
 * Returns null when nothing searchable is left, which callers treat as
 * "no results", never as an error.
 */
export function toMatchQuery(raw: string): string | null {
  const tokens: { operator: boolean; text: string }[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index] as string;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '"') {
      // An unterminated quote closes at the end of the input instead of
      // reaching FTS5 as "unterminated string".
      const close = raw.indexOf('"', index + 1);
      const body = close === -1 ? raw.slice(index + 1) : raw.slice(index + 1, close);
      index = close === -1 ? raw.length : close + 1;
      let prefix = false;
      if (raw[index] === "*") {
        prefix = true;
        index++;
      }
      const quoted = phrase(body);
      if (quoted !== null) tokens.push({ operator: false, text: prefix ? `${quoted}*` : quoted });
      continue;
    }
    let end = index;
    while (end < raw.length && !/\s/.test(raw[end] as string) && raw[end] !== '"') end++;
    const word = raw.slice(index, end);
    index = end;
    if (OPERATORS.has(word)) {
      tokens.push({ operator: true, text: word });
      continue;
    }
    const prefix = word.endsWith("*");
    const quoted = phrase(prefix ? word.slice(0, -1) : word);
    if (quoted !== null) tokens.push({ operator: false, text: prefix ? `${quoted}*` : quoted });
  }

  const kept: string[] = [];
  let pendingOperator: string | null = null;
  for (const token of tokens) {
    if (token.operator) {
      // Leading operators have nothing to bind; doubled ones keep the first.
      if (kept.length > 0 && pendingOperator === null) pendingOperator = token.text;
      continue;
    }
    if (pendingOperator !== null) {
      kept.push(pendingOperator);
      pendingOperator = null;
    }
    kept.push(token.text);
  }
  return kept.length === 0 ? null : kept.join(" ");
}

type Bindings = Record<string, string | number>;

/** Filter clauses and their bindings together, so a clause can never be
 * added without its parameter. */
function sessionFilters(filters: SessionFilters): { sql: string; bindings: Bindings } {
  const clauses: string[] = [];
  const bindings: Bindings = {};
  if (filters.workspace !== undefined) {
    clauses.push("sessions.workspace = $workspace");
    bindings["$workspace"] = filters.workspace;
  }
  if (filters.agent !== undefined) {
    clauses.push("sessions.agent = $agent");
    bindings["$agent"] = filters.agent;
  }
  if (filters.since !== undefined) {
    clauses.push("sessions.updated_at >= $since");
    bindings["$since"] = filters.since;
  }
  if (filters.until !== undefined) {
    clauses.push("sessions.updated_at <= $until");
    bindings["$until"] = filters.until;
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), bindings };
}

function dimension(by: AggregateDimension): string {
  switch (by) {
    case "agent":
      return "sessions.agent";
    case "workspace":
      return "sessions.workspace";
    case "date":
      return "substr(sessions.updated_at, 1, 10)";
  }
}

/**
 * The query-less listing: `search "" --workspace X --days 7` is the
 * documented idiom for "everything in scope", and a query of only operators
 * or punctuation reduces to the same thing. It is an index scan, not a
 * match, so there is no rank to sort by and no snippet to highlight — the
 * newest messages come first and the excerpt is simply the head of the body.
 */
function scanRecent(db: Database, options: SearchOptions): SearchHit[] {
  const filters = sessionFilters(options);
  return db
    .query(
      `SELECT sessions.source_path AS sourcePath, messages.line AS line,
              sessions.agent AS agent, sessions.workspace AS workspace,
              sessions.title AS title,
              substr(messages.body, 1, 200) AS snippet,
              0.0 AS score, sessions.created_at AS createdAt,
              sessions.session_id AS sessionId, messages.ordinal AS ordinal,
              messages.role AS role, sessions.thread_source AS threadSource,
              sessions.originator AS originator
       FROM messages
       JOIN sessions ON sessions.id = messages.session_id
       WHERE 1 = 1${filters.sql}
       ORDER BY sessions.updated_at DESC, sessions.id ASC, messages.ordinal ASC
       LIMIT $limit OFFSET $offset`,
    )
    .all({
      $limit: options.limit,
      $offset: options.offset ?? 0,
      ...filters.bindings,
    }) as SearchHit[];
}

export function search(db: Database, options: SearchOptions): SearchHit[] {
  const match = toMatchQuery(options.query);
  if (match === null) return scanRecent(db, options);
  const marks = options.marks ?? DEFAULT_MARKS;
  const filters = sessionFilters(options);
  const rows = db
    .query(
      `SELECT sessions.source_path AS sourcePath, messages.line AS line,
              sessions.agent AS agent, sessions.workspace AS workspace,
              sessions.title AS title,
              snippet(messages_fts, 0, $start, $end, $ellipsis, $tokens) AS snippet,
              bm25(messages_fts) AS score, sessions.created_at AS createdAt,
              sessions.session_id AS sessionId, messages.ordinal AS ordinal,
              messages.role AS role, sessions.thread_source AS threadSource,
              sessions.originator AS originator
       FROM messages_fts
       JOIN messages ON messages.id = messages_fts.rowid
       JOIN sessions ON sessions.id = messages.session_id
       WHERE messages_fts MATCH $match${filters.sql}
       ORDER BY score ASC, sessions.updated_at DESC, sessions.id ASC, messages.ordinal ASC
       LIMIT $limit OFFSET $offset`,
    )
    .all({
      $match: match,
      $start: marks.start,
      $end: marks.end,
      $ellipsis: marks.ellipsis,
      $tokens: Math.min(Math.max(Math.trunc(marks.tokens), 1), 64),
      $limit: options.limit,
      $offset: options.offset ?? 0,
      ...filters.bindings,
    }) as SearchHit[];
  return rows;
}

export function sessions(
  db: Database,
  options: SessionFilters & { limit: number },
): SessionSummary[] {
  const filters = sessionFilters(options);
  return db
    .query(
      `SELECT sessions.source_path AS path, sessions.agent AS agent,
              sessions.workspace AS workspace, sessions.title AS title,
              sessions.updated_at AS modified, sessions.message_count AS messageCount,
              sessions.human_turns AS humanTurns, sessions.session_id AS sessionId,
              sessions.thread_source AS threadSource, sessions.originator AS originator
       FROM sessions
       WHERE 1 = 1${filters.sql}
       ORDER BY sessions.updated_at DESC, sessions.id DESC
       LIMIT $limit`,
    )
    .all({ $limit: options.limit, ...filters.bindings }) as SessionSummary[];
}

/** Counts, never content: what the corpus contains, sliced one way. */
export function aggregate(db: Database, options: AggregateOptions): AggregateRow[] {
  const filters = sessionFilters(options);
  const key = dimension(options.by);
  const raw = options.query ?? "";
  if (raw.trim() === "") {
    return db
      .query(
        `SELECT ${key} AS key, COUNT(*) AS sessions,
                COALESCE(SUM(sessions.message_count), 0) AS messages
         FROM sessions
         WHERE 1 = 1${filters.sql}
         GROUP BY key
         ORDER BY sessions DESC, key ASC`,
      )
      .all(filters.bindings) as AggregateRow[];
  }
  const match = toMatchQuery(raw);
  if (match === null) return [];
  return db
    .query(
      `SELECT ${key} AS key, COUNT(DISTINCT sessions.id) AS sessions, COUNT(*) AS messages
       FROM messages_fts
       JOIN messages ON messages.id = messages_fts.rowid
       JOIN sessions ON sessions.id = messages.session_id
       WHERE messages_fts MATCH $match${filters.sql}
       GROUP BY key
       ORDER BY messages DESC, key ASC`,
    )
    .all({ $match: match, ...filters.bindings }) as AggregateRow[];
}

export function status(db: Database): IndexStatus {
  const counts = db
    .query(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT MAX(updated_at) FROM sessions) AS newestSession,
              (SELECT MAX(indexed_at) FROM sessions) AS lastIndexedAt`,
    )
    .get() as {
    sessions: number;
    messages: number;
    newestSession: string | null;
    lastIndexedAt: string | null;
  };
  const pages = db.query("PRAGMA page_count").get() as { page_count: number };
  const size = db.query("PRAGMA page_size").get() as { page_size: number };
  const agents = db
    .query(
      `SELECT agent, COUNT(*) AS sessions, COALESCE(SUM(message_count), 0) AS messages
       FROM sessions GROUP BY agent ORDER BY sessions DESC, agent ASC`,
    )
    .all() as { agent: string; sessions: number; messages: number }[];
  return {
    schemaVersion: storedSchemaVersion(db),
    expectedSchemaVersion: SCHEMA_VERSION,
    sessions: counts.sessions,
    messages: counts.messages,
    bytes: pages.page_count * size.page_size,
    newestSession: counts.newestSession === "" ? null : counts.newestSession,
    lastIndexedAt: counts.lastIndexedAt,
    agents,
  };
}
