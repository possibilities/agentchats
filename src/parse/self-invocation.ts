/** A command that runs this tool, or the one it replaced. A subcommand is
 * required so prose that merely names agentchats remains searchable. */
const SELF_INVOCATION =
  /\b(?:agentchats|cass)\s+(?:search|sessions|state|view|expand|resume|index|status|guide|triage|pack)\b/;

// The normal native-MCP and discovered Executor call spellings. Test calls,
// not mentions of the integration, so unrelated discovery and prose survive.
const SELF_NATIVE_MCP = /\bmcp__agentchats__(?:search|sessions|state|view|expand|resume|index|status|guide)\b/;
const SELF_EXECUTOR = /\btools\s*(?:\[\s*["'](?:tools\.)?agentchats\.[\w-]+\.[\w-]+\.(?:search|sessions|state|view|expand|resume|index|status|guide)["']\s*\]|\.agentchats\.[\w-]+\.[\w-]+\.(?:search|sessions|state|view|expand|resume|index|status|guide))\s*\(/;

function containsInvocation(value: string): boolean {
  return SELF_INVOCATION.test(value) || SELF_NATIVE_MCP.test(value) || SELF_EXECUTOR.test(value);
}

function structuredInputContainsSelfInvocation(value: unknown): boolean {
  if (typeof value === "string") {
    if (containsInvocation(value)) return true;
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
  return containsInvocation(rendered) || structuredInputContainsSelfInvocation(input);
}
