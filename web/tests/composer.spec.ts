import { expect, test, type Page } from "@playwright/test"

const calls = (page: Page) =>
  page.evaluate(() => (window as any).composerHost.calls)
const update = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate(
    (patch) =>
      (window as any).composerHost.setProps((props: any) => ({
        ...props,
        ...patch,
      })),
    patch,
  )

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/composer.html")
})

test("Send retains rejected drafts, prevents duplicate requests, and supports multiline/IME input", async ({
  page,
}) => {
  const input = page.getByRole("textbox", {
    name: "Message Agent",
    exact: true,
  })
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled()
  await input.fill("  A draft  ")
  await page.evaluate(() => {
    ;(window as any).composerHost.delay = true
  })
  await input.press("Enter")
  await expect(input).toHaveAttribute("readonly")
  await input.press("Enter")
  expect(await calls(page)).toEqual([{ action: "send", args: ["A draft"] }])
  await page.evaluate(() => (window as any).composerHost.settle("Send failed"))
  await expect(page.getByRole("alert")).toHaveText("Send failed")
  await expect(input).toHaveValue("  A draft  ")
  await page.evaluate(() => {
    ;(window as any).composerHost.delay = false
  })
  await input.fill("One")
  await input.press("Shift+Enter")
  await input.press("T")
  await expect(input).toHaveValue("One\nT")
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true })
  expect(await calls(page)).toHaveLength(1)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toHaveValue("")
  expect(await calls(page)).toEqual([
    { action: "send", args: ["A draft"] },
    { action: "send", args: ["One\nT"] },
  ])
})

test("active mode defaults to Steer, exposes Queue, and keeps Stop pending until terminal state", async ({
  page,
}) => {
  await update(page, { active: true })
  const input = page.getByRole("textbox", {
    name: "Message Agent",
    exact: true,
  })
  await expect(
    page.getByRole("button", { name: "Stop Agent", exact: true }),
  ).toBeEnabled()
  await input.fill("Adjust the current work")
  await page.getByRole("button", { name: "Steer", exact: true }).click()
  await expect(input).toHaveValue("")
  expect(await calls(page)).toEqual([
    { action: "steer", args: ["Adjust the current work"] },
  ])
  await page.getByRole("button", { name: "Follow-up behavior" }).click()
  await expect(page.getByRole("menu")).toHaveCSS(
    "background-color",
    "rgb(17, 21, 16)",
  )
  await page.getByRole("menuitemradio", { name: "Queue for next turn" }).click()
  await expect(page.getByRole("menu")).toHaveCount(0)
  await input.fill("Do this next")
  await page.getByRole("button", { name: "Queue", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Do this next")
  await input.fill("Steer once instead")
  await input.press("Control+Shift+Enter")
  await expect(input).toHaveValue("")
  expect((await calls(page)).at(-1)).toEqual({
    action: "steer",
    args: ["Steer once instead"],
  })
  await page.getByRole("button", { name: "Stop Agent", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Stop Agent", exact: true }),
  ).toBeDisabled()
  await expect(page.getByRole("status")).toContainText("Stopping…")
  await update(page, { active: false, stopping: false })
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled()
  expect((await calls(page)).at(-1)).toEqual({ action: "interrupt", args: [] })
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("Do this next")
})

test("editing waits for host acceptance and cancel restores the draft without sending", async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(window as any).composerHost.setQueue([
      { id: "one", text: "A queued message" },
    ])
    ;(window as any).composerHost.rejectEdit = true
  })
  await page
    .getByRole("textbox", { name: "Message Agent", exact: true })
    .fill("Unsent draft")
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveText(
    "This queued message has already been sent.",
  )
  await expect(
    page.getByRole("textbox", { name: "Message Agent", exact: true }),
  ).toHaveValue("Unsent draft")
  await page.evaluate(() => {
    ;(window as any).composerHost.rejectEdit = false
  })
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Edit queued message", exact: true }),
  ).toHaveValue("A queued message")
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Message Agent", exact: true }),
  ).toHaveValue("Unsent draft")
  expect(await calls(page)).toEqual([])
  expect(
    await page.evaluate(() => (window as any).composerHost.editing),
  ).toBeNull()
})

test("queued edit preserves position and prior draft; paused rows require explicit permitted actions", async ({
  page,
}) => {
  await update(page, { active: true })
  await page.evaluate(() =>
    (window as any).composerHost.setQueue([
      { id: "first", text: "First queued" },
      {
        id: "second",
        text: "Second queued",
        pausedReason: "Stopped by you",
        canResume: true,
      },
      {
        id: "unknown",
        text: "Unknown delivery",
        pausedReason: "Delivery is unknown",
        canSteer: false,
        canResume: false,
      },
    ]),
  )
  const first = page.getByRole("listitem", {
    name: "Queued message: First queued",
    exact: true,
  })
  const unknown = page.getByRole("listitem", {
    name: "Queued message: Unknown delivery",
    exact: true,
  })
  await expect(
    unknown.getByRole("button", { name: "Resume", exact: true }),
  ).toBeDisabled()
  await expect(
    unknown.getByRole("button", { name: "Steer", exact: true }),
  ).toBeDisabled()
  await page
    .getByRole("textbox", { name: "Message Agent", exact: true })
    .fill("Existing unsent draft")
  await first.getByRole("button", { name: "Edit", exact: true }).click()
  const edit = page.getByRole("textbox", {
    name: "Edit queued message",
    exact: true,
  })
  await expect(edit).toHaveValue("First queued")
  expect(await page.evaluate(() => (window as any).composerHost.editing)).toBe(
    "first",
  )
  await edit.fill("Edited first queued")
  await page
    .getByRole("button", { name: "Save queued message", exact: true })
    .click()
  await expect(
    page.getByRole("textbox", { name: "Message Agent", exact: true }),
  ).toHaveValue("Existing unsent draft")
  expect(await calls(page)).toEqual([
    { action: "editQueued", args: ["first", "Edited first queued"] },
  ])
  await expect(page.getByRole("listitem").first()).toHaveAccessibleName(
    "Queued message: Edited first queued",
  )
  const second = page.getByRole("listitem", {
    name: "Queued message: Second queued",
    exact: true,
  })
  await second.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(second.getByRole("status")).toHaveCount(0)
  await unknown.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(unknown).toHaveCount(0)
  await page
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: "Steer", exact: true })
    .click()
  expect((await calls(page)).at(-1)).toEqual({
    action: "steerQueued",
    args: ["first"],
  })
})

test("disabled and pending states prevent dispatch; late completion cannot erase a new session draft", async ({
  page,
}) => {
  const input = page.getByRole("textbox", {
    name: "Message Agent",
    exact: true,
  })
  await update(page, { disabled: true })
  await expect(input).toBeDisabled()
  await update(page, { disabled: false })
  await input.fill("Old session")
  await update(page, { pending: true })
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled()
  await update(page, { pending: false })
  await page.evaluate(() => {
    ;(window as any).composerHost.delay = true
  })
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toHaveAttribute("readonly")
  await update(page, { transcriptId: "two" })
  await expect(input).toHaveValue("")
  await input.fill("New session draft")
  await page.evaluate(() => (window as any).composerHost.settle())
  await expect(input).toHaveValue("New session draft")
  expect(await calls(page)).toEqual([{ action: "send", args: ["Old session"] }])
})

test("desktop-like composer and queue reflow on a narrow host without touching page styles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await update(page, { active: true })
  await page.evaluate(() =>
    (window as any).composerHost.setQueue([
      {
        id: "paused",
        text: "Then check the live transcript layout on a narrow screen.",
        pausedReason: "Stopped by you",
        canResume: true,
      },
    ]),
  )
  await page
    .getByRole("textbox", { name: "Message Agent", exact: true })
    .fill("Keep the Human and Agent labels.")
  await expect(
    page.getByRole("button", { name: "Steer", exact: true }).last(),
  ).toBeInViewport()
  await expect(page.locator("#host-marker")).toHaveCSS("color", "rgb(0, 0, 0)")
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({ path: "test-results/composer-mobile.png" })
})
