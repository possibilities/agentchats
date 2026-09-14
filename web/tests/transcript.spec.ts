import { expect, test } from "@playwright/test"
import { groupTranscript } from "../src/lib/transcript"
import { mapCodexSubagentActivity } from "../src/transcript/codex"
import type { Message } from "../src/types/message"
import { item, mockHistory } from "./fixtures"

const viewport = '[data-slot="message-scroller-viewport"]'

function subagentMessage(
  id: string,
  kind: string,
  agentPath: string,
): Message {
  const mapped = mapCodexSubagentActivity({
    id,
    kind,
    agentThreadId: `thread-${id}`,
    agentPath,
  })!
  return {
    id,
    role: "tool",
    content: mapped.content,
    status: "complete",
    toolActivity: mapped.activity,
  }
}

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

test("message-keyed disclosures survive singleton grouping and prepends, then reset by transcript", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?direct")
  const tool = (id: string, detail: string): Message => ({
    id,
    role: "tool",
    content: detail,
    status: "complete",
    toolActivity: {
      name: "Command",
      detail,
      state: "complete",
      sections: [{ label: "Command", content: detail }],
    },
  })
  await page.evaluate((messages) => {
    const host = (window as any).directTranscript
    host.setDetail("full")
    host.setMessages(messages)
  }, [tool("stable", "original command")])
  const stable = page.locator(".tool-disclosure__trigger", {
    hasText: "original command",
  })
  await stable.click()
  await expect(stable).toHaveAttribute("aria-expanded", "true")

  await page.evaluate((messages) => {
    ;(window as any).directTranscript.setMessages(messages)
  }, [tool("stable", "streamed command"), tool("appended", "appended command")])
  const group = page.locator(".activity-group__trigger")
  await expect(group).toHaveAttribute("aria-expanded", "true")
  const streamed = page.locator(".tool-disclosure__trigger", {
    hasText: "streamed command",
  })
  await expect(streamed).toHaveAttribute("aria-expanded", "true")

  await page.evaluate((messages) => {
    ;(window as any).directTranscript.setMessages(messages)
  }, [
    tool("prepended", "prepended command"),
    tool("stable", "polled command"),
    tool("appended", "appended command"),
  ])
  await expect(group).toHaveAttribute("aria-expanded", "true")
  await expect(
    page.locator(".tool-disclosure__trigger", { hasText: "polled command" }),
  ).toHaveAttribute("aria-expanded", "true")

  await page.evaluate(() => {
    ;(window as any).directTranscript.setId("another-transcript")
  })
  await expect(group).toHaveAttribute("aria-expanded", "false")
})

test("a closed earlier tool cannot hide a later expanded tool when they regroup", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?direct")
  const tool = (id: string, detail: string): Message => ({
    id,
    role: "tool",
    content: detail,
    status: "complete",
    toolActivity: {
      name: "Command",
      detail,
      state: "complete",
      sections: [{ label: "Command", content: detail }],
    },
  })
  const first = tool("closed-first", "first command")
  const second = tool("open-second", "second command")
  await page.evaluate((messages) => {
    const host = (window as any).directTranscript
    host.setDetail("full")
    host.setMessages(messages)
  }, [first])
  const firstTrigger = page.locator(".tool-disclosure__trigger", {
    hasText: "first command",
  })
  await firstTrigger.click()
  await firstTrigger.click()
  await expect(firstTrigger).toHaveAttribute("aria-expanded", "false")

  await page.evaluate((messages) => {
    ;(window as any).directTranscript.setMessages(messages)
  }, [second])
  const secondTrigger = page.locator(".tool-disclosure__trigger", {
    hasText: "second command",
  })
  await secondTrigger.click()
  await expect(secondTrigger).toHaveAttribute("aria-expanded", "true")

  await page.evaluate((messages) => {
    ;(window as any).directTranscript.setMessages(messages)
  }, [first, second])
  await expect(page.locator(".activity-group__trigger")).toHaveAttribute(
    "aria-expanded",
    "true",
  )
  await expect(
    page.locator(".tool-disclosure__trigger", { hasText: "second command" }),
  ).toHaveAttribute("aria-expanded", "true")
})

test("windowed subagent lifecycle groups keep every detail reachable through polling", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?direct")
  const singleton = subagentMessage(
    "interaction",
    "interacted",
    "/root/android_disconnected_layout",
  )
  const separator: Message = {
    id: "agent-separator",
    role: "assistant",
    content: "The requested child work is continuing.",
    status: "complete",
  }
  const started = subagentMessage("spawn", "started", "/root/layout_worker")
  const completed = subagentMessage(
    "completion",
    "completed",
    "/root/layout_worker",
  )
  await page.evaluate((messages) => {
    const host = (window as any).directTranscript
    host.setWindowed(true)
    host.setDetail("full")
    host.setMessages(messages)
  }, [singleton, separator, started, completed])

  const scroller = page.locator(viewport)
  const singletonTrigger = page.locator(".tool-disclosure__trigger", {
    hasText: "/root/android_disconnected_layout",
  })
  await singletonTrigger.click()
  await expect(
    page.getByLabel("Agent thread", { exact: true }).filter({ hasText: "thread-interaction" }),
  ).toBeVisible()

  const group = page.locator(".activity-group__trigger")
  await expect(group).toContainText("2 subagent activities")
  await group.click()
  await expect(group).toHaveAttribute("aria-expanded", "true")
  const children = page.locator(".activity-group__items .tool-disclosure")
  await expect(children).toHaveCount(2)

  const startedTrigger = children.nth(0).locator(".tool-disclosure__trigger")
  const completedTrigger = children.nth(1).locator(".tool-disclosure__trigger")
  await startedTrigger.scrollIntoViewIfNeeded()
  await expect(startedTrigger).toBeVisible()
  await startedTrigger.click()
  const startedBody = children.nth(0).getByLabel("Activity", { exact: true })
  await startedBody.scrollIntoViewIfNeeded()
  await expect(startedBody).toHaveText("Started")
  expect(await startedBody.evaluate((element, selector) => {
    const viewport = document.querySelector(selector)!.getBoundingClientRect()
    const body = element.getBoundingClientRect()
    return body.top >= viewport.top && body.bottom <= viewport.bottom
  }, viewport)).toBe(true)
  await completedTrigger.scrollIntoViewIfNeeded()
  await expect(completedTrigger).toBeVisible()
  await completedTrigger.focus()
  await completedTrigger.press("Enter")
  const completedBody = children.nth(1).getByLabel("Activity", { exact: true })
  await completedBody.scrollIntoViewIfNeeded()
  await expect(completedBody).toHaveText("Completed")
  expect(await completedBody.evaluate((element, selector) => {
    const viewport = document.querySelector(selector)!.getBoundingClientRect()
    const body = element.getBoundingClientRect()
    return body.top >= viewport.top && body.bottom <= viewport.bottom
  }, viewport)).toBe(true)
  expect(await scroller.evaluate((element) => element.scrollTop > 0)).toBe(true)

  const followup = subagentMessage("followup", "interacted", "/root/reviewer")
  await page.evaluate((messages) => {
    ;(window as any).directTranscript.setMessages(messages)
  }, [
    { ...singleton },
    separator,
    { ...started },
    { ...completed },
    followup,
  ])
  await expect(group).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(".activity-group__items .tool-disclosure")).toHaveCount(3)
  await expect(
    page.locator(".tool-disclosure__trigger", { hasText: "Started" }),
  ).toHaveAttribute("aria-expanded", "true")
  await expect(
    page.locator(".tool-disclosure__trigger", { hasText: "Completed" }),
  ).toHaveAttribute("aria-expanded", "true")
  const followupTrigger = page.locator(".tool-disclosure__trigger", {
    hasText: "/root/reviewer",
  })
  await followupTrigger.scrollIntoViewIfNeeded()
  await expect(followupTrigger).toBeVisible()
})

test("Human delivery status is announced without changing the source body", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?direct")
  await page.evaluate(() => {
    ;(window as any).directTranscript.setMessages([
      {
        id: "optimistic-human",
        role: "user",
        content: "Keep this source text exact.",
        status: "complete",
        deliveryStatus: "Accepted · waiting for transcript",
      },
    ])
  })
  await expect(page.getByRole("status")).toHaveText(
    "Accepted · waiting for transcript",
  )
  await expect(page.getByText("Keep this source text exact.")).toBeVisible()
})

test("unread count detects a new message ID when the visible count is unchanged", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?direct")
  const messages = Array.from({ length: 40 }, (_, index): Message => ({
    id: `message-${index}`,
    role: "assistant",
    content: `Message ${index}. ${"Readable history. ".repeat(20)}`,
    status: "complete",
  }))
  await page.evaluate((items) => {
    ;(window as any).directTranscript.setMessages(items)
  }, messages)
  const scroller = page.locator(viewport)
  await expect(page.locator('[data-slot="message"]')).toHaveCount(40)
  await scroller.hover()
  await page.mouse.wheel(0, -5_000)
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible()
  messages[messages.length - 1] = {
    ...messages[messages.length - 1],
    id: "replacement-message",
    content: "A new message replaced unavailable history.",
  }
  await page.evaluate((items) => {
    ;(window as any).directTranscript.setMessages(items)
  }, messages)
  await expect(
    page.getByRole("button", {
      name: "1 new message. Jump to latest",
      exact: true,
    }),
  ).toBeVisible()
})

test("Messages contains only conversation; Full collapses 100 activities and per-file Pierre diffs", async ({
  page,
}) => {
  await mockHistory(page)
  await page.goto("/")
  await expect(page.locator('[data-slot="message"]')).toHaveCount(4)
  await expect(page.locator(".message-author")).toHaveText(["Human", "Agent", "Agent", "Human"])
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

test("session search, density persistence, and session navigation without commands", async ({
  page,
}) => {
  await mockHistory(page)
  await page.goto("/")
  await page.getByRole("textbox", { name: "Find a session" }).fill("agentusage")
  await expect(
    page.getByRole("list", { name: "Recent sessions" }).getByRole("button"),
  ).toHaveCount(1)
  await page.getByRole("button", { name: "Clear session search" }).click()
  await expect(page.getByRole("button", { name: "Open commands" })).toHaveCount(0)
  await page.keyboard.press("Control+k")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("combobox")).toHaveCount(0)
  await page.getByRole("button", { name: "Full transcript", exact: true }).click()
  await expect(page.locator(".activity-group__trigger")).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Full transcript", exact: true }),
  ).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: /Keep usage readings stable/ }).click()
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
  const initialTop = await page.locator(viewport).evaluate((element) => element.scrollTop)
  await page.locator(viewport).hover()
  await page.mouse.wheel(0, -1200)
  await expect.poll(() => page.locator(viewport).evaluate((element) => element.scrollTop)).toBeLessThan(initialTop - 1100)
  await expect(
    page.getByRole("button", { name: "Jump to latest" }),
  ).toHaveAttribute("data-active", "true")
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
  await page.getByRole("button", { name: "1 new message. Jump to latest", exact: true }).click()
  await expect(
    page.getByText("An update while reading earlier messages."),
  ).toBeInViewport()
  state.live = [item(106, "agentMessage", { text: "Following after jumping." })]
  await expect(page.getByText("Following after jumping.", { exact: true })).toBeInViewport()
})

for (const working of [false, true]) {
  test(`opens delayed ${working ? "working" : "idle"} history at the bottom with Watch off`, async ({ page }) => {
    await mockHistory(page, { long: true, threadDelay: 150, working })
    await page.goto("/?thread=design-review")
    const bottomGap = () => page.locator(viewport).evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    )
    await expect(page.locator('[data-slot="message"]')).toHaveCount(5)
    await expect.poll(bottomGap).toBeLessThan(2)
    await expect(page.getByRole("button", { name: "Watch live", exact: true })).toHaveAttribute("aria-pressed", "false")
    await page.getByRole("button", { name: "Full transcript", exact: true }).click()
    await expect(page.locator(".activity-group__trigger")).toHaveCount(1)
    await expect.poll(bottomGap).toBeLessThan(2)
    await page.getByRole("button", { name: /Keep usage readings stable/ }).click()
    await expect(page).toHaveURL(/thread=session-1/)
    await expect(page.locator('[data-slot="message"]')).toHaveCount(5)
    await expect.poll(bottomGap).toBeLessThan(2)
    await page.reload()
    await expect(page.locator('[data-slot="message"]')).toHaveCount(5)
    await expect.poll(bottomGap).toBeLessThan(2)
  })
}

test("follows new committed messages while the agent stays idle", async ({ page }) => {
  const state = await mockHistory(page, { long: true })
  await page.goto("/")
  await expect(page.locator('[data-slot="message"]')).toHaveCount(5)
  await page.getByRole("button", { name: "Watch live", exact: true }).click()
  await expect.poll(() => state.polls).toBeGreaterThan(0)
  state.live = [item(105, "agentMessage", { text: "Committed while idle." })]
  await expect(page.getByText("Committed while idle.", { exact: true })).toBeInViewport()
  await expect.poll(() => page.locator(viewport).evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThan(2)
})

test("prompt-seeded metadata becomes a concise title while the first Human message keeps its Markdown", async ({ page }) => {
  await mockHistory(page, { markdownTitle: true })
  await page.goto("/")
  await expect(page.locator(".thread-intro h1")).toHaveText("A Markdown task")
  const first = page.locator('[data-slot="message"]').first()
  await expect(first.locator(".message-author")).toHaveText("Human")
  await expect(first.getByRole("heading", { level: 1 })).toHaveText("A Markdown task")
  await expect(first.getByRole("heading", { level: 2 })).toHaveText("Goal")
  await expect(first.getByRole("listitem")).toHaveCount(2)
  await expect(first.locator("strong")).toHaveText("Markdown")
  await expect(first.locator("code")).toHaveText("code")
  await expect(first.getByRole("link")).toHaveAttribute("href", "https://example.test")
  await expect(page.locator(".session-row__title").first()).toHaveText("A Markdown task")
})
