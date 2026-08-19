#!/usr/bin/env bun
import { resolve } from "node:path";
import { runSearch } from "./app.ts";

/**
 * `agentchats search [query…] [--workspace <dir>]` — the surface-hosted
 * resume picker. The bash CLI dispatches here; this file only parses the
 * few arguments and hands the terminal to the app.
 */

function usage(): string {
  return [
    "Usage: agentchats search [query…] [--workspace <dir>]",
    "",
    "Live-search coding-agent sessions via cass and resume the picked one on",
    "the herdr surface. Runs under a surface host, which reads one session",
    "directive from stdout: agentsurface host -- agentchats search",
    "",
    "Options:",
    "  --workspace <dir>   Project scope (default: the current git project)",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  let workspace: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === "-h" || argument === "--help") {
      console.error(usage());
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
    if (argument.startsWith("--")) {
      console.error(`agentchats search: unknown option "${argument}"`);
      console.error(usage());
      return 64;
    }
    words.push(argument);
  }
  return await runSearch(process.env, { query: words.join(" "), workspace });
}

process.exit(await main(process.argv.slice(2)));
