import { memo, useMemo } from "react"
import { ChevronRightIcon } from "lucide-react"
import { ChatMessage } from "@/components/chat/chat-message"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { activitySummary } from "@/lib/transcript"
import {
  useAnyDisclosure,
  useDisclosureState,
} from "@/transcript/disclosure-state"
import type { Message } from "@/types/message"

export const ActivityGroup = memo(function ActivityGroup({
  messages,
}: {
  messages: readonly Message[]
}) {
  const groupKeys = useMemo(
    () => messages.map((message) => `group:${message.id}`),
    [messages],
  )
  const childKeys = useMemo(
    () => messages.map((message) => `tool:${message.id}`),
    [messages],
  )
  const [open, setOpen] = useDisclosureState(
    groupKeys,
    useAnyDisclosure(childKeys),
  )
  const { kinds, errors, running, files } = activitySummary(messages)
  if (messages.length === 1) return <ChatMessage message={messages[0]} />

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="activity-group"
      data-error={errors > 0 || undefined}
    >
      <CollapsibleTrigger
        className="activity-group__trigger"
        data-open={open || undefined}
      >
        <ChevronRightIcon
          className="tool-disclosure__chevron"
          aria-hidden="true"
        />
        <span className="activity-group__count">
          {messages.length} activities
        </span>
        <span className="activity-group__summary">
          {kinds
            .map(
              ([name, count]) =>
                `${count} ${name === "Command" ? (count === 1 ? "command" : "commands") : name === "MCP" ? (count === 1 ? "lookup" : "lookups") : name === "Files" ? (count === 1 ? "change set" : "change sets") : name.toLowerCase()}`,
            )
            .join(" · ")}
        </span>
        {errors > 0 ? (
          <span className="activity-group__error">{errors} failed</span>
        ) : null}
        {running > 0 ? (
          <span className="telemetry-live">{running} running</span>
        ) : null}
        {files > 0 ? (
          <span className="activity-group__files">{files} file changes</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open ? (
          <div className="activity-group__items">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
})
