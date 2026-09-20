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
import { setImmediate } from "node:timers/promises";
import type { ParsedSession, Parser } from "../parse/types.ts";

export interface ParserBinding {
  /** This root holds preserved copies rather than the harness's own store.
   * Its sessions are searchable but not resumable, and a live copy of the
   * same session always wins. */
  archived?: boolean;
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
  outcome: "indexed" | "skipped" | "deferred" | "failed";
}

/** Stage 1 keeps the legacy whole-file parser only behind a hard input fence.
 * Streaming and compressed-source support belong to later stages. */
export const LEGACY_SOURCE_LIMIT_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_SAMPLE_LIMIT = 20;

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
  /** Reparse safe sources even when their size and mtime are unchanged. */
  force?: boolean;
  /** Test seam for the Stage 1 whole-source allocation fence. */
  maxSourceBytes?: number;
  onProgress?: (event: IngestProgress) => void;
  /** Stop between complete session transactions; do not prune an unfinished pass. */
  signal?: AbortSignal;
  /** Injected so an age-bounded run is testable without waiting a day. */
  now?: () => Date;
}

export interface IngestFailure {
  path: string;
  error: string;
}

export interface IngestDeferral {
  path: string;
  reason: "compressed_source" | "source_too_large" | "source_changed" | "empty_parse";
  bytes: number;
}

export interface RootCoverage {
  root: string;
  status: "complete" | "unavailable" | "incomplete";
  errors: number;
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
  failuresOmitted: number;
  deferred: number;
  deferrals: IngestDeferral[];
  deferralsOmitted: number;
  /** True only when every configured root/subtree/stat and every source was
   * handled completely, so disappearance was safe to mirror. */
  complete: boolean;
  outcome: "complete" | "deferred" | "incomplete";
  pruning: "applied" | "withheld";
  coverage: RootCoverage[];
  sourceBytesConsidered: number;
  sourceBytesRead: number;
  elapsedMs: number;
  /** Configured roots that were not there to read — an unmounted volume, a
   * store this machine does not have. Their sessions stay in the index; see
   * the retention rule in `ingest`. */
  unavailableRoots: string[];
  incompleteRoots: string[];
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
  updatedAt: string;
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
): { files: ScannedFile[]; status: RootCoverage["status"]; errors: number } {
  const files: ScannedFile[] = [];
  let status: RootCoverage["status"] = "complete";
  let errors = 0;
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
      errors++;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(dir, error);
      // The root itself being absent is the case retention must not mistake
      // for "every session under it was deleted".
      status = dir === root ? "unavailable" : "incomplete";
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
        errors++;
        status = "incomplete";
        onError(path, error);
      }
    }
    for (let index = directories.length - 1; index >= 0; index--) {
      stack.push(directories[index] as string);
    }
  }
  return { files, status, errors };
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
  for (const row of db.query("SELECT id, source_path, size, mtime_ms, updated_at FROM sessions").all() as {
    id: number;
    source_path: string;
    size: number;
    mtime_ms: number;
    updated_at: string;
  }[]) {
    known.set(row.source_path, {
      id: row.id,
      size: row.size,
      mtimeMs: row.mtime_ms,
      updatedAt: row.updated_at,
    });
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
  incompleteRoots: string[];
  deferred: number;
  deferredBytes: number;
  complete: boolean;
  coverage: RootCoverage[];
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
  const incompleteRoots: string[] = [];
  const coverage: RootCoverage[] = [];
  for (const root of options.roots) {
    const scan = scanRoot(root, () => {});
    files.push(...scan.files);
    coverage.push({ root, status: scan.status, errors: scan.errors });
    if (scan.status === "unavailable") unavailableRoots.push(root);
    if (scan.status !== "complete") incompleteRoots.push(root);
  }
  const known = knownRows(db);
  const seen = new Set<string>();
  let pending = 0;
  let deferred = 0;
  let deferredBytes = 0;
  const maxSourceBytes = options.maxSourceBytes ?? LEGACY_SOURCE_LIMIT_BYTES;
  for (const file of files) {
    seen.add(file.path);
    if (!isUnchanged(file, known.get(file.path))) {
      pending++;
      if (file.path.endsWith(".zst") || file.size > maxSourceBytes) {
        deferred++;
        deferredBytes += file.size;
      }
    }
  }
  const isUnder = (path: string, root: string): boolean =>
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
  let vanished = 0;
  for (const path of known.keys()) {
    if (seen.has(path)) continue;
    if (!options.roots.some((root) => isUnder(path, root))) continue;
    if (incompleteRoots.some((root) => isUnder(path, root))) continue;
    vanished++;
  }
  return {
    scanned: files.length,
    pending,
    vanished,
    unavailableRoots,
    incompleteRoots,
    deferred,
    deferredBytes,
    complete: incompleteRoots.length === 0 && deferred === 0,
    coverage,
  };
}

export async function ingest(db: Database, options: IngestOptions): Promise<IngestResult> {
  const { roots, parsers, onProgress } = options;
  const started = performance.now();
  options.signal?.throwIfAborted();
  const now = options.now ?? (() => new Date());
  const failures: IngestFailure[] = [];
  let failureCount = 0;
  const record = (path: string, error: unknown): void => {
    failureCount++;
    if (failures.length < DIAGNOSTIC_SAMPLE_LIMIT) {
      failures.push({ path, error: message(error).slice(0, 512) });
    }
  };
  const deferrals: IngestDeferral[] = [];
  let deferred = 0;
  const defer = (entry: IngestDeferral): void => {
    deferred++;
    if (deferrals.length < DIAGNOSTIC_SAMPLE_LIMIT) deferrals.push(entry);
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
  const incompleteRoots: string[] = [];
  const coverage: RootCoverage[] = [];
  for (const root of roots) {
    options.signal?.throwIfAborted();
    const scan = scanRoot(root, record);
    files.push(...scan.files);
    coverage.push({ root, status: scan.status, errors: scan.errors });
    if (scan.status === "unavailable") unavailableRoots.push(root);
    if (scan.status !== "complete") incompleteRoots.push(root);
  }

  const known = knownRows(db);
  // An archive is an rsync copy of a live store, so the same conversation
  // exists at two paths under the same filename — and `-a` preserves mtime,
  // so size and mtime cannot tell the copies apart either. The transcript
  // filename is the native session id, which makes it the identity. Roots are
  // walked in the order given, so the first root to claim a session keeps it;
  // callers list live stores before archives, and the live copy is the one
  // that can still be resumed.
  const claimed = new Set<string>();

  const deleteByPath = db.query("DELETE FROM sessions WHERE source_path = ?");
  const deleteById = db.query("DELETE FROM sessions WHERE id = ?");
  const insertSession = db.query(
    `INSERT INTO sessions
       (agent, session_id, source_path, workspace, title, created_at, updated_at,
        message_count, human_turns, thread_source, originator, archived, size, mtime_ms,
        indexed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     RETURNING id`,
  );
  const insertMessage = db.query(
    `INSERT INTO messages (session_id, ordinal, line, byte_offset, role, ts, body, truncated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  );

  /** Replacement is one transaction: the DELETE cascades to `messages`,
   * whose trigger clears the FTS rows, so a session is never half-old. */
  const replace = db.transaction((session: ParsedSession, file: ScannedFile, archived: boolean) => {
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
      archived ? 1 : 0,
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
  let sourceBytesRead = 0;
  const sourceBytesConsidered = files.reduce((total, file) => total + file.size, 0);
  const maxSourceBytes = options.maxSourceBytes ?? LEGACY_SOURCE_LIMIT_BYTES;
  const present = new Set<string>();
  const retire = new Set<string>();
  const report = (path: string, outcome: IngestProgress["outcome"]): void => {
    handled++;
    onProgress?.({ path, handled, total: files.length, outcome });
  };

  for (const file of files) {
    // A healthy index may skip every file synchronously. Yield periodically so
    // the MCP transport can deliver cancellation or EOF during that pass too.
    if (options.signal && handled % 100 === 0) {
      await setImmediate();
      options.signal.throwIfAborted();
    }
    options.signal?.throwIfAborted();
    const existing = known.get(file.path);

    // Aged-out and duplicate rows are only retired after complete coverage
    // has been proven for the whole pass. Until then they remain searchable.
    const indexedUpdatedMs = existing?.updatedAt ? Date.parse(existing.updatedAt) : Number.NaN;
    if (cutoffMs !== null &&
      (file.mtimeMs < cutoffMs || (Number.isFinite(indexedUpdatedMs) && indexedUpdatedMs < cutoffMs))) {
      present.add(file.path);
      if (existing !== undefined) retire.add(file.path);
      skipped++;
      report(file.path, "skipped");
      continue;
    }

    const identity = file.path.slice(file.path.lastIndexOf("/") + 1);
    if (claimed.has(identity)) {
      // A copy of a session an earlier root already supplied. Drop any row it
      // left behind rather than carrying the same conversation twice.
      present.add(file.path);
      if (existing !== undefined) retire.add(file.path);
      skipped++;
      report(file.path, "skipped");
      continue;
    }
    claimed.add(identity);

    if (!options.force && isUnchanged(file, existing)) {
      present.add(file.path);
      skipped++;
      report(file.path, "skipped");
      continue;
    }

    // The legacy parsers materialize a complete string and split it into a
    // complete record array. Refuse unsupported or oversized sources before
    // invoking `read`, which is the allocation boundary Stage 1 contains.
    if (file.path.endsWith(".zst")) {
      present.add(file.path);
      defer({ path: file.path, reason: "compressed_source", bytes: file.size });
      report(file.path, "deferred");
      continue;
    }
    if (file.size > maxSourceBytes) {
      present.add(file.path);
      defer({ path: file.path, reason: "source_too_large", bytes: file.size });
      report(file.path, "deferred");
      continue;
    }

    const binding = bindingFor(file.path, parsers);
    let session: ParsedSession | null;
    try {
      if (binding === null) throw new Error("no parser owns this file");
      const content = await abortableRead(binding.read(file.path), options.signal);
      sourceBytesRead += Buffer.byteLength(content);
      options.signal?.throwIfAborted();
      const afterRead = statSync(file.path);
      if (afterRead.size !== file.size || Math.round(afterRead.mtimeMs) !== file.mtimeMs) {
        present.add(file.path);
        defer({ path: file.path, reason: "source_changed", bytes: afterRead.size });
        report(file.path, "deferred");
        continue;
      }
      session = binding.parse(content, file.path);
      options.signal?.throwIfAborted();
    } catch (error) {
      options.signal?.throwIfAborted();
      // The row we already have survives a failed reparse: a transient read
      // error must not evict a session that is still searchable.
      present.add(file.path);
      record(file.path, error);
      report(file.path, "failed");
      continue;
    }

    if (session === null || session.messages.length === 0) {
      // Empty output is ambiguous: the source may be incomplete, truncated,
      // or a format the legacy parser does not understand. Keep the previous
      // searchable row and make the incomplete coverage explicit.
      present.add(file.path);
      defer({ path: file.path, reason: "empty_parse", bytes: file.size });
      report(file.path, "deferred");
      continue;
    }

    try {
      options.signal?.throwIfAborted();
      replace(session, file, binding?.archived === true);
      present.add(file.path);
      indexed++;
      report(file.path, "indexed");
    } catch (error) {
      options.signal?.throwIfAborted();
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
  options.signal?.throwIfAborted();
  const isUnder = (path: string, root: string): boolean =>
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
  const complete = incompleteRoots.length === 0 && failureCount === 0 && deferred === 0;
  if (complete) {
    for (const path of retire) {
      const row = known.get(path);
      if (row !== undefined) {
        deleteById.run(row.id);
        removed++;
      }
    }
    for (const [path, row] of known) {
      if (present.has(path) || retire.has(path)) continue;
      // A deliberately narrow/injected root never authorizes deleting rows
      // from another configured store.
      if (!roots.some((root) => isUnder(path, root))) continue;
      deleteById.run(row.id);
      removed++;
    }
  }

  return {
    scanned: files.length,
    indexed,
    skipped,
    removed,
    failed: failureCount,
    failures,
    failuresOmitted: failureCount - failures.length,
    deferred,
    deferrals,
    deferralsOmitted: deferred - deferrals.length,
    complete,
    outcome: complete ? "complete" : deferred > 0 ? "deferred" : "incomplete",
    pruning: complete ? "applied" : "withheld",
    coverage,
    sourceBytesConsidered,
    sourceBytesRead,
    elapsedMs: Math.round(performance.now() - started),
    unavailableRoots,
    incompleteRoots,
  };
}

/** A cancelled read may finish its I/O, but cannot resume indexing or pruning. */
function abortableRead(read: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return read;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
