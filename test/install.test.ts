import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root: string;
let repo: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentchats-install-"));
  repo = join(root, "repo");
  for (const path of ["repo/scripts", "repo/bin", "repo/node_modules/@opentui/core", "fake-bin", "home"]) mkdirSync(join(root, path), { recursive: true });
  for (const file of ["install.sh", "run-with-timeout"]) copyFileSync(resolve(import.meta.dir, "../scripts", file), join(repo, "scripts", file));
  writeFileSync(join(root, "fake-bin/bun"), '#!/bin/bash\nprintf "deps:%s\\n" "$*" >> "$AGENTCHATS_TEST_INSTALL_LOG"\n[ "${AGENTCHATS_TEST_FAIL_INSTALL:-0}" != 1 ]\n', { mode: 0o755 });
  writeFileSync(join(repo, "bin/agentchats"), '#!/bin/bash\nprintf "cli:%s\\n" "$*" >> "$AGENTCHATS_TEST_INSTALL_LOG"\n', { mode: 0o755 });
  env = { ...process.env, HOME: join(root, "home"), PATH: `${join(root, "fake-bin")}:${process.env["PATH"] ?? ""}`, AGENTCHATS_TEST_INSTALL_LOG: join(root, "calls") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(option: string) {
  const child = Bun.spawn(["bash", join(repo, "scripts/install.sh"), option], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("the plan is read-only and stale TUI markers do not skip frozen dependencies", async () => {
  const check = await run("--check");
  expect(check.code).toBe(0);
  expect(check.stdout).toContain("bun install --frozen-lockfile");
  expect(existsSync(join(root, "calls"))).toBe(false);
  expect(existsSync(join(root, "home/.local"))).toBe(false);
  const installed = await run("--install");
  expect(installed.code).toBe(0);
  expect(readFileSync(join(root, "calls"), "utf8")).toBe("deps:install --frozen-lockfile\ncli:index\n");
  expect(readlinkSync(join(root, "home/.local/bin/agentchats"))).toBe(join(repo, "bin/agentchats"));
  expect((await run("--install")).code).toBe(0);
});

test("dependency failure preserves the existing command and does not start an index pass", async () => {
  mkdirSync(join(root, "home/.local/bin"), { recursive: true });
  const target = join(root, "home/.local/bin/agentchats");
  const previous = join(root, "old-agentchats");
  writeFileSync(previous, "old command");
  symlinkSync(previous, target);
  env["AGENTCHATS_TEST_FAIL_INSTALL"] = "1";
  expect((await run("--install")).code).toBe(1);
  expect(readlinkSync(target)).toBe(previous);
  expect(readFileSync(previous, "utf8")).toBe("old command");
  expect(readFileSync(join(root, "calls"), "utf8")).toBe("deps:install --frozen-lockfile\n");
});
