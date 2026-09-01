/**
 * Everything read out of the index: full-text search, the recent-sessions
 * listing the picker and `agentchats state` stand on, counts, and status.
 *
 * Search answers in three passes, in falling order of confidence, because
 * replaying real historical queries showed that a body-only, message-scoped
 * match loses most of what a person actually meant:
 *
 *   message   this message body matched the query. Exact, ranked by bm25.
 *   session   every term of the query appears somewhere in this session,
 *             though no single message holds them all. A lead, not a hit,
 *             and only offered when the exact pass came up nearly empty.
 *   metadata  the session's title, workspace, or transcript path matched.
 *             "Which sessions touched agentbrowse?" answers here.
 *
 * The passes concatenate rather than interleave: a bm25 score from
 * `messages_fts` and one from `sessions_fts` are computed over different
 * corpora and are not comparable, so mixing them by score would be sorting
 * on noise. Every hit carries `matchedOn` saying which pass produced it,
 * and the result envelope carries `fallback` so a caller can tell an agent
 * plainly that these are widened leads.
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

/** Which pass produced a hit. Scores are comparable within one kind and
 * meaningless across kinds. */
export type MatchKind = "message" | "session" | "metadata";

export interface SearchHit {
  sourcePath: string;
  line: number;
  agent: string;
  workspace: string;
  title: string;
  snippet: string;
  /** Raw bm25: negative, and *lower is better*. Passed through rather than
   * normalized so a caller can compare hits across two queries — but only
   * against hits of the same `matchedOn` kind. */
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
  matchedOn: MatchKind;
}

export interface SearchResult {
  hits: SearchHit[];
  /** "session" when the exact pass came up nearly empty and the store
   * widened to session scope to find leads. Callers are expected to say so
   * out loud: an agent handed widened results without being told will read
   * them as exact matches. */
  fallback: null | "session";
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

/** Below this many exact message hits, a multi-term query is worth widening
 * to session scope. Above it the user has enough to read and a widened list
 * would only bury the exact answers. */
const WIDEN_BELOW = 3;

const OPERATORS = new Set(["AND", "OR", "NOT"]);

/** A term FTS5 will accept for any text at all, or null when the text holds
 * nothing searchable. Quoting is the whole trick: inside a phrase every
 * character FTS5 would otherwise read as syntax — parentheses, colons,
 * carets, braces, plus signs — is just a token separator. */
function phrase(text: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return `"${text.replace(/"/g, '""')}"`;
}

interface ParsedQuery {
  /** The FTS5 expression, or null when nothing searchable was typed. */
  match: string | null;
  /** The distinct terms, for the session-scoped widening — but only when
   * the query is a plain conjunction. A query with an explicit operator is
   * never widened: re-reading `a NOT b` as "sessions holding both a and b"
   * would return the opposite of what was asked. */
  terms: string[];
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
 * FTS5 has no substring wildcard, so a leading `*` is dropped with the rest
 * of the punctuation rather than faked with a scan.
 */
function parseQuery(raw: string): ParsedQuery {
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
  const terms = new Set<string>();
  let operatorKept = false;
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
      operatorKept = true;
    }
    kept.push(token.text);
    terms.add(token.text);
  }
  return {
    match: kept.length === 0 ? null : kept.join(" "),
    terms: operatorKept ? [] : [...terms],
  };
}

export function toMatchQuery(raw: string): string | null {
  return parseQuery(raw).match;
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

/**
 * The sessions the message pass returned — as a set operation, not as a
 * list of the rows it happened to return. A later pass runs only once the
 * message pass is exhausted, so "has a message matching this query" *is*
 * that pass's result set, exactly. Saying it this way keeps the exclusion
 * one bound parameter wide however many rows matched; passing the paths
 * instead made a 50,000-row page build a statement with 48,000 parameters
 * and take fourteen seconds.
 */
const MESSAGE_SESSIONS = `SELECT session_id FROM messages
  WHERE id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH $match)`;

/** "Every term appears in some message of this session" — the widening
 * pass's membership test, reused by the metadata pass to exclude what
 * widening already returned. */
function widenedPredicate(terms: readonly string[]): { sql: string; bindings: Bindings } {
  const bindings: Bindings = {};
  const clauses = terms.map((term, position) => {
    bindings[`$term${position}`] = term;
    return `sessions.id IN (SELECT session_id FROM messages
              WHERE id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH $term${position}))`;
  });
  return { sql: clauses.join(" AND "), bindings };
}

function markBindings(marks: SnippetMarks): Bindings {
  return {
    $start: marks.start,
    $end: marks.end,
    $ellipsis: marks.ellipsis,
    $tokens: Math.min(Math.max(Math.trunc(marks.tokens), 1), 64),
  };
}

/** The hit projection, shared by the two message-anchored passes so their
 * rows are indistinguishable apart from `matchedOn`. */
function hitColumns(kind: "message" | "session"): string {
  return `sessions.source_path AS sourcePath, messages.line AS line,
          sessions.agent AS agent, sessions.workspace AS workspace,
          sessions.title AS title,
          snippet(messages_fts, 0, $start, $end, $ellipsis, $tokens) AS snippet,
          bm25(messages_fts) AS score, sessions.created_at AS createdAt,
          sessions.session_id AS sessionId, messages.ordinal AS ordinal,
          messages.role AS role, sessions.thread_source AS threadSource,
          sessions.originator AS originator, '${kind}' AS matchedOn`;
}

const HIT_FIELDS = `sourcePath, line, agent, workspace, title, snippet, score,
                    createdAt, sessionId, ordinal, role, threadSource, originator, matchedOn`;

const MESSAGE_JOIN = `FROM messages_fts
  JOIN messages ON messages.id = messages_fts.rowid
  JOIN sessions ON sessions.id = messages.session_id`;

/** Pass one: messages whose body matched, best first. */
function messageMatches(
  db: Database,
  match: string,
  limit: number,
  options: SearchOptions,
  marks: SnippetMarks,
): SearchHit[] {
  const filters = sessionFilters(options);
  return db
    .query(
      `SELECT ${hitColumns("message")}
       ${MESSAGE_JOIN}
       WHERE messages_fts MATCH $match${filters.sql}
       ORDER BY score ASC, sessions.updated_at DESC, sessions.id ASC, messages.ordinal ASC
       LIMIT $limit`,
    )
    .all({ $match: match, $limit: limit, ...markBindings(marks), ...filters.bindings }) as SearchHit[];
}

/**
 * Pass two: sessions where every term appears in *some* message, even
 * though no single message holds them all — `fable opus-1m` is two words
 * from one conversation, not one sentence. The qualifying sessions are
 * found first and capped at the page size, so the expensive part only ever
 * runs over the handful of sessions that can actually be returned; then one
 * message per session is chosen, the best-scoring against any term, to
 * anchor the citation.
 */
function sessionMatches(
  db: Database,
  match: string,
  terms: readonly string[],
  limit: number,
  options: SearchOptions,
  marks: SnippetMarks,
): SearchHit[] {
  const filters = sessionFilters(options);
  const widened = widenedPredicate(terms);
  const qualifying = db
    .query(
      `SELECT sessions.id AS id FROM sessions
       WHERE sessions.id NOT IN (${MESSAGE_SESSIONS})${filters.sql}
         AND ${widened.sql}
       ORDER BY sessions.updated_at DESC, sessions.id DESC
       LIMIT $limit`,
    )
    .all({
      $match: match,
      $limit: limit,
      ...filters.bindings,
      ...widened.bindings,
    }) as { id: number }[];
  if (qualifying.length === 0) return [];

  const idBindings: Bindings = {};
  const idNames = qualifying.map((row, position) => {
    idBindings[`$id${position}`] = row.id;
    return `$id${position}`;
  });
  // bm25 cannot be called from a window function's ORDER BY, so the scores
  // are materialized by the inner select before the window ranks them.
  return db
    .query(
      `SELECT ${HIT_FIELDS} FROM (
         SELECT ${HIT_FIELDS}, updatedAt, sessionRowId,
                ROW_NUMBER() OVER (
                  PARTITION BY sessionRowId ORDER BY score ASC, ordinal ASC
                ) AS pick
         FROM (
           SELECT ${hitColumns("session")},
                  sessions.updated_at AS updatedAt, sessions.id AS sessionRowId
           ${MESSAGE_JOIN}
           WHERE messages_fts MATCH $any AND sessions.id IN (${idNames.join(", ")})
         )
       )
       WHERE pick = 1
       ORDER BY updatedAt DESC, sessionRowId DESC`,
    )
    .all({ $any: terms.join(" OR "), ...markBindings(marks), ...idBindings }) as SearchHit[];
}

type MetadataRow = Omit<SearchHit, "snippet"> & {
  highlightedTitle: string;
  highlightedWorkspace: string;
  highlightedPath: string;
};

/** The leftmost metadata column that actually matched — a highlight differs
 * from its raw column only when FTS5 marked something in it. Showing the
 * matched column is the whole point: it is the answer to "why is this
 * session here?". */
function metadataSnippet(row: MetadataRow): string {
  if (row.highlightedTitle !== row.title) return row.highlightedTitle;
  if (row.highlightedWorkspace !== row.workspace) return row.highlightedWorkspace;
  if (row.highlightedPath !== row.sourcePath) return row.highlightedPath;
  // Only reachable when the caller marks with empty strings, which makes a
  // highlight indistinguishable from the raw text.
  return row.workspace === "" ? row.title : row.workspace;
}

/**
 * Pass three: the session's own metadata matched — its title, the workspace
 * it ran in, or the transcript's path. Paths and workspaces tokenize on
 * their separators, so `agentbrowse` finds every session that ran in
 * `/Users/arthack/code/agentbrowse` whether or not anyone typed the name.
 *
 * Each hit is anchored on the session's first message so `line`, `ordinal`
 * and `role` stay meaningful and a caller can still open the transcript at
 * a real position. A session with no messages cannot be anchored and so is
 * not returned — which costs nothing, since a transcript with no indexable
 * content never becomes a session row in the first place.
 */
function metadataMatches(
  db: Database,
  match: string,
  terms: readonly string[],
  limit: number,
  options: SearchOptions,
  marks: SnippetMarks,
): SearchHit[] {
  const filters = sessionFilters(options);
  // `terms` is non-empty only when the widening pass ran, in which case the
  // sessions it returned are excluded here by the same predicate that found
  // them.
  const widened = widenedPredicate(terms);
  const excluded = terms.length === 0 ? "" : ` AND NOT (${widened.sql})`;
  const rows = db
    .query(
      `SELECT sessions.source_path AS sourcePath, messages.line AS line,
              sessions.agent AS agent, sessions.workspace AS workspace,
              sessions.title AS title, bm25(sessions_fts) AS score,
              sessions.created_at AS createdAt, sessions.session_id AS sessionId,
              messages.ordinal AS ordinal, messages.role AS role,
              sessions.thread_source AS threadSource, sessions.originator AS originator,
              'metadata' AS matchedOn,
              highlight(sessions_fts, 0, $start, $end) AS highlightedTitle,
              highlight(sessions_fts, 1, $start, $end) AS highlightedWorkspace,
              highlight(sessions_fts, 2, $start, $end) AS highlightedPath
       FROM sessions_fts
       JOIN sessions ON sessions.id = sessions_fts.rowid
       JOIN messages ON messages.id = (
         SELECT anchor.id FROM messages AS anchor
         WHERE anchor.session_id = sessions.id
         ORDER BY anchor.ordinal ASC, anchor.id ASC LIMIT 1
       )
       WHERE sessions_fts MATCH $match
         AND sessions.id NOT IN (${MESSAGE_SESSIONS})${filters.sql}${excluded}
       ORDER BY sessions.updated_at DESC, sessions.id DESC
       LIMIT $limit`,
    )
    .all({
      $match: match,
      $limit: limit,
      $start: marks.start,
      $end: marks.end,
      ...filters.bindings,
      ...widened.bindings,
    }) as MetadataRow[];
  return rows.map((row) => {
    const { highlightedTitle, highlightedWorkspace, highlightedPath, ...hit } = row;
    return { ...hit, snippet: metadataSnippet(row) };
  });
}

export function search(db: Database, options: SearchOptions): SearchResult {
  const parsed = parseQuery(options.query);
  if (parsed.match === null) return { hits: [], fallback: null };
  const marks = options.marks ?? DEFAULT_MARKS;
  const offset = options.offset ?? 0;
  const need = offset + options.limit;

  // One invariant carries the whole composition: a later pass runs only
  // while the page is short, and a short page means the pass before it
  // returned fewer rows than it was asked for — so that pass is exhausted,
  // its count is the true count, and the sessions it found are the complete
  // set to exclude. Nothing here is best-effort.
  let hits = messageMatches(db, parsed.match, need, options, marks);
  let fallback: null | "session" = null;

  const widening = hits.length < need && hits.length < WIDEN_BELOW && parsed.terms.length > 1;
  if (widening) {
    const widened = sessionMatches(
      db,
      parsed.match,
      parsed.terms,
      need - hits.length,
      options,
      marks,
    );
    if (widened.length > 0) fallback = "session";
    hits = hits.concat(widened);
  }

  if (hits.length < need) {
    // The terms go through only when widening ran, so that the metadata
    // pass excludes what it returned and nothing more.
    hits = hits.concat(
      metadataMatches(
        db,
        parsed.match,
        widening ? parsed.terms : [],
        need - hits.length,
        options,
        marks,
      ),
    );
  }

  return { hits: hits.slice(offset), fallback };
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

/** Counts, never content: what the corpus contains, sliced one way. Counts
 * message matches only — the widening and metadata passes exist to rescue a
 * thin result list, and a count is not a result list. */
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
       ${MESSAGE_JOIN}
       WHERE messages_fts MATCH $match${filters.sql}
       GROUP BY key
       ORDER BY messages DESC, key ASC`,
    )
    .all({ $match: match, ...filters.bindings }) as AggregateRow[];
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
