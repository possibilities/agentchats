import { describe, expect, test } from "bun:test";
import { loadProjectChoices, parseProjectChoices } from "../src/tui/projects.ts";

const CURRENT = "/Users/op/code/agentchats";

describe("parseProjectChoices", () => {
  test("leads with the current project, then keeps indexed projects in recent order", () => {
    const stdout = JSON.stringify({
      sessions: [
        { workspace: "/Users/op/code/beta" },
        { workspace: "/Users/op/code/beta" },
        { workspace: CURRENT },
        { workspace: "/opt/shared/gamma" },
        { workspace: "" },
      ],
    });
    expect(parseProjectChoices(stdout, CURRENT, "/Users/op")).toEqual([
      { path: CURRENT, display: "~/code/agentchats" },
      { path: "/Users/op/code/beta", display: "~/code/beta" },
      { path: "/opt/shared/gamma", display: "/opt/shared/gamma" },
    ]);
  });

  test("malformed output still offers the current project", () => {
    expect(parseProjectChoices("not json", CURRENT, "/Users/op")).toEqual([
      { path: CURRENT, display: "~/code/agentchats" },
    ]);
  });

  test("an unavailable home keeps absolute paths absolute", () => {
    expect(parseProjectChoices('{"sessions":[]}', CURRENT, "")).toEqual([
      { path: CURRENT, display: CURRENT },
    ]);
  });
});

describe("loadProjectChoices", () => {
  test("asks cass for the complete global session list", async () => {
    const calls: string[][] = [];
    const result = await loadProjectChoices(
      async (args) => {
        calls.push(args);
        return { ok: true, stdout: JSON.stringify({ sessions: [] }) };
      },
      CURRENT,
      "/Users/op",
    );
    expect(calls).toEqual([["sessions", "--json", "--limit", "0"]]);
    expect(result).toEqual({
      ok: true,
      projects: [{ path: CURRENT, display: "~/code/agentchats" }],
    });
  });
});
