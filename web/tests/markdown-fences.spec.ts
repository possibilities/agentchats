import { expect, test } from "@playwright/test"
import { item, mockHistory } from "./fixtures"

const malformed =
  "```Reconcile the working-doctrine roadmap. Update the phases to reflect HUD and the guidance already shipped, then identify the next concrete phase.\n```"
const conventional = "```\nplain fenced content\n```"
const languageWithMetadata =
  '```ts title="roadmap.ts"\nconst nextPhase = "tool recovery"\n```'
const emptyLanguageWithMetadata = '```ts title="empty.ts"\n```'
const emptyKnownLanguageWithFreeformMetadata =
  "```js A harmless explanatory sentence.\n```"
const nestedFence =
  "````md\n```Reconcile this literal stays inside the example.\n```\n````"

test("preserves sentence-like empty fence info without changing valid fences", async ({
  page,
}) => {
  const raw = [
    malformed,
    conventional,
    languageWithMetadata,
    emptyLanguageWithMetadata,
    emptyKnownLanguageWithFreeformMetadata,
    nestedFence,
  ]
  const original = [...raw]
  await mockHistory(page, {
    items: raw.map((text, index) =>
      item(index, index === 0 ? "userMessage" : "agentMessage", index === 0
        ? { content: [{ text }] }
        : { text }),
    ),
  })

  const threadResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/threads/design-review",
  )
  await page.goto("/")
  const source = (await (await threadResponse).json()) as {
    items: Array<{ item: { content?: Array<{ text: string }>; text?: string } }>
  }
  expect(source.items[0].item.content?.[0]?.text).toBe(malformed)
  expect(source.items[1].item.text).toBe(conventional)
  expect(source.items[2].item.text).toBe(languageWithMetadata)
  const rows = page.locator('[data-slot="message"]')
  await expect(rows).toHaveCount(6)

  const malformedBlock = rows.nth(0).locator(".code-block")
  await expect(malformedBlock.locator(".code-block__header > span")).toHaveText(
    "code",
  )
  await expect(malformedBlock.locator("pre")).toHaveText(
    "Reconcile the working-doctrine roadmap. Update the phases to reflect HUD and the guidance already shipped, then identify the next concrete phase.",
  )

  const conventionalBlock = rows.nth(1).locator(".code-block")
  await expect(conventionalBlock.locator(".code-block__header > span")).toHaveText(
    "code",
  )
  await expect(conventionalBlock.locator("pre")).toHaveText(
    "plain fenced content",
  )

  const metadataBlock = rows.nth(2).locator(".code-block")
  await expect(metadataBlock.locator(".code-block__header > span")).toHaveText(
    "ts",
  )
  await expect(metadataBlock.locator("pre")).toHaveText(
    'const nextPhase = "tool recovery"',
  )
  await expect(metadataBlock).not.toContainText('title="roadmap.ts"')

  const emptyMetadataBlock = rows.nth(3).locator(".code-block")
  await expect(
    emptyMetadataBlock.locator(".code-block__header > span"),
  ).toHaveText("ts")
  await expect(emptyMetadataBlock.locator("pre")).toHaveText("")

  const knownLanguageBlock = rows.nth(4).locator(".code-block")
  await expect(
    knownLanguageBlock.locator(".code-block__header > span"),
  ).toHaveText("js")
  await expect(knownLanguageBlock.locator("pre")).toHaveText("")

  const nestedBlock = rows.nth(5).locator(".code-block")
  await expect(nestedBlock.locator(".code-block__header > span")).toHaveText(
    "md",
  )
  await expect(nestedBlock.locator("pre")).toHaveText(
    "```Reconcile this literal stays inside the example.\n```",
  )

  expect(raw).toEqual(original)
})
