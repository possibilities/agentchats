/**
 * The cass surface the picker stands on: one search command and one
 * recent-sessions command, each a short-lived subprocess returning JSON.
 * The parse half is pure; only runCass touches a process. cass falls back
 * to an unscoped listing for an unmatched workspace and an index can carry
 * duplicate rows for one session file, so project scope filters and dedups
 * client-side — the same contract as `agentchats state`.
 */

export interface SessionRow {
  agent: string;
  workspace: string;
  /** The native session file cass indexed. */
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

export interface CassRunner {
  (args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
}

export type SessionClass = "full-harness" | "auxiliary" | "unknown";
export type SessionClassifier = (row: SessionRow) => Promise<SessionClass>;

export interface VisibleRowsRequest {
  query: string;
  scope: string | null;
  window: TimeWindow;
  limit: number;
  includeAuxiliary: boolean;
  /** Stops a stale live-search generation before it starts another cass page. */
  shouldContinue?: () => boolean;
}

export type VisibleRowsResult =
  | { ok: true; rows: SessionRow[] }
  | { ok: false; error: string };

/** Same resolution as the bash CLI: PATH first, ~/.local/bin as fallback. */
export function cassBinary(env: Record<string, string | undefined>): string | null {
  const found = Bun.which("cass", { PATH: env["PATH"] ?? "" });
  if (found !== null) return found;
  const home = env["HOME"];
  if (home === undefined || home === "") return null;
  const fallback = `${home}/.local/bin/cass`;
  return Bun.file(fallback).size > 0 ? fallback : null;
}

export function spawnRunner(binary: string): CassRunner {
  return async (args) => {
    try {
      const proc = Bun.spawn([binary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        const detail = stderr.trim().split("\n").pop() ?? "";
        return { ok: false, error: detail === "" ? `cass exited ${code}` : detail };
      }
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export type TimeWindow = "all" | "today" | "week";

export function searchArgs(
  query: string,
  scope: string | null,
  limit: number,
  window: TimeWindow = "all",
  offset = 0,
): string[] {
  const args = ["search", query, "--json", "--limit", String(limit), "--mode", "hybrid"];
  if (offset > 0) args.push("--offset", String(offset));
  if (window === "today") args.push("--days", "1");
  if (window === "week") args.push("--days", "7");
  if (scope !== null) args.push("--workspace", scope);
  return args;
}

export function sessionsArgs(
  scope: string | null,
  limit: number,
  window: TimeWindow = "all",
): string[] {
  const args = ["sessions", "--json", "--limit", String(limit)];
  if (window === "today") args.push("--since", "1d");
  if (window === "week") args.push("--since", "7d");
  if (scope !== null) args.push("--workspace", scope);
  return args;
}

function stamp(value: unknown): string {
  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
  }
  if (typeof value === "string" && value.length >= 16) {
    return value.slice(0, 16).replace("T", " ");
  }
  return "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function recordCount(stdout: string, key: "hits" | "sessions"): number {
  try {
    const records = (JSON.parse(stdout) as Record<string, unknown>)[key];
    return Array.isArray(records) ? records.length : 0;
  } catch {
    return 0;
  }
}

/** Search hits, in cass's order (score already applied server-side),
 * collapsed to one row per session: cass ranks messages, the picker picks
 * sessions, and a session matching in ten places is still one session. The
 * first hit per path is its best-ranked one, so order survives the
 * collapse. */
export function parseHits(stdout: string, scope: string | null): SessionRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const hits = (parsed as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const record = hit as Record<string, unknown>;
    const workspace = text(record["workspace"]);
    if (scope !== null && workspace !== scope) continue;
    const path = text(record["source_path"]);
    if (path === "") continue;
    if (seen.has(path)) continue;
    seen.add(path);
    rows.push({
      agent: text(record["agent"]),
      workspace,
      path,
      title: text(record["title"]) || "(untitled)",
      when: stamp(record["created_at"]),
      snippet: text(record["snippet"]) || null,
      line: typeof record["line_number"] === "number" ? record["line_number"] : null,
      slug: null,
      excerpt: null,
    });
  }
  return rows;
}

/** Recent sessions, newest first, collapsed to one row per session file. */
export function parseSessions(stdout: string, scope: string | null): SessionRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  const byPath = new Map<string, SessionRow & { modified: string }>();
  for (const session of sessions) {
    const record = session as Record<string, unknown>;
    const workspace = text(record["workspace"]);
    if (scope !== null && workspace !== scope) continue;
    const path = text(record["path"]);
    if (path === "") continue;
    const modified = typeof record["modified"] === "string" ? record["modified"] : "";
    const existing = byPath.get(path);
    if (existing !== undefined && existing.modified >= modified) continue;
    byPath.set(path, {
      agent: text(record["agent"]),
      workspace,
      path,
      title: text(record["title"]) || "(untitled)",
      when: stamp(modified),
      snippet: null,
      line: null,
      slug: null,
      excerpt: null,
      modified,
    });
  }
  return [...byPath.values()]
    .sort((a, b) => (a.modified < b.modified ? 1 : -1))
    .map(({ modified: _modified, ...row }) => row);
}

const ROLLOUT_PREFIX_BYTES = 64 * 1024;
const NO_AUXILIARY_ORIGINATORS = new Set<string>();

export interface RolloutMetadata {
  threadSource: string | null;
  originator: string | null;
}

export function rolloutMetadata(text: string): RolloutMetadata | undefined {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record["type"] !== "session_meta") continue;
    const payload = record["payload"];
    if (typeof payload !== "object" || payload === null) return undefined;
    const metadata = payload as Record<string, unknown>;
    const source = metadata["thread_source"] ?? metadata["threadSource"];
    const originator = metadata["originator"];
    return {
      threadSource: typeof source === "string" && source !== "" ? source : null,
      originator: typeof originator === "string" && originator !== "" ? originator : null,
    };
  }
  return undefined;
}

/** `undefined` means no readable session metadata; `null` is a legacy
 * session_meta with no thread source. */
export function rolloutThreadSource(text: string): string | null | undefined {
  return rolloutMetadata(text)?.threadSource;
}

async function rolloutPrefix(path: string): Promise<string> {
  const file = Bun.file(path);
  if (path.endsWith(".zst")) {
    const compressed = new Uint8Array(await file.arrayBuffer());
    const decompressed = await Bun.zstdDecompress(compressed);
    return new TextDecoder().decode(decompressed);
  }
  return await file.slice(0, ROLLOUT_PREFIX_BYTES).text();
}

/** Full harness Codex sessions identify themselves as `user`, which always
 * wins — including in a workspace also used by an auxiliary producer. Any
 * other explicit source is auxiliary. Configured originators classify only
 * legacy metadata with no source; unreadable metadata fails open. */
export async function classifySession(
  row: SessionRow,
  auxiliaryCodexOriginators: ReadonlySet<string> = NO_AUXILIARY_ORIGINATORS,
): Promise<SessionClass> {
  if (row.agent !== "codex") return "full-harness";
  try {
    const metadata = rolloutMetadata(await rolloutPrefix(row.path));
    if (metadata === undefined) return "unknown";
    if (metadata.threadSource === "user") return "full-harness";
    if (metadata.threadSource !== null) return "auxiliary";
    return metadata.originator !== null && auxiliaryCodexOriginators.has(metadata.originator)
      ? "auxiliary"
      : "full-harness";
  } catch {
    return "unknown";
  }
}

/** Cache only definitive answers. A file that was absent or incomplete on
 * first sight gets another chance after the next cass refresh. */
export function cachedSessionClassifier(
  classify: SessionClassifier = classifySession,
): SessionClassifier {
  const cache = new Map<string, Promise<SessionClass>>();
  return async (row) => {
    const key = `${row.agent}\0${row.path}`;
    const existing = cache.get(key);
    if (existing !== undefined) return await existing;
    const pending = classify(row).catch((): SessionClass => "unknown");
    cache.set(key, pending);
    const result = await pending;
    if (result === "unknown") cache.delete(key);
    return result;
  };
}

async function visibleRows(
  rows: SessionRow[],
  includeAuxiliary: boolean,
  classify: SessionClassifier,
): Promise<SessionRow[]> {
  if (includeAuxiliary) return rows;
  const classes = await Promise.all(rows.map((row) => classify(row)));
  return rows.filter((_row, index) => classes[index] !== "auxiliary");
}

async function loadSearchRows(
  runner: CassRunner,
  request: VisibleRowsRequest,
  classify: SessionClassifier,
): Promise<VisibleRowsResult> {
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (rows.length < request.limit && (request.shouldContinue?.() ?? true)) {
    const result = await runner(
      searchArgs(request.query, request.scope, request.limit, request.window, offset),
    );
    if (!result.ok) return result;
    if (!(request.shouldContinue?.() ?? true)) break;
    const count = recordCount(result.stdout, "hits");
    const unscoped = parseHits(result.stdout, null);
    const scoped = request.scope === null ? unscoped : parseHits(result.stdout, request.scope);
    // Cass answers an unmatched workspace with an unscoped fallback. It is
    // not a first page whose project matches might appear later.
    if (request.scope !== null && scoped.length === 0 && unscoped.length > 0) break;
    const page = await visibleRows(
      scoped.filter((row) => {
        if (seen.has(row.path)) return false;
        seen.add(row.path);
        return true;
      }),
      request.includeAuxiliary,
      classify,
    );
    rows.push(...page);
    if (count < request.limit || count === 0) break;
    offset += count;
  }
  return { ok: true, rows: rows.slice(0, request.limit) };
}

async function loadRecentRows(
  runner: CassRunner,
  request: VisibleRowsRequest,
  classify: SessionClassifier,
): Promise<VisibleRowsResult> {
  let fetchLimit = request.limit;
  while (request.shouldContinue?.() ?? true) {
    const result = await runner(sessionsArgs(request.scope, fetchLimit, request.window));
    if (!result.ok) return result;
    if (!(request.shouldContinue?.() ?? true)) break;
    const count = recordCount(result.stdout, "sessions");
    const rows = await visibleRows(
      parseSessions(result.stdout, request.scope),
      request.includeAuxiliary,
      classify,
    );
    if (rows.length >= request.limit || count < fetchLimit || count === 0) {
      return { ok: true, rows: rows.slice(0, request.limit) };
    }
    fetchLimit *= 4;
  }
  return { ok: true, rows: [] };
}

/** The picker asks cass for ranked pages until hidden auxiliary sessions no
 * longer consume its visible limit. Recent listings grow geometrically
 * because cass has no offset on `sessions`; content searches page by offset. */
export async function loadVisibleRows(
  runner: CassRunner,
  request: VisibleRowsRequest,
  classify: SessionClassifier,
): Promise<VisibleRowsResult> {
  return request.query === ""
    ? await loadRecentRows(runner, request, classify)
    : await loadSearchRows(runner, request, classify);
}
