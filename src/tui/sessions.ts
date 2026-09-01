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
  row: { agent: string; threadSource: string | null; originator: string | null },
  auxiliaryCodexOriginators: ReadonlySet<string>,
): boolean {
  if (row.agent !== "codex") return false;
  if (row.threadSource === "user") return false;
  if (row.threadSource !== null && row.threadSource !== "") return true;
  return row.originator !== null && auxiliaryCodexOriginators.has(row.originator);
}

/**
 * One page of rows for the picker: ranked hits when there is a query, recent
 * sessions when there is not. The classification rides on the row itself —
 * ingest recorded it — so suppressing auxiliary sessions costs a predicate
 * rather than the 64 KB transcript read per row it used to.
 */
export function loadVisibleRows(
  db: Database,
  request: VisibleRowsRequest,
  auxiliaryCodexOriginators: ReadonlySet<string> = new Set(),
): VisibleRowsResult {
  const window = since(request.window);
  const scope = {
    // The picker resumes; an archived copy cannot be resumed, so offering one
    // would only produce a fatal error on the pick.
    resumableOnly: true as const,
    ...(request.scope !== null ? { workspace: request.scope } : {}),
    ...(window !== undefined ? { since: window } : {}),
  };
  // Auxiliary rows are dropped after ranking, so ask for enough that hiding
  // them cannot empty a page the operator expected to be full.
  const fetch = request.includeAuxiliary ? request.limit : request.limit * 3;
  const keep = (row: { agent: string; threadSource: string | null; originator: string | null }): boolean =>
    request.includeAuxiliary || !isAuxiliary(row, auxiliaryCodexOriginators);
  try {
    if (request.query === "") {
      return {
        ok: true,
        rows: listSessions(db, { limit: fetch, ...scope })
          .filter(keep)
          .slice(0, request.limit)
          .map((session) => ({
            agent: session.agent,
            workspace: session.workspace,
            path: session.path,
            title: text(session.title) || "(untitled)",
            when: stamp(session.modified),
            snippet: null,
            line: null,
            slug: null,
            excerpt: null,
          })),
      };
    }
    const hits = search(db, { query: request.query, limit: fetch, offset: 0, ...scope }).hits.filter(keep);
    return { ok: true, rows: collapseToSessions(hits, request.limit) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A session matching in ten places is still one session: the picker picks
 * sessions, and the first hit per path is its best-ranked one, so the
 * collapse preserves the ranking. */
function collapseToSessions(hits: readonly SearchHit[], limit: number): SessionRow[] {
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
    if (rows.length >= limit) break;
  }
  return rows;
}
