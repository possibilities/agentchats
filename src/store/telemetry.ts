import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureIndexDirectory, MEMORY_INDEX } from "./paths.ts";
import type { ResourcePreflight, WriterOwner } from "./containment.ts";
import type { IngestResult } from "./ingest.ts";

export interface IngestAttemptSummary {
  startedAt: string;
  finishedAt: string;
  origin: string;
  owner: Pick<WriterOwner, "pid" | "startedAt">;
  outcome: "complete" | "deferred" | "incomplete" | "cancelled" | "failed";
  complete: boolean;
  indexed: number;
  skipped: number;
  removed: number;
  failed: number;
  deferred: number;
  scanned: number;
  sourceBytesConsidered: number | null;
  sourceBytesRead: number | null;
  elapsedMs: number;
  pruning: "applied" | "withheld";
  deferredByReason: Record<string, number>;
  incompleteRoots: string[];
  resource: ResourcePreflight;
  error?: string;
}

const LAST_ATTEMPT = "last_ingest_attempt";
const LAST_COMPLETE = "last_complete_reconciliation";
const MAX_TELEMETRY_BYTES = 32 * 1024;

function encodedAttempt(attempt: IngestAttemptSummary): string {
  const encoded = JSON.stringify(attempt);
  if (Buffer.byteLength(encoded) > MAX_TELEMETRY_BYTES) {
    throw new Error("ingest telemetry exceeds 32 KiB");
  }
  return encoded;
}

export function summarizeAttempt(
  report: IngestResult,
  details: {
    startedAt: string;
    finishedAt: string;
    origin: string;
    owner: WriterOwner;
    resource: ResourcePreflight;
  },
): IngestAttemptSummary {
  const deferredByReason: Record<string, number> = {};
  for (const entry of report.deferrals) {
    deferredByReason[entry.reason] = (deferredByReason[entry.reason] ?? 0) + 1;
  }
  if (report.deferralsOmitted > 0) deferredByReason.omitted = report.deferralsOmitted;
  return {
    ...details,
    owner: { pid: details.owner.pid, startedAt: details.owner.startedAt },
    outcome: report.outcome,
    complete: report.complete,
    indexed: report.indexed,
    skipped: report.skipped,
    removed: report.removed,
    failed: report.failed,
    deferred: report.deferred,
    scanned: report.scanned,
    sourceBytesConsidered: report.sourceBytesConsidered,
    sourceBytesRead: report.sourceBytesRead,
    elapsedMs: report.elapsedMs,
    pruning: report.pruning,
    deferredByReason,
    incompleteRoots: report.incompleteRoots.slice(0, 20).map((root) => root.slice(0, 1024)),
  };
}

export function writeIngestAttempt(db: Database, attempt: IngestAttemptSummary): void {
  const write = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const encoded = encodedAttempt(attempt);
  // This is summary telemetry, never transcript text or an unbounded event log.
  write.run(LAST_ATTEMPT, encoded);
  if (attempt.complete) write.run(LAST_COMPLETE, attempt.finishedAt);
}

function sidecarPath(path: string): string | null {
  if (path === MEMORY_INDEX) return null;
  ensureIndexDirectory(path);
  const canonical = existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), basename(path));
  return `${canonical}.ingest-status.json`;
}

/** Pre-open deferrals cannot safely write the session index. This bounded
 * atomic sidecar preserves their status without opening or migrating it. */
export function writeIngestAttemptSidecar(path: string, attempt: IngestAttemptSummary): boolean {
  const target = sidecarPath(path);
  if (target === null) return false;
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${encodedAttempt(attempt)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    return true;
  } catch {
    try { unlinkSync(temporary); } catch { /* Nothing owned remains. */ }
    return false;
  }
}

export function readIngestAttemptSidecar(path: string): IngestAttemptSummary | null {
  const target = sidecarPath(path);
  if (target === null) return null;
  try {
    const raw = readFileSync(target);
    if (raw.byteLength > MAX_TELEMETRY_BYTES) return null;
    return parseAttempt(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function readJson(db: Database, key: string): IngestAttemptSummary | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  if (row === null) return null;
  return parseAttempt(row.value);
}

function parseAttempt(raw: string): IngestAttemptSummary | null {
  try {
    const value = JSON.parse(raw) as Partial<IngestAttemptSummary> | null;
    if (value === null || typeof value !== "object" ||
      typeof value.startedAt !== "string" || typeof value.finishedAt !== "string" ||
      typeof value.outcome !== "string" || typeof value.complete !== "boolean") return null;
    return value as IngestAttemptSummary;
  } catch {
    return null;
  }
}

export function readIngestTelemetry(db: Database): {
  lastAttempt: IngestAttemptSummary | null;
  lastSuccessfulCompleteReconciliation: string | null;
} {
  const complete = db.query("SELECT value FROM meta WHERE key = ?").get(LAST_COMPLETE) as { value: string } | null;
  return {
    lastAttempt: readJson(db, LAST_ATTEMPT),
    lastSuccessfulCompleteReconciliation: complete?.value ?? null,
  };
}
