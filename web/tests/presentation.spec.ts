import { expect, test } from "@playwright/test"
import { item, mockHistory } from "./fixtures"

const raw =
  "<realtime_delegation>\n  <input>Keep &lt;code&gt; safe &amp; readable.</input>\n  <transcript_delta>user: Improve the reader\nassistant: I can do that.</transcript_delta>\n</realtime_delegation>"

test("built package shows a readable handoff and inspects all source variants in a modal", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?direct=1")
  await page.evaluate(
    (content) =>
      (window as any).directTranscript.setCodexMessages([
        { id: "voice", role: "user", content, status: "complete" },
      ]),
    raw,
  )
  await expect(page.locator(".message-author")).toHaveText("Human")
  await expect(page.getByText("Via Voice", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Keep <code> safe & readable.", { exact: true }),
  ).toBeVisible()
  await expect(page.locator("code")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Voice context" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Original message" })).toHaveCount(0)

  const trigger = page.getByRole("button", { name: "Inspect voice message" })
  await trigger.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Voice message details" })
  await expect(dialog).toBeVisible()
  const backdrop = page.locator(".voice-message-modal__backdrop")
  await expect(backdrop).toBeVisible()
  expect(await backdrop.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 1440,
    height: 1000,
  })
  await expect(dialog.getByRole("heading", { name: "Displayed text" })).toBeVisible()
  await expect(dialog.getByText("Keep <code> safe & readable.", { exact: true })).toBeVisible()
  const contextSection = dialog
    .getByRole("heading", { name: "Voice context" })
    .locator("..")
  await expect(contextSection).toContainText("user: Improve the reader")
  await expect(dialog.getByRole("heading", { name: "Original message" })).toBeVisible()
  const original = dialog.locator("pre").filter({ hasText: "<realtime_delegation>" })
  await expect(original).toBeVisible()
  expect(await original.textContent()).toBe(raw)
  await page.screenshot({ path: "test-results/voice-handoff.png" })
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("voice inspection preserves context that repeats the displayed request", async ({ page }) => {
  const content =
    "<realtime_delegation><input>Repeat request.</input><transcript_delta>user: Repeat request.</transcript_delta></realtime_delegation>"
  await page.goto("/tests/consumer.html?direct=1")
  await page.evaluate(
    (message) =>
      (window as any).directTranscript.setCodexMessages([
        { id: "voice", role: "user", content: message, status: "complete" },
      ]),
    content,
  )
  await page.getByRole("button", { name: "Inspect voice message" }).click()
  const dialog = page.getByRole("dialog", { name: "Voice message details" })
  const context = dialog
    .getByRole("heading", { name: "Voice context" })
    .locator("..")
    .locator("pre")
  await expect(context).toHaveText("user: Repeat request.")
  expect(
    await dialog
      .getByRole("heading", { name: "Original message" })
      .locator("..")
      .locator("pre")
      .textContent(),
  ).toBe(content)
})

test("voice inspection handles a message without voice context", async ({ page }) => {
  const content =
    "<realtime_delegation><input>Request without context.</input></realtime_delegation>"
  await page.goto("/tests/consumer.html?direct=1")
  await page.evaluate(
    (message) =>
      (window as any).directTranscript.setCodexMessages([
        { id: "voice", role: "user", content: message, status: "complete" },
      ]),
    content,
  )
  await page.getByRole("button", { name: "Inspect voice message" }).click()
  const contextSection = page
    .getByRole("dialog", { name: "Voice message details" })
    .getByRole("heading", { name: "Voice context" })
    .locator("..")
  await expect(contextSection).toContainText(
    "No voice context was included in this message.",
  )
})

test("reader polling normalizes delegation while preserving Human labels and same-message details", async ({
  page,
}) => {
  const state = await mockHistory(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Watch live", exact: true }).click()
  await expect.poll(() => state.polls).toBeGreaterThan(0)
  state.live = [item(105, "userMessage", { content: [{ text: raw }] })]
  await expect(page.getByText("Via Voice", { exact: true })).toBeInViewport()
  const handoff = page.locator('[data-slot="message"]').last()
  await expect(handoff.locator(".message-author")).toHaveText("Human")
  await handoff.getByRole("button", { name: "Inspect voice message" }).click()
  await expect(page.getByRole("dialog", { name: "Voice message details" })).toBeVisible()
  const polls = state.polls
  await expect.poll(() => state.polls).toBeGreaterThan(polls)
  await expect(page.getByRole("heading", { name: "Voice context" })).toBeVisible()
})
