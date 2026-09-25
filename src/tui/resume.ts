/** Native resume identities for the indexed Claude and Codex transcripts. */
const RESUMABLE: Record<string, "claude" | "codex"> = {
  claude_code: "claude",
  codex: "codex",
};

export type ResumeKind = "claude" | "codex";

export function resumeKind(agent: string): ResumeKind | null {
  return RESUMABLE[agent] ?? null;
}

/** Native session ids are glob-literal in each harness store. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The native session id, from the harness store layouts:
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
