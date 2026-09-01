import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const runner = new URL("../scripts/run-with-timeout", import.meta.url).pathname;
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForFile(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} remained alive`);
}

test("a successful captured command returns immediately", () => {
  const started = Date.now();
  const result = spawnSync(runner, ["3", "instant command", "/usr/bin/printf", "ready"], {
    encoding: "utf8",
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready");
  assert.ok(elapsed < 1000, `successful command waited ${elapsed}ms`);
});

test("a timed command is reaped and cannot keep writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentchats-timeout-"));
  roots.push(root);
  const child = join(root, "child.sh");
  const marker = join(root, "marker");
  writeFileSync(
    child,
    `#!/bin/bash\ntrap 'exit 0' TERM\nsleep 3\nprintf late >"$1"\n`,
    { mode: 0o700 },
  );
  chmodSync(child, 0o700);

  const started = Date.now();
  const result = spawnSync(runner, ["1", "slow command", child, marker], { encoding: "utf8" });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /slow command timed out after 1 seconds/);
  assert.ok(elapsed >= 900 && elapsed < 2500, `timeout returned after ${elapsed}ms`);

  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.throws(() => readFileSync(marker), /ENOENT/);
});

for (const [signal, expectedStatus] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  test(`${signal} is forwarded and the timed child is reaped`, async () => {
    const root = mkdtempSync(join(tmpdir(), "agentchats-timeout-signal-"));
    roots.push(root);
    const childScript = join(root, "child.sh");
    const pidPath = join(root, "child.pid");
    writeFileSync(
      childScript,
      `#!/bin/bash
trap 'exit 0' TERM INT HUP
printf '%s' "$$" >"$1"
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    const command = spawn(runner, ["30", `${signal} command`, childScript, pidPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForFile(pidPath);
    const commandPid = Number(readFileSync(pidPath, "utf8"));
    command.kill(signal);
    const [status, exitSignal] = await once(command, "exit");
    assert.equal(exitSignal, null);
    assert.equal(status, expectedStatus);
    await waitForProcessExit(commandPid);
  });
}

test("an installer-like parent reaps the entire timed command group", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentchats-timeout-parent-"));
  roots.push(root);
  const childScript = join(root, "slow-child.sh");
  const harness = join(root, "installer-like.sh");
  const childPidPath = join(root, "child.pid");
  const grandchildPidPath = join(root, "grandchild.pid");
  writeFileSync(
    childScript,
    `#!/bin/bash
sleep 30 &
grandchild=$!
printf '%s' "$$" >"$1"
printf '%s' "$grandchild" >"$2"
trap 'kill -TERM "$grandchild" 2>/dev/null || true; wait "$grandchild" 2>/dev/null || true; exit 0' TERM INT HUP
wait "$grandchild"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    harness,
    `#!/bin/bash
set -u
runner=$1
child_script=$2
child_pid_path=$3
grandchild_pid_path=$4
active=
trap 'trap - TERM INT HUP; kill -TERM "$active" 2>/dev/null || true; wait "$active" 2>/dev/null || true; exit 143' TERM
"$runner" 30 'installer-like child' "$child_script" "$child_pid_path" "$grandchild_pid_path" &
active=$!
wait "$active"
`,
    { mode: 0o700 },
  );
  const parent = spawn(harness, [runner, childScript, childPidPath, grandchildPidPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.all([waitForFile(childPidPath), waitForFile(grandchildPidPath)]);
  const childPid = Number(readFileSync(childPidPath, "utf8"));
  const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
  parent.kill("SIGTERM");
  const [status, exitSignal] = await once(parent, "exit");
  assert.equal(exitSignal, null);
  assert.equal(status, 143);
  await Promise.all([waitForProcessExit(childPid), waitForProcessExit(grandchildPid)]);
});
