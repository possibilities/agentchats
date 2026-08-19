import type { ResumeTarget } from "./resume.ts";

/**
 * The surface handoff: a committed pick leaves as one session directive — a
 * JSON line written to stdout, which the host holds as a pipe while the TUI
 * renders on stderr — and the host realizes it on the surface. Agentchats
 * never calls herdr or agentsurface; the directive stream carries
 * everything the surface needs. The `surface-handoff-protocol` wiki page is
 * the contract; agentsurface/directive.schema.json is the executable format.
 */

export const DIRECTIVE_SCHEMA_VERSION = 1;

export interface SessionDirective {
  schema_version: number;
  cwd: string;
  worktree: boolean;
  focus: boolean;
  agent: { kind: string; args: string[] };
  /** The native session this directive continues. The host dedups on it: a
   * session already live on the surface is focused, not resumed again. */
  session_id: string;
  intent: string | null;
  record?: Record<string, unknown>;
}

/**
 * A resume directive: the session's own workspace as cwd (a worktree
 * session recorded its worktree, so resuming there is what carries the
 * worktree over — resume never mints a new one), the shim's --x-resume
 * spelling as the args, and no intent — the harness restores the session's
 * own model, effort, and conversation. Tab naming needs nothing here:
 * herdr's agent-detection hook names the tab from the resumed conversation.
 */
export function buildResumeDirective(
  target: ResumeTarget,
  record: { query: string; source_path: string },
): SessionDirective {
  return {
    schema_version: DIRECTIVE_SCHEMA_VERSION,
    cwd: target.cwd,
    worktree: false,
    focus: true,
    agent: { kind: target.kind, args: ["--x-resume", target.sessionId] },
    session_id: target.sessionId,
    intent: null,
    record: { tool: "agentchats", query: record.query, source_path: record.source_path },
  };
}

/** One directive, one line: a single atomic write to stdout per commit. */
export function directiveLine(directive: SessionDirective): string {
  return `${JSON.stringify(directive)}\n`;
}

/** Stdout belongs to the host: a stdout that is a terminal means no host is
 * reading, and the directive would print onto the operator's screen. */
export function assertHostedStdout(stdout: { isTTY?: boolean | undefined }): string | null {
  if (stdout.isTTY === true) {
    return [
      "agentchats search writes session directives to stdout, and stdout is a terminal",
      "run it under a surface host: agentsurface host -- agentchats search",
    ].join("\n");
  }
  return null;
}
