import { expect, test, type Locator } from "@playwright/test"

interface Anchor {
  key: string
  top: number
}

const visibleAnchor = (viewport: Locator) =>
  viewport.evaluate((element): Anchor | null => {
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
          key: visible.row.dataset.windowedRowKey ?? "",
          top: visible.bounds.top - viewportBounds.top,
        }
      : null
  })

test("retains a real-wheel anchor across a varied-height full-snapshot prepend", async ({
  page,
}) => {
  await page.goto("/tests/windowed-varied-consumer.html")
  const viewport = page.getByRole("region", {
    name: "Varied transcript",
    exact: true,
  })
  await expect(viewport.locator('[data-windowed-row-key="block:streaming-tail"]')).toBeVisible({
    timeout: 60_000,
  })

  await viewport.hover()
  await page.mouse.wheel(0, -720)
  for (let index = 0; index < 12; index++) {
    await page.mouse.wheel(0, -180)
    await page.waitForTimeout(16)
  }
  await expect(
    page.getByRole("button", { name: "Jump to latest", exact: true }),
  ).toBeVisible()

  const beforeAppend = await visibleAnchor(viewport)
  expect(beforeAppend).not.toBeNull()
  await page.evaluate(() => (window as any).windowedVariedTranscript.append())
  await page.waitForTimeout(750)
  await expect.poll(() => visibleAnchor(viewport)).toEqual(beforeAppend)

  await page.evaluate(() => (window as any).windowedVariedTranscript.prepend())
  await page.waitForTimeout(750)
  await expect.poll(() => visibleAnchor(viewport)).toEqual(beforeAppend)
  await expect(
    page.getByRole("button", {
      name: "101 new messages. Jump to latest",
      exact: true,
    }),
  ).toBeVisible()
  expect(await viewport.locator("[data-windowed-row-key]").count()).toBeLessThan(40)
})
