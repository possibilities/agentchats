import { useState } from "react"
import { createRoot } from "react-dom/client"
import {
  Transcript,
  TranscriptComposer,
  type TranscriptQueuedMessage,
} from "@agentchats/transcript/react"
import "@agentchats/transcript/styles.css"

const host = {
  calls: [] as Array<{ action: string; args: string[] }>,
  editing: null as string | null,
  fail: false,
  delay: false,
  rejectEdit: false,
  settle: (_error?: string) => {},
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
  const [props, setProps] = useState({
    transcriptId: "one",
    active: false,
    pending: false,
    stopping: false,
    disabled: false,
    allowInterrupt: true,
  })
  const [queue, setQueue] = useState<TranscriptQueuedMessage[]>([])
  Object.assign(window, {
    composerHost: Object.assign(host, { setProps, setQueue }),
  })
  return (
    <>
      <p id="host-marker">Host page</p>
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
          onSend={(text) => request("send", text)}
          onSteer={(text) => request("steer", text)}
          onQueue={async (text) => {
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
createRoot(document.getElementById("consumer")!).render(<Consumer />)
