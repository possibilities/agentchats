import { expect, test } from "@playwright/test"
import { groupTranscript } from "../src/lib/transcript"
import type { Message } from "../src/types/message"
import { item, mockHistory } from "./fixtures"

const viewport = '[data-slot="message-scroller-viewport"]'

test("grouping preserves message boundaries and stable live group ids", () => {
  const message = (id: string, role: Message["role"]): Message => ({
    id,
    role,
    content: id,
    createdAt: new Date().toISOString(),
    status: "complete",
  })
  const source = [
    message("u", "user"),
    message("t1", "tool"),
    message("t2", "tool"),
    message("a", "assistant"),
    message("t3", "tool"),
  ]
  const grouped = groupTranscript(source)
  expect(grouped.map((entry) => [entry.kind, entry.id])).toEqual([
    ["message", "u"],
    ["activity", "t1"],
    ["message", "a"],
    ["activity", "t3"],
  ])
  expect(groupTranscript([...source, message("t4", "tool")]).at(-1)?.id).toBe(
    "t3",
  )
  expect(source).toHaveLength(5)
})

test("Messages contains only conversation; Full collapses 100 activities and per-file Pierre diffs", async ({
  page,
}) => {
  await mockHistory(page)
  await page.goto("/")
  await expect(page.locator('[data-slot="message"]')).toHaveCount(4)
  await expect(page.locator(".activity-group")).toHaveCount(0)
  await expect(page.locator("textarea")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Voice/ })).toHaveCount(0)
  await page
    .getByRole("button", { name: "Full transcript", exact: true })
    .click()
  const group = page.locator(".activity-group__trigger")
  await expect(group).toContainText("100 activities")
  await expect(group).toContainText("1 failed")
  await expect(group).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator(".tool-disclosure")).toHaveCount(0)
  await group.click()
  await expect(page.locator(".tool-disclosure")).toHaveCount(100)
  await expect(page.locator(".tool-detail pre")).toHaveCount(0)
  const first = page.locator(".tool-disclosure__trigger").first()
  await first.click()
  await expect(
    page
      .getByText("The original transcript order is preserved.", {
        exact: false,
      })
      .first(),
  ).toBeVisible()
  await first.click()
  const files = page.locator(".file-change-event .tool-disclosure__trigger")
  await files.click()
  const file = page.getByRole("button", {
    name: "Expand diff for src/components/chat/chat-pane.tsx",
  })
  await expect(file).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator(".pierre-diff")).toHaveCount(0)
  await file.click()
  await expect(page.locator(".pierre-diff")).toBeVisible()
  await expect(
    page
      .locator(".pierre-diff")
      .getByText("groupTranscript", { exact: false })
      .first(),
  ).toBeVisible()
  await page.getByRole("button", { name: "Messages only", exact: true }).click()
  await expect(page.locator(".activity-group")).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Messages only", exact: true }),
  ).toHaveAttribute("aria-pressed", "true")
})

test("live polling appends once, preserves disclosure state, recovers errors, and stops", async ({
  page,
}) => {
  const state = await mockHistory(page)
  await page.goto("/")
  await page
    .getByRole("button", { name: "Full transcript", exact: true })
    .click()
  await page.locator(".activity-group__trigger").click()
  await page.locator(".tool-disclosure__trigger").first().click()
  await page.getByRole("button", { name: "Watch live", exact: true }).click()
  await expect.poll(() => state.polls).toBeGreaterThan(0)
  state.live = [item(104, "agentMessage", { text: "A new committed reply." })]
  await expect(
    page.getByText("A new committed reply.", { exact: true }),
  ).toHaveCount(1)
  await expect(page.locator(".activity-group__trigger")).toHaveAttribute(
    "aria-expanded",
    "true",
  )
  await expect(
    page.locator(".tool-disclosure__trigger").first(),
  ).toHaveAttribute("aria-expanded", "true")
  state.failPoll = true
  await expect(page.getByRole("alert")).toContainText(
    "History temporarily unavailable.",
  )
  await expect(
    page.getByText("A new committed reply.", { exact: true }),
  ).toHaveCount(1)
  state.failPoll = false
  await expect(page.getByRole("alert")).toHaveCount(0)
  await page.getByRole("button", { name: "Watching", exact: true }).click()
  const count = state.polls
  await page.waitForTimeout(1200)
  expect(state.polls).toBe(count)
  expect(
    state.requests.some((request) =>
      request.includes("after_ordinal=104&detail=full"),
    ),
  ).toBe(true)
})

test("session search, keyboard command palette, density persistence, and session navigation", async ({
  page,
}) => {
  await mockHistory(page)
  await page.goto("/")
  await page.getByRole("textbox", { name: "Find a session" }).fill("agentusage")
  await expect(
    page.getByRole("list", { name: "Recent sessions" }).getByRole("button"),
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Clear session search" }).click()
  await page.keyboard.press("Control+k")
  await expect(page.getByRole("dialog")).toBeVisible()
  const search = page.getByRole("combobox", { name: "Find a command" })
  await expect(search).toBeFocused()
  await search.fill("full transcript")
  await search.press("Enter")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.locator(".activity-group__trigger")).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Full transcript", exact: true }),
  ).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox").fill("usage readings")
  await page.getByRole("combobox").press("Enter")
  await expect(page).toHaveURL(/thread=session-1/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Keep usage readings stable during refresh",
  )
})

test("empty, error recovery, narrow and shallow layouts retain usable controls", async ({
  page,
}) => {
  const state = await mockHistory(page, { empty: true })
  state.failIndex = true
  await page.goto("/")
  await expect(page.getByRole("alert")).toContainText(
    "Session index unavailable",
  )
  state.failIndex = false
  await page.getByRole("button", { name: "Retry session index" }).click()
  await expect(
    page.getByText("No local sessions yet.", { exact: false }),
  ).toBeVisible()
  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 1024, height: 360 },
  ]) {
    await page.setViewportSize(size)
    await expect(page.locator(viewport)).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await expect(
      page.getByRole("button", { name: "Full transcript", exact: true }),
    ).toBeInViewport()
    await expect(
      page.getByRole("button", { name: "Watch live", exact: true }),
    ).toBeInViewport()
  }
})

test("mobile session drawer closes on selection and long content does not overflow", async ({
  page,
}) => {
  await mockHistory(page, { long: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByRole("button", { name: "Toggle session history" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: /Keep usage readings stable/ }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page).toHaveURL(/thread=session-1/)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  expect(
    await page
      .locator(viewport)
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true)
})

test("thread retry works and live updates respect a reader who scrolls away", async ({
  page,
}) => {
  const state = await mockHistory(page, { long: true })
  state.failThread = true
  await page.goto("/?thread=design-review")
  await expect(page.getByRole("alert")).toContainText(
    "Could not open this conversation",
  )
  state.failThread = false
  await page.getByRole("button", { name: "Retry history" }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await page.getByRole("button", { name: "Watch live", exact: true }).click()
  await expect.poll(() => state.polls).toBeGreaterThan(0)
  await page.locator(viewport).hover()
  await page.mouse.wheel(0, -1200)
  await expect(
    page.getByRole("button", { name: "Jump to latest" }),
  ).toBeVisible()
  const before = await page
    .locator(viewport)
    .evaluate((element) => element.scrollTop)
  state.live = [
    item(105, "agentMessage", {
      text: "An update while reading earlier messages.",
    }),
  ]
  await expect(
    page.getByText("An update while reading earlier messages."),
  ).toHaveCount(1)
  const after = await page
    .locator(viewport)
    .evaluate((element) => element.scrollTop)
  expect(Math.abs(after - before)).toBeLessThan(5)
  await page.getByRole("button", { name: "Jump to latest" }).click()
  await expect(
    page.getByText("An update while reading earlier messages."),
  ).toBeInViewport()
})
