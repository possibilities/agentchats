import { expect, test } from "@playwright/test"
import type { Locator } from "@playwright/test"

const viewport = '[data-slot="message-scroller-viewport"]'
const rows = "[data-windowed-row]"

const bottomGap = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight - element.scrollTop

const startReading = (scroller: Locator) =>
  scroller.dispatchEvent("wheel", { deltaY: -1 })

const visibleRowAnchor = (scroller: Locator) =>
  scroller.evaluate((element) => {
    const viewportBounds = element.getBoundingClientRect()
    const visible = [...element.querySelectorAll<HTMLElement>("[data-windowed-row-key]")]
      .map((row) => ({ row, bounds: row.getBoundingClientRect() }))
      .filter(
        ({ bounds }) =>
          bounds.bottom > viewportBounds.top && bounds.top < viewportBounds.bottom,
      )
      .sort((left, right) => left.bounds.top - right.bounds.top)[0]
    return visible
      ? {
          key: visible.row.dataset.windowedRowKey!,
          top: visible.bounds.top,
        }
      : null
  })

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/windowed-consumer.html")
  await expect(page.locator('[data-block-id="row-1999"]')).toBeVisible()
})

test("keeps a bounded DOM and reaches both ends of 2,000 variable rows", async ({
  page,
}) => {
  const scroller = page.locator(viewport)
  expect(await page.locator(rows).count()).toBeLessThan(40)
  await expect(page.locator('[data-test-footer]')).toBeVisible()

  await startReading(scroller)
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(page.locator('[data-block-id="row-0"]')).toBeVisible()
  await expect(page.locator('[data-test-header]')).toBeVisible()
  expect(await page.locator(rows).count()).toBeLessThan(40)

  await scroller.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  )
  await expect(page.locator('[data-block-id="row-1999"]')).toBeVisible()
  expect(await page.locator(rows).count()).toBeLessThan(40)
})

test("anchors prepends and counts only newly introduced message IDs", async ({
  page,
}) => {
  const scroller = page.locator(viewport)
  await scroller.hover()
  await page.mouse.wheel(0, -720)
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible()
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }))
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )

  const anchor = await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const row = [...element.querySelectorAll<HTMLElement>("[data-windowed-row-key]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > bounds.top)!
    return { key: row.dataset.windowedRowKey!, top: row.getBoundingClientRect().top }
  })

  await page.evaluate(() => (window as any).windowedTranscript.prepend(100))
  const anchored = page.locator(`[data-windowed-row-key="${anchor.key}"]`)
  await expect(anchored).toBeVisible()
  await expect.poll(async () =>
    Math.abs((await anchored.boundingBox())!.y - anchor.top),
  ).toBeLessThan(6)
  await expect(
    page.getByRole("button", {
      name: "100 new messages. Jump to latest",
      exact: true,
    }),
  ).toBeVisible()
})

test("anchors a prepend while reading deep inside a tall row", async ({ page }) => {
  const scroller = page.locator(viewport)
  const tallRow = page.locator('[data-block-id="row-1999"]')
  await page.getByRole("button", { name: "Toggle row-1999" }).click()
  await expect(tallRow.locator('[data-expanded="row-1999"]')).toBeVisible()
  await startReading(scroller)
  await scroller.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 700)
  })
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible()
  const before = (await tallRow.boundingBox())!.y
  expect(before).toBeLessThan(-300)

  await page.evaluate(() => (window as any).windowedTranscript.prepend(100))
  await expect(tallRow).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(
      async () => Math.abs((await tallRow.boundingBox())!.y - before),
      { timeout: 15_000 },
    )
    .toBeLessThan(6)
})

test("follows streaming growth at the end and retains disclosure across remount", async ({
  page,
}) => {
  const scroller = page.locator(viewport)
  const toggle = page.getByRole("button", { name: "Toggle row-1999" })
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await page.evaluate(() => (window as any).windowedTranscript.growLast())
  await expect.poll(() => scroller.evaluate(bottomGap)).toBeLessThan(2)

  await startReading(scroller)
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(page.locator('[data-block-id="row-0"]')).toBeVisible()
  await expect(page.locator('[data-block-id="row-1999"]')).toHaveCount(0)
  await scroller.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  )
  const remounted = page.getByRole("button", { name: "Toggle row-1999" })
  await expect(remounted).toBeVisible()
  await expect(remounted).toHaveAttribute("aria-expanded", "true")
})

test("does not follow while disabled and the jump resumes the end", async ({
  page,
}) => {
  const scroller = page.locator(viewport)
  await page.evaluate(() => (window as any).windowedTranscript.setFollow(false))
  await page.evaluate(() => (window as any).windowedTranscript.append(3))
  await expect(
    page.getByRole("button", {
      name: "3 new messages. Jump to latest",
      exact: true,
    }),
  ).toBeVisible()
  await expect.poll(() => scroller.evaluate(bottomGap)).toBeGreaterThan(64)
  await page
    .getByRole("button", {
      name: "3 new messages. Jump to latest",
      exact: true,
    })
    .click()
  await expect.poll(() => scroller.evaluate(bottomGap)).toBeLessThan(2)
})

test("keeps the end pinned across viewport shrink and preserves an away reader", async ({
  page,
}) => {
  const scroller = page.locator(viewport)
  await page.evaluate(() => (window as any).windowedTranscript.setDockHeight(250))
  await expect.poll(() => scroller.evaluate(bottomGap)).toBeLessThan(2)
  await expect(page.locator('[data-block-id="row-1999"]')).toBeVisible()

  await page.evaluate(() => (window as any).windowedTranscript.setDockHeight(0))
  await expect.poll(() => scroller.evaluate(bottomGap)).toBeLessThan(2)
  await scroller.hover()
  await page.mouse.wheel(0, -720)
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible()
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }))
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await page.waitForTimeout(250)
  await expect.poll(() => visibleRowAnchor(scroller)).not.toBeNull()
  const anchor = (await visibleRowAnchor(scroller))!

  await page.evaluate(() => (window as any).windowedTranscript.setDockHeight(250))
  const anchored = page.locator(`[data-windowed-row-key="${anchor.key}"]`)
  await expect(anchored).toBeVisible()
  await expect.poll(async () =>
    Math.abs((await anchored.boundingBox())!.y - anchor.top),
  ).toBeLessThan(6)
})

test("keeps following through late automatic row measurements", async ({ page }) => {
  const scroller = page.locator(viewport)
  await page.evaluate(() => (window as any).windowedTranscript.setLateGrowth(120))
  await expect.poll(() => scroller.evaluate(bottomGap)).toBeLessThan(2)
  await expect(page.locator('[data-block-id="row-1999"]')).toBeVisible()
  await expect(page.getByRole("button", { name: /Jump to latest/ })).toHaveCount(0)
})
