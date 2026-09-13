import { memo } from "react"
import { FileChangeMessage } from "@/components/chat/file-change-message"
import { MessageBody } from "@/components/chat/message-body"
import { ToolActivityMessage } from "@/components/chat/tool-activity-message"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  Message as MessageRow,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message"
import { formatClockTime } from "@/lib/relative-time"
import type { Message } from "@/types/message"

export const ChatMessage = memo(function ChatMessage({
  message,
}: {
  message: Message
}) {
  if (message.role === "tool" || message.role === "system") {
    return message.fileChanges ? (
      <FileChangeMessage message={message} />
    ) : (
      <ToolActivityMessage message={message} />
    )
  }
  const isUser = message.role === "user"
  return (
    <MessageRow align="start" data-role={message.role}>
      <MessageContent>
        <MessageHeader>
          <span className="message-author">{isUser ? "Human" : "Agent"}</span>
          {message.createdAt ? (
            <time
              dateTime={message.createdAt}
              title={new Date(message.createdAt).toLocaleString()}
            >
              {formatClockTime(message.createdAt)}
            </time>
          ) : null}
        </MessageHeader>
        <Bubble
          align="start"
          variant={isUser ? "secondary" : "ghost"}
        >
          <BubbleContent>
            <MessageBody message={message} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </MessageRow>
  )
})
