import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPrepared } from "../src/cli/commands.ts";
import {
  acquireWriter,
  evaluateResourceHeadroom,
  RESOURCE_LIMITS,
} from "../src/store/containment.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agentchats-containment-"));
  roots.push(root);
  return root;
}

test("the canonical writer lease excludes contenders and is released with its connection", () => {
  const index = join(scratch(), "state/index.db");
  const first = acquireWriter(index, "cli");
  expect(first.acquired).toBe(true);
  const contender = acquireWriter(index, "mcp");
  expect(contender).toMatchObject({ acquired: false, reason: "writer_busy" });
  if (first.acquired) first.release();
  const next = acquireWriter(index, "installer");
  expect(next.acquired).toBe(true);
  if (next.acquired) next.release();
});

test("a writer contender defers before opening the session index", async () => {
  const root = scratch();
  const index = join(root, "state/index.db");
  mkdirSync(join(root, ".claude/projects"), { recursive: true });
  mkdirSync(join(root, ".codex/sessions"), { recursive: true });
  const held = acquireWriter(index, "cli");
  expect(held.acquired).toBe(true);
  try {
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "index", "--json"],
      {
        env: { ...process.env, HOME: root, AGENTCHATS_INDEX: index },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(75);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      success: false, complete: false, outcome: "deferred", runDeferrals: ["writer_busy"],
    });
    expect(existsSync(index)).toBe(false);
    expect(existsSync(`${index}.ingest-status.json`)).toBe(false);
  } finally {
    if (held.acquired) held.release();
  }
});

test("resource preflight covers disk, memory, process RSS, and process headroom", () => {
  const constrained = evaluateResourceHeadroom({
    diskAvailableBytes: RESOURCE_LIMITS.minimumDiskBytes - 1,
    systemFreeMemoryBytes: RESOURCE_LIMITS.minimumFreeMemoryBytes - 1,
    processRssBytes: RESOURCE_LIMITS.maximumProcessRssBytes,
    processHeadroom: RESOURCE_LIMITS.minimumProcessHeadroom - 1,
  }, "cli");
  expect(constrained.ok).toBe(false);
  expect(constrained.reasons).toEqual([
    "insufficient_disk",
    "insufficient_memory",
    "process_memory_high",
    "insufficient_process_headroom",
  ]);

  const unknownUnattended = evaluateResourceHeadroom({
    diskAvailableBytes: RESOURCE_LIMITS.minimumDiskBytes,
    systemFreeMemoryBytes: RESOURCE_LIMITS.minimumFreeMemoryBytes,
    processRssBytes: 1,
    processHeadroom: null,
  }, "installer");
  expect(unknownUnattended.reasons).toEqual(["process_headroom_unavailable"]);
  expect(evaluateResourceHeadroom(unknownUnattended.snapshot, "cli").ok).toBe(true);
});

test("a pre-open resource deferral is atomically visible to later status", async () => {
  const root = scratch();
  const index = join(root, "state/index.db");
  const env = { ...process.env, HOME: root, AGENTCHATS_INDEX: index };
  const constrained = evaluateResourceHeadroom({
    diskAvailableBytes: 1,
    systemFreeMemoryBytes: RESOURCE_LIMITS.minimumFreeMemoryBytes,
    processRssBytes: 1,
    processHeadroom: RESOURCE_LIMITS.minimumProcessHeadroom,
  }, "installer");
  const parsed = { positional: [], values: {}, flags: new Set<string>() };
  const output = await runPrepared("index", parsed, env, {
    origin: "installer",
    resourcePreflight: () => constrained,
  });
  expect(output.exitCode).toBe(75);
  expect(output.value).toMatchObject({
    success: false, complete: false, outcome: "deferred", telemetryPersisted: true,
    runDeferrals: ["insufficient_disk"],
  });
  expect(existsSync(index)).toBe(false);
  expect(existsSync(`${index}.ingest-status.json`)).toBe(true);

  const status = await runPrepared("status", parsed, env);
  expect(status.value).toMatchObject({
    complete: false,
    lastAttempt: { origin: "installer", outcome: "deferred", complete: false },
  });
});
