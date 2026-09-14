import { expect, test, type Page } from "@playwright/test"

const input = (page: Page, name = "Message Agent") =>
  page.getByRole("textbox", { name, exact: true })
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

test("keeps the latest draft through reader resets, reconnect gating, and scope replacement", async ({
  page,
}) => {
  await update(page, {
    persistenceScope: "workspace-a:thread-a:agent",
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await input(page).fill("A draft before the reader resets")
  await update(page, { transcriptId: "reader-incarnation-two" })
  await expect(input(page)).toHaveValue("A draft before the reader resets")

  await update(page, { actionsDisabled: true })
  await expect(input(page)).toBeEnabled()
  await input(page).fill("A draft typed while reconnecting")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled()

  await update(page, {
    persistenceScope: "workspace-a:thread-b:agent",
    actionsDisabled: false,
  })
  await expect(input(page)).toHaveValue("")
  await input(page).fill("Thread B draft")
  await update(page, { persistenceScope: "workspace-a:thread-a:agent" })
  await expect(input(page)).toHaveValue("A draft typed while reconnecting")

  await page.reload()
  await update(page, {
    persistenceScope: "workspace-a:thread-a:agent",
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await expect(input(page)).toHaveValue("A draft typed while reconnecting")
})

test("restores unknown submitted text without replay and exact echo pruning preserves the newer draft", async ({
  page,
}) => {
  const scope = "workspace-pending:thread-pending:agent"
  await update(page, {
    persistenceScope: scope,
    active: true,
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await page.evaluate(() => {
    ;(window as any).composerHost.delay = true
  })
  await input(page).fill("Submitted before reload")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await input(page).fill("Newer draft after submit")
  const clientId = await page.evaluate(
    () => (window as any).composerHost.submissions[0].clientId as string,
  )

  await page.reload()
  await update(page, {
    persistenceScope: scope,
    active: true,
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await expect(input(page)).toHaveValue("Newer draft after submit")
  const recovery = page.getByRole("alert").filter({
    hasText: "Delivery status is unknown after reload.",
  })
  await expect(recovery).toContainText("Submitted before reload")
  expect(
    await page.evaluate(() => (window as any).composerHost.calls),
  ).toEqual([])

  await update(page, { observedSubmissionIds: [clientId] })
  await expect(recovery).toHaveCount(0)
  await expect(input(page)).toHaveValue("Newer draft after submit")
})

test("an authoritative echo wins over a later callback rejection", async ({ page }) => {
  await update(page, {
    persistenceScope: "workspace-race:thread-race:agent",
    active: true,
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await page.evaluate(() => {
    ;(window as any).composerHost.delay = true
  })
  await input(page).fill("Already reached the transcript")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await input(page).fill("Keep this newer draft")
  const clientId = await page.evaluate(
    () => (window as any).composerHost.submissions[0].clientId as string,
  )
  await update(page, { observedSubmissionIds: [clientId] })
  await page.evaluate(() =>
    (window as any).composerHost.settle("Late transport rejection"),
  )
  await expect(page.getByText("Late transport rejection")).toHaveCount(0)
  await expect(page.getByText("Already reached the transcript")).toHaveCount(0)
  await expect(input(page)).toHaveValue("Keep this newer draft")
})

test("queued edit and saved main draft survive reload, then Save reacquires the row", async ({
  page,
}) => {
  const scope = "workspace-edit:thread-edit:agent"
  await update(page, { persistenceScope: scope, alwaysShowSend: true })
  await page.evaluate(() =>
    (window as any).composerHost.setQueue([
      { id: "queued-one", text: "Original queued text" },
    ]),
  )
  await input(page).fill("Saved main draft")
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await input(page, "Edit queued message").fill("Edited during reload")

  await page.reload()
  await page.evaluate(() =>
    (window as any).composerHost.setQueue([
      { id: "queued-one", text: "Original queued text" },
    ]),
  )
  await update(page, { persistenceScope: scope, alwaysShowSend: true })
  await expect(input(page, "Edit queued message")).toHaveValue(
    "Edited during reload",
  )
  await page
    .getByRole("button", { name: "Save queued message", exact: true })
    .click()
  await expect(input(page)).toHaveValue("Saved main draft")
  expect(
    await page.evaluate(() => (window as any).composerHost.calls),
  ).toEqual([
    { action: "editQueued", args: ["queued-one", "Edited during reload"] },
  ])
  expect(
    await page.evaluate(() => (window as any).composerHost.editing),
  ).toBeNull()
})

test("storage failure stays visible without blocking input or an authorized send", async ({
  page,
}) => {
  await update(page, {
    persistenceScope: "workspace-storage:thread-storage:agent",
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    ;(window as any).restoreStorage = () => {
      Storage.prototype.setItem = original
    }
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError")
    }
  })
  await input(page).fill("Still editable without storage")
  await expect(page.getByRole("alert")).toContainText(
    "Browser storage is unavailable.",
  )
  await update(page, { transcriptId: "storage-reader-reset" })
  await expect(input(page)).toHaveValue("Still editable without storage")
  await expect(page.getByRole("alert")).toContainText(
    "Browser storage is unavailable.",
  )
  await page.getByRole("button", { name: "Send", exact: true }).click()
  expect(
    await page.evaluate(() => (window as any).composerHost.calls),
  ).toEqual([{ action: "send", args: ["Still editable without storage"] }])
  await expect(page.getByRole("alert")).toContainText(
    "may not be recoverable after a reload",
  )
  await page.evaluate(() => (window as any).restoreStorage())
  await input(page).fill("Persistence works again")
  await page.waitForTimeout(180)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await page.reload()
  await update(page, {
    persistenceScope: "workspace-storage:thread-storage:agent",
    alwaysShowSend: true,
    optimisticSubmit: true,
  })
  await expect(input(page)).toHaveValue("Persistence works again")
})

test("reloaded queued edit can be cancelled and releases the host hold", async ({
  page,
}) => {
  const scope = "workspace-cancel:thread-cancel:agent"
  await update(page, { persistenceScope: scope, alwaysShowSend: true })
  await page.evaluate(() =>
    (window as any).composerHost.setQueue([
      { id: "queued-cancel", text: "Queued before reload" },
    ]),
  )
  await input(page).fill("Main draft before edit")
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await input(page, "Edit queued message").fill("Queued edit before reload")
  await page.reload()
  await page.evaluate(() =>
    (window as any).composerHost.setQueue([
      { id: "queued-cancel", text: "Queued before reload" },
    ]),
  )
  await update(page, { persistenceScope: scope, alwaysShowSend: true })
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click()
  await expect(input(page)).toHaveValue("Main draft before edit")
  expect(
    await page.evaluate(() => (window as any).composerHost.editing),
  ).toBeNull()
})

test("rapid composed input batches storage writes and reloads the final value", async ({
  page,
}) => {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    ;(window as any).composerStorageWrites = 0
    Storage.prototype.setItem = function (...args) {
      ;(window as any).composerStorageWrites += 1
      return original.apply(this, args)
    }
  })
  const scope = "workspace-ime:thread-ime:agent"
  await update(page, { persistenceScope: scope })
  const field = input(page)
  await field.dispatchEvent("compositionstart")
  await field.pressSequentially("Fast input and 日本語", { delay: 0 })
  await field.dispatchEvent("compositionend")
  await page.waitForTimeout(180)
  expect(
    await page.evaluate(() => (window as any).composerStorageWrites),
  ).toBeLessThanOrEqual(2)
  await page.reload()
  await update(page, { persistenceScope: scope })
  await expect(input(page)).toHaveValue("Fast input and 日本語")
})

test("Cmd/Ctrl+V and synthetic paste are not prevented by composer handlers", async ({
  page,
}) => {
  const field = input(page)
  await field.dispatchEvent("keydown", {
    key: "v",
    code: "KeyV",
    metaKey: true,
  })
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "Synthetic paste payload")
    document.querySelector("textarea")?.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    )
  })
  expect(
    await page.evaluate(
      () => (window as any).composerHost.pasteKeyDefaultPrevented,
    ),
  ).toBe(false)
  expect(
    await page.evaluate(
      () => (window as any).composerHost.pasteEventDefaultPrevented,
    ),
  ).toBe(false)
  expect(
    await page.evaluate(() => (window as any).composerHost.pastePayload),
  ).toBe("Synthetic paste payload")
})

test("another tab receives explicit recoveries without overwriting either live draft", async ({
  context,
  page,
}) => {
  const scope = "workspace-tabs:thread-tabs:agent"
  await update(page, { persistenceScope: scope })
  await input(page).fill("Draft in the first tab")
  await page.waitForTimeout(180)

  const second = await context.newPage()
  await second.goto("/tests/composer.html")
  await update(second, { persistenceScope: scope })
  await expect(input(second)).toHaveValue("")
  await expect(second.getByRole("alert")).toContainText(
    "Draft recovered from another browser session.",
  )
  await expect(second.getByRole("alert")).toContainText("Draft in the first tab")
  await input(second).fill("Draft in the second tab")
  await second.waitForTimeout(180)
  await expect(input(page)).toHaveValue("Draft in the first tab")
  await second.close()
})

test("does not overwrite an unreadable durable slot", async ({ page }) => {
  const scope = "workspace-corrupt:thread-corrupt:agent"
  await update(page, { persistenceScope: scope })
  await input(page).fill("Valid draft before corruption")
  await page.waitForTimeout(180)
  const slotKey = await page.evaluate((scope) => {
    const prefix = `@agentchats/transcript:composer:v2:${encodeURIComponent(scope)}:`
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith(prefix),
    )
    if (!key) throw new Error("Expected a durable composer slot")
    localStorage.setItem(key, "{unreadable")
    return key
  }, scope)

  await page.reload()
  await update(page, { persistenceScope: scope })
  await expect(page.getByRole("alert")).toContainText(
    "Browser storage is unavailable.",
  )
  await input(page).fill("Do not overwrite unreadable data")
  await page.waitForTimeout(180)
  expect(
    await page.evaluate((key) => localStorage.getItem(key), slotKey),
  ).toBe("{unreadable")
})

test("activity divider is full width, adds no height, and stays still for reduced motion", async ({
  page,
}) => {
  await update(page, { active: true, alwaysShowSend: true })
  const composer = page.locator(".transcript-composer")
  const line = page.locator(".transcript-composer__activity-line")
  await expect(line).toHaveAttribute("role", "status")
  await expect(line).toHaveAccessibleName("Agent is working")
  const geometry = await page.evaluate(() => {
    const root = document.querySelector(".transcript-composer")!.getBoundingClientRect()
    const line = document
      .querySelector(".transcript-composer__activity-line")!
      .getBoundingClientRect()
    const pseudo = getComputedStyle(
      document.querySelector(".transcript-composer__activity-line")!,
      "::after",
    )
    return {
      rootWidth: root.width,
      lineWidth: line.width,
      lineTop: line.top,
      rootTop: root.top,
      height: line.height,
      animationName: pseudo.animationName,
      segmentWidth: Number.parseFloat(pseudo.width),
    }
  })
  expect(geometry.lineWidth).toBe(geometry.rootWidth)
  expect(geometry.lineTop).toBe(geometry.rootTop - 1)
  expect(geometry.height).toBe(2)
  expect(geometry.animationName).toBe("none")
  expect(geometry.segmentWidth).toBe(geometry.lineWidth)
  await expect(composer.locator(".transcript-composer__working")).toHaveCount(0)
  await expect(composer.locator(".transcript-composer__progress")).toHaveCount(0)
})
