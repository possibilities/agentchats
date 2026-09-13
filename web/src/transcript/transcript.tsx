import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDownIcon } from "lucide-react"
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
  useMessageScroller,
  useMessageScrollerScrollable,
} from "../components/ui/message-scroller"
import { groupTranscript, type TranscriptEntry } from "../lib/transcript"
import type { Message } from "../types/message"
import type { TranscriptDetail } from "./types"

/** Keep subscription updates out of the transcript's message rendering. */
function TranscriptFollow({
  messages,
  follow,
  showJumpToLatest,
}: Pick<Required<TranscriptProps>, "messages" | "follow" | "showJumpToLatest">) {
  const { end: away } = useMessageScrollerScrollable()
  const { scrollToEnd } = useMessageScroller()
  const ids = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  )
  const [previous, setPrevious] = useState({ ids, away, follow, unread: 0 })
  const wasFollowing = useRef(follow)
  let unread = previous.unread
  if (
    previous.ids !== ids ||
    previous.away !== away ||
    previous.follow !== follow
  ) {
    if (!away && (follow || previous.away)) {
      unread = 0
    } else if (previous.ids !== ids) {
      for (const id of ids) if (!previous.ids.has(id)) unread++
    }
    setPrevious({ ids, away, follow, unread })
  }

  useLayoutEffect(() => {
    // Use the edge state from before this commit grows the DOM. Wheel/key
    // intent can release the primitive without moving an already-ended viewport;
    // explicitly resume it before its content observer measures the new end.
    // Calling the public action once when disabling follow at the end also
    // releases its internal follow mode, which otherwise masks the jump button.
    if (!away && (follow || wasFollowing.current)) {
      scrollToEnd({ behavior: "auto" })
    }
    wasFollowing.current = follow
  }, [messages, away, follow, scrollToEnd])

  const countLabel = `${unread} new ${unread === 1 ? "message" : "messages"}`
  return showJumpToLatest ? (
    <MessageScrollerButton
      size="sm"
      className="jump-latest"
      behavior="auto"
      aria-label={unread > 0 ? `${countLabel}. Jump to latest` : "Jump to latest"}
    >
      <ArrowDownIcon data-icon="inline-start" aria-hidden="true" />
      <span aria-live="polite" aria-atomic="true">
        {unread > 0 ? countLabel : "Jump to latest"}
      </span>
    </MessageScrollerButton>
  ) : null
}

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
  /** Show the new-message count and jump control when away from the end. Default true. */
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
  const visibleMessages = useMemo(
    () =>
      detail === "full"
        ? messages
        : messages.filter(
            (message) =>
              message.role === "user" || message.role === "assistant",
          ),
    [messages, detail],
  )
  const blocks = useMemo(() => groupTranscript(visibleMessages), [visibleMessages])
  return (
    <div className={cn("agentchats-transcript chat-pane", className)}>
      <TooltipProvider>
        <MessageScrollerProvider
          autoScroll={follow}
          scrollEdgeThreshold={64}
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
            <TranscriptFollow
              messages={visibleMessages}
              follow={follow}
              showJumpToLatest={showJumpToLatest}
            />
          </MessageScroller>
        </MessageScrollerProvider>
      </TooltipProvider>
    </div>
  )
}
