// Test-only host: import the built package exactly as an external UI does.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import {
  DocumentViewerProvider,
  Transcript,
  TranscriptBlock,
  useTranscript,
  type DocumentLoader,
} from "@agentchats/transcript/react"
import {
  groupTranscript,
  type TranscriptSource,
  type TranscriptMessage,
} from "@agentchats/transcript"
import "@agentchats/transcript/styles.css"
import { parseCodexMessagePresentation } from "@agentchats/transcript/codex"

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

const documentContent = `---
title: Working doctrine
tags:
  - roadmap
  - guidance
created: 2026-09-07
updated: 2026-09-14
---
# Working doctrine

The roadmap now reflects the shipped HUD and guidance work.

| Phase | State | Next step |
| --- | --- | --- |
| Guidance | Shipped | Observe |
| Document reader | Active | Validate links |

\`\`\`ts
const phase = "document-reader"
\`\`\`

[Open the next phase](./plans/phase-two.md)

[Jump to evidence](#evidence)

${"A calm reading surface keeps long local notes legible. ".repeat(24)}

## Evidence

The loader retains the source href and returns a canonical path.
`

const documentState = {
  loads: [] as Array<{ href: string; base?: string }>,
  failures: 0,
}

const documentLoader: DocumentLoader = async ({ href, base, signal }) => {
  documentState.loads.push({ href, base })
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, 45)
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }, { once: true })
  })
  if (href.includes("missing.md") && documentState.failures++ === 0)
    throw new Error("Document is outside the available workspace.")
  if (href.includes("phase-two.md"))
    return {
      title: "Phase two",
      path: "/Users/arthack/wiki/plans/phase-two.md",
      content: "# Phase two\n\nThis is the next concrete phase.\n\n[Missing evidence](../missing.md)",
    }
  if (href.includes("missing.md"))
    return {
      title: "Recovered evidence",
      path: "/Users/arthack/wiki/missing.md",
      content: "# Recovered evidence\n\nRetry kept the reading context intact.",
    }
  return {
    title: "Working doctrine",
    path: "/Users/arthack/wiki/working-doctrine.md",
    content: documentContent,
  }
}
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
  const [windowed, setWindowed] = useState(false)
  Object.assign(window, {
    directTranscript: {
      setMessages, setId, setDetail, setLoading, setFollow, setWindowed,
      setCodexMessages: (messages: TranscriptMessage[]) => setMessages(messages.map((message) => ({
        ...message, presentation: parseCodexMessagePresentation(message.content),
      }))),
    },
  })
  return (
    <div style={{ height: 500, display: "flex", flexDirection: "column" }}>
      <Transcript
        transcriptId={id}
        messages={messages}
        detail={detail}
        loading={loading}
        follow={follow}
        windowed={windowed}
        aria-label="Direct transcript"
      />
    </div>
  )
}

function DocumentConsumer() {
  const [scope, setScope] = useState("thread-one")
  const messages = [message(
    "document-links",
    `Read [Working doctrine](~/wiki/working-doctrine.md), [Crash kit](</Users/arthack/Test Workspace/CRASH-KIT.md>), [file link](file:///Users/arthack/code/project/README.md), or [wiki note](wiki:working-doctrine).\n\n[Missing note](~/wiki/missing.md) · [External reference](https://example.test/reference) · [Email](mailto:reader@example.test)`,
  )]
  Object.assign(window, {
    consumerState: { ...state, document: documentState, setDocumentScope: setScope },
  })
  return (
    <DocumentViewerProvider load={documentLoader} resetKey={scope}>
      <main className="document-fixture">
        <Transcript
          transcriptId="documents"
          messages={messages}
          aria-label="Document transcript"
        />
        <label className="document-fixture__draft">
          Draft
          <textarea aria-label="Draft reply" defaultValue="Keep this draft" />
        </label>
      </main>
    </DocumentViewerProvider>
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
  new URLSearchParams(location.search).has("document") ? (
    <DocumentConsumer />
  ) : new URLSearchParams(location.search).has("direct") ? (
    <DirectConsumer />
  ) : (
    <Consumer />
  ),
)
