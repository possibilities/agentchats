import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverProjectChoices,
  projectDisplayPath,
  scanProjectPaths,
} from "../src/tui/projects.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function sandbox(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentchats-projects-"));
  temps.push(temp);
  return temp;
}

describe("scanProjectPaths", () => {
  test("offers roots and their immediate directories without touching transcript history", () => {
    const home = sandbox();
    mkdirSync(join(home, "code", "alpha"), { recursive: true });
    mkdirSync(join(home, "code", "beta"));
    mkdirSync(join(home, "code", ".hidden"));
    writeFileSync(join(home, "code", "notes.md"), "");
    symlinkSync(join(home, "code", "alpha"), join(home, "code", "linked"));

    expect(scanProjectPaths(["~/code", "~/missing"], home)).toEqual([
      join(home, "code"),
      join(home, "code", "alpha"),
      join(home, "code", "beta"),
      join(home, "code", "linked"),
    ]);
  });
});

describe("discoverProjectChoices", () => {
  test("leads with the opening project and deduplicates the scan", () => {
    const home = sandbox();
    const current = join(home, "code", "beta");
    mkdirSync(join(home, "code", "alpha"), { recursive: true });
    mkdirSync(current);

    expect(discoverProjectChoices(current, home, ["~/code"])).toEqual([
      { path: current, display: "~/code/beta" },
      { path: join(home, "code"), display: "~/code" },
      { path: join(home, "code", "alpha"), display: "~/code/alpha" },
    ]);
  });

  test("an unavailable home keeps absolute paths absolute", () => {
    expect(projectDisplayPath("/Users/op/code/agentchats", "")).toBe(
      "/Users/op/code/agentchats",
    );
  });
});
