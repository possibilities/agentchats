import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createListOverlay } from "../src/tui/overlay.ts";

const TOKENS = {
  panel: "#131a1e",
  line: "#333333",
  accent: "#00ffff",
  muted: "#999999",
  text: "#eeeeee",
};

describe("list overlay", () => {
  test("keyless items align without rendering an empty keycode", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const overlay = createListOverlay(core, setup.renderer, "commands", TOKENS, {
      title: " COMMANDS ",
      empty: "no matching command",
    });
    setup.renderer.root.add(overlay.root);
    overlay.update({
      width: 80,
      height: 24,
      items: [
        { id: "resume", key: "⏎", label: "resume", onRun: () => {} },
        { id: "project", label: "choose project", onRun: () => {} },
      ],
    });
    overlay.open();
    await setup.flush();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[⏎]");
    expect(frame).toContain("choose project");
    expect(frame).not.toContain("[]");
    setup.renderer.destroy();
  });
});
