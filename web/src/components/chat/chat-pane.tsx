import { Transcript } from "@/transcript/react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
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
  const messageCount = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  ).length
  const activityCount = messages.length - messageCount
  return (
    <section className="chat-pane" aria-label="Conversation">
      <Transcript
        transcriptId={id}
        messages={messages}
        detail={full ? "full" : "messages"}
        loading={loading}
        viewportId="conversation"
        header={
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
        }
        empty={
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
        }
        footer={
          active ? (
            <div className="thread-working" role="status">
              <span aria-hidden="true">●</span>
              {watching ? "Agent is working" : "Agent last observed working"}
            </div>
          ) : watching ? (
            <div className="thread-watching" role="status">
              Watching for new messages
            </div>
          ) : null
        }
      />
    </section>
  )
}
