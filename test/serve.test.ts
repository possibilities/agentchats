import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentTools } from "../src/cli/mcp-tools.ts";
import { runForeground } from "../src/cli/serve.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("serve help and argument errors do not launch a server, and MCP never advertises it", async () => {
  const cli = resolve(import.meta.dir, "../bin/agentchats");
  for (const [args, expected] of [ [["serve", "--help"], 0], [["serve", "extra"], 64], [["serve", "--host", "0.0.0.0"], 64] ] as const) {
    const child = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(expected);
    expect(stdout + stderr).toContain("serve");
  }
  expect(agentTools().map((tool) => tool.name)).not.toContain("serve");
});

test("foreground runner preserves child failure, including bind failures", async () => {
  expect(await runForeground(process.execPath, ["-e", "process.exit(7)"], process.cwd(), process.env)).toBe(7);
});

for (const [signal, exit] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  test(`foreground ${signal} waits for child cleanup before returning`, async () => {
    const root = mkdtempSync(join(tmpdir(), "agentchats-serve-"));
    roots.push(root);
    const module = resolve(import.meta.dir, "../src/cli/serve.ts");
    const worker = join(root, "worker.ts");
    const supervisor = join(root, "supervisor.ts");
    writeFileSync(worker, `
      const fs = require("node:fs");
      const finish = () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(join(root, "stopped"))}, "reaped"); process.exit(0); }, 80);
      process.once("SIGINT", finish); process.once("SIGTERM", finish);
      fs.writeFileSync(${JSON.stringify(join(root, "ready"))}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    writeFileSync(supervisor, `import { runForeground } from ${JSON.stringify(module)};
      process.exit(await runForeground(process.execPath, [${JSON.stringify(worker)}], ${JSON.stringify(root)}, process.env));`);
    const child = Bun.spawn([process.execPath, supervisor], { stdout: "pipe", stderr: "pipe" });
    try {
      const ready = join(root, "ready");
      const deadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
      if (!existsSync(ready)) {
        child.kill("SIGTERM");
        throw new Error(await new Response(child.stderr).text());
      }
      const pid = Number(readFileSync(ready, "utf8"));
      child.kill(signal);
      expect(await child.exited).toBe(exit);
      expect(readFileSync(join(root, "stopped"), "utf8")).toBe("reaped");
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  });
}
