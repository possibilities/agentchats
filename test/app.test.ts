import { describe, expect, test } from "bun:test";
import { queryKeyBindings } from "../src/tui/app.ts";

type Binding = Parameters<typeof queryKeyBindings>[0][number];

const DEFAULTS: Binding[] = [
  { name: "return", action: "newline" },
  { name: "kpenter", action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "k", ctrl: true, action: "delete-to-line-end" as Binding["action"] },
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

  test("ctrl+k is released to the command palette", () => {
    const bindings = queryKeyBindings(DEFAULTS);
    expect(bindings.some((b) => b.name === "k" && b.ctrl === true)).toBe(false);
  });

  test("the rest of the line-editing set survives", () => {
    const bindings = queryKeyBindings(DEFAULTS);
    expect(bindings.some((b) => b.name === "a" && b.ctrl === true)).toBe(true);
  });
});
