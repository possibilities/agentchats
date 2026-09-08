import { CONTRACT, type ContractArgument, type ContractCommand } from "./contract.ts";

function argumentHelp(argument: ContractArgument): string {
  const value = argument.type === "boolean" ? "" : ` <${argument.type}>`;
  const defaults = argument.default === undefined ? "" : ` Default: ${JSON.stringify(argument.default)}.`;
  return `  ${argument.name}${value}\n    ${argument.description}${defaults}`;
}

export function commandHelp(command: ContractCommand): string {
  const sections = [
    `Usage: agentchats ${command.name} [arguments]`, "", command.summary,
    ...(command.guidance ? ["", command.guidance] : []),
    "", ...command.arguments.map(argumentHelp),
  ];
  if (command.x_operator_arguments) {
    sections.push("", "Bare terminal search opens the human picker:", ...command.x_operator_arguments.map(argumentHelp));
  }
  for (const example of command.examples ?? []) sections.push("", example.invocation, example.description);
  return `${sections.join("\n")}\n`;
}

export function topHelp(): string {
  return [
    "Usage: agentchats <command> [options]", "", CONTRACT.meta.purpose, "", "Commands:",
    ...CONTRACT.commands.map((command) => `  ${command.name.padEnd(10)} ${command.summary}${command.audience === "internal" ? " (internal)" : ""}`),
    "", "Run agentchats <command> --help for arguments. Bare search opens the human picker.",
    "The index is derived state; source transcripts and configured archives remain authoritative.", "",
  ].join("\n");
}

export function agentHelp(): string {
  return [
    CONTRACT.guidance, "", "Results:", ...Object.values(CONTRACT.concepts.output_contract.envelope), "",
    ...CONTRACT.concepts.agent_defaults, "",
    ...CONTRACT.commands.filter((command) => command.audience === "agent").map(commandHelp),
    "Errors:", ...CONTRACT.concepts.error_codes.map((error) => `${error.code}: ${error.meaning}. ${error.recovery}`), "",
  ].join("\n");
}

export function agentTeaser(): string {
  return `${CONTRACT.meta.name}: ${CONTRACT.meta.purpose}\n${CONTRACT.commands.filter((command) => command.audience === "agent").map((command) => command.name).join(", ")}\n`;
}
