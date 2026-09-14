/* oxlint-disable react/only-export-components -- standalone browser-test entry */
import { StrictMode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Transcript } from "../src/transcript/transcript"
import "../src/transcript/styles"
import type { Message } from "../src/types/message"

const prose =
  "The transcript preserves the complete conversation while the agent works. " +
  "Each update should keep typing responsive and retain the reader's scroll position. "

function message(index: number, lane: string): Message {
  if (index % 23 === 0) {
    return {
      id: `${lane}-tool-${index}`,
      role: "tool",
      status: "complete",
      content: "",
      toolActivity: {
        name: index % 46 === 0 ? "functions.exec" : "read",
        detail: `Synthetic tool ${index}`,
        state: "complete",
        sections: [
          {
            label: "Output",
            content: `line ${index}\n${"tool output text ".repeat(80)}`,
          },
          {
            label: "Original record",
            content: JSON.stringify({ index, ok: true }),
          },
        ],
      },
    }
  }
  const code =
    index % 31 === 0
      ? `\n\n\`\`\`typescript\nexport const value${index} = ${index};\nconsole.log(value${index});\n\`\`\``
      : ""
  return {
    id: `${lane}-message-${index}`,
    role: index % 7 === 0 ? "user" : "assistant",
    status: "complete",
    content: `Message ${index}\n\n${prose.repeat(2 + (index % 3))}${code}`,
  }
}

function fixture(variant: "stream" | "append" | "prepend", revision: number) {
  const messages: Message[] = [
    ...Array.from({ length: 1_699 }, (_, index) => message(index, "agent")),
    {
      id: "streaming-tail",
      role: "assistant",
      status: "streaming",
      content: `Streaming revision ${revision}. ${prose.repeat(2)}${"x".repeat(revision % 200)}`,
    },
  ]
  if (variant === "append" || variant === "prepend") {
    messages.push(message(2_001, "appended"))
  }
  if (variant === "prepend") {
    messages.unshift(
      ...Array.from({ length: 100 }, (_, index) =>
        message(10_000 + index, "prepended"),
      ),
    )
  }
  return messages
}

function Host() {
  const [messages, setMessages] = useState(() => fixture("stream", 0))

  Object.assign(window, {
    windowedVariedTranscript: {
      append() {
        setMessages(fixture("append", 1))
      },
      prepend() {
        setMessages(fixture("prepend", 2))
      },
    },
  })

  return (
    <main style={{ height: 900, width: 720, display: "flex", flexDirection: "column" }}>
      <Transcript
        transcriptId="varied-window"
        messages={messages}
        detail="full"
        follow
        windowed
        aria-label="Varied transcript"
      />
    </main>
  )
}

const testWindow = window as Window & { windowedVariedRoot?: Root }
const root =
  testWindow.windowedVariedRoot ??
  createRoot(document.getElementById("windowed-varied-consumer")!)
testWindow.windowedVariedRoot = root
root.render(
  <StrictMode>
    <Host />
  </StrictMode>,
)
