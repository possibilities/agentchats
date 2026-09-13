import { expect, test } from "@playwright/test"
import { mockHistory } from "./fixtures"

test("capture the real components with synthetic review content", async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await mockHistory(page)
  await page.goto("/")
  await expect(page.locator('[data-slot="message"]')).toHaveCount(4)
  await expect(
    page.getByText("The reading surface is now much quieter."),
  ).toBeVisible()
  await page
    .locator('[data-slot="message-scroller-viewport"]')
    .evaluate((element) => element.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath("messages.png") })
  await page
    .getByRole("button", { name: "Full transcript", exact: true })
    .click()
  await expect(page.locator(".activity-group__trigger")).toBeVisible()
  await page
    .locator('[data-slot="message-scroller-viewport"]')
    .evaluate((element) => element.scrollTo(0, 0))
  // Capture the settled composition after deferred content-visibility paint.
  // Interaction assertions above do not depend on this screenshot-only delay.
  await page.waitForTimeout(250)
  await page.screenshot({ path: testInfo.outputPath("full.png") })
  await page.locator(".activity-group__trigger").click()
  await page.locator(".file-change-event .tool-disclosure__trigger").click()
  await page
    .getByRole("button", {
      name: "Expand diff for src/components/chat/chat-pane.tsx",
    })
    .click()
  await page.locator(".pierre-diff").scrollIntoViewIfNeeded()
  await expect(
    page
      .locator(".pierre-diff")
      .getByText("groupTranscript", { exact: false })
      .first(),
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("diff.png") })
  await page.locator(".activity-group__trigger").click()
  await page
    .locator('[data-slot="message-scroller-viewport"]')
    .evaluate((element) => element.scrollTo(0, 0))
  await page.setViewportSize({ width: 390, height: 844 })
  // Resize restores the followed edge; frame the mobile review at the top.
  await page.waitForTimeout(250)
  await page
    .locator('[data-slot="message-scroller-viewport"]')
    .evaluate((element) => element.scrollTo(0, 0))
  await page.waitForTimeout(250)
  await page.screenshot({ path: testInfo.outputPath("mobile.png") })
  expect(errors).toEqual([])
})
