/* oxlint-disable react/only-export-components -- standalone browser-test entry */
import { StrictMode, useState, type CSSProperties } from "react"
import { createRoot, type Root } from "react-dom/client"
import { DisclosureStateProvider, useDisclosureState } from "../src/transcript/disclosure-state"
import "../src/transcript/styles"
import { WindowedTranscript } from "../src/transcript/windowed-transcript"

interface TestBlock {
  id: string
  content: string
}

const makeBlock = (id: string, index: number): TestBlock => ({
  id,
  content: `${id}: ${"variable height content ".repeat((index % 5) + 1)}`,
})

const initial = Array.from({ length: 2_000 }, (_, index) =>
  makeBlock(`row-${index}`, index),
)

function TestRow({ block }: { block: TestBlock }) {
  const [open, setOpen] = useDisclosureState(`test:${block.id}`)
  return (
    <article
      data-windowed-row=""
      data-block-id={block.id}
      style={{
        boxSizing: "border-box",
        minHeight: 56 + (Number(block.id.match(/\d+/)?.[0] ?? 0) % 5) * 14,
        padding: "12px 12px calc(12px + var(--late-row-extra, 0px))",
        border: "1px solid currentColor",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Toggle {block.id}
      </button>
      <p style={{ margin: "8px 0 0" }}>{block.content}</p>
      {open ? <div data-expanded={block.id}>{"Expanded detail. ".repeat(300)}</div> : null}
    </article>
  )
}

function renderBlock(block: TestBlock) {
  return <TestRow block={block} />
}

function Host() {
  const [blocks, setBlocks] = useState(initial)
  const [id, setId] = useState("windowed")
  const [follow, setFollow] = useState(true)
  const [dockHeight, setDockHeight] = useState(0)
  const [lateGrowth, setLateGrowth] = useState(0)

  Object.assign(window, {
    windowedTranscript: {
      append(count: number) {
        setBlocks((current) => [
          ...current,
          ...Array.from({ length: count }, (_, index) =>
            makeBlock(`append-${current.length + index}`, current.length + index),
          ),
        ])
      },
      prepend(count: number) {
        setBlocks((current) => [
          ...Array.from({ length: count }, (_, index) =>
            makeBlock(`prepend-${index}`, index),
          ),
          ...current,
        ])
      },
      growLast() {
        setBlocks((current) =>
          current.map((block, index) =>
            index === current.length - 1
              ? { ...block, content: `${block.content} ${"streaming growth ".repeat(100)}` }
              : block,
          ),
        )
      },
      setFollow,
      setDockHeight,
      setLateGrowth,
      setId,
    },
  })

  return (
    <main style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <div
        className="agentchats-transcript chat-pane"
        style={{ "--late-row-extra": `${lateGrowth}px` } as CSSProperties}
      >
        <DisclosureStateProvider key={id}>
          <WindowedTranscript
            key={id}
            blocks={blocks}
            messageIds={blocks.map((block) => block.id)}
            renderBlock={renderBlock}
            follow={follow}
            showJumpToLatest
            header={<div data-test-header="">Header</div>}
            footer={<div data-test-footer="">Footer</div>}
            aria-label="Windowed transcript"
          />
        </DisclosureStateProvider>
      </div>
      <div data-test-dock="" style={{ flex: "none", height: dockHeight }} />
    </main>
  )
}

const testWindow = window as Window & { windowedRoot?: Root }
const root = testWindow.windowedRoot ?? createRoot(document.getElementById("windowed-consumer")!)
testWindow.windowedRoot = root
root.render(
  <StrictMode>
    <Host />
  </StrictMode>,
)
