// Char-frame tests per the fleet contract: no pinned chrome or identity text,
// in-body status, palette on ctrl+k that filters and runs, all against the
// real renderer at contract widths.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { createMockKeys } from "@opentui/core/testing"
import { App } from "../src/app"
import { createNormalizer } from "../src/normalize/index"
import { setSessionStatus, upsertMessage, upsertPart, upsertSession } from "../src/store"
import { setShowTimestamps } from "../src/config"

const SESSION = "ses_render_test"

function loadFixture() {
  const normalizer = createNormalizer("claude", SESSION, {
    session: upsertSession,
    message: upsertMessage,
    part: upsertPart,
  })
  const file = path.join(import.meta.dir, "fixtures", "claude.jsonl")
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    normalizer.push(JSON.parse(line))
  }
  setSessionStatus(SESSION, { type: "idle" })
}

loadFixture()

let quitCalled = false
const setup = await testRender(
  () => <App sessionID={SESSION} live={false} gone={() => false} onQuit={() => (quitCalled = true)} />,
  { width: 80, height: 34 },
)

const kittyInput = createMockKeys(setup.renderer, { kittyKeyboard: true })

afterAll(() => {
  setup.renderer.destroy()
})

async function frame(): Promise<string> {
  await setup.renderOnce()
  return setup.captureCharFrame()
}

describe("transcript shell", () => {
  test("renders the subject header and transcript content", async () => {
    await setup.waitForFrame((current) => current.includes("flaky-retry-fix"))
    const current = await frame()
    expect(current).toContain("▎ flaky-retry-fix")
    expect(current).toContain("Fix the flaky retry test")
    expect(current).toContain("$ bun test api")
    expect(current).toContain("retry now uses exponential backoff")
  })

  test("no pinned chrome: no product name, no help line", async () => {
    const current = await frame()
    expect(current).not.toContain("AGENTCHATS")
    expect(current.toLowerCase()).not.toContain("ctrl+k")
    const rows = current.split("\n")
    expect(rows[0].trim()).toBe("")
  })

  test("assistant footer chip shows harness and model", async () => {
    const current = await frame()
    expect(current).toContain("Claude · claude-fable-5")
  })

  test("tool detail toggle hides completed tools", async () => {
    setup.mockInput.pressKey("d")
    await setup.waitForFrame((current) => !current.includes("$ bun test api"))
    setup.mockInput.pressKey("d")
    await setup.waitForFrame((current) => current.includes("$ bun test api"))
  })

  test("timestamps toggle via direct hotkey", async () => {
    setup.mockInput.pressKey("s")
    await setup.waitForFrame((current) => /10:00|AM|PM/.test(current))
    setShowTimestamps(false)
  })
})

describe("command palette", () => {
  test("ctrl+k opens, filters, and runs; esc closes", async () => {
    setup.mockInput.pressKey("k", { ctrl: true })
    await setup.waitForFrame((current) => current.includes("COMMANDS"))
    let current = await frame()
    expect(current).toContain("type to filter")
    expect(current).toContain("[q]")

    await setup.mockInput.typeText("quit")
    current = await frame()
    expect(current).toContain("> quit")
    expect(current).not.toContain("follow the tail")

    // A lone ESC byte coalesces with following input in a mocked stream, so
    // the escape path is exercised through the kitty keyboard encoding.
    kittyInput.pressKey("ESCAPE")
    await setup.waitForFrame((current) => !current.includes("COMMANDS"))

    setup.mockInput.pressKey("k", { ctrl: true })
    await setup.waitForFrame((current) => current.includes("COMMANDS"))
    await setup.mockInput.typeText("quit")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((current) => !current.includes("COMMANDS"))
    expect(quitCalled).toBe(true)
  })

  test("q quits directly when the palette is closed", async () => {
    quitCalled = false
    setup.mockInput.pressKey("q")
    await setup.waitFor(() => quitCalled)
  })
})

describe("narrow width", () => {
  test("80→40 columns still renders without pinned chrome", async () => {
    setup.resize(40, 20)
    await setup.renderOnce()
    setup.mockInput.pressKey("g")
    await setup.waitForFrame((current) => current.includes("flaky-retry-fix"), { maxPasses: 60 })
    const current = await frame()
    // Scrolled to the top, the breathing row leads — nothing pinned above it.
    expect(current.split("\n")[0].trim()).toBe("")
    expect(current).not.toContain("AGENTCHATS")
    setup.resize(80, 34)
  })
})
