import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { freemem, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureIndexDirectory, MEMORY_INDEX } from "./paths.ts";

export type InvocationOrigin = "cli" | "mcp" | "installer";

export interface WriterOwner {
  pid: number;
  startedAt: string;
  origin: InvocationOrigin;
  indexPath: string;
}

export type WriterLease =
  | { acquired: true; owner: WriterOwner; release: () => void }
  | { acquired: false; reason: "writer_busy"; indexPath: string };

const memoryOwners = new Set<string>();

function canonicalIndexPath(path: string): string {
  if (path === MEMORY_INDEX) return path;
  ensureIndexDirectory(path);
  return existsSync(path)
    ? realpathSync(path)
    : join(realpathSync(dirname(path)), basename(path));
}

/** A separate, tiny SQLite file supplies a kernel-held same-host writer lock.
 * The transaction is released by the OS when a process exits, so there is no
 * stale PID-file recovery race. It is acquired before the session index is
 * opened or any transcript body is read. */
export function acquireWriter(path: string, origin: InvocationOrigin): WriterLease {
  const canonical = canonicalIndexPath(path);
  const owner: WriterOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    origin,
    indexPath: canonical,
  };
  if (canonical === MEMORY_INDEX) {
    if (memoryOwners.has(canonical)) return { acquired: false, reason: "writer_busy", indexPath: canonical };
    memoryOwners.add(canonical);
    return { acquired: true, owner, release: () => { memoryOwners.delete(canonical); } };
  }

  const lockPath = `${canonical}.writer-lock`;
  const db = new Database(lockPath, { create: true });
  try {
    chmodSync(lockPath, 0o600);
    db.run("PRAGMA busy_timeout = 0");
    db.run("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    const code = (error as { code?: string }).code ?? "";
    if (code.includes("BUSY") || String(error).includes("locked")) {
      return { acquired: false, reason: "writer_busy", indexPath: canonical };
    }
    throw error;
  }
  let released = false;
  return {
    acquired: true,
    owner,
    release: () => {
      if (released) return;
      released = true;
      try { db.run("ROLLBACK"); } finally { db.close(); }
    },
  };
}

export interface ResourceSnapshot {
  diskAvailableBytes: number | null;
  systemFreeMemoryBytes: number;
  processRssBytes: number;
  processHeadroom: number | null;
}

export interface ResourcePreflight {
  ok: boolean;
  reasons: Array<
    "disk_headroom_unavailable" | "insufficient_disk" | "insufficient_memory" |
    "process_memory_high" | "process_headroom_unavailable" | "insufficient_process_headroom"
  >;
  snapshot: ResourceSnapshot;
  limits: {
    minimumDiskBytes: number;
    minimumFreeMemoryBytes: number;
    maximumProcessRssBytes: number;
    minimumProcessHeadroom: number;
  };
}

export const RESOURCE_LIMITS = {
  minimumDiskBytes: 10 * 1024 ** 3,
  minimumFreeMemoryBytes: 256 * 1024 ** 2,
  maximumProcessRssBytes: 256 * 1024 ** 2,
  minimumProcessHeadroom: 32,
} as const;

function integerFile(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function linuxProcessHeadroom(): number | null {
  const current = integerFile("/sys/fs/cgroup/pids.current");
  let maximum: number | null = null;
  try {
    const raw = readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim();
    maximum = raw === "max" ? null : Number(raw);
  } catch {
    // Fall through to the bounded /proc estimate below.
  }
  if (current !== null && maximum !== null && Number.isSafeInteger(maximum)) return maximum - current;
  try {
    const count = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).length;
    const pidMax = integerFile("/proc/sys/kernel/pid_max");
    return pidMax === null ? null : pidMax - count;
  } catch {
    return null;
  }
}

function macProcessHeadroom(): number | null {
  if (process.getuid === undefined) return null;
  const maximum = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.maxprocperuid"], {
    stdout: "pipe", stderr: "ignore",
  });
  const processes = Bun.spawnSync(["/bin/ps", "-U", String(process.getuid()), "-o", "pid="], {
    stdout: "pipe", stderr: "ignore",
  });
  if (maximum.exitCode !== 0 || processes.exitCode !== 0) return null;
  const max = Number(new TextDecoder().decode(maximum.stdout).trim());
  if (!Number.isSafeInteger(max)) return null;
  const count = new TextDecoder().decode(processes.stdout).split("\n").filter((line) => line.trim() !== "").length;
  return max - count;
}

function processHeadroom(): number | null {
  if (platform() === "linux") return linuxProcessHeadroom();
  if (platform() === "darwin") return macProcessHeadroom();
  return null;
}

export function resourceSnapshot(path: string): ResourceSnapshot {
  let diskAvailableBytes: number | null = path === MEMORY_INDEX ? Number.MAX_SAFE_INTEGER : null;
  if (path !== MEMORY_INDEX) {
    ensureIndexDirectory(path);
    try {
      const stat = statfsSync(dirname(path));
      diskAvailableBytes = stat.bavail * stat.bsize;
    } catch {
      // The evaluator turns missing disk telemetry into a deferral.
    }
  }
  return {
    diskAvailableBytes,
    systemFreeMemoryBytes: freemem(),
    processRssBytes: process.memoryUsage().rss,
    processHeadroom: processHeadroom(),
  };
}

export function evaluateResourceHeadroom(
  snapshot: ResourceSnapshot,
  origin: InvocationOrigin,
): ResourcePreflight {
  const reasons: ResourcePreflight["reasons"] = [];
  if (snapshot.diskAvailableBytes === null) reasons.push("disk_headroom_unavailable");
  else if (snapshot.diskAvailableBytes < RESOURCE_LIMITS.minimumDiskBytes) reasons.push("insufficient_disk");
  if (snapshot.systemFreeMemoryBytes < RESOURCE_LIMITS.minimumFreeMemoryBytes) reasons.push("insufficient_memory");
  if (snapshot.processRssBytes >= RESOURCE_LIMITS.maximumProcessRssBytes) reasons.push("process_memory_high");
  if (snapshot.processHeadroom === null) {
    if (origin === "installer") reasons.push("process_headroom_unavailable");
  } else if (snapshot.processHeadroom < RESOURCE_LIMITS.minimumProcessHeadroom) {
    reasons.push("insufficient_process_headroom");
  }
  return { ok: reasons.length === 0, reasons, snapshot, limits: { ...RESOURCE_LIMITS } };
}

export function resourcePreflight(path: string, origin: InvocationOrigin): ResourcePreflight {
  return evaluateResourceHeadroom(resourceSnapshot(path), origin);
}
