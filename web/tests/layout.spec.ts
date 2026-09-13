import { expect, test } from "@playwright/test"
import { mockHistory } from "./fixtures"

test("shared transcripts use the reading room width and preserve independent narrow lanes", async ({
  page,
}) => {
  await mockHistory(page)
  await page.goto("/")
  const prose = page
    .locator('[data-slot="message"][data-align="start"] .markdown-content')
    .last()
  await expect(prose).toBeVisible()
  expect(
    await prose.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThan(900)
  await page.screenshot({ path: "test-results/reader-wide.png" })

  await page.goto("/tests/consumer.html")
  const lanes = page.locator('[data-slot="message-scroller-viewport"]')
  await expect(lanes).toHaveCount(2)
  await expect(
    lanes.first().locator('[data-slot="message-content"]'),
  ).toHaveCount(1)
  await expect(
    lanes.last().locator('[data-slot="message-content"]'),
  ).toHaveCount(26)
  await expect(
    lanes.first().getByText("Voice lane", { exact: true }),
  ).toBeInViewport()
  await expect(lanes.last().locator(".message-author").last()).toBeVisible()
  const widths = await lanes.evaluateAll((elements) =>
    elements.map((element) => {
      const content = element.querySelector('[data-slot="message-content"]')!
      return {
        lane: element.clientWidth,
        prose: content.getBoundingClientRect().width,
      }
    }),
  )
  for (const width of widths)
    expect(width.prose / width.lane).toBeGreaterThan(0.9)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({ path: "test-results/lanes-wide.png" })
})
