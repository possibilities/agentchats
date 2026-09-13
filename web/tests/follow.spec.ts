import { expect, test, type Locator, type Page } from "@playwright/test"

const bottomGap = (viewport: Locator) => viewport.evaluate(
  (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
)
const append = (page: Page, ids: string[], role = "assistant") => page.evaluate(
  ({ ids, role }) => (window as any).directTranscript.setMessages((messages: any[]) => [
    ...messages,
    ...ids.map((id) => ({ id, role, content: `${id}\n\n${"New content. ".repeat(200)}`, status: "complete" })),
  ]),
  { ids, role },
)

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/consumer.html?direct=1")
  await expect.poll(() => bottomGap(page.getByRole("region", { name: "Direct transcript" }))).toBeLessThan(2)
})

test("direct props follow large appends and same-ID growth after idle wheel input at the end", async ({ page }) => {
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  await viewport.hover()
  await page.waitForTimeout(250)
  await page.mouse.wheel(0, 600)
  // Let the wheel finish without a scroll event: the viewport is already at its end.
  await page.waitForTimeout(250)
  await append(page, ["new-one", "new-two"])
  await expect(viewport.getByText("new-two", { exact: true })).toHaveCount(1)
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
  await page.evaluate(() => (window as any).directTranscript.setMessages((messages: any[]) =>
    messages.map((message) => message.id === "new-two"
      ? { ...message, content: `${message.content}\n\n${"Streaming paragraph.\n\n".repeat(50)}` }
      : message),
  ))
  await expect(viewport.getByText("Streaming paragraph.", { exact: true })).toHaveCount(50)
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
})

test("near-bottom follows; reading earlier counts arrivals, and keyboard activation resumes follow", async ({ page }) => {
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  await viewport.hover()
  await page.mouse.wheel(0, -32)
  await expect.poll(() => bottomGap(viewport)).toBeGreaterThan(20)
  await append(page, ["near-bottom"])
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
  await page.mouse.wheel(0, -900)
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true })
  await expect(jump).toHaveAttribute("data-active", "true")
  const before = await viewport.evaluate((element) => element.scrollTop)
  await append(page, ["unread-one"])
  const chip = page.getByRole("button", { name: "1 new message. Jump to latest", exact: true })
  await expect(chip).toBeVisible()
  await append(page, ["unread-two", "unread-three"])
  await expect(page.getByRole("button", { name: "3 new messages. Jump to latest", exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).directTranscript.setMessages((messages: any[]) =>
    messages.map((message) => ({ ...message, content: `${message.content} ` })),
  ))
  await expect(page.getByRole("button", { name: "3 new messages. Jump to latest", exact: true })).toBeVisible()
  expect(Math.abs(await viewport.evaluate((element) => element.scrollTop) - before)).toBeLessThan(5)
  await page.getByRole("button", { name: "3 new messages. Jump to latest", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
  await expect(page.getByRole("button", { name: /new messages/ })).toHaveCount(0)
  await append(page, ["following-again"])
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
})

test("manual return clears unread; session, density and loading resets start at the end", async ({ page }) => {
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  for (const reset of ["manual", "session", "density", "loading"]) {
    await viewport.hover()
    await page.mouse.wheel(0, -900)
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveAttribute("data-active", "true")
    await append(page, [`unread-${reset}`])
    await expect(page.getByRole("button", { name: "1 new message. Jump to latest", exact: true })).toBeVisible()
    if (reset === "manual") {
      await page.mouse.wheel(0, 100_000)
    } else {
      await page.evaluate((reset) => {
        const host = (window as any).directTranscript
        if (reset === "session") host.setId("another")
        if (reset === "density") host.setDetail("full")
        if (reset === "loading") host.setLoading(true)
      }, reset)
      if (reset === "loading") {
        await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
        await page.evaluate(() => (window as any).directTranscript.setLoading(false))
      }
    }
    await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
    await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(0)
  }
})

test("counts visible message IDs, including activity appended inside an existing Full block", async ({ page }) => {
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  await viewport.hover()
  await page.mouse.wheel(0, -900)
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveAttribute("data-active", "true")
  await append(page, ["hidden-tool"], "tool")
  await append(page, ["visible-reply"])
  await expect(page.getByRole("button", { name: "1 new message. Jump to latest", exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).directTranscript.setDetail("full"))
  await append(page, ["first-tool"], "tool")
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
  await page.mouse.wheel(0, -900)
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveAttribute("data-active", "true")
  const blocks = await viewport.locator('[data-slot="message-scroller-item"]').count()
  await append(page, ["second-tool", "third-tool"], "tool")
  await expect(page.getByRole("button", { name: "2 new messages. Jump to latest", exact: true })).toBeVisible()
  await expect(viewport.locator('[data-slot="message-scroller-item"]')).toHaveCount(blocks)
})

test("follow opt-out leaves new content unread until a manual jump", async ({ page }) => {
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  await page.evaluate(() => (window as any).directTranscript.setFollow(false))
  await append(page, ["not-followed"])
  await expect(page.getByRole("button", { name: "1 new message. Jump to latest", exact: true })).toBeVisible()
  await expect.poll(() => bottomGap(viewport)).toBeGreaterThan(64)
  await page.getByRole("button", { name: "1 new message. Jump to latest", exact: true }).click()
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(0)
})

test("the unread chip stays reachable in a narrow transcript", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  const viewport = page.getByRole("region", { name: "Direct transcript" })
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
  await viewport.hover()
  await page.mouse.wheel(0, -900)
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toHaveAttribute("data-active", "true")
  await append(page, ["mobile-one", "mobile-two"])
  const chip = page.getByRole("button", { name: "2 new messages. Jump to latest", exact: true })
  await expect(chip).toBeInViewport()
  await expect(page.locator(".agentchats-transcript")).toHaveCSS("background-color", "rgb(9, 11, 10)")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/follow-chip-mobile.png" })
  await chip.click()
  await expect.poll(() => bottomGap(viewport)).toBeLessThan(2)
})
