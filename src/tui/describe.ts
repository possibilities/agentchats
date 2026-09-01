import type { SessionRow } from "./sessions.ts";
import { resumeKind } from "./resume.ts";

/**
 * Row enrichment through `agentsurface conversation describe` — the fleet's
 * read-only naming surface: the stored slug (computed once by tab naming,
 * never here) and the first-prompt excerpt per transcript. One subprocess
 * per listing refresh. A machine without agentsurface, or a failing call,
 * enriches nothing: the rows keep the indexed title, which is the fallback text
 * anyway.
 */

export interface Description {
  slug: string | null;
  excerpt: string | null;
}

/** Requests for the fleet-named harnesses only; other connectors have no
 * transcripts agentsurface can read. */
export function describeRequests(rows: readonly SessionRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const kind = resumeKind(row.agent);
    if (kind === null) continue;
    lines.push(JSON.stringify({ harness: kind, path: row.path }));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function parseDescriptions(stdout: string): Map<string, Description> {
  const byPath = new Map<string, Description>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as { path?: unknown; slug?: unknown; excerpt?: unknown };
    if (typeof record.path !== "string") continue;
    byPath.set(record.path, {
      slug: typeof record.slug === "string" ? record.slug : null,
      excerpt: typeof record.excerpt === "string" ? record.excerpt : null,
    });
  }
  return byPath;
}

/** Merge in place; rows without an answer keep their indexed text. */
export function applyDescriptions(
  rows: SessionRow[],
  descriptions: Map<string, Description>,
): void {
  for (const row of rows) {
    const description = descriptions.get(row.path);
    if (description === undefined) continue;
    row.slug = description.slug;
    row.excerpt = description.excerpt;
  }
}

export async function fetchDescriptions(
  rows: readonly SessionRow[],
  env: Record<string, string | undefined>,
): Promise<Map<string, Description>> {
  const requests = describeRequests(rows);
  if (requests === "") return new Map();
  const binary = Bun.which("agentsurface", { PATH: env["PATH"] ?? "" });
  if (binary === null) return new Map();
  try {
    const proc = Bun.spawn([binary, "conversation", "describe"], {
      stdin: new TextEncoder().encode(requests),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return new Map();
    return parseDescriptions(stdout);
  } catch {
    return new Map();
  }
}
