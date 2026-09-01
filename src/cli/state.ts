import type { SessionSummary } from "../store/query.ts";

/**
 * The bearings dump: recent sessions for one workspace as a short markdown
 * section, newest first, for an agent re-orienting in a project. Markdown a
 * model reads directly, not JSON for a program — the structured surface is
 * `agentchats search --json`, and the runbook for it is the chats skill.
 *
 * The contract is shared with the other agent* state dumps: one workspace,
 * bounded by an approximate token budget, fast, offline, read-only, and
 * silent when the workspace has nothing. An empty section is the one output
 * an agent never needs to read.
 */

/** One session line is ~20 tokens; the header and trailer are ~30. Ten lines
 * is the ceiling regardless of budget: past that the dump stops being
 * bearings and starts being a search. */
export function sessionLimit(budget: number): number {
  return Math.min(10, Math.max(1, Math.floor((budget - 30) / 20)));
}

function title(session: SessionSummary): string {
  const collapsed = session.title.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(untitled)";
  return collapsed.length > 48 ? `${collapsed.slice(0, 47)}…` : collapsed;
}

export function renderState(workspace: string, sessions: readonly SessionSummary[]): string {
  if (sessions.length === 0) return "";
  const lines = sessions.map(
    (session) =>
      `- ${(session.modified || "unknown").slice(0, 16)} · ${session.agent} · ` +
      `${session.messageCount} msgs (${session.humanTurns} human) · ${title(session)}`,
  );
  return [
    `## chats — recent sessions in ${workspace}`,
    ...lines,
    `more: agentchats sessions --workspace ${workspace} --limit 10 --json · deeper: the chats skill`,
    "",
  ].join("\n");
}
