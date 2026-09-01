#!/usr/bin/env bun
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { daysAgo, integer, parseArgs, resolveWhen, UsageError } from "./args.ts";
import { renderState, sessionLimit } from "./state.ts";
import { FIELD_SETS, HIT_FIELDS, project, truncate } from "./fields.ts";
import { indexPath } from "../store/paths.ts";
import { openIndex } from "../store/schema.ts";
import { ingest, type ParserBinding, pendingWork } from "../store/ingest.ts";
import {
  aggregate,
  type AggregateDimension,
  type SearchHit,
  type SessionSummary,
  search,
  sessions as listSessions,
  status,
} from "../store/query.ts";
import { parseClaude } from "../parse/claude.ts";
import { parseCodex, readRollout } from "../parse/codex.ts";
import { deriveSessionId, resumeKind } from "../tui/resume.ts";
import { type ArchiveRoot, loadAgentchatsConfig } from "../tui/config.ts";
import { MESSAGE_BODY_CAP } from "../parse/types.ts";

/** The two transcript stores, and the parser that reads each. Nothing else
 * is discovered: other agents' histories are out of scope by decision, not
 * by omission. */
function liveSources(
  env: Record<string, string | undefined>,
  archives: readonly ArchiveRoot[] = [],
): { roots: string[]; parsers: Record<string, ParserBinding> } {
  const home = env["HOME"] ?? "";
  const claude = resolve(home, ".claude/projects");
  const codex = resolve(home, ".codex/sessions");
  const parsers: Record<string, ParserBinding> = {
    claude_code: { root: claude, parse: parseClaude, read: (path) => Bun.file(path).text() },
    codex: { root: codex, parse: parseCodex, read: readRollout },
  };
  // Live roots first: when the same session exists in both, the live copy
  // wins, because it is the one the harness can still resume.
  const roots = [claude, codex];
  archives.forEach((archive, index) => {
    roots.push(archive.path);
    parsers[`archive-${index}`] = {
      root: archive.path,
      archived: true,
      parse: archive.agent === "codex" ? parseCodex : parseClaude,
      read: archive.agent === "codex" ? readRollout : (path) => Bun.file(path).text(),
    };
  });
  return { roots, parsers };
}

/** The wire shape agents parse. Internally the store speaks camelCase like
 * the rest of the codebase; the JSON contract is snake_case because that is
 * what the chats skill documents and what every caller already reads. */
function hitJson(hit: SearchHit): Record<string, unknown> {
  return {
    source_path: hit.sourcePath,
    line: hit.line,
    agent: hit.agent,
    workspace: hit.workspace,
    title: hit.title,
    snippet: hit.snippet,
    score: hit.score,
    created_at: hit.createdAt,
    session_id: hit.sessionId,
    ordinal: hit.ordinal,
    role: hit.role,
    truncated: hit.truncated,
  };
}

function sessionJson(session: SessionSummary): Record<string, unknown> {
  return {
    path: session.path,
    agent: session.agent,
    workspace: session.workspace,
    title: session.title,
    modified: session.modified,
    message_count: session.messageCount,
    human_turns: session.humanTurns,
    session_id: session.sessionId,
  };
}

/** `exactOptionalPropertyTypes` forbids handing an explicit undefined to an
 * optional field, so absent filters are omitted rather than passed empty. */
function filters(values: {
  workspace?: string | undefined;
  agent?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
}): { workspace?: string; agent?: string; since?: string; until?: string } {
  return {
    ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
    ...(values.agent !== undefined ? { agent: values.agent } : {}),
    ...(values.since !== undefined ? { since: values.since } : {}),
    ...(values.until !== undefined ? { until: values.until } : {}),
  };
}

/**
 * The agentchats command surface. Two audiences share one binary: an agent
 * reading JSON, and a human driving the picker. `search` is where they meet —
 * bare it opens the picker, `--json` makes it the agent surface — because the
 * herdr plugin invokes `agentchats search` and that contract predates this
 * index.
 *
 * Every command here is read-only except `index`. Failures leave stdout empty
 * and put a structured envelope on stderr, so a caller can branch on the exit
 * code and then on `error.code` without scraping prose.
 */

const EXIT = { ok: 0, error: 1, missingIndex: 3, usage: 64 } as const;

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
    readonly exitCode: number = EXIT.error,
  ) {
    super(message);
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * The index is derived state, so a missing one is a recoverable condition
 * with an exact next command, never a crash. Opening also creates the file,
 * which means "does not exist" and "exists but was never built" arrive here
 * looking identical — and answering an agent's search with a confident empty
 * result when nothing has ever been indexed is the worse of the two lies.
 * Both are reported as missing-index.
 */
function open(env: Record<string, string | undefined>): Database {
  const path = indexPath(env);
  let db: Database;
  try {
    db = openIndex(path);
  } catch (error) {
    throw new CliError(
      "missing-index",
      `the session index cannot be opened at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "run: agentchats index",
      EXIT.missingIndex,
    );
  }
  const built = db.query("select exists (select 1 from sessions) as built").get() as { built: number };
  if (built.built === 0) {
    db.close();
    throw new CliError(
      "missing-index",
      `the session index at ${path} holds no sessions yet`,
      "run: agentchats index",
      EXIT.missingIndex,
    );
  }
  return db;
}

function timeWindow(parsed: ReturnType<typeof parseArgs>): { since?: string; until?: string } {
  const window: { since?: string; until?: string } = {};
  if (parsed.values["days"] !== undefined) window.since = daysAgo(integer(parsed, "days", 0));
  if (parsed.values["since"] !== undefined) window.since = resolveWhen(parsed.values["since"]!);
  if (parsed.values["until"] !== undefined) window.until = resolveWhen(parsed.values["until"]!);
  return window;
}

function workspaceOf(parsed: ReturnType<typeof parseArgs>): string | undefined {
  const raw = parsed.values["workspace"];
  return raw === undefined ? undefined : resolve(raw);
}

async function commandIndex(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const parsed = parseArgs(argv, { value: ["retain-days"], boolean: ["json", "full"] });
  const path = indexPath(env);
  if (parsed.flags.has("full")) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await Bun.file(`${path}${suffix}`).delete();
      } catch {
        // A rebuild starts from whatever is there; an absent file is the goal.
      }
    }
  }
  const db = openIndex(path);
  const retainDays = parsed.values["retain-days"];
  const report = await ingest(db, {
    ...liveSources(env, (await loadAgentchatsConfig(env)).archives),
    ...(retainDays === undefined ? {} : { retainDays: integer(parsed, "retain-days", 0) }),
  });
  db.close();
  if (parsed.flags.has("json")) emit({ success: report.failed === 0, ...report });
  else {
    process.stdout.write(
      `indexed ${report.indexed}, skipped ${report.skipped}, removed ${report.removed}` +
        (report.failed > 0 ? `, failed ${report.failed}` : "") +
        ` (${report.scanned} scanned)\n`,
    );
    // A root that was not there is worth saying out loud: its sessions are
    // still searchable, but nothing under it was refreshed this run.
    for (const root of report.unavailableRoots) {
      process.stdout.write(`unavailable, left untouched: ${root}\n`);
    }
  }
  return report.failed > 0 && report.indexed === 0 ? EXIT.error : EXIT.ok;
}

async function commandStatus(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const parsed = parseArgs(argv, { value: [], boolean: ["json"] });
  // status is the one command that must answer for an empty index rather than
  // refuse: "zero sessions" is the diagnosis being asked for, and a nonzero
  // exit carrying a full payload would break the rule that a failure leaves
  // stdout empty. It always succeeds; the payload carries the verdict.
  const db = openIndex(indexPath(env));
  const work = pendingWork(db, liveSources(env, (await loadAgentchatsConfig(env)).archives));
  const state = status(db);
  const report = {
    ...state,
    path: indexPath(env),
    /** Is there an index worth searching at all. */
    healthy: state.sessions > 0,
    /** Would `agentchats index` change anything. */
    stale: work.pending > 0 || work.vanished > 0,
    pending: work.pending,
    vanished: work.vanished,
    scanned: work.scanned,
    unavailableRoots: work.unavailableRoots,
  };
  db.close();
  if (parsed.flags.has("json")) emit(report);
  else {
    process.stdout.write(
      `${report.sessions} sessions, ${report.messages} messages, ` +
        `${(report.bytes / 1e6).toFixed(0)} MB at ${report.path}\n` +
        `newest indexed session: ${report.newestSession ?? "(none)"}\n` +
        (report.stale
          ? `stale: ${report.pending} to index, ${report.vanished} to drop — run: agentchats index\n`
          : "fresh\n"),
    );
    for (const root of report.unavailableRoots) {
      process.stdout.write(`unavailable: ${root}\n`);
    }
  }
  return EXIT.ok;
}

async function commandSearch(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  // Bare `search` is the picker: the herdr plugin runs `agentsurface host --
  // agentchats search`, and that contract is older than this index. --json
  // selects the agent surface instead.
  if (!argv.includes("--json")) {
    const { runPicker } = await import("../tui/main.ts");
    return await runPicker(argv, env);
  }
  const parsed = parseArgs(argv, {
    value: [
      "limit", "offset", "workspace", "agent", "days", "since", "until",
      "fields", "max-content-length", "aggregate",
    ],
    boolean: ["json"],
  });
  const query = parsed.positional.join(" ");
  const db = open(env);
  try {
    const window = timeWindow(parsed);
    const scope = filters({ ...window, workspace: workspaceOf(parsed), agent: parsed.values["agent"] });
    const by = parsed.values["aggregate"];
    if (by !== undefined) {
      // A comma list is independent facets, not a cross-product: "how much by
      // agent, and how much by workspace" is the question callers ask, and it
      // is what the skill has always documented.
      const dimensions = by.split(",").map((name) => name.trim()).filter((name) => name !== "");
      if (dimensions.length === 0) throw new UsageError("--aggregate needs a dimension");
      for (const dimension of dimensions) {
        if (dimension !== "agent" && dimension !== "workspace" && dimension !== "date") {
          throw new UsageError(
            `--aggregate has no dimension "${dimension}"; choose from agent, workspace, date`,
          );
        }
      }
      const facets = dimensions.map((dimension) => ({
        dimension,
        buckets: aggregate(db, { by: dimension as AggregateDimension, query, ...scope }),
      }));
      emit({
        query,
        aggregate: by,
        // One dimension keeps the flat shape it has always had; several add
        // `facets` beside it rather than changing what a caller already reads.
        ...(facets.length === 1 ? { buckets: facets[0]!.buckets } : {}),
        facets,
      });
      return EXIT.ok;
    }
    const result = search(db, {
      query,
      limit: integer(parsed, "limit", 10),
      offset: integer(parsed, "offset", 0),
      ...scope,
    });
    const hits = result.hits.map(hitJson);
    const max = parsed.values["max-content-length"] === undefined
      ? undefined
      : integer(parsed, "max-content-length", 0);
    emit({
      query,
      count: hits.length,
      hits: truncate(project(hits, parsed.values["fields"]) as never, max),
    });
    return EXIT.ok;
  } finally {
    db.close();
  }
}

function commandSessions(argv: string[], env: Record<string, string | undefined>): number {
  const parsed = parseArgs(argv, {
    value: ["limit", "workspace", "agent", "days", "since", "until"],
    boolean: ["json", "current"],
  });
  const db = open(env);
  try {
    const workspace = parsed.flags.has("current") ? process.cwd() : workspaceOf(parsed);
    const rows = listSessions(db, {
      limit: integer(parsed, "limit", 20),
      ...filters({ ...timeWindow(parsed), workspace, agent: parsed.values["agent"] }),
    });
    emit({ count: rows.length, sessions: rows.map(sessionJson) });
    return EXIT.ok;
  } finally {
    db.close();
  }
}

interface MessageRow {
  source_path: string;
  agent: string;
  workspace: string;
  session_id: string;
  ordinal: number;
  line: number;
  byte_offset: number;
  role: string;
  ts: string;
  body: string;
  truncated: number;
}

const MESSAGE_COLUMNS = `s.source_path, s.agent, s.workspace, s.session_id,
  m.ordinal, m.line, m.byte_offset, m.role, m.ts, m.body, m.truncated`;

/**
 * The transcript record behind a stored message, read from the file at the
 * byte offset ingest recorded. This is what makes a capped body recoverable:
 * the index holds the first 16 KB, the transcript holds all of it, and the
 * offset is the seek that avoids scanning a multi-megabyte file to find one
 * line.
 */
async function sourceRecord(row: MessageRow): Promise<string | null> {
  try {
    const file = Bun.file(row.source_path);
    const tail = await file.slice(row.byte_offset).text();
    const line = tail.split("\n", 1)[0] ?? "";
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

/** Recorded by the parser at write time. It was briefly inferred from the
 * stored length instead, which missed 349 cut bodies in this corpus: `slice`
 * counts UTF-16 code units and SQLite's `length()` counts code points, so an
 * emoji anywhere in a tool output made a truncated message look whole. */
function wasTruncated(row: MessageRow): boolean {
  return row.truncated === 1;
}

function messageAt(db: Database, sourcePath: string, line: number): MessageRow {
  const row = db
    .query(
      `select ${MESSAGE_COLUMNS} from messages m join sessions s on s.id = m.session_id
       where s.source_path = ? and m.line = ? limit 1`,
    )
    .get(sourcePath, line) as MessageRow | null;
  if (row === null) {
    throw new CliError(
      "not-found",
      `no indexed message at line ${line} of ${sourcePath}`,
      "the index may be stale; run: agentchats index",
    );
  }
  return row;
}

async function commandView(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const parsed = parseArgs(argv, { value: ["line"], boolean: ["json", "full"] });
  const sourcePath = parsed.positional[0];
  if (sourcePath === undefined) throw new UsageError("view needs a session path");
  if (parsed.values["line"] === undefined) throw new UsageError("view needs --line");
  const db = open(env);
  try {
    const row = messageAt(db, sourcePath, integer(parsed, "line", 0));
    const truncated = wasTruncated(row);
    const source = parsed.flags.has("full") ? await sourceRecord(row) : null;
    if (parsed.flags.has("json")) {
      emit({ ...row, truncated, ...(source !== null ? { source_record: source } : {}) });
    } else {
      process.stdout.write(`${row.role} · ${row.ts}\n${row.body}\n`);
      if (source !== null) process.stdout.write(`\n--- full record ---\n${source}\n`);
      else if (truncated) {
        process.stdout.write(
          `\n[truncated at ${MESSAGE_BODY_CAP} characters; rerun with --full for the whole record]\n`,
        );
      }
    }
    return EXIT.ok;
  } finally {
    db.close();
  }
}

function commandExpand(argv: string[], env: Record<string, string | undefined>): number {
  const parsed = parseArgs(argv, { value: ["line", "context"], boolean: ["json"] });
  const sourcePath = parsed.positional[0];
  if (sourcePath === undefined) throw new UsageError("expand needs a session path");
  if (parsed.values["line"] === undefined) throw new UsageError("expand needs --line");
  const context = integer(parsed, "context", 3);
  const db = open(env);
  try {
    const anchor = messageAt(db, sourcePath, integer(parsed, "line", 0));
    const rows = db
      .query(
        `select ${MESSAGE_COLUMNS} from messages m join sessions s on s.id = m.session_id
         where s.source_path = ? and m.ordinal between ? and ? order by m.ordinal`,
      )
      .all(sourcePath, anchor.ordinal - context, anchor.ordinal + context) as MessageRow[];
    const withFlag = rows.map((row) => ({ ...row, truncated: wasTruncated(row) }));
    if (parsed.flags.has("json")) {
      emit({ source_path: sourcePath, line: anchor.line, context, count: rows.length, messages: withFlag });
    } else {
      for (const row of withFlag) {
        process.stdout.write(
          `${row.line === anchor.line ? "▸" : " "} ${row.role} · ${row.ts}` +
            `${row.truncated ? " · truncated" : ""}\n${row.body}\n\n`,
        );
      }
    }
    return EXIT.ok;
  } finally {
    db.close();
  }
}

/** The native invocation for a session's own harness — the thing to hand a
 * human, never to run as a nested agent. Derived from the store layout, the
 * same rule the picker resumes by. */
function commandResume(argv: string[], env: Record<string, string | undefined>): number {
  const parsed = parseArgs(argv, { value: [], boolean: ["json", "shell"] });
  const sourcePath = parsed.positional[0];
  if (sourcePath === undefined) throw new UsageError("resume needs a session path");
  // An archived transcript is a preserved copy; the harness reads only its own
  // store, so printing a resume command for one would hand over an invocation
  // that fails. Say why instead.
  try {
    const db = openIndex(indexPath(env));
    const row = db
      .query("SELECT archived FROM sessions WHERE source_path = ?")
      .get(sourcePath) as { archived: number } | null;
    db.close();
    if (row !== null && row.archived === 1) {
      throw new CliError(
        "archived",
        `${sourcePath} is a preserved copy, not a live session`,
        "the harness pruned the original; the transcript is searchable and readable with view/expand, but cannot be resumed",
      );
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    // No index, or no row: fall through and answer from the path alone.
  }
  const agent = sourcePath.includes("/.codex/") ? "codex" : "claude_code";
  const kind = resumeKind(agent);
  if (kind === null) throw new CliError("unsupported", `${agent} sessions cannot be resumed`);
  const sessionId = deriveSessionId(kind, sourcePath);
  if (sessionId === null) {
    throw new CliError("not-found", `no native session id is derivable from ${sourcePath}`);
  }
  const command = kind === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`;
  if (parsed.flags.has("json")) emit({ agent: kind, session_id: sessionId, command });
  else process.stdout.write(`${command}\n`);
  return EXIT.ok;
}

function commandState(argv: string[], env: Record<string, string | undefined>): number {
  const parsed = parseArgs(argv, { value: ["workspace", "budget"], boolean: [] });
  const budget = integer(parsed, "budget", 400);
  if (budget < 60) throw new UsageError("--budget below 60 tokens cannot fit a dump");
  let workspace = workspaceOf(parsed);
  if (workspace === undefined) {
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
    const top = new TextDecoder().decode(git.stdout).trim();
    workspace = top === "" ? process.cwd() : top;
  }
  // A machine with no index yet says so in one line rather than failing: the
  // dump is called by agents re-orienting, and a stack trace helps nobody.
  let db: Database;
  try {
    db = open(env);
  } catch {
    process.stdout.write("## chats\n- the session index is not built; run: agentchats index\n");
    return EXIT.ok;
  }
  try {
    const sessions = listSessions(db, { limit: sessionLimit(budget), workspace });
    process.stdout.write(renderState(workspace, sessions));
    return EXIT.ok;
  } finally {
    db.close();
  }
}

const COMMANDS: Record<string, (argv: string[], env: Record<string, string | undefined>) => number | Promise<number>> = {
  index: commandIndex,
  status: commandStatus,
  search: commandSearch,
  sessions: commandSessions,
  view: commandView,
  expand: commandExpand,
  resume: commandResume,
  state: commandState,
};

async function main(argv: string[]): Promise<number> {
  const name = argv[0];
  const run = name === undefined ? undefined : COMMANDS[name];
  if (run === undefined) {
    console.error(`agentchats: unknown command "${name ?? ""}"; run agentchats --help`);
    return EXIT.usage;
  }
  try {
    return await run(argv.slice(1), process.env);
  } catch (error) {
    if (error instanceof UsageError) {
      // The skill states a non-negotiable: a failure puts
      // {"error":{code,message,hint}} on stderr. Usage errors were the one
      // path that printed bare prose, so an agent parsing stderr on exit 64
      // got something it could not read.
      console.error(
        JSON.stringify({
          error: {
            code: "usage",
            message: `agentchats ${name}: ${error.message}`,
            hint: "run: agentchats --help",
          },
        }),
      );
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      console.error(JSON.stringify({ error: { code: error.code, message: error.message, hint: error.hint } }));
      return error.exitCode;
    }
    console.error(
      JSON.stringify({
        error: { code: "internal", message: error instanceof Error ? error.message : String(error), hint: null },
      }),
    );
    return EXIT.error;
  }
}

process.exit(await main(process.argv.slice(2)));
