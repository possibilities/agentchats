import { expect, test } from "bun:test"
import { parseCodexMessagePresentation } from "../src/transcript/codex"
import { mapCodexSubagentActivity } from "../src/transcript/codex"
import { mapCodexItem } from "../src/lib/api/codex"

const envelope = (input: string, transcript?: string, source?: string) =>
  `<realtime_delegation>\n${source ? `  <source>${source}</source>\n` : ""}  <input>${input}</input>\n${transcript ? `  <transcript_delta>${transcript}</transcript_delta>\n` : ""}</realtime_delegation>`

test("canonical voice handoffs decode once and preserve voice context for inspection", () => {
  expect(
    parseCodexMessagePresentation(envelope("Copy this", "user:  Copy this")),
  ).toEqual({
    title: "Via Voice",
    body: "Copy this",
    details: [{ label: "Voice context", content: "user:  Copy this" }],
  })
  expect(
    parseCodexMessagePresentation(
      envelope(
        "a &lt; b &amp;&amp; &amp;lt;c&amp;gt;",
        "assistant: context\nuser: request",
      ),
    ),
  ).toEqual({
    title: "Via Voice",
    body: "a < b && &lt;c&gt;",
    details: [
      { label: "Voice context", content: "assistant: context\nuser: request" },
    ],
  })
})

test("tail flush presents end-of-call context without turning its instructions into a new request", () => {
  expect(
    parseCodexMessagePresentation(
      envelope(
        "Acknowledge the remaining tail",
        "user: remaining words",
        "transcript_tail_flush",
      ),
    ),
  ).toEqual({
    title: "Voice session ended",
    body: "The remaining voice context was added to this conversation.",
    details: [
      { label: "Voice context", content: "user: remaining words" },
      {
        label: "Handoff instructions",
        content: "Acknowledge the remaining tail",
      },
    ],
  })
})

test("ordinary text, examples, partial, mixed, nested and unknown envelopes are never rewritten", () => {
  for (const content of [
    "Ordinary typed input",
    `Example: ${envelope("test")}`,
    `\x60\x60\x60xml\n${envelope("test")}\n\x60\x60\x60`,
    "<realtime_delegation><input>partial",
    envelope(""),
    envelope("test", undefined, "new_source"),
    "<realtime_delegation><source></source><input>test</input></realtime_delegation>",
    "<realtime_delegation><input>test<unknown>more</unknown></input></realtime_delegation>",
    "<realtime_delegation><input>test</input><extra>do not drop</extra></realtime_delegation>",
    "<realtime_conversation>custom instructions</realtime_conversation>",
    "<realtime_conversation>Realtime conversation started.</realtime_conversation><realtime_conversation>Realtime conversation ended.</realtime_conversation>",
  ])
    expect(parseCodexMessagePresentation(content)).toBeUndefined()
})

test("related canonical voice context preserves its complete instructions", () => {
  const instructions =
    "Realtime conversation started.\n\nVoice instructions here."
  expect(
    parseCodexMessagePresentation(
      `<realtime_conversation>\n${instructions}\n</realtime_conversation>`,
    ),
  ).toEqual({
    title: "Voice session started",
    body: "Voice input is connected to this conversation.",
    details: [{ label: "Voice instructions", content: instructions }],
  })
})

test("the reader adapter adds presentation metadata without mutating raw content or identity", () => {
  const content = envelope("Copy this", "user: Copy this")
  const mapped = mapCodexItem({
    threadId: "one",
    turnId: "turn",
    itemId: "message",
    rolloutOrdinal: 1,
    createdAtMs: 0,
    itemType: "userMessage",
    item: { content: [{ text: content }] },
  })
  expect(mapped).toMatchObject({
    id: "turn:message",
    role: "user",
    content,
    status: "complete",
    presentation: { title: "Via Voice", body: "Copy this" },
  })
})

test("subagent lifecycle records expose path, action, and stable source details", () => {
  const item = {
    id: "call_GR4cGfSXKZr1ubNdikZLQ9uM",
    kind: "interacted",
    agentThreadId: "01a0a060-8b15-7211-b62c-26e9bc56d447",
    agentPath: "/root/android_disconnected_layout",
  }
  const before = JSON.stringify(item)
  expect(mapCodexSubagentActivity(item)).toEqual({
    content: "Interacted /root/android_disconnected_layout",
    activity: {
      name: "Subagent",
      detail: "/root/android_disconnected_layout",
      meta: "Interacted",
      state: "complete",
      sections: [
        { label: "Activity", content: "Interacted" },
        { label: "Agent path", content: "/root/android_disconnected_layout" },
        { label: "Agent thread", content: "01a0a060-8b15-7211-b62c-26e9bc56d447" },
        { label: "Activity ID", content: "call_GR4cGfSXKZr1ubNdikZLQ9uM" },
        { label: "Original record", content: JSON.stringify(item, null, 2) },
      ],
    },
  })
  expect(JSON.stringify(item)).toBe(before)

  expect(mapCodexItem({
    threadId: "one",
    turnId: "turn",
    itemId: item.id,
    rolloutOrdinal: 2,
    createdAtMs: 0,
    itemType: "subAgentActivity",
    item,
  })).toMatchObject({
    id: `turn:${item.id}`,
    role: "tool",
    content: "Interacted /root/android_disconnected_layout",
    toolActivity: {
      name: "Subagent",
      detail: "/root/android_disconnected_layout",
      meta: "Interacted",
    },
  })
})
