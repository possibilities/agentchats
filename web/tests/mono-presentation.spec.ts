import { expect, test } from "@playwright/test"
import type { TranscriptMessage } from "@agentchats/transcript"

test("packaged mono transcripts keep a shared reading edge and adapt to the host lane", async ({ page }, testInfo) => {
  await page.goto("/tests/consumer.html?direct=1")
  await page.evaluate(() => {
    const transcript = (window as any).directTranscript
    transcript.setMessages([
      { id: "human", role: "user", content: "Keep the work inspectable while I read the conversation.", status: "complete" },
      {
        id: "agent", role: "assistant", status: "complete",
        content: "A readable line of prose with paths and commands nearby. ".repeat(5) +
          "\n\n```sh\nrg --files " + "src/transcript/".repeat(16) + "\n```",
      },
      {
        id: "tool", role: "tool", content: "Inspect transcript", status: "error",
        toolActivity: { name: "Command", state: "error", detail: "rg --files src/transcript", meta: "exit 1", sections: [{ label: "Output", content: "No matching files in this fixture." }] },
      },
      {
        id: "file", role: "tool", content: "Update presentation", status: "complete",
        fileChanges: [{ path: "src/transcript/presentation.css", kind: "update", diff: "@@ -1 +1 @@\n-before\n+after\n", diffTruncated: false }],
      },
    ] satisfies TranscriptMessage[])
    transcript.setDetail("full")
  })
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  await expect(viewport.locator(".activity-group__trigger")).toContainText("2 activities")
  await viewport.evaluate((el) => el.scrollTo(0, 0))
  const metrics = await viewport.evaluate((el) => {
    const human = el.querySelector('[data-role="user"] .markdown-content p')!
    const agent = el.querySelector('[data-role="assistant"] .markdown-content p')!
    const code = el.querySelector(".code-block")!
    const style = getComputedStyle(agent)
    const context = document.createElement("canvas").getContext("2d")!
    context.font = `${style.fontSize} ${style.fontFamily}`
    return {
      fontSize: parseFloat(style.fontSize),
      narrowGlyphs: context.measureText("iiiiiiii").width,
      wideGlyphs: context.measureText("MMMMMMMM").width,
      measure: context.measureText("0").width * 80,
      prose: agent.getBoundingClientRect().width,
      code: code.getBoundingClientRect().width,
      humanX: human.getBoundingClientRect().x,
      agentX: agent.getBoundingClientRect().x,
    }
  })
  expect(metrics.fontSize).toBeGreaterThanOrEqual(18)
  expect(metrics.narrowGlyphs).toBeCloseTo(metrics.wideGlyphs, 1)
  expect(metrics.prose).toBeLessThanOrEqual(metrics.measure + 1)
  expect(metrics.code).toBeGreaterThan(metrics.prose)
  expect(metrics.humanX).toBeCloseTo(metrics.agentX, 1)

  // Keep the browser wide: compression must respond to its embedded lane.
  for (const width of [480, 320]) {
    await viewport.evaluate((el, width) => {
      const host = el.closest(".chat-pane")!.parentElement!
      host.style.width = `${width}px`
    }, width)
    await viewport.locator(".activity-group__trigger").scrollIntoViewIfNeeded()
    await expect(viewport.locator(".activity-group__summary")).toBeHidden()
    await expect(viewport.getByText("1 failed", { exact: true })).toBeInViewport()
    await expect(viewport.getByText("1 file changes", { exact: true })).toBeInViewport()
    expect(await viewport.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await viewport.locator(".activity-group__trigger").click()
    await viewport.locator(".tool-disclosure__trigger").first().focus()
    await page.keyboard.press("Enter")
    await expect(viewport.getByText("No matching files in this fixture.", { exact: true })).toBeVisible()
    await viewport.locator(".activity-group__trigger").click()
  }
  await viewport.evaluate((el) => el.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath("narrow-package.png") })
})

test("packaged composer uses the transcript face and one keyboard focus treatment", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto("/tests/composer.html")
  const input = page.getByRole("textbox", { name: "Message Agent", exact: true })
  await expect(input).toHaveAttribute("placeholder", "Message Agent…")
  await expect(page.locator("label")).toHaveCount(0)
  await input.fill("Keep the Human and Agent labels.")
  const proseFont = await page.locator(".markdown-content").first().evaluate((el) => getComputedStyle(el).fontFamily)
  await expect(input).toHaveCSS("font-family", proseFont)
  await expect(input).toHaveCSS("font-size", "18px")
  await expect(input).toHaveCSS("outline-style", "none")
  await expect(input).toHaveCSS("box-shadow", "none")
  const field = input.locator("..")
  await expect(field).toHaveCSS("border-color", "rgb(197, 231, 145)")
  await expect(page.locator("#host-marker")).toHaveCSS("color", "rgb(0, 0, 0)")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("composer.png") })
})

test.describe("touch presentation", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 900 } })

  test("large composer text and touch targets fit a narrow lane", async ({ page }, testInfo) => {
    await page.goto("/tests/composer.html")
    const input = page.getByRole("textbox", { name: "Message Agent", exact: true })
    await input.fill("Keep the Human and Agent labels.")
    await page.evaluate(() => (window as any).composerHost.setProps({ transcriptId: "one", active: true }))
    for (const name of ["Follow-up behavior", "Steer"]) {
      const button = page.getByRole("button", { name, exact: true })
      await expect(button).toBeInViewport()
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(input).toHaveCSS("font-size", "18px")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath("touch-composer.png") })
  })
})
