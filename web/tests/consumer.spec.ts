import { expect, test } from "@playwright/test"

test("built package composes independent lanes, scopes CSS, follows idle updates, and handles live revisions", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/tests/consumer.html")
  await expect(page.getByText("Voice lane", { exact: true })).toBeVisible()
  const transcript = page.getByRole("region", {
    name: "agent transcript",
    exact: true,
  })
  await expect(transcript.locator(".message-author").last()).toHaveText("Agent")
  await expect
    .poll(() =>
      transcript.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThan(2)
  await expect(transcript.getByRole("button")).toHaveCount(0)
  await expect(transcript.locator("time")).toHaveCount(0)
  expect(await transcript.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await transcript.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(500)
  await expect(page.locator("#host-marker")).toHaveCSS("color", "rgb(0, 0, 0)")
  await expect(page.locator("body")).toHaveCSS("margin", "8px")
  await expect(transcript.locator(".message-author").last()).toHaveCSS(
    "color",
    "rgb(229, 231, 223)",
  )
  await page.evaluate(() => {
    const state = (window as any).consumerState
    state.live = [
      {
        id: "streamed",
        role: "assistant",
        content: "First live text",
        createdAt: "2026-09-13T12:00:00Z",
        status: "streaming",
      },
    ]
  })
  await expect(
    transcript.getByText("First live text", { exact: true }),
  ).toBeInViewport()
  await page.evaluate(() => {
    ;(window as any).consumerState.live[0] = {
      ...(window as any).consumerState.live[0],
      content: "Revised live text",
      status: "complete",
    }
  })
  await expect(
    transcript.getByText("Revised live text", { exact: true }),
  ).toHaveCount(1)
  await expect(
    transcript.getByText("First live text", { exact: true }),
  ).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as any).consumerState.fail = true
  })
  await expect(page.getByRole("alert")).toContainText("Server disconnected")
  await expect(
    transcript.getByText("Revised live text", { exact: true }),
  ).toHaveCount(1)
  await page.evaluate(() => {
    ;(window as any).consumerState.fail = false
  })
  await expect(page.getByRole("alert")).toHaveCount(0)
  await page.getByRole("button", { name: "Toggle polling" }).click()
  const polls = await page.evaluate(
    () => (window as any).consumerState.polls.length,
  )
  await page.waitForTimeout(300)
  expect(
    await page.evaluate(() => (window as any).consumerState.polls.length),
  ).toBe(polls)
  await page.getByRole("button", { name: "Slow session" }).click()
  await expect(
    page
      .getByRole("region", { name: "slow transcript", exact: true })
      .locator(".message-author"),
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Other session" }).click()
  await expect(
    page
      .getByRole("region", { name: "other transcript", exact: true })
      .locator(".message-author"),
  ).toHaveCount(26)
  await page.waitForTimeout(750)
  await expect(
    page
      .getByRole("region", { name: "other transcript", exact: true })
      .locator(".message-author"),
  ).toHaveCount(26)
  expect(
    await page.evaluate(() => (window as any).consumerState.aborted),
  ).toContain("load:slow")
  await page.getByRole("button", { name: "Copy code", exact: true }).hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    "Copy code",
  )
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCSS(
    "background-color",
    "rgb(229, 231, 223)",
  )
  await page.locator(".file-change-event .tool-disclosure__trigger").click()
  await expect(page.locator(".pierre-diff")).toHaveCount(0)
  await page.getByRole("button", { name: "Expand diff for example.ts" }).click()
  await expect(page.locator(".pierre-diff")).toBeVisible()
  expect(errors).toEqual([])
})

test("an unavailable source can retry without restarting the other transcript lane", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?failLoad=1")
  await expect(page.getByRole("alert")).toHaveCount(2)
  await page.evaluate(() => {
    ;(window as any).consumerState.failLoad = false
  })
  const agent = page.getByRole("region", { name: "agent lane", exact: true })
  await agent.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(agent.getByRole("alert")).toHaveCount(0)
  await expect(agent.locator(".message-author")).toHaveCount(26)
  await expect(
    page
      .getByRole("region", { name: "voice lane", exact: true })
      .getByRole("alert"),
  ).toContainText("No transcript server")
})

test("polling lanes show independent unread chips and resume after a jump", async ({ page }) => {
  await page.goto("/tests/consumer.html")
  const agent = page.getByRole("region", { name: "agent lane", exact: true })
  const viewport = agent.getByRole("region", { name: "agent transcript", exact: true })
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
  await viewport.hover()
  await page.mouse.wheel(0, -900)
  await expect(agent.getByRole("button", { name: "Jump to latest", exact: true })).toHaveAttribute("data-active", "true")
  await page.evaluate(() => {
    ;(window as any).consumerState.live = [
      { id: "unread", role: "assistant", content: "Polling unread", status: "complete" },
    ]
  })
  await expect(agent.getByRole("button", { name: "1 new message. Jump to latest", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "voice lane", exact: true }).getByRole("button", { name: /new message/ })).toHaveCount(0)
  await agent.getByRole("button", { name: "1 new message. Jump to latest", exact: true }).click()
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
  await expect(agent.getByRole("button", { name: /new message/ })).toHaveCount(0)
})
