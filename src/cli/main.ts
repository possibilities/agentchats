#!/usr/bin/env bun
import { parseArgs, UsageError } from "./args.ts";
import { commandError, EXIT, runPrepared } from "./commands.ts";
import { findCommand, guideValue, parserSpec } from "./contract.ts";
import { agentHelp, agentTeaser, commandHelp, topHelp } from "./help.ts";

async function main(argv: string[]): Promise<number> {
  const name = argv[0];
  if (name === undefined || name === "--help" || name === "-h") {
    process.stdout.write(topHelp());
    return EXIT.ok;
  }
  if (name === "--agent-help" || name === "--agent-teaser" || name === "--help-json") {
    process.stdout.write(name === "--agent-help" ? agentHelp() : name === "--agent-teaser" ? agentTeaser() : `${JSON.stringify(guideValue())}\n`);
    return EXIT.ok;
  }
  const command = findCommand(name);
  if (!command) {
    console.error(`agentchats: unknown command "${name}"; run agentchats --help`);
    return EXIT.usage;
  }
  const rest = argv.slice(1);
  try {
    // Preserve the existing operator picker, including its own help and input grammar.
    if (name === "search" && !rest.includes("--json")) {
      const { runPicker } = await import("../tui/main.ts");
      return await runPicker(rest, process.env);
    }
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(commandHelp(command));
      return EXIT.ok;
    }
    const parsed = parseArgs(rest, parserSpec(command));
    if (name === "mcp") {
      if (parsed.positional.length > 0) throw new UsageError("mcp accepts no positional arguments");
      const { serveAgentchatsMcp } = await import("./mcp.ts");
      await serveAgentchatsMcp();
      return EXIT.ok;
    }
    const output = await runPrepared(name, parsed, process.env);
    const text = typeof output.value === "string"
      ? output.value
      : parsed.flags.has("json") || command.x_output === "json"
        ? `${JSON.stringify(output.value)}\n`
        : output.human?.() ?? "";
    process.stdout.write(text);
    return output.exitCode;
  } catch (error) {
    const failure = commandError(error, name);
    console.error(JSON.stringify(failure.value));
    return failure.exitCode;
  }
}

process.exit(await main(process.argv.slice(2)));
