import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../src/tui/cass.ts";
import {
  applyError,
  applyRows,
  buildResultRows,
  createState,
  cycleWindow,
  moveSelection,
  scopeLabel,
  scopeWorkspace,
  type SearchState,
  toggleAuxiliary,
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
    slug: null,
    excerpt: null,
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
    expect(scopeLabel(state)).toBe("alpha");
    toggleScope(state);
    expect(scopeWorkspace(state)).toBeNull();
    expect(scopeLabel(state)).toBe("everywhere");
    toggleScope(state);
    expect(scopeWorkspace(state)).toBe("/Users/op/code/alpha");
  });

  test("auxiliary sessions are opt-in and visible in the scope label", () => {
    const state = stateWith([]);
    expect(state.includeAuxiliary).toBe(false);
    expect(scopeLabel(state)).toBe("alpha");
    toggleAuxiliary(state);
    expect(state.includeAuxiliary).toBe(true);
    expect(scopeLabel(state)).toBe("alpha · auxiliary");
    cycleWindow(state);
    expect(scopeLabel(state)).toBe("alpha · today · auxiliary");
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

  test("a described row shows the slug first, then the excerpt; title only as fallback", () => {
    const described = stateWith([
      sessionRow(0, { slug: "queue fix", excerpt: "the queue drops messages", title: "<command-message>collab</command-message>" }),
    ]);
    const text = textRows(described).join("\n");
    expect(text).toContain("queue fix");
    expect(text).toContain("the queue drops messages");
    expect(text).not.toContain("<command-message>");
    expect(text.indexOf("queue fix")).toBeLessThan(text.indexOf("the queue drops"));

    const excerptOnly = stateWith([
      sessionRow(0, { excerpt: "just the prompt", title: "<command-message>x</command-message>" }),
    ]);
    expect(textRows(excerptOnly).join("")).toContain("just the prompt");
    expect(textRows(excerptOnly).join("")).not.toContain("command-message");

    const bare = stateWith([sessionRow(0, { title: "raw cass title" })]);
    expect(textRows(bare).join("")).toContain("raw cass title");
  });

  test("the window rides the scope label", () => {
    const state = stateWith([]);
    expect(scopeLabel(state)).toBe("alpha");
    cycleWindow(state);
    expect(scopeLabel(state)).toBe("alpha · today");
    cycleWindow(state);
    expect(scopeLabel(state)).toBe("alpha · week");
    cycleWindow(state);
    expect(scopeLabel(state)).toBe("alpha");
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
