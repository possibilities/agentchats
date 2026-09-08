import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import { type Parsed, UsageError } from "./args.ts";
import { CONTRACT, type ContractArgument, type ContractCommand } from "./contract.ts";

function propertyName(argument: ContractArgument): string {
  return argument.name.replace(/^--/, "");
}

function property(argument: ContractArgument): z.ZodType {
  let scalar: z.ZodType;
  if (argument.choices) scalar = z.enum(argument.choices as [string, ...string[]]);
  else if (argument.type === "string") scalar = z.string();
  else if (argument.type === "boolean") scalar = z.boolean();
  else {
    let number = argument.type === "integer" ? z.number().int() : z.number();
    if (argument.minimum !== undefined) number = number.min(argument.minimum);
    if (argument.maximum !== undefined) number = number.max(argument.maximum);
    scalar = number;
  }
  const description = argument.description +
    (argument.csv ? " Values are comma-joined in one string." : "") +
    (argument.format === "path" ? " Use an absolute path; this server does not know the caller's directory." : "");
  const described = scalar.describe(description);
  const input = argument.required || argument.x_mcp_required ? described : described.optional();
  // Let the shared handler apply defaults without creating explicit flags.
  return argument.default === undefined ? input : input.meta({ default: argument.default });
}

export function agentTools() {
  return CONTRACT.commands.filter((command) => command.audience === "agent").map((command) => {
    const args: ContractArgument[] = [...command.arguments, ...CONTRACT.global_arguments]
      .filter((argument) => (argument.role ?? "call") === "call");
    const shape: Record<string, z.ZodType> = {};
    for (const argument of args) shape[propertyName(argument)] = property(argument);
    return {
      name: command.name,
      command,
      arguments: args,
      title: command.summary,
      description: [
        ...(command.blocking ? ["Blocks: a large index pass can take time; cancellation stops between completed session transactions."] : []),
        command.summary,
        `Runs the shared agentchats ${command.name} handler in this process.`,
        ...(command.guidance ? [command.guidance] : []),
      ].join("\n\n"),
      input: z.strictObject(shape),
      annotations: {
        readOnlyHint: !command.mutates,
        destructiveHint: command.name === "index",
        idempotentHint: command.name !== "index",
        openWorldHint: false,
      },
    };
  });
}

export type AgentTool = ReturnType<typeof agentTools>[number];

/** No argv construction, shell parsing, or CLI subprocess sits behind a tool. */
export function invocationFor(tool: AgentTool, input: Record<string, unknown>): Parsed {
  const parsed: Parsed = { positional: [], values: {}, flags: new Set() };
  for (const argument of tool.arguments) {
    const name = propertyName(argument);
    const value = input[name];
    if (value === undefined) continue;
    if (argument.format === "path" && !isAbsolute(String(value))) {
      throw new UsageError(`${name} requires an absolute path for MCP`);
    }
    if (argument.positional) parsed.positional.push(String(value));
    else if (argument.type === "boolean") {
      if (value === true) parsed.flags.add(name);
    } else parsed.values[name] = String(value);
  }
  return parsed;
}

export function serverInstructions(): string {
  return [
    CONTRACT.guidance,
    ...Object.values(CONTRACT.concepts.output_contract.envelope),
    "MCP preserves each JSON object in structuredContent and standalone JSON text. Markdown remains plain text. Errors set isError and preserve the original {error:{code,message,hint}} object; diagnostic prose is separate. An incomplete index report also sets isError while retaining its original success:false and failures fields.",
    "Index progress is available through MCP progress notifications when the caller supplies a progress token. Cancellation or connection shutdown stops the pass between complete session transactions and skips final pruning; completed work is retained. Calls in this server run sequentially so a rebuild cannot race its own readers.",
    "The process uses one startup environment to select its index, transcript roots, and archive configuration file. Tools do not accept HOME, database, or credential overrides. Supply an explicit absolute workspace for state; sessions uses workspace instead of the terminal-only current flag.",
    ...CONTRACT.concepts.error_codes.map((error) => `${error.code}: ${error.meaning}. ${error.recovery}`),
    ...CONTRACT.concepts.agent_defaults,
  ].join("\n\n");
}

export function jsonOutput(command: ContractCommand, value: Record<string, unknown>): boolean {
  return command.name !== "index" || value["success"] !== false;
}
