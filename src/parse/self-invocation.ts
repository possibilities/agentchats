/** A command that runs this tool, or the one it replaced. A subcommand is
 * required so prose that merely names agentchats remains searchable. */
const SELF_INVOCATION =
  /\b(?:agentchats|cass)\s+(?:search|sessions|state|view|expand|resume|index|status|triage|pack)\b/;

function structuredInputContainsSelfInvocation(value: unknown): boolean {
  if (typeof value === "string") {
    if (SELF_INVOCATION.test(value)) return true;
    // Codex function-call arguments are JSON serialized before they reach
    // the transcript. Decode them so a command after `\n` is tested after a
    // real newline, not after the escape's word-character `n`.
    try {
      const decoded: unknown = JSON.parse(value);
      return decoded !== value && structuredInputContainsSelfInvocation(decoded);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(structuredInputContainsSelfInvocation);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(structuredInputContainsSelfInvocation);
}

/** Test both the rendered tool call retained by the index and its structured
 * input. JSON rendering escapes newlines, so the latter is required to see a
 * command whose executable begins on a later line. */
export function isSelfInvocation(rendered: string, input: unknown): boolean {
  return SELF_INVOCATION.test(rendered) || structuredInputContainsSelfInvocation(input);
}
