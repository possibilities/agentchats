import { expect, test, type Page } from "@playwright/test"
import { isLocalMarkdownHref } from "../src/transcript/react"

const opener = (page: Page) => page.getByRole("link", { name: "Working doctrine" })
const viewer = (page: Page) => page.locator('[data-slot="document-viewer"]')

test("local document recognition stays narrow and keeps external schemes native", () => {
  for (const href of [
    "~/wiki/working-doctrine.md",
    "/Users/arthack/code/project/README.md#usage",
    "/Users/arthack/code/project/README.md:12:4",
    "../CRASH-KIT.markdown",
    "file:///Users/arthack/obsidian/work/Scratch.md",
    "wiki:working-doctrine",
  ]) expect(isLocalMarkdownHref({ href })).toBe(true)
  for (const href of [
    "https://example.test/README.md",
    "mailto:reader@example.test",
    "data:text/markdown,unsafe",
    "javascript:alert(1)",
    "vscode://file/Users/arthack/README.md",
    "#local-heading",
    "notes.mdx",
    "notes.txt",
  ]) expect(isLocalMarkdownHref({ href })).toBe(false)
})

test("file and wiki schemes are inert until a document provider opts in", async ({ page }) => {
  await page.goto("/tests/consumer.html?direct")
  await page.evaluate(() => {
    ;(window as any).directTranscript.setMessages([{
      id: "local-schemes",
      role: "assistant",
      status: "complete",
      content: "[File](file:///Users/arthack/wiki/note.md) · [Wiki](wiki:note)",
    }])
  })
  for (const name of ["File", "Wiki"]) {
    const link = page.getByRole("link", { name })
    await expect(link).toHaveAttribute("href", "")
    await expect(link).not.toHaveAttribute("aria-haspopup", "dialog")
  }
})

test("viewer reads local Markdown, navigates relative links, and preserves focus and draft", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/tests/consumer.html?document")
  const draft = page.getByRole("textbox", { name: "Draft reply" })
  await draft.fill("A draft that must survive document reading")

  await opener(page).focus()
  await page.keyboard.press("Enter")
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page).getByRole("heading", { name: "Working doctrine", level: 2 })).toBeVisible()
  await expect(viewer(page).locator(".document-viewer__path")).toHaveText(
    "/Users/arthack/wiki/working-doctrine.md",
  )
  await expect(viewer(page).locator(".document-viewer__source")).toHaveText(
    "Opened from ~/wiki/working-doctrine.md",
  )
  await expect(viewer(page).getByRole("heading", { name: "Working doctrine", level: 1 })).toBeVisible()
  const metadata = viewer(page).getByText("Document metadata", { exact: true })
  await expect(metadata).toBeVisible()
  await metadata.click()
  await expect(viewer(page).locator(".document-viewer__metadata pre")).toContainText(
    "updated: 2026-09-14",
  )
  await metadata.click()
  await expect(viewer(page).getByRole("table")).toContainText("Document reader")
  await expect(viewer(page).locator(".code-block")).toContainText(
    'const phase = "document-reader"',
  )
  await page.screenshot({ path: testInfo.outputPath("document-viewer-wide.png") })

  await viewer(page).getByRole("link", { name: "Jump to evidence" }).click()
  const evidence = viewer(page).getByRole("heading", { name: "Evidence" })
  await expect(evidence).toBeInViewport()

  await viewer(page).getByRole("link", { name: "Open the next phase" }).click()
  await expect(viewer(page).getByRole("heading", { name: "Phase two", level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).consumerState.document.loads.at(-1))).toEqual({
    href: "./plans/phase-two.md",
    base: "/Users/arthack/wiki/working-doctrine.md",
  })
  const loadsBeforeBack = await page.evaluate(
    () => (window as any).consumerState.document.loads.length,
  )
  await viewer(page).getByRole("button", { name: "Back" }).click()
  await expect(viewer(page).getByRole("heading", { name: "Working doctrine", level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(
    () => (window as any).consumerState.document.loads.length,
  )).toBe(loadsBeforeBack)

  const close = viewer(page).getByRole("button", { name: "Close document" })
  await close.focus()
  await page.keyboard.press("Tab")
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-slot="document-viewer"]')))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(viewer(page)).toBeHidden()
  await expect(opener(page)).toBeFocused()
  await expect(draft).toHaveValue("A draft that must survive document reading")

  const external = page.getByRole("link", { name: "External reference" })
  await expect(external).toHaveAttribute("href", "https://example.test/reference")
  await expect(external).toHaveAttribute("target", "_blank")
  await expect(page.getByRole("link", { name: "Email" })).toHaveAttribute(
    "href",
    "mailto:reader@example.test",
  )
  await expect(page.getByRole("link", { name: "file link" })).toHaveAttribute(
    "aria-haspopup",
    "dialog",
  )
  await expect(page.getByRole("link", { name: "wiki note" })).toHaveAttribute(
    "aria-haspopup",
    "dialog",
  )
})

test("viewer shows a retryable error and resets only when the host scope changes", async ({
  page,
}) => {
  await page.goto("/tests/consumer.html?document")
  const draft = page.getByRole("textbox", { name: "Draft reply" })
  await draft.fill("Unchanged")
  const missing = page.getByRole("link", { name: "Missing note" })
  await missing.click()
  await expect(page.getByRole("status")).toContainText("Loading document")
  await expect(page.getByRole("alert")).toContainText(
    "Document is outside the available workspace.",
  )
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(viewer(page).getByRole("heading", { name: "Recovered evidence", level: 1 })).toBeVisible()
  await page.evaluate(() => (window as any).consumerState.setDocumentScope("thread-two"))
  await expect(viewer(page)).toBeHidden()
  await expect(draft).toHaveValue("Unchanged")
})

test("document reader keeps its hierarchy and controls usable at narrow width", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/tests/consumer.html?document")
  await opener(page).click()
  await expect(viewer(page).getByRole("heading", { name: "Working doctrine", level: 1 })).toBeVisible()
  await expect(viewer(page).getByRole("button", { name: "Close document" })).toHaveCSS(
    "min-height",
    "44px",
  )
  await page.screenshot({ path: testInfo.outputPath("document-viewer-narrow.png") })
  await viewer(page).getByText("Source", { exact: true }).click()
  await expect(viewer(page).locator(".document-viewer__provenance dd").nth(0)).toHaveText(
    "/Users/arthack/wiki/working-doctrine.md",
  )
  await expect(viewer(page).locator(".document-viewer__provenance dd").nth(1)).toHaveText(
    "~/wiki/working-doctrine.md",
  )
})
