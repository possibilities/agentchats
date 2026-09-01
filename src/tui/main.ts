import { resolve } from "node:path";
import { runSearch } from "./app.ts";

/**
 * The resume picker's argument parsing. Reached from `agentchats search`
 * without `--json`: the CLI routes here and imports this module lazily, so an
 * agent running a JSON search never pays to load the terminal renderer.
 */

export function pickerUsage(): string {
  return [
    "Usage: agentchats search [query…] [--workspace <dir>] [--include-auxiliary]",
    "",
    "Live-search coding-agent sessions in the local index and resume the picked",
    "one on the herdr surface. Runs under a surface host, which reads one",
    "session directive from stdout: agentsurface host -- agentchats search",
    "",
    "Options:",
    "  --workspace <dir>   Project scope (default: the current git project)",
    "  --include-auxiliary Include app-server, realtime, and child Codex threads",
    "",
    "Add --json for ranked hits as JSON instead of the picker.",
  ].join("\n");
}

export async function runPicker(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  let workspace: string | null = null;
  let includeAuxiliary = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === "-h" || argument === "--help") {
      console.error(pickerUsage());
      return 0;
    }
    if (argument === "--workspace") {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error("agentchats search: --workspace needs a directory");
        return 64;
      }
      workspace = resolve(value);
      i++;
      continue;
    }
    if (argument === "--include-auxiliary") {
      includeAuxiliary = true;
      continue;
    }
    if (argument.startsWith("--")) {
      console.error(`agentchats search: unknown option "${argument}"`);
      console.error(pickerUsage());
      return 64;
    }
    words.push(argument);
  }
  return await runSearch(env, {
    query: words.join(" "),
    workspace,
    includeAuxiliary,
  });
}
