// Test-only host: import the built package exactly as an external UI does.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import {
  Transcript,
  TranscriptBlock,
  useTranscript,
} from "@agentchats/transcript/react"
import {
  groupTranscript,
  type TranscriptSource,
  type TranscriptMessage,
} from "@agentchats/transcript"
import "@agentchats/transcript/styles.css"

const message = (
  id: string,
  content: string,
  role: TranscriptMessage["role"] = "assistant",
): TranscriptMessage => ({
  id,
  role,
  content,
  status: "complete",
})
const initial = [
  message("human", "Human prompt", "user"),
  ...Array.from({ length: 25 }, (_, i) =>
    message(
      `agent-${i}`,
      `Agent response ${i}.\n\n${"Readable transcript content. ".repeat(10)}`,
    ),
  ),
]
const state = {
  polls: [] as Array<{ id: string; cursor: string; detail: string }>,
  aborted: [] as string[],
  fail: false,
  failLoad: new URLSearchParams(location.search).has("failLoad"),
  slow: false,
  live: [] as TranscriptMessage[],
}
Object.assign(window, { consumerState: state })
const source: TranscriptSource = {
  async load({ id, signal }) {
    signal.addEventListener("abort", () => state.aborted.push(`load:${id}`))
    await new Promise((resolve) =>
      setTimeout(resolve, id === "slow" ? 700 : 80),
    )
    if (state.failLoad) throw new Error("No transcript server")
    return {
      id,
      title: id,
      messages:
        id === "voice"
          ? [
              message(
                "voice",
                "Voice lane\n\n```ts\nconst voice = true\n```",
                "user",
              ),
            ]
          : initial,
      cursor: "first",
      status: "idle",
    }
  },
  async poll({ id, cursor, detail, signal }) {
    state.polls.push({ id, cursor, detail })
    signal.addEventListener("abort", () => state.aborted.push(`poll:${id}`))
    if (state.slow) await new Promise((resolve) => setTimeout(resolve, 600))
    if (state.fail) throw new Error("Server disconnected")
    return { messages: state.live, cursor: "next", status: "idle" }
  },
}
function Lane({ id, watch }: { id: string; watch: boolean }) {
  const { snapshot, loading, error, retry } = useTranscript(source, id, {
    watch,
    pollIntervalMs: 100,
  })
  return (
    <section
      style={{ height: 500, display: "flex", flexDirection: "column", minWidth: 0 }}
      aria-label={`${id} lane`}
    >
      {error ? (
        <div role="alert">
          {error.message}
          <button onClick={retry}>Retry</button>
        </div>
      ) : null}
      <Transcript
        transcriptId={id}
        messages={snapshot?.messages ?? []}
        loading={loading}
        aria-label={`${id} transcript`}
      />
    </section>
  )
}

function DirectConsumer() {
  const [messages, setMessages] = useState(initial)
  const [id, setId] = useState("direct")
  const [detail, setDetail] = useState<"messages" | "full">("messages")
  const [loading, setLoading] = useState(false)
  const [follow, setFollow] = useState(true)
  Object.assign(window, {
    directTranscript: { setMessages, setId, setDetail, setLoading, setFollow },
  })
  return (
    <div style={{ height: 500, display: "flex", flexDirection: "column" }}>
      <Transcript
        transcriptId={id}
        messages={messages}
        detail={detail}
        loading={loading}
        follow={follow}
        aria-label="Direct transcript"
      />
    </div>
  )
}
function Consumer() {
  const [id, setId] = useState("agent")
  const [watch, setWatch] = useState(true)
  return (
    <>
      <p id="host-marker">Host styles stay intact</p>
      <button onClick={() => setId("slow")}>Slow session</button>
      <button onClick={() => setId("other")}>Other session</button>
      <button onClick={() => setWatch((value) => !value)}>
        Toggle polling
      </button>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Lane id="voice" watch={false} />
        <Lane id={id} watch={watch} />
      </div>
      <TranscriptBlock
        block={
          groupTranscript([
            {
              ...message("file", "A file changed", "tool"),
              fileChanges: [
                {
                  path: "example.ts",
                  kind: "update",
                  diff: "@@ -1 +1 @@\n-before\n+after\n",
                  diffTruncated: false,
                },
              ],
            },
          ])[0]
        }
      />
    </>
  )
}
createRoot(document.getElementById("consumer")!).render(
  new URLSearchParams(location.search).has("direct") ? <DirectConsumer /> : <Consumer />,
)
