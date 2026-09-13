import { expect, test } from "@playwright/test"
import { item, mockHistory } from "./fixtures"

const raw =
  "<realtime_delegation>\n  <input>Keep &lt;code&gt; safe &amp; readable.</input>\n  <transcript_delta>user: Improve the reader\nassistant: I can do that.</transcript_delta>\n</realtime_delegation>"

test("built package shows a readable handoff, collapsed context and exact original without rendering HTML", async ({
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
  await expect(
    page.getByRole("button", { name: "Voice context", exact: true }),
  ).toHaveAttribute("aria-expanded", "false")
  await expect(
    page.getByRole("button", { name: "Original message", exact: true }),
  ).toHaveAttribute("aria-expanded", "false")
  await page.getByRole("button", { name: "Voice context", exact: true }).click()
  await expect(
    page
      .locator(".transcript-presentation__detail")
      .filter({ hasText: "user: Improve the reader" }),
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Original message", exact: true })
    .click()
  const original = page
    .locator(".transcript-presentation__detail")
    .filter({ hasText: "<realtime_delegation>" })
  await expect(original).toBeVisible()
  expect(await original.textContent()).toBe(raw)
  await page.screenshot({ path: "test-results/voice-handoff.png" })
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
  await handoff
    .getByRole("button", { name: "Voice context", exact: true })
    .click()
  const polls = state.polls
  await expect.poll(() => state.polls).toBeGreaterThan(polls)
  await expect(
    handoff.getByRole("button", { name: "Voice context", exact: true }),
  ).toHaveAttribute("aria-expanded", "true")
})
