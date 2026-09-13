import { useMemo, type ReactNode } from "react"
import { cn } from "cn"
import { ActivityGroup } from "../components/chat/activity-group"
import { ChatMessage } from "../components/chat/chat-message"
import { TooltipProvider } from "../components/ui/tooltip"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../components/ui/message-scroller"
import { groupTranscript, type TranscriptEntry } from "../lib/transcript"
import type { Message } from "../types/message"
import type { TranscriptDetail } from "./types"

export interface TranscriptBlockProps {
  block: TranscriptEntry
}

function BlockContent({ block }: TranscriptBlockProps) {
  return block.kind === "activity" ? (
    <ActivityGroup messages={block.messages} />
  ) : (
    <ChatMessage message={block.message} />
  )
}

/** A single prose message or collapsed activity run, for host-owned layouts. */
export function TranscriptBlock({ block }: TranscriptBlockProps) {
  return (
    <div className="agentchats-transcript">
      <TooltipProvider>
        <BlockContent block={block} />
      </TooltipProvider>
    </div>
  )
}

export interface TranscriptProps {
  /** Changing this ID resets scroll and disclosure state. */
  transcriptId: string
  messages: readonly Message[]
  detail?: TranscriptDetail
  loading?: boolean
  /** Follow the bottom until the reader scrolls away; independent of agent status. */
  follow?: boolean
  /** Hosts with no controls can omit the jump button. */
  showJumpToLatest?: boolean
  header?: ReactNode
  footer?: ReactNode
  empty?: ReactNode
  className?: string
  viewportId?: string
  "aria-label"?: string
}

/** Presentation only: no fetching, storage, session navigation, or command UI. */
export function Transcript({
  transcriptId,
  messages,
  detail = "messages",
  loading = false,
  follow = true,
  showJumpToLatest = true,
  header,
  footer,
  empty,
  className,
  viewportId,
  "aria-label": label = "Human / Agent transcript",
}: TranscriptProps) {
  const blocks = useMemo(
    () =>
      groupTranscript(
        detail === "full"
          ? messages
          : messages.filter(
              (message) =>
                message.role === "user" || message.role === "assistant",
            ),
      ),
    [messages, detail],
  )
  return (
    <div className={cn("agentchats-transcript chat-pane", className)}>
      <TooltipProvider>
        <MessageScrollerProvider
          autoScroll={follow}
          defaultScrollPosition="end"
          key={`${transcriptId}:${detail}:${loading ? "loading" : "ready"}`}
        >
          <MessageScroller>
            <MessageScrollerViewport
              id={viewportId}
              tabIndex={0}
              aria-label={label}
            >
              <MessageScrollerContent className="chat-transcript">
                {header}
                {blocks.length === 0 ? empty : null}
                {blocks.map((block) => (
                  <MessageScrollerItem key={block.id} messageId={block.id}>
                    <BlockContent block={block} />
                  </MessageScrollerItem>
                ))}
                {footer}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            {showJumpToLatest ? (
              <MessageScrollerButton size="sm" className="jump-latest">
                Jump to latest
              </MessageScrollerButton>
            ) : null}
          </MessageScroller>
        </MessageScrollerProvider>
      </TooltipProvider>
    </div>
  )
}
