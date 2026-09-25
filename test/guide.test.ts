import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../bin/agentchats");
const VALIDATOR = join(homedir(), "code/agentstart/scripts/validate-agent-contract.ts");

test.skipIf(!existsSync(VALIDATOR))("the published guide conforms to the fleet contract", async () => {
  const child = Bun.spawn([process.execPath, VALIDATOR, CLI], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("conforms to version 1");
});

test("operator and producer help stay available without opening a picker", async () => {
  for (const args of [["--help"], ["--agent-help"], ["--agent-teaser"], ["search", "--json", "--help"], ["search", "--help"]]) {
    const child = Bun.spawn([CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stdout + stderr).toContain("agentchats");
  }
});

test("bare search uses the query path rather than requiring a Surface host", async () => {
  const child = Bun.spawn([CLI, "search", "retirement-probe"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: "/nonexistent/agentchats-retirement-probe" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(3);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr).error.code).toBe("missing-index");
});
