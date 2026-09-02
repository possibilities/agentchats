/**
 * Reading the index: ranked search, session listings, aggregates, status.
 *
 * The unit of an answer is a session. A caller asks which conversation
 * discussed something, so search ranks sessions and carries their best
 * matching message as the citation — `--limit 10` means ten conversations,
 * not ten lines from three of them.
 *
 * One pass, deliberately. Two fallback passes lived here — widening a sparse
 * conjunction to session scope, and matching session metadata — each gated
 * on the page coming up short. Measured against 246 real historical queries
 * they fired once and zero times respectively, and recovered no expected
 * document between them, so ~200 lines and a second full-text index went.
 * Every query language they implemented is still available directly:
 * `--workspace` scopes, `OR` widens, `sessions` lists.
 */

import type { Database } from "bun:sqlite";
import type { Role } from "../parse/types.ts";
import { SCHEMA_VERSION, storedSchemaVersion } from "./schema.ts";

export interface SessionFilters {
  workspace?: string;
  agent?: string;
  /** Limit to sessions the harness can still resume. The picker sets it: a
   * row that fatally refuses on Enter has no business in a resume picker. */
  resumableOnly?: boolean;
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

/** 48 of the 64 tokens FTS5 permits. The cited message averages about 4,200
 * characters and a 20-token window showed 145 of them — 3.4%. Widening to 48
 * roughly doubles that and measured free: ten snippets cost the same either
 * way, because the work is finding the match, not rendering it. */
const DEFAULT_MARKS: SnippetMarks = { start: "[", end: "]", ellipsis: " … ", tokens: 48 };

/** Which pass produced a hit. Scores are comparable within one kind and
 * meaningless across kinds. */
export interface SearchHit {
  sourcePath: string;
  line: number;
  agent: string;
  workspace: string;
  title: string;
  snippet: string;
  /**
   * Raw bm25: negative, and lower is better. Comparable only *within* one
   * query's results, as a re-rank key — never across queries and never as a
   * quality threshold. Magnitude tracks how rare the term is, not how good
   * the match is: measured best-hit scores run "the" −0.89, "herdr" −4.52,
   * "ECONNREFUSED" −14.45, so the commonest word scores nearest zero.
   */
  score: number;
  createdAt: string;
  sessionId: string;
  ordinal: number;
  role: Role;
  /** The stored body was cut by the cap. Measured at 8.2% of returned hits —
   * above the 5% corpus rate, because ranking favours exactly the long tool
   * output the cap bites. Worth reading before deciding a snippet earns a
   * `view`, since `view --full` is what recovers the rest. */
  truncated: boolean;
  /** Codex rollout metadata, carried on every result row so the picker can
   * tell an auxiliary session (app-server, realtime, a child thread) from a
   * real one without reopening the transcript. Null for Claude Code. */
  threadSource: string | null;
  originator: string | null;
}

export interface SearchResult {
  hits: SearchHit[];
  /** "session" when the exact pass came up nearly empty and the store
   * widened to session scope to find leads. Callers are expected to say so
   * out loud: an agent handed widened results without being told will read
   * them as exact matches. */
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
  if (filters.resumableOnly === true) clauses.push("sessions.archived = 0");
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

function markBindings(marks: SnippetMarks): Bindings {
  return {
    $start: marks.start,
    $end: marks.end,
    $ellipsis: marks.ellipsis,
    $tokens: Math.min(Math.max(Math.trunc(marks.tokens), 1), 64),
  };
}

/** The hit projection every result row shares. */
function hitColumns(): string {
  return `sessions.source_path AS sourcePath, messages.line AS line,
          sessions.agent AS agent, sessions.workspace AS workspace,
          sessions.title AS title,
          snippet(messages_fts, 0, $start, $end, $ellipsis, $tokens) AS snippet,
          bm25(messages_fts) AS score, sessions.created_at AS createdAt,
          sessions.session_id AS sessionId, messages.ordinal AS ordinal,
          messages.role AS role, messages.truncated AS truncated, sessions.thread_source AS threadSource,
          sessions.originator AS originator`;
}

const HIT_FIELDS = `sourcePath, line, agent, workspace, title, snippet, score,
                    createdAt, sessionId, ordinal, role, threadSource, originator`;

const MESSAGE_JOIN = `FROM messages_fts
  JOIN messages ON messages.id = messages_fts.rowid
  JOIN sessions ON sessions.id = messages.session_id`;

/**
 * How many ranked messages to consider before grouping them into sessions.
 * A page is sessions, but the evidence is messages, and a chatty session can
 * hold dozens of matches — so the pool has to be deeper than the page or the
 * tail of the ranking is never seen. Measured: ten message hits used to yield
 * a mean of 4.91 distinct sessions, and 45.5% of pages showed fewer than five.
 */
/**
 * How far below a session's best score a prose message may sit and still be
 * shown as its citation. bm25 is negative and lower is better, so this is an
 * absolute score distance.
 *
 * Swept against real queries — prose share of citations against the mean
 * score given up to get it: 0 → 10.7% / 0.000, 1.0 → 15.3% / 0.024,
 * 2.0 → 21.4% / 0.109, 5.0 → 30.4% / 0.404, unbounded → 40.2% / 1.264.
 * Two doubles the prose for a tenth the penalty of always preferring it, and
 * keeps the guarantee that matters: a citation is only swapped for one that
 * matched nearly as well, so a query whose real answer is a stack trace
 * still gets the stack trace.
 */
const CITATION_BAND = 2.0;

function poolSize(need: number): number {
  // Scales with what was asked for, so a caller wanting a deep page pays for
  // the depth rather than silently getting a shallow one. The ceiling only
  // bounds a pathological request; the default page of ten costs 400.
  return Math.min(Math.max(need * 20, 400), 50_000);
}

/**
 * Pass one: the sessions whose messages matched, best first.
 *
 * The unit of an answer is a session — "which conversation discussed this" —
 * so ranking sessions rather than messages is what the caller actually asked
 * for. A session scores by its best message plus a saturating bonus for how
 * many matched, `-bm25 + 2·ln(1 + n)`: one strong hit beats one weak hit, and
 * a conversation that returns to a subject beats one that mentions it once,
 * without a chatty session drowning the page. Measured over 244 real
 * historical queries this moved recall@10 from 0.612 to 0.724, with 70
 * queries better and 5 worse.
 *
 * Two statements, deliberately. Ranking and snippet generation both need the
 * full-text match, and doing them in one statement makes FTS5 score every
 * matching row twice — 13s on a term matching 228k messages, against 6s for
 * the flat pass it replaced. Ranking first and then asking for snippets by
 * rowid costs single-digit milliseconds for the ten rows that survived.
 */
function messageMatches(
  db: Database,
  match: string,
  limit: number,
  options: SearchOptions,
  marks: SnippetMarks,
): SearchHit[] {
  const filters = sessionFilters(options);
  // MATERIALIZED is load-bearing: as an ordinary CTE, SQLite re-ran the whole
  // ranked scan once per session while picking that session's best message.
  const picked = db
    .query(
      `WITH pool AS MATERIALIZED (
         SELECT messages.id AS mid, messages.session_id AS sid, messages.role AS role,
                bm25(messages_fts) AS s
         FROM messages_fts
         JOIN messages ON messages.id = messages_fts.rowid
         JOIN sessions ON sessions.id = messages.session_id
         WHERE messages_fts MATCH $match${filters.sql}
         ORDER BY s ASC
         LIMIT $pool
       ),
       agg AS (SELECT sid, MIN(s) AS best, COUNT(*) AS n FROM pool GROUP BY sid),
       scored AS (SELECT mid, sid, role, s, MIN(s) OVER (PARTITION BY sid) AS sbest FROM pool),
       best AS (
         SELECT mid, sid FROM (
           SELECT mid, sid, ROW_NUMBER() OVER (
             PARTITION BY sid
             -- Which message to show, once the session has been chosen. bm25
             -- favours long repetitive tool output, so 82% of citations were
             -- machine text and 28% of them hid a human or assistant sentence
             -- matching the same query. Prefer prose when it scored within
             -- $band of the session's best; outside that band the tool output
             -- really is the better evidence and still wins. Ranking is
             -- untouched — the session was already chosen.
             ORDER BY CASE WHEN role IN ('user', 'assistant') AND s <= sbest + $band
                           THEN 0 ELSE 1 END,
                      s ASC, mid ASC
           ) AS rn
           FROM scored
         ) WHERE rn = 1
       )
       SELECT best.mid AS mid, agg.best AS best, agg.n AS n
       FROM best
       JOIN agg ON agg.sid = best.sid
       JOIN sessions ON sessions.id = best.sid
       ORDER BY (-agg.best + 2.0 * ln(1 + agg.n)) DESC,
                sessions.updated_at DESC, sessions.id ASC
       LIMIT $limit`,
    )
    .all({
      $match: match,
      $limit: limit,
      $pool: poolSize(limit),
      $band: CITATION_BAND,
      ...filters.bindings,
    }) as {
    mid: number;
    best: number;
    n: number;
  }[];
  if (picked.length === 0) return [];

  const ids = picked.map((row) => row.mid);
  const snippets = new Map<number, string>();
  for (const row of db
    .query(
      `SELECT messages_fts.rowid AS mid,
              snippet(messages_fts, 0, $start, $end, $ellipsis, $tokens) AS snippet
       FROM messages_fts
       WHERE messages_fts MATCH $match AND messages_fts.rowid IN (${ids.join(",")})`,
    )
    .all({ $match: match, ...markBindings(marks) }) as { mid: number; snippet: string }[]) {
    snippets.set(row.mid, row.snippet);
  }

  const rows = db
    .query(
      `SELECT messages.id AS mid, sessions.source_path AS sourcePath, messages.line AS line,
              sessions.agent AS agent, sessions.workspace AS workspace, sessions.title AS title,
              sessions.created_at AS createdAt, sessions.session_id AS sessionId,
              messages.ordinal AS ordinal, messages.role AS role,
              messages.truncated AS truncated, sessions.thread_source AS threadSource,
              sessions.originator AS originator
       FROM messages
       JOIN sessions ON sessions.id = messages.session_id
       WHERE messages.id IN (${ids.join(",")})`,
    )
    .all() as Record<string, unknown>[];
  const byId = new Map(rows.map((row) => [row["mid"] as number, row]));

  // The rank order is the pick order; the lookups above only add detail.
  return picked.flatMap((entry) => {
    const row = byId.get(entry.mid);
    if (row === undefined) return [];
    return [
      {
        ...row,
        snippet: snippets.get(entry.mid) ?? "",
        score: entry.best,
      } as unknown as SearchHit,
    ];
  });
}



/**
 * The query-less listing. `search "" --workspace X --days 7` is the
 * documented idiom for "everything in scope", and a query of only
 * punctuation or operators reduces to the same thing. It is an index scan
 * rather than a match, so there is no rank to sort by and no term to
 * highlight: newest first, and the excerpt is the head of the body.
 * Returning nothing here would be the worst answer — an agent reads it as
 * "the archive holds nothing about this workspace".
 */
function scanRecent(db: Database, options: SearchOptions): SearchResult {
  const filters = sessionFilters(options);
  const hits = db
    .query(
      `SELECT sessions.source_path AS sourcePath, messages.line AS line,
              sessions.agent AS agent, sessions.workspace AS workspace,
              sessions.title AS title,
              substr(messages.body, 1, 200) AS snippet,
              0.0 AS score, sessions.created_at AS createdAt,
              sessions.session_id AS sessionId, messages.ordinal AS ordinal,
              messages.role AS role, messages.truncated AS truncated, sessions.thread_source AS threadSource,
              sessions.originator AS originator, 'message' AS matchedOn
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
  return { hits: asBoolean(hits) };
}

/** SQLite stores the flag as 0/1; the contract says boolean. Normalise once
 * here so no caller has to remember which it is. */
function asBoolean(hits: SearchHit[]): SearchHit[] {
  for (const hit of hits) hit.truncated = Boolean(hit.truncated);
  return hits;
}

export function search(db: Database, options: SearchOptions): SearchResult {
  const parsed = parseQuery(options.query);
  if (parsed.match === null) return scanRecent(db, options);
  const offset = options.offset ?? 0;
  const hits = messageMatches(
    db,
    parsed.match,
    offset + options.limit,
    options,
    options.marks ?? DEFAULT_MARKS,
  );
  return { hits: asBoolean(hits.slice(offset)) };
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
