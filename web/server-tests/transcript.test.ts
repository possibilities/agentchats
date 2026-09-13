import { expect, test } from "bun:test"
import {
  mergeTranscript,
  groupTranscript,
  type TranscriptMessage,
  type TranscriptSnapshot,
} from "../src/transcript/index"
import { createCodexTranscriptSource } from "../src/transcript/codex"

const message = (
  id: string,
  role: TranscriptMessage["role"] = "assistant",
): TranscriptMessage => ({
  id,
  role,
  content: id,
  createdAt: "2026-09-13T12:00:00Z",
  status: "complete",
})

test("live revisions replace stable IDs without reordering, mutating, or duplicating; hidden records advance cursor", () => {
  const first = message("human", "user")
  const tool = message("tool", "tool")
  const snapshot: TranscriptSnapshot = {
    id: "one",
    title: "One",
    messages: Object.freeze([first, tool]),
    cursor: "start",
    status: "idle",
  }
  expect(
    mergeTranscript(snapshot, {
      messages: [],
      cursor: "start",
      status: "idle",
    }),
  ).toBe(snapshot)
  const hidden = mergeTranscript(snapshot, {
    messages: [],
    cursor: "hidden",
    status: "idle",
  })
  expect(hidden.cursor).toBe("hidden")
  expect(hidden.messages).toBe(snapshot.messages)
  const revision = { ...tool, content: "Updated tool" }
  const appended = message("next", "tool")
  const next = mergeTranscript(snapshot, {
    messages: [revision, appended, appended],
    cursor: "next",
    status: "complete",
  })
  expect(next.messages).toEqual([first, revision, appended])
  expect(snapshot.messages).toEqual([first, tool])
  expect(groupTranscript(next.messages).map((block) => block.id)).toEqual([
    "human",
    "tool",
  ])
})

test("Codex source supports host-owned transport and hides numeric cursor details", async () => {
  const requests: Array<{ url: string; signal?: AbortSignal | null }> = []
  const source = createCodexTranscriptSource({
    baseUrl: "https://host.test/history/",
    fetch: (async (input, init) => {
      requests.push({ url: String(input), signal: init?.signal })
      return Response.json({
        items: [],
        latestOrdinal: 42,
        turnStatus: "completed",
      })
    }) as typeof fetch,
  })
  const controller = new AbortController()
  const update = await source.poll({
    id: "one/two",
    detail: "messages",
    cursor: "40",
    signal: controller.signal,
  })
  expect(update).toEqual({ messages: [], cursor: "42", status: "complete" })
  expect(requests).toEqual([
    {
      url: "https://host.test/history/threads/one%2Ftwo/items?after_ordinal=40&detail=messages",
      signal: controller.signal,
    },
  ])
  await expect(
    source.poll({
      id: "one",
      detail: "full",
      cursor: "invalid",
      signal: controller.signal,
    }),
  ).rejects.toThrow("Invalid transcript cursor")
  expect(requests).toHaveLength(1)
})

test("prompt-seeded display titles use Markdown text, stay bounded, and preserve ordinary titles", async () => {
  const { transcriptTitle } = await import("../src/lib/transcript-title")
  expect(
    transcriptTitle(
      "# Ship **readable** `transcripts`\r\n\r\n## Goal\r\nDo the work.",
    ),
  ).toBe("Ship readable transcripts")
  expect(transcriptTitle("Ordinary conversation title")).toBe(
    "Ordinary conversation title",
  )
  expect(transcriptTitle("[A title](https://example.test) &amp; more")).toBe(
    "A title & more",
  )
  expect(Array.from(transcriptTitle("😀".repeat(130)))).toHaveLength(120)
  expect(transcriptTitle(" \n\n")).toBe("Untitled Agent conversation")
})
