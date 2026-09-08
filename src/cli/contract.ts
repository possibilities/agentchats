import packageInfo from "../../package.json";
import { FIELD_SETS, HIT_FIELDS } from "./fields.ts";

export interface ContractArgument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  positional?: boolean;
  required?: boolean;
  choices?: string[];
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  csv?: boolean;
  format?: "path";
  direction?: "in" | "out";
  role?: "call" | "output-format" | "store-selection" | "meta";
  /** The terminal can infer its cwd; a shared MCP server cannot infer the caller's. */
  x_mcp_required?: boolean;
}

export interface ContractCommand {
  name: string;
  summary: string;
  audience: "agent" | "operator" | "internal";
  mutates: boolean;
  blocking?: boolean;
  guidance?: string;
  arguments: ContractArgument[];
  examples?: Array<{ invocation: string; description: string }>;
  x_output: "json" | "text" | "json-or-text";
  /** The existing bare-search picker has a separate operator grammar. */
  x_operator_arguments?: ContractArgument[];
}

const json: ContractArgument = {
  name: "--json", type: "boolean", role: "output-format",
  description: "Print this command's JSON result; search selects the producer query instead of the human picker.",
};
const workspace: ContractArgument = {
  name: "--workspace", type: "string", format: "path", direction: "in",
  description: "Filter one project using its reported workspace path. MCP requires an absolute path.",
};
const sourcePath: ContractArgument = {
  name: "source_path", type: "string", positional: true, required: true,
  format: "path", direction: "in",
  description: "The exact source_path returned by a hit, or path returned by sessions. MCP requires an absolute path.",
};
const line: ContractArgument = {
  name: "--line", type: "integer", minimum: 0, required: true,
  description: "The exact physical transcript line returned by a hit; lines in source files begin at one.",
};
const timeFilters: ContractArgument[] = [
  { name: "--agent", type: "string", choices: ["claude_code", "codex"], description: "Filter one of the two indexed harnesses." },
  { name: "--days", type: "integer", minimum: 0, description: "Include sessions from the last N days. An explicit since value takes precedence." },
  { name: "--since", type: "string", description: "Lower time bound: an ISO date or relative value such as -7d or 24h." },
  { name: "--until", type: "string", description: "Upper time bound: an ISO date or relative value such as -1d." },
];

const commands: ContractCommand[] = [
  {
    name: "index", summary: "Build or incrementally refresh the derived session index",
    audience: "agent", mutates: true, blocking: true, x_output: "json-or-text",
    guidance: "Refresh when the index is missing or relevant transcript changes make it stale. This can take time on a large corpus. Default indexing is incremental. Full discards only the derived database; it never removes transcripts. Cancellation retains completed session transactions and skips the unfinished pass's final pruning. A success:false report retains its failure details even when some sessions were indexed.",
    arguments: [
      { name: "--full", type: "boolean", description: "Discard the derived index and rebuild it from the configured transcript roots." },
      { name: "--retain-days", type: "integer", minimum: 0, description: "Also drop indexed sessions older than N days; source transcripts remain untouched." },
      json,
    ],
  },
  {
    name: "status", summary: "Inspect index counts, health, and freshness",
    audience: "agent", mutates: true, x_output: "json-or-text",
    guidance: "Returns a successful payload even for an empty index. Branch on healthy and stale, and inspect unavailableRoots. Opening a missing index may create its derived database and schema; it does not ingest transcripts.",
    arguments: [json],
  },
  {
    name: "search", summary: "Search ranked sessions with bounded excerpts and exact citations",
    audience: "agent", mutates: false, x_output: "json",
    guidance: "MCP always uses the producer query. Bare terminal search opens the existing human resume picker. One hit represents one session and cites its best matching message. Terms AND within one message. An empty query lists the filtered scope. Aggregate dimensions are independent facets, not a cross-product. Preserve source_path and line for view and expand.",
    arguments: [
      { name: "query", type: "string", positional: true, default: "", description: "FTS5 terms, quoted phrases, OR/NOT, or prefix wildcards. Empty means everything in the selected scope." },
      { name: "--limit", type: "integer", minimum: 0, default: 10, description: "Maximum ranked sessions returned." },
      { name: "--offset", type: "integer", minimum: 0, default: 0, description: "Skip this many ranked sessions for the next page." },
      workspace, ...timeFilters,
      { name: "--fields", type: "string", csv: true, description: `A named set (${Object.keys(FIELD_SETS).join(", ")}) or comma-joined hit fields: ${HIT_FIELDS.join(", ")}. line_number remains a supported alias for line.` },
      { name: "--max-content-length", type: "integer", minimum: 0, description: "Cap snippet and title length without truncating citation fields." },
      { name: "--aggregate", type: "string", csv: true, description: "Return counts for comma-joined agent, workspace, or date dimensions instead of hits." },
      json,
    ],
    x_operator_arguments: [
      { name: "query", type: "string", positional: true, description: "Optional starting query for the human picker." },
      workspace,
      { name: "--include-auxiliary", type: "boolean", description: "Include app-server, realtime, and child Codex threads in the human picker." },
    ],
    examples: [{ invocation: 'agentchats search "authentication timeout" --json --limit 5 --fields summary --max-content-length 400', description: "Find a bounded set of prior conversations." }],
  },
  {
    name: "sessions", summary: "List recent sessions in a selected scope",
    audience: "agent", mutates: false, x_output: "json",
    arguments: [
      { name: "--limit", type: "integer", minimum: 0, default: 20, description: "Maximum recent sessions returned." },
      workspace, ...timeFilters,
      { name: "--current", type: "boolean", role: "store-selection", description: "Use the terminal's current directory. MCP callers supply workspace explicitly." },
      json,
    ],
  },
  {
    name: "view", summary: "Read one indexed message at its exact source citation",
    audience: "agent", mutates: false, x_output: "json-or-text",
    guidance: "A truncated message is incomplete evidence. Full adds source_record from the original transcript when it remains readable; it does not replace body or change the citation.",
    arguments: [sourcePath, line, { name: "--full", type: "boolean", description: "Read the complete original source record behind this message." }, json],
  },
  {
    name: "expand", summary: "Read the neighboring messages around one cited hit",
    audience: "agent", mutates: false, x_output: "json-or-text",
    arguments: [sourcePath, line, { name: "--context", type: "integer", minimum: 0, default: 3, description: "Number of indexed messages before and after the anchor." }, json],
  },
  {
    name: "resume", summary: "Print a live session's native resume command",
    audience: "agent", mutates: false, x_output: "json-or-text",
    guidance: "Returns a command for human handoff; this tool never launches a harness or nested agent. Archived copies are readable but cannot be resumed.",
    arguments: [sourcePath, { name: "--shell", type: "boolean", role: "output-format", description: "Print the native shell invocation (also the default terminal format)." }, json],
  },
  {
    name: "state", summary: "Read a short Markdown account of recent work in one workspace",
    audience: "agent", mutates: false, x_output: "text",
    guidance: "Returns plain Markdown, or no text when the workspace has no sessions. The terminal defaults to its current Git project; MCP requires an explicit absolute workspace because its process does not know the caller's directory.",
    arguments: [
      { ...workspace, x_mcp_required: true },
      { name: "--budget", type: "integer", minimum: 60, default: 400, description: "Approximate token budget; at most ten recent session lines." },
    ],
  },
  {
    name: "guide", summary: "Read the authored command and workflow contract",
    audience: "agent", mutates: false, x_output: "json-or-text", arguments: [json],
  },
  {
    name: "mcp", summary: "Serve the producer MCP tools over stdio",
    audience: "internal", mutates: true, blocking: true, x_output: "text", arguments: [],
  },
];

export const CONTRACT = {
  contract_version: 1,
  meta: {
    name: "agentchats", version: packageInfo.version, audience: "agent",
    purpose: "Search and reread local Claude Code and Codex transcripts through a derived SQLite index.",
  },
  guidance: "Use Chats when prior decisions, debugging, or session context are relevant. Agents discover its MCP tools through the directly connected MCP server. Search bounded excerpts, then read exact source citations. The index is derived and can be stale; inspect status when freshness matters and refresh incrementally when needed. Native filesystem tools remain useful for exact source investigation. The operator CLI and human resume picker remain available.",
  concepts: {
    model: {
      scope: "Only Claude Code and Codex transcripts, plus explicitly configured archives. Live copies win over archived duplicates. Unavailable roots retain their indexed sessions.",
      evidence: "One ranked hit per session; source_path and line identify its best message. Truncated bodies require full source records for complete quotations.",
      self_invocation: "Exclude this tool's own invocations and their recorded output so search results do not rank their own echoes.",
    },
    output_contract: {
      envelope: {
        success: "Existing JSON commands return their command-specific object unchanged; state returns plain Markdown. There is no common success wrapper.",
        error: "Failures preserve {error:{code,message,hint}}. The terminal writes this object to stderr with stdout empty, except index reports which retain their partial data.",
        guide: "The new guide command uses {schema_version:1,ok:true,error:null,data:contract} as required by the fleet contract validator.",
      },
      exit_codes: { "0": "command completed; inspect index.success and status.healthy for their verdicts", "1": "domain, internal, or wholly failed index pass", "3": "no populated session index", "64": "usage fault" },
    },
    error_codes: [
      { code: "missing-index", meaning: "No populated index is available", recovery: "Run an incremental index pass, then retry the bounded read." },
      { code: "not-found", meaning: "The cited message or derivable native session ID is absent", recovery: "Check the exact source path and line; refresh a stale index when needed." },
      { code: "archived", meaning: "The transcript is a preserved copy", recovery: "Use view or expand; an archived copy cannot be resumed." },
      { code: "unsupported", meaning: "The session has no supported native resume invocation", recovery: "Read the transcript instead of launching a guessed command." },
      { code: "usage", meaning: "The invocation is invalid", recovery: "Read the guide and correct the arguments." },
      { code: "internal", meaning: "An unexpected local failure occurred", recovery: "Inspect the reported error; do not treat it as an empty search result." },
    ],
    read_only_commands: commands.filter((command) => !command.mutates).map((command) => command.name),
    agent_defaults: [
      "Use absolute paths and an explicit workspace for project-scoped reads.",
      "Start with a small limit and fields:summary; paginate with offset.",
      "Use source_path and line exactly as returned, and inspect truncated before quoting.",
      "Resume returns a human handoff command; it never starts another agent.",
    ],
  },
  global_arguments: [
    { name: "--help", type: "boolean", role: "meta", description: "Render command help." },
    { name: "--agent-help", type: "boolean", role: "meta", description: "Render the agent contract as text." },
    { name: "--agent-teaser", type: "boolean", role: "meta", description: "Render a short list of producer capabilities." },
    { name: "--help-json", type: "boolean", role: "meta", description: "Print the guide JSON document." },
  ] satisfies ContractArgument[],
  commands,
};

export function findCommand(name: string): ContractCommand | undefined {
  return CONTRACT.commands.find((command) => command.name === name);
}

/** The terminal parser and MCP mapper read the same authored arguments. */
export function parserSpec(command: ContractCommand): { value: string[]; boolean: string[] } {
  const flags = command.arguments.filter((argument) => !argument.positional);
  return {
    value: flags.filter((argument) => argument.type !== "boolean").map((argument) => argument.name.slice(2)),
    boolean: flags.filter((argument) => argument.type === "boolean").map((argument) => argument.name.slice(2)),
  };
}

export function guideValue(): Record<string, unknown> {
  return { schema_version: 1, ok: true, error: null, data: CONTRACT };
}
