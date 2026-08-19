import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../src/tui/cass.ts";
import {
  applyError,
  applyRows,
  buildResultRows,
  createState,
  moveSelection,
  scopeWorkspace,
  type SearchState,
  toggleScope,
} from "../src/tui/model.ts";

function sessionRow(index: number, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    agent: "claude_code",
    workspace: "/Users/op/code/alpha",
    path: `/store/${index}.jsonl`,
    title: `session ${index}`,
    when: "2026-08-12 02:54",
    snippet: null,
    line: null,
    ...overrides,
  };
}

function stateWith(rows: SessionRow[]): SearchState {
  const state = createState("/Users/op/code/alpha", "");
  applyRows(state, "search", rows);
  return state;
}

function textRows(state: SearchState, width = 100, visible = 10): string[] {
  return buildResultRows(state, width, visible).map((row) =>
    row.spans.map((span) => span.text).join(""),
  );
}

describe("selection discipline", () => {
  test("moves within bounds and clamps on shorter results", () => {
    const state = stateWith([sessionRow(0), sessionRow(1), sessionRow(2)]);
    moveSelection(state, 1);
    moveSelection(state, 1);
    moveSelection(state, 5);
    expect(state.selected).toBe(2);
    moveSelection(state, -9);
    expect(state.selected).toBe(0);
    state.selected = 2;
    applyRows(state, "search", [sessionRow(0)]);
    expect(state.selected).toBe(0);
  });

  test("scope toggles between the project and everywhere", () => {
    const state = stateWith([]);
    expect(scopeWorkspace(state)).toBe("/Users/op/code/alpha");
    toggleScope(state);
    expect(scopeWorkspace(state)).toBeNull();
    toggleScope(state);
    expect(scopeWorkspace(state)).toBe("/Users/op/code/alpha");
  });
});

describe("buildResultRows", () => {
  test("marks the selected row with the accent rail, never color alone", () => {
    const state = stateWith([sessionRow(0), sessionRow(1)]);
    state.selected = 1;
    const rows = buildResultRows(state, 100, 10);
    const selected = rows.find((row) => row.index === 1);
    const other = rows.find((row) => row.index === 0);
    expect(selected?.spans[0]?.text).toContain("▎");
    expect(selected?.spans[0]?.token).toBe("accent");
    expect(other?.spans[0]?.text).not.toContain("▎");
  });

  test("shows date, agent in operator vocabulary, project, and title", () => {
    const text = textRows(stateWith([sessionRow(0, { agent: "pi_agent" })])).join("\n");
    expect(text).toContain("2026-08-12 02:54");
    expect(text).toContain("pi");
    expect(text).not.toContain("pi_agent");
    expect(text).toContain("alpha");
    expect(text).toContain("session 0");
  });

  test("the selected row's snippet renders as a quiet evidence line", () => {
    const state = stateWith([sessionRow(0, { snippet: "the queue was broken here" })]);
    const text = textRows(state).join("\n");
    expect(text).toContain("the queue was broken here");
  });

  test("the failure line comes first and carries the reason", () => {
    const state = stateWith([sessionRow(0)]);
    applyError(state, "index is unhealthy");
    const rows = buildResultRows(state, 100, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spans[0]?.token).toBe("danger");
    expect(rows[0]?.spans[0]?.text).toContain("FAILED");
    expect(rows[0]?.spans[0]?.text).toContain("index is unhealthy");
  });

  test("empty states invite by scope and query", () => {
    const state = createState("/Users/op/code/alpha", "");
    applyRows(state, "recent", []);
    expect(textRows(state).join("")).toContain("no sessions in alpha");
    state.query = "zebra";
    expect(textRows(state).join("")).toContain("no matches in alpha");
    toggleScope(state);
    expect(textRows(state).join("")).toContain("no matches anywhere");
  });

  test("narrow widths truncate instead of wrapping", () => {
    const rows = textRows(
      stateWith([
        sessionRow(0, {
          title: "a very long session title that cannot possibly fit in a narrow pane",
        }),
      ]),
      44,
    );
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(44);
  });

  test("the window follows a selection past the visible rows", () => {
    const state = stateWith(Array.from({ length: 30 }, (_, index) => sessionRow(index)));
    state.selected = 25;
    const rows = buildResultRows(state, 100, 5);
    const indices = rows.filter((row) => row.index !== null).map((row) => row.index);
    expect(indices).toHaveLength(5);
    expect(indices).toContain(25);
  });
});
