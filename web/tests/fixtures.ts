import type { Page } from "@playwright/test"
import type {
  CodexThreadItemRecord,
  CodexThreadRecord,
} from "../src/types/codex-db"

const now = Date.now()
export const thread: CodexThreadRecord = {
  id: "design-review",
  title: "Make long transcripts easier to read",
  cwd: "/workspace/be-like-grok",
  rolloutPath: "",
  source: "cli",
  threadSource: null,
  model: "gpt-6",
  gitBranch: "design-makeover",
  preview: "",
  updatedAtMs: now,
  recencyAtMs: now,
  hasUserEvent: true,
  messageCount: 4,
  turnStatus: "completed",
}
export const sessions = [
  thread,
  ...[
    ["arthack", "Refine the icon studio's export flow"],
    ["agentusage", "Keep usage readings stable during refresh"],
    ["be-like-grok", "Connect the local Codex history"],
    ["agentnotify", "Make arrival previews easier to scan"],
    ["arthack", "Typography and spacing across product pages"],
  ].map(([workspace, title], index) => ({
    ...thread,
    id: `session-${index}`,
    title,
    cwd: `/workspace/${workspace}`,
    messageCount: 8 + index * 3,
    recencyAtMs: now - (index + 1) * 3600000,
  })),
]
export function item(
  ordinal: number,
  itemType: string,
  body: unknown,
  threadId = thread.id,
): CodexThreadItemRecord {
  return {
    threadId,
    turnId: "turn-one",
    itemId: `item-${ordinal}`,
    rolloutOrdinal: ordinal,
    createdAtMs: now - 300000 + ordinal * 1000,
    itemType,
    item: body,
  }
}
export const items = [
  item(0, "userMessage", {
    content: [
      {
        text: "The conversation disappears under all the tool calls. Can we keep the work inspectable without letting it take over?",
      },
    ],
  }),
  item(1, "agentMessage", {
    text: "I'll group consecutive activity between messages. You can open a group to inspect the individual commands, searches, and file changes.",
  }),
  ...Array.from({ length: 98 }, (_, index) =>
    item(index + 2, "commandExecution", {
      command:
        index === 0
          ? "rg --files src/components/chat"
          : `inspect transcript activity ${index + 1}`,
      cwd: "/workspace/be-like-grok",
      output:
        index === 11
          ? "A temporary read failed. Retried successfully in the next command."
          : `Inspection ${index + 1} completed.\nThe original transcript order is preserved.`,
      status: index === 11 ? "failed" : "completed",
      exitCode: index === 11 ? 1 : 0,
    }),
  ),
  item(100, "mcpToolCall", {
    server: "agentwiki",
    tool: "get",
    status: "completed",
    argumentsText:
      '{"ref":"design-studio-playbook-for-android-web-and-native-apps"}',
    resultText:
      "Design from the real content. Preserve user intent across ordinary updates.",
  }),
  item(101, "fileChange", {
    status: "completed",
    changes: [
      {
        path: "src/components/chat/chat-pane.tsx",
        kind: "update",
        diff: "@@ -1,2 +1,2 @@\n-const entries = messages\n+const entries = groupTranscript(messages)\n render(entries)\n",
      },
      {
        path: "src/lib/transcript.ts",
        kind: "add",
        diff: "export const grouping = 'consecutive activity'\n",
      },
    ],
  }),
  item(102, "agentMessage", {
    text: "The reading surface is now much quieter.\n\n- **Messages** keeps the conversation in focus.\n- **Full** groups the 100 activities into one expandable row.\n- Commands and file diffs open only when you ask for them.\n\nThe order stays intact, and failures remain visible even while a group is closed.\n\n```ts\nconst entries = groupTranscript(messages)\n```",
  }),
  item(103, "userMessage", {
    content: [
      {
        text: "Good. Keep the details close, and let the conversation breathe.",
      },
    ],
  }),
]

export async function mockHistory(
  page: Page,
  options: { empty?: boolean; long?: boolean; threadDelay?: number; working?: boolean; markdownTitle?: boolean } = {},
) {
  const listed = options.markdownTitle
    ? sessions.map((session) => ({ ...session, title: "# A **Markdown** task\n\n## Goal\n- Preserve real newlines.\n- Keep the full message.\n\nUse `code` and [links](https://example.test)." }))
    : sessions
  const state = {
    polls: 0,
    failPoll: false,
    failThread: false,
    failIndex: false,
    live: [] as CodexThreadItemRecord[],
    requests: [] as string[],
  }
  await page.route("**/api/threads**", async (route) => {
    const url = new URL(route.request().url())
    state.requests.push(url.pathname + url.search)
    if (url.pathname === "/api/threads") {
      await route.fulfill({
        status: state.failIndex ? 503 : 200,
        json: state.failIndex
          ? { error: "Session index unavailable." }
          : { threads: options.empty ? [] : listed },
      })
      return
    }
    const isPoll = url.pathname.endsWith("/items")
    if (isPoll) state.polls++
    if ((isPoll && state.failPoll) || (!isPoll && state.failThread)) {
      await route.fulfill({
        status: 503,
        json: { error: "History temporarily unavailable." },
      })
      return
    }
    if (!isPoll && options.threadDelay)
      await new Promise((resolve) => setTimeout(resolve, options.threadDelay))
    const id = decodeURIComponent(url.pathname.split("/")[3])
    const selected = listed.find((session) => session.id === id) ?? thread
    let source = options.empty
      ? []
      : isPoll
        ? state.live
        : [...items, ...state.live]
    if (options.markdownTitle && !isPoll)
      source = [item(0, "userMessage", { content: [{ text: listed[0].title }] }), ...source.slice(1)]
    if (options.long && !isPoll)
      source = [
        ...source,
        item(104, "agentMessage", {
          text:
            "A long identifier: `" +
            "long_path_segment/".repeat(24) +
            "`\n\n" +
            "A paragraph that should stay readable when the window is narrow. ".repeat(
              120,
            ),
        }),
      ]
    if (url.searchParams.get("detail") !== "full")
      source = source.filter(
        (record) =>
          record.itemType === "userMessage" ||
          record.itemType === "agentMessage",
      )
    await route.fulfill({
      json: {
        thread: selected,
        items: source.map((record) => ({ ...record, threadId: id })),
        latestOrdinal: state.live.at(-1)?.rolloutOrdinal ?? 103,
        turnStatus: options.working ? "inProgress" : "completed",
      },
    })
  })
  return state
}
