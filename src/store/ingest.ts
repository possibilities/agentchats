/**
 * One pass over the transcript stores: walk, skip what has not moved,
 * reparse what has, and forget what is gone. Two properties matter more
 * than speed.
 *
 * A rerun is nearly free. A file is unchanged iff its (size, mtime) match
 * the row we stored, and both stores append rather than rewrite, so a
 * second run touches only the sessions that grew since the first.
 *
 * A run never wedges. `funk` calls this on a timer with a timeout, so one
 * unreadable file, one parser that throws on a format it has not seen, one
 * directory the operator chmod'd away — each is counted and reported, and
 * the walk keeps going. Nothing here can abort the pass.
 *
 * Parsers arrive injected rather than imported: this module must not know
 * that Codex rollouts are zstd or that Claude's transcripts are line JSON,
 * and the tests must be able to hand it a parser that returns whatever the
 * case under test needs.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ParsedSession, Parser } from "../parse/types.ts";

export interface ParserBinding {
  /** The store's root directory. Every transcript beneath it is this
   * parser's, which is how a walked file finds its parser. */
  root: string;
  parse: Parser;
  /** Reading is injected because a `.jsonl.zst` rollout needs
   * decompression that the index has no business knowing about. */
  read: (path: string) => Promise<string>;
}

export interface IngestProgress {
  /** The file just handled. */
  path: string;
  /** Files handled so far, this one included. */
  handled: number;
  /** Files the walk found, fixed before the first parse. */
  total: number;
  outcome: "indexed" | "skipped" | "failed";
}

export interface IngestOptions {
  /** The roots to walk this run. Normally every parser's root; naming a
   * subset reindexes one store without touching the other. */
  roots: readonly string[];
  /** Agent name to the parser that owns that store. */
  parsers: Readonly<Record<string, ParserBinding>>;
  /** Optional extra bound on age, in days. Off by default, and rightly so:
   * the index mirrors stores that already bound themselves — Claude prunes
   * at 90 days, and the corpus spans weeks, not years. */
  retainDays?: number;
  onProgress?: (event: IngestProgress) => void;
  /** Injected so an age-bounded run is testable without waiting a day. */
  now?: () => Date;
}

export interface IngestFailure {
  path: string;
  error: string;
}

export interface IngestResult {
  /** Transcript files the walk found. */
  scanned: number;
  /** Sessions parsed and written this run. */
  indexed: number;
  /** Files left alone: unchanged, empty, or older than `retainDays`. */
  skipped: number;
  /** Session rows dropped: source gone, or aged out. */
  removed: number;
  failed: number;
  failures: IngestFailure[];
  /** Configured roots that were not there to read — an unmounted volume, a
   * store this machine does not have. Their sessions stay in the index; see
   * the retention rule in `ingest`. */
  unavailableRoots: string[];
}

interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

interface KnownRow {
  id: number;
  size: number;
  mtimeMs: number;
}

const TRANSCRIPT = /\.jsonl(\.zst)?$/;

/** Depth-first, alphabetical, and iterative — a deep store must not be able
 * to blow the stack. Directory symlinks are not followed: a loop under a
 * transcript root would turn a bounded walk into an unbounded one, and
 * neither store puts transcripts behind one. */
/**
 * Walk one root. `available` distinguishes the two things an empty result can
 * mean: a root that is present and holds nothing, and a root that is not
 * there at all. Retention depends on telling them apart — see `ingest`.
 */
function scanRoot(
  root: string,
  onError: (path: string, error: unknown) => void,
): { files: ScannedFile[]; available: boolean } {
  const files: ScannedFile[] = [];
  let available = true;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A root that is not installed on this machine is not a failure; a
      // root we cannot read is.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(dir, error);
      // The root itself being absent is the case retention must not mistake
      // for "every session under it was deleted".
      if (dir === root) available = false;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const directories: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !TRANSCRIPT.test(entry.name)) continue;
      try {
        const stat = statSync(path);
        files.push({ path, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      } catch (error) {
        onError(path, error);
      }
    }
    for (let index = directories.length - 1; index >= 0; index--) {
      stack.push(directories[index] as string);
    }
  }
  return { files, available };
}

/** The parser whose root contains this one — the longest match, so a store
 * nested inside another still resolves to its own parser. */
function bindingFor(
  path: string,
  parsers: Readonly<Record<string, ParserBinding>>,
): ParserBinding | null {
  let best: ParserBinding | null = null;
  for (const binding of Object.values(parsers)) {
    if (path !== binding.root && !path.startsWith(`${binding.root}/`)) continue;
    if (best === null || binding.root.length > best.root.length) best = binding;
  }
  return best;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one definition of "this file is already indexed as it stands". Shared
 * with `pendingWork` so a freshness probe and the indexer cannot drift into
 * disagreeing about what needs doing — a disagreement that would be silent. */
function isUnchanged(file: ScannedFile, known: KnownRow | undefined): boolean {
  return known !== undefined && known.size === file.size && known.mtimeMs === file.mtimeMs;
}

/** The indexed rows, keyed by path. */
function knownRows(db: Database): Map<string, KnownRow> {
  const known = new Map<string, KnownRow>();
  for (const row of db.query("SELECT id, source_path, size, mtime_ms FROM sessions").all() as {
    id: number;
    source_path: string;
    size: number;
    mtime_ms: number;
  }[]) {
    known.set(row.source_path, { id: row.id, size: row.size, mtimeMs: row.mtime_ms });
  }
  return known;
}

export interface PendingReport {
  /** Transcripts the walk found. */
  scanned: number;
  /** Transcripts new or changed since they were indexed. */
  pending: number;
  /** Indexed sessions whose transcript is gone from a readable root. */
  vanished: number;
  unavailableRoots: string[];
}

/**
 * What an index run would do, without doing it. A no-op `agentchats index`
 * costs about 6.5 seconds; this costs about 0.2, so it is the cheap question
 * to ask before spending that — which is what the skill's preflight step is
 * for.
 */
export function pendingWork(db: Database, options: IngestOptions): PendingReport {
  const files: ScannedFile[] = [];
  const unavailableRoots: string[] = [];
  for (const root of options.roots) {
    const scan = scanRoot(root, () => {});
    files.push(...scan.files);
    if (!scan.available) unavailableRoots.push(root);
  }
  const known = knownRows(db);
  const seen = new Set<string>();
  let pending = 0;
  for (const file of files) {
    seen.add(file.path);
    if (!isUnchanged(file, known.get(file.path))) pending++;
  }
  const isUnder = (path: string, root: string): boolean =>
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
  let vanished = 0;
  for (const path of known.keys()) {
    if (seen.has(path)) continue;
    if (unavailableRoots.some((root) => isUnder(path, root))) continue;
    vanished++;
  }
  return { scanned: files.length, pending, vanished, unavailableRoots };
}

export async function ingest(db: Database, options: IngestOptions): Promise<IngestResult> {
  const { roots, parsers, onProgress } = options;
  const now = options.now ?? (() => new Date());
  const failures: IngestFailure[] = [];
  const record = (path: string, error: unknown): void => {
    failures.push({ path, error: message(error) });
  };

  // Resolving ownership up front turns a misconfigured root into one error
  // before any work, instead of one error per file after all of it.
  for (const root of roots) {
    if (bindingFor(root, parsers) === null) {
      throw new Error(`no parser owns the transcript root ${root}`);
    }
  }

  const files: ScannedFile[] = [];
  const unavailableRoots: string[] = [];
  for (const root of roots) {
    const scan = scanRoot(root, record);
    files.push(...scan.files);
    if (!scan.available) unavailableRoots.push(root);
  }

  const known = knownRows(db);

  const deleteByPath = db.query("DELETE FROM sessions WHERE source_path = ?");
  const deleteById = db.query("DELETE FROM sessions WHERE id = ?");
  const insertSession = db.query(
    `INSERT INTO sessions
       (agent, session_id, source_path, workspace, title, created_at, updated_at,
        message_count, human_turns, thread_source, originator, size, mtime_ms, indexed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     RETURNING id`,
  );
  const insertMessage = db.query(
    `INSERT INTO messages (session_id, ordinal, line, byte_offset, role, ts, body, truncated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  );

  /** Replacement is one transaction: the DELETE cascades to `messages`,
   * whose trigger clears the FTS rows, so a session is never half-old. */
  const replace = db.transaction((session: ParsedSession, file: ScannedFile) => {
    deleteByPath.run(file.path);
    const inserted = insertSession.get(
      session.agent,
      session.sessionId,
      file.path,
      session.workspace,
      session.title,
      session.createdAt,
      session.updatedAt,
      session.messages.length,
      session.messages.filter((entry) => entry.role === "user").length,
      session.threadSource,
      session.originator,
      file.size,
      file.mtimeMs,
      now().toISOString(),
    ) as { id: number };
    for (const entry of session.messages) {
      insertMessage.run(
        inserted.id,
        entry.ordinal,
        entry.line,
        entry.byteOffset,
        entry.role,
        entry.ts,
        entry.body,
        entry.truncated ? 1 : 0,
      );
    }
  });

  const cutoffMs =
    options.retainDays === undefined
      ? null
      : now().getTime() - options.retainDays * 24 * 60 * 60 * 1000;

  let indexed = 0;
  let skipped = 0;
  let removed = 0;
  let handled = 0;
  const present = new Set<string>();
  const report = (path: string, outcome: IngestProgress["outcome"]): void => {
    handled++;
    onProgress?.({ path, handled, total: files.length, outcome });
  };

  for (const file of files) {
    const existing = known.get(file.path);

    // Aged out by the file's own clock, so an old transcript is dropped
    // without being parsed — and, crucially, without being reindexed on
    // every run only to be pruned again at the end of it.
    if (cutoffMs !== null && file.mtimeMs < cutoffMs) {
      present.add(file.path);
      if (existing !== undefined) {
        deleteById.run(existing.id);
        removed++;
      }
      skipped++;
      report(file.path, "skipped");
      continue;
    }

    if (isUnchanged(file, existing)) {
      present.add(file.path);
      skipped++;
      report(file.path, "skipped");
      continue;
    }

    let session: ParsedSession | null;
    try {
      const binding = bindingFor(file.path, parsers);
      if (binding === null) throw new Error("no parser owns this file");
      session = binding.parse(await binding.read(file.path), file.path);
    } catch (error) {
      // The row we already have survives a failed reparse: a transient read
      // error must not evict a session that is still searchable.
      present.add(file.path);
      record(file.path, error);
      report(file.path, "failed");
      continue;
    }

    if (session === null) {
      // Nothing indexable — an empty or truncated transcript. Not an error,
      // and no row is kept, so the next run reconsiders it for free.
      present.add(file.path);
      if (existing !== undefined) {
        deleteById.run(existing.id);
        removed++;
      }
      skipped++;
      report(file.path, "skipped");
      continue;
    }

    try {
      replace(session, file);
      present.add(file.path);
      indexed++;
      report(file.path, "indexed");
    } catch (error) {
      present.add(file.path);
      record(file.path, error);
      report(file.path, "failed");
    }
  }

  // The retention policy: the index mirrors the transcript stores, so a
  // source file that is gone takes its session with it.
  //
  // "Gone" must mean the file was deleted, never that its whole root was
  // unreadable this run. An unmounted external volume looks exactly like one
  // whose every session was deleted, and mistaking the two silently empties
  // the index of everything that volume holds — recoverable only by a full
  // re-ingest once it returns. A row is eligible for removal only when the
  // root that owns it was actually read.
  const isUnder = (path: string, root: string): boolean =>
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
  for (const [path, row] of known) {
    if (present.has(path)) continue;
    if (unavailableRoots.some((root) => isUnder(path, root))) continue;
    deleteById.run(row.id);
    removed++;
  }

  if (cutoffMs !== null) {
    const cutoff = new Date(cutoffMs).toISOString();
    // Undated sessions are never pruned by age: we cannot say how old they
    // are, and guessing would delete what the operator can still resume.
    const pruned = db
      .query("DELETE FROM sessions WHERE updated_at <> '' AND updated_at < ?")
      .run(cutoff);
    removed += pruned.changes;
  }

  return {
    scanned: files.length,
    indexed,
    skipped,
    removed,
    failed: failures.length,
    failures,
    unavailableRoots,
  };
}
