import { useState } from "react"
import { createRoot } from "react-dom/client"
import {
  Transcript,
  TranscriptComposer,
  type TranscriptQueuedMessage,
  type TranscriptSubmission,
} from "@agentchats/transcript/react"
import "@agentchats/transcript/styles.css"

const host = {
  calls: [] as Array<{ action: string; args: string[] }>,
  submissions: [] as TranscriptSubmission[],
  editing: null as string | null,
  fail: false,
  delay: false,
  rejectEdit: false,
  settle: (_error?: string) => {},
  pasteKeyDefaultPrevented: null as boolean | null,
  pasteEventDefaultPrevented: null as boolean | null,
  pastePayload: null as string | null,
}

async function request(action: string, ...args: string[]) {
  host.calls.push({ action, args })
  if (host.delay)
    await new Promise<void>((resolve, reject) => {
      host.settle = (error) => (error ? reject(new Error(error)) : resolve())
    })
  if (host.fail) throw new Error("Connection lost; delivery is unknown.")
}

function Consumer() {
  const [props, setProps] = useState<{
    transcriptId: string
    active: boolean
    reachable?: boolean
    pending: boolean
    stopping: boolean
    actionsDisabled: boolean
    disabled: boolean
    allowInterrupt: boolean
    alwaysShowSend: boolean
    optimisticSubmit: boolean
    persistenceScope?: string
    persistenceInstanceId?: string
    observedSubmissionIds: readonly string[]
  }>({
    transcriptId: "one",
    active: false,
    pending: false,
    stopping: false,
    actionsDisabled: false,
    disabled: false,
    allowInterrupt: true,
    alwaysShowSend: false,
    optimisticSubmit: false,
    observedSubmissionIds: [],
  })
  const [queue, setQueue] = useState<TranscriptQueuedMessage[]>([])
  Object.assign(window, {
    composerHost: Object.assign(host, { setProps, setQueue }),
  })
  return (
    <>
      <p id="host-marker">Host page</p>
      <button id="focus-target">Review transcript</button>
      <section
        aria-label="Agent lane"
        style={{ height: 740, display: "flex", flexDirection: "column" }}
      >
        <Transcript
          transcriptId={props.transcriptId}
          messages={[
            {
              id: "human",
              role: "user",
              content: "Help me improve the transcript reader.",
              status: "complete",
            },
            {
              id: "agent",
              role: "assistant",
              content: "I'll check the reader's layout and live behavior.",
              status: "complete",
            },
          ]}
        />
        <TranscriptComposer
          {...props}
          queue={queue}
          onSend={(text, submission) => {
            host.submissions.push(submission)
            return request("send", text)
          }}
          onSteer={(text, submission) => {
            host.submissions.push(submission)
            return request("steer", text)
          }}
          onQueue={async (text, submission) => {
            host.submissions.push(submission)
            await request("queue", text)
            setQueue((rows) => [...rows, { id: `q${rows.length + 1}`, text }])
          }}
          onInterrupt={props.allowInterrupt ? async () => {
            await request("interrupt")
            setProps((value) => ({ ...value, stopping: true }))
          } : undefined}
          onSteerQueued={async (id) => {
            await request("steerQueued", id)
            setQueue((rows) => rows.filter((row) => row.id !== id))
          }}
          onResumeQueued={async (id) => {
            await request("resumeQueued", id)
            setQueue((rows) =>
              rows.map((row) =>
                row.id === id ? { ...row, pausedReason: undefined } : row,
              ),
            )
          }}
          onEditQueued={async (id, text) => {
            await request("editQueued", id, text)
            setQueue((rows) =>
              rows.map((row) => (row.id === id ? { ...row, text } : row)),
            )
          }}
          onRemoveQueued={async (id) => {
            await request("removeQueued", id)
            setQueue((rows) => rows.filter((row) => row.id !== id))
          }}
          onEditingQueuedChange={async (id) => {
            if (host.rejectEdit)
              throw new Error("This queued message has already been sent.")
            host.editing = id
          }}
        />
      </section>
    </>
  )
}
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v")
    host.pasteKeyDefaultPrevented = event.defaultPrevented
})
document.addEventListener("paste", (event) => {
  host.pasteEventDefaultPrevented = event.defaultPrevented
  host.pastePayload = event.clipboardData?.getData("text/plain") ?? null
})
createRoot(document.getElementById("consumer")!).render(<Consumer />)
