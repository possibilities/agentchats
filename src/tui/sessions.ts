import type { Database } from "bun:sqlite";
import { indexPath } from "../store/paths.ts";
import { openIndex } from "../store/schema.ts";
import { type SearchHit, search, sessions as listSessions } from "../store/query.ts";

/**
 * The index surface the picker stands on. This replaces a subprocess and a
 * JSON parser with one SQLite query, and most of what the old subprocess adapter
 * did disappears with it: there is no paging around an unscoped fallback,
 * because a workspace filter here means the workspace; no dedup by source
 * path, because a session is one row; and no reading transcript prefixes to
 * classify a Codex thread, because ingest recorded its metadata.
 */

export interface SessionRow {
  agent: string;
  workspace: string;
  /** The native session file the index read. */
  path: string;
  title: string;
  /** Display timestamp, `YYYY-MM-DD HH:MM` or "". */
  when: string;
  snippet: string | null;
  line: number | null;
  /** Enrichment from `agentsurface conversation describe`: the fleet's
   * stored slug and first-prompt excerpt; null until described, and for
   * connectors the fleet does not name. */
  slug: string | null;
  excerpt: string | null;
}

export type TimeWindow = "all" | "today" | "week";

export interface VisibleRowsRequest {
  query: string;
  scope: string | null;
  window: TimeWindow;
  limit: number;
  includeAuxiliary: boolean;
}

export type VisibleRowsResult =
  | { ok: true; rows: SessionRow[] }
  | { ok: false; error: string };

/** The picker opens the index read-only and tolerates its absence: a machine
 * that has never indexed gets a message, not a stack trace. */
export function openPickerIndex(env: Record<string, string | undefined>): Database | null {
  try {
    return openIndex(indexPath(env));
  } catch {
    return null;
  }
}

function stamp(value: string): string {
  return value.length >= 16 ? value.slice(0, 16).replace("T", " ") : "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function since(window: TimeWindow): string | undefined {
  if (window === "all") return undefined;
  const days = window === "today" ? 1 : 7;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Full-harness Codex sessions identify themselves as `user`, which always
 * wins — including in a workspace also used by an auxiliary producer. Any
 * other explicit source is auxiliary. Configured originators classify only
 * legacy metadata with no source; a session with neither fails open, because
 * hiding a resumable session is worse than showing an extra one.
 */
export function isAuxiliary(
  row: { agent: string; thread_source: string | null; originator: string | null },
  auxiliaryCodexOriginators: ReadonlySet<string>,
): boolean {
  if (row.agent !== "codex") return false;
  if (row.thread_source === "user") return false;
  if (row.thread_source !== null && row.thread_source !== "") return true;
  return row.originator !== null && auxiliaryCodexOriginators.has(row.originator);
}

/**
 * The classification metadata for a page of rows. Ingest recorded it, so the
 * picker reads two columns instead of the first 64 KB of every transcript —
 * the single biggest reason a listing repaints instantly now.
 */
function classifications(
  db: Database,
  paths: readonly string[],
): Map<string, { agent: string; thread_source: string | null; originator: string | null }> {
  const found = new Map<string, { agent: string; thread_source: string | null; originator: string | null }>();
  if (paths.length === 0) return found;
  const rows = db
    .query(
      `select source_path, agent, thread_source, originator from sessions
       where source_path in (${paths.map(() => "?").join(",")})`,
    )
    .all(...paths) as {
    source_path: string;
    agent: string;
    thread_source: string | null;
    originator: string | null;
  }[];
  for (const row of rows) {
    found.set(row.source_path, {
      agent: row.agent,
      thread_source: row.thread_source,
      originator: row.originator,
    });
  }
  return found;
}

/**
 * One page of rows for the picker: ranked hits when there is a query, recent
 * sessions when there is not. Auxiliary suppression happens in the same pass
 * and is cheap now, so the old geometric refetch is gone — the query simply
 * asks for more than it shows.
 */
export function loadVisibleRows(
  db: Database,
  request: VisibleRowsRequest,
  auxiliaryCodexOriginators: ReadonlySet<string> = new Set(),
): VisibleRowsResult {
  const window = since(request.window);
  const scope = {
    ...(request.scope !== null ? { workspace: request.scope } : {}),
    ...(window !== undefined ? { since: window } : {}),
  };
  // Auxiliary rows are dropped after ranking, so ask for enough that hiding
  // them cannot empty a page the operator expected to be full.
  const fetch = request.includeAuxiliary ? request.limit : request.limit * 3;
  try {
    const raw: SessionRow[] =
      request.query === ""
        ? listSessions(db, { limit: fetch, ...scope }).map((session) => ({
            agent: session.agent,
            workspace: session.workspace,
            path: session.path,
            title: text(session.title) || "(untitled)",
            when: stamp(session.modified),
            snippet: null,
            line: null,
            slug: null,
            excerpt: null,
          }))
        : collapseToSessions(search(db, { query: request.query, limit: fetch, offset: 0, ...scope }));

    if (request.includeAuxiliary) return { ok: true, rows: raw.slice(0, request.limit) };
    const meta = classifications(db, raw.map((row) => row.path));
    const rows = raw.filter((row) => {
      const found = meta.get(row.path);
      return found === undefined || !isAuxiliary(found, auxiliaryCodexOriginators);
    });
    return { ok: true, rows: rows.slice(0, request.limit) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A session matching in ten places is still one session: the picker picks
 * sessions, and the first hit per path is its best-ranked one, so the
 * collapse preserves the ranking. */
function collapseToSessions(hits: readonly SearchHit[]): SessionRow[] {
  const seen = new Set<string>();
  const rows: SessionRow[] = [];
  for (const hit of hits) {
    if (hit.sourcePath === "" || seen.has(hit.sourcePath)) continue;
    seen.add(hit.sourcePath);
    rows.push({
      agent: hit.agent,
      workspace: hit.workspace,
      path: hit.sourcePath,
      title: text(hit.title) || "(untitled)",
      when: stamp(hit.createdAt),
      snippet: text(hit.snippet) || null,
      line: hit.line,
      slug: null,
      excerpt: null,
    });
  }
  return rows;
}
