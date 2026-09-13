import { useMemo } from "react"
import { ActivityGroup } from "@/components/chat/activity-group"
import { ChatMessage } from "@/components/chat/chat-message"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { groupTranscript } from "@/lib/transcript"
import { formatRelativeTime } from "@/lib/relative-time"
import type { Message } from "@/types/message"
import type { SessionSummary } from "@/types/session-summary"

interface ChatPaneProps {
  id: string
  title: string
  session?: SessionSummary
  messages: Message[]
  watching: boolean
  active: boolean
  loading: boolean
  full: boolean
}

export function ChatPane({
  id,
  title,
  session,
  messages,
  watching,
  active,
  loading,
  full,
}: ChatPaneProps) {
  const entries = useMemo(() => groupTranscript(messages), [messages])
  const messageCount = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  ).length
  const activityCount = messages.length - messageCount
  return (
    <section className="chat-pane" aria-label="Conversation">
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="end"
        key={`${id}:${loading ? "loading" : "ready"}`}
      >
        <MessageScroller>
          <MessageScrollerViewport
            id="conversation"
            tabIndex={0}
            aria-label="Conversation transcript"
          >
            <MessageScrollerContent className="chat-transcript">
              <div className="thread-intro">
                <h1>{title}</h1>
                {session ? (
                  <p>
                    <span>{messageCount} messages</span>
                    {full ? <span>{activityCount} activities</span> : null}
                    <span>Updated {formatRelativeTime(session.updatedAt)}</span>
                    <span>Read only</span>
                  </p>
                ) : null}
              </div>
              {messages.length === 0 ? (
                <Empty className="transcript-empty">
                  <EmptyHeader>
                    <EmptyTitle>
                      {loading
                        ? "Opening conversation…"
                        : session
                          ? "No messages yet"
                          : "Human / Agent conversations"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {loading
                        ? "Reading local history."
                        : session
                          ? "Watch this thread to follow new messages as they arrive."
                          : "Select a session to read the conversation and inspect the work behind it."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {entries.map((entry) => (
                <MessageScrollerItem key={entry.id} messageId={entry.id}>
                  {entry.kind === "activity" ? (
                    <ActivityGroup messages={entry.messages} />
                  ) : (
                    <ChatMessage message={entry.message} />
                  )}
                </MessageScrollerItem>
              ))}
              {active ? (
                <div className="thread-working" role="status">
                  <span aria-hidden="true">●</span>
                  {watching ? "Agent is working" : "Agent last observed working"}
                </div>
              ) : watching ? (
                <div className="thread-watching" role="status">
                  Watching for new messages
                </div>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton size="sm" className="jump-latest">
            Jump to latest
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
    </section>
  )
}
