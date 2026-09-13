import { expect, test, type Locator } from "@playwright/test"
import type { Message } from "../src/types/message"
import { item, mockHistory } from "./fixtures"

async function fullSection(row: Locator, label: string, content: string) {
  const pre = row.locator("pre").and(row.getByLabel(label, { exact: true }))
  await expect(pre).toBeVisible()
  await expect(pre).toHaveJSProperty("textContent", content)
  await expect(pre).toHaveCSS("white-space", "pre-wrap")
  await expect(pre).toHaveCSS("overflow-y", "auto")
  expect(await pre.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  return pre
}

for (const width of [1440, 390]) {
  test(`reader expands complete commands, MCP payloads, and searches at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    const command = `  cat <<'END'\n${"unchanged command text\n".repeat(600)}${"long_token_".repeat(100)}\nCOMMAND_TAIL\nEND\n`
    const cwd = "/workspace/full-tool-details"
    const output = "  Output keeps its leading spaces.\nOUTPUT_TAIL\n\n"
    const tool = "inspect_".repeat(35) + "TOOL_TAIL"
    const args = JSON.stringify({ prompt: "argument ".repeat(500) + "ARGUMENT_TAIL", count: 0 }, null, 2)
    const result = JSON.stringify({ content: [{ type: "text", text: "result\n".repeat(500) + "RESULT_TAIL" }] }, null, 2)
    const error = JSON.stringify({ message: "failure ".repeat(500) + "ERROR_TAIL" }, null, 2)
    const query = `  ${"search query ".repeat(40)}\nQUERY_TAIL\n`
    const action = JSON.stringify({ type: "search", queries: [query, "SECOND_QUERY_TAIL"] }, null, 2)
    const results = JSON.stringify([{ title: "Result", snippet: "snippet ".repeat(500) + "SEARCH_TAIL" }], null, 2)
    await mockHistory(page, { items: [
      item(0, "commandExecution", { command, cwd, output, status: "completed", exitCode: 0 }),
      item(1, "mcpToolCall", { server: "fixtures", tool, argumentsText: args, resultText: result, errorText: error, status: "failed" }),
      item(2, "webSearch", { query, actionText: action, resultsText: results, resultCount: 1 }),
      item(3, "webSearch", { query }),
      item(4, "mcpToolCall", { server: "fixtures", tool }),
    ] })
    await page.goto("/?thread=design-review")
    await page.getByRole("button", { name: "Full transcript", exact: true }).click()
    await page.locator(".activity-group__trigger").click()
    const rows = page.locator(".tool-disclosure")
    await expect(rows).toHaveCount(5)
    await expect(page.locator(".tool-detail pre")).toHaveCount(0)
    const summaries = rows.locator(".tool-disclosure__summary")
    await expect(summaries.first()).toHaveCSS("text-overflow", "ellipsis")
    expect(await summaries.first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

    const checks = [
      [["Command", command], ["Working directory", cwd], ["Output", output]],
      [["Tool", `fixtures.${tool}`], ["Arguments", args], ["Result", result], ["Error", error]],
      [["Query", query], ["Action", action], ["Results", results]],
      [["Query", query]],
      [["Tool", `fixtures.${tool}`]],
    ]
    for (const [index, sections] of checks.entries()) {
      const row = rows.nth(index)
      const trigger = row.locator(".tool-disclosure__trigger")
      await expect(trigger).toBeEnabled()
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(row.locator(".tool-detail pre")).toHaveCount(sections.length)
      for (const [label, content] of sections) await fullSection(row, label!, content!)
      if (index === 0) {
        const pre = row.getByLabel("Command", { exact: true })
        await pre.scrollIntoViewIfNeeded()
        // Reach the actual final text inside the bounded, scrollable section.
        expect(await pre.evaluate((el) => {
          el.scrollTop = el.scrollHeight
          const text = el.firstChild!
          const range = document.createRange()
          range.setStart(text, text.textContent!.indexOf("COMMAND_TAIL"))
          range.setEnd(text, text.textContent!.indexOf("COMMAND_TAIL") + "COMMAND_TAIL".length)
          const tail = range.getBoundingClientRect()
          const box = el.getBoundingClientRect()
          return el.scrollTop > 0 && tail.top >= box.top && tail.bottom <= box.bottom
        })).toBe(true)
        await page.screenshot({ path: testInfo.outputPath("command-details.png") })
      }
      await trigger.click()
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  })

  test(`packaged disclosures expose host detail and content without requiring sections at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto("/tests/consumer.html?direct")
    const command = `  printf '%s\\n' '${"full command ".repeat(60)}COMMAND_TAIL'\n`
    const payload = JSON.stringify({ query: "full argument ".repeat(60) + "PAYLOAD_TAIL" }, null, 2)
    const message = (id: string, content = ""): Message => ({ id, content, role: "tool", status: "complete" })
    const messages: Message[] = [
      { ...message("command"), toolActivity: { name: "Command", detail: command, state: "complete", sections: [{ label: "Output", content: "OUTPUT_TAIL\n" }] } },
      { ...message("pending"), toolActivity: { name: "Command", detail: command, state: "running", sections: [{ label: "Output", content: "" }] } },
      { ...message("custom", payload), toolActivity: { name: "Custom tool", detail: "Inspect arguments", state: "complete" } },
      message("plain", payload),
      { ...message("system", payload), role: "system" },
      { ...message("explicit"), toolActivity: { name: "Command", detail: command, state: "complete", sections: [{ label: "Command", content: command }] } },
      message("empty"),
    ]
    await page.evaluate((items) => {
      const host = (window as any).directTranscript
      host.setMessages(items)
      host.setDetail("full")
    }, messages)
    await page.locator(".activity-group__trigger").click()
    const rows = page.locator(".tool-disclosure")
    await expect(rows).toHaveCount(7)
    const checks = [
      [["Command", command], ["Output", "OUTPUT_TAIL\n"]],
      [["Command", command]],
      [["Custom tool", "Inspect arguments"], ["Content", payload]],
      [["Details", payload]],
      [["Details", payload]],
      [["Command", command]],
    ]
    for (const [index, sections] of checks.entries()) {
      const row = rows.nth(index)
      const trigger = row.locator(".tool-disclosure__trigger")
      await expect(trigger).toBeEnabled()
      await trigger.focus()
      await trigger.press("Enter")
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(row.locator(".tool-detail pre")).toHaveCount(sections.length)
      for (const [label, content] of sections) await fullSection(row, label!, content!)
      await trigger.click()
    }
    await expect(rows.last().locator(".tool-disclosure__trigger")).toBeDisabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  })
}
