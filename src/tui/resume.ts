/**
 * What it takes to resume a picked session on the surface, and every way it
 * can be impossible. The rule is fatal errors over fallbacks: a session that
 * cannot be resumed faithfully — unknown connector, no derivable native
 * session id, a session file or workspace that is gone — refuses with a
 * reason, and the app exits nonzero so the host holds the message on
 * screen. Nothing here degrades to "launch something similar".
 */

import type { SessionRow } from "./cass.ts";

/** The herdr agent kinds the fleet can resume, by cass connector name. */
const RESUMABLE: Record<string, "claude" | "codex"> = {
  claude_code: "claude",
  codex: "codex",
};

export type ResumeKind = "claude" | "codex";

export interface ResumeTarget {
  kind: ResumeKind;
  sessionId: string;
  /** The session's recorded workspace: the directive's cwd. */
  cwd: string;
}

export type ResumeOutcome = { ok: true; target: ResumeTarget } | { ok: false; reason: string };

export function resumeKind(agent: string): ResumeKind | null {
  return RESUMABLE[agent] ?? null;
}

/** Native session ids are glob-literal in every store agentlaunch scans. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The native session id, from the store layouts agentlaunch resumes from:
 *   claude  projects/<slug>/<id>.jsonl
 *   codex   sessions/.../rollout-<stamp>-<uuid>.jsonl[.zst]
 */
export function deriveSessionId(kind: ResumeKind, sourcePath: string): string | null {
  const base = sourcePath.split("/").pop() ?? "";
  switch (kind) {
    case "claude": {
      const match = base.match(/^(.+)\.jsonl$/);
      const id = match?.[1];
      return id !== undefined && SESSION_ID.test(id) ? id : null;
    }
    case "codex": {
      const match = base.match(
        new RegExp(`^rollout-.+-(${UUID.source})\\.jsonl(\\.zst)?$`, "i"),
      );
      return match?.[1] ?? null;
    }
  }
}

export interface ResumeProbes {
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
}

/** Judge one picked row. Filesystem truth arrives as probes so the
 * judgment itself stays pure and testable. */
export function resumeTarget(row: SessionRow, probes: ResumeProbes): ResumeOutcome {
  const kind = resumeKind(row.agent);
  if (kind === null) {
    return {
      ok: false,
      reason: `${row.agent} sessions cannot be resumed on the surface — only claude and codex can`,
    };
  }
  const sessionId = deriveSessionId(kind, row.path);
  if (sessionId === null) {
    return {
      ok: false,
      reason: `no native session id is derivable from ${row.path}`,
    };
  }
  if (!probes.fileExists(row.path)) {
    return {
      ok: false,
      reason: `the session file is gone from the ${kind} store: ${row.path} (the cass index is stale; run cass index)`,
    };
  }
  if (row.workspace === "" || !probes.directoryExists(row.workspace)) {
    return {
      ok: false,
      reason: `the session's workspace no longer exists: ${row.workspace === "" ? "(unrecorded)" : row.workspace}`,
    };
  }
  return { ok: true, target: { kind, sessionId, cwd: row.workspace } };
}
