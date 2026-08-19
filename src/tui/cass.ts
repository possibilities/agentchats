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
}

export interface CassRunner {
  (args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
}

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

export function searchArgs(query: string, scope: string | null, limit: number): string[] {
  const args = ["search", query, "--json", "--limit", String(limit), "--mode", "hybrid"];
  if (scope !== null) args.push("--workspace", scope);
  return args;
}

export function sessionsArgs(scope: string | null, limit: number): string[] {
  const args = ["sessions", "--json", "--limit", String(limit)];
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

/** Search hits, in cass's order (score already applied server-side). */
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
  for (const hit of hits) {
    const record = hit as Record<string, unknown>;
    const workspace = text(record["workspace"]);
    if (scope !== null && workspace !== scope) continue;
    const path = text(record["source_path"]);
    if (path === "") continue;
    rows.push({
      agent: text(record["agent"]),
      workspace,
      path,
      title: text(record["title"]) || "(untitled)",
      when: stamp(record["created_at"]),
      snippet: text(record["snippet"]) || null,
      line: typeof record["line_number"] === "number" ? record["line_number"] : null,
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
      modified,
    });
  }
  return [...byPath.values()]
    .sort((a, b) => (a.modified < b.modified ? 1 : -1))
    .map(({ modified: _modified, ...row }) => row);
}
