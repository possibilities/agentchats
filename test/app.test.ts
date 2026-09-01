import { describe, expect, test } from "bun:test";
import { queryKeyBindings, queryRailGlyph } from "../src/tui/app.ts";
import { GLYPHS } from "../src/tui/theme.ts";

type Binding = Parameters<typeof queryKeyBindings>[0][number];

const DEFAULTS: Binding[] = [
  { name: "return", action: "newline" },
  { name: "kpenter", action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "k", ctrl: true, action: "delete-to-line-end" as Binding["action"] },
  { name: "g", ctrl: true, action: "abort" as Binding["action"] },
  { name: "t", ctrl: true, action: "transpose" as Binding["action"] },
  { name: "tab", action: "insert-tab" as Binding["action"] },
  { name: "a", ctrl: true, action: "move-to-line-start" as Binding["action"] },
];

describe("queryKeyBindings", () => {
  test("plain enter submits the pick instead of inserting a newline", () => {
    const bindings = queryKeyBindings(DEFAULTS);
    expect(
      bindings.some((b) => b.name === "return" && b.shift !== true && b.action === "newline"),
    ).toBe(false);
    expect(bindings.some((b) => b.name === "return" && b.action === "submit")).toBe(true);
    expect(bindings.some((b) => b.name === "kpenter" && b.action === "submit")).toBe(true);
  });

  test("ctrl+k, ctrl+g, and ctrl+t are released to the app's own chords", () => {
    const bindings = queryKeyBindings(DEFAULTS);
    expect(bindings.some((b) => b.name === "k" && b.ctrl === true)).toBe(false);
    expect(bindings.some((b) => b.name === "g" && b.ctrl === true)).toBe(false);
    expect(bindings.some((b) => b.name === "t" && b.ctrl === true)).toBe(false);
  });

  test("tab is released to move focus to the project row", () => {
    const bindings = queryKeyBindings(DEFAULTS);
    expect(bindings.some((b) => b.name === "tab")).toBe(false);
  });

  test("the rest of the line-editing set survives", () => {
    const bindings = queryKeyBindings(DEFAULTS);
    expect(bindings.some((b) => b.name === "a" && b.ctrl === true)).toBe(true);
  });
});

describe("queryRailGlyph", () => {
  test("uses the same left-weighted rail as selected rows while idle", () => {
    expect(queryRailGlyph(false)).toBe(GLYPHS.rail);
  });

  test("keeps the live-search signal while a query is running", () => {
    expect(queryRailGlyph(true)).toBe(GLYPHS.busy);
  });
});
