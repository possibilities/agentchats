import { useState } from "react"
import { CircleAlertIcon, ChevronRightIcon, TerminalSquareIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import type { Message } from "@/types/message"

export function ToolActivityMessage({ message }: { message: Message }) {
  const [open, setOpen] = useState(false)
  const activity = message.toolActivity
  const isError = message.status === "error"
  const hasDetails = Boolean(activity?.sections?.length)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Marker variant="border" className="tool-disclosure" data-error={isError || undefined}>
        <MarkerIcon>
          {isError ? <CircleAlertIcon /> : <TerminalSquareIcon />}
        </MarkerIcon>
        <MarkerContent>
          <CollapsibleTrigger
            className="tool-disclosure__trigger"
            disabled={!hasDetails}
            data-open={open || undefined}
          >
            <span className="tool-disclosure__name">
              {isError ? "Failed · " : ""}{activity?.name ?? "Tool"}
            </span>
            <span className="tool-disclosure__summary">
              {activity?.detail ?? message.content}
            </span>
            {activity?.meta ? (
              <span className="tool-disclosure__meta">{activity.meta}</span>
            ) : null}
            {hasDetails ? (
              <ChevronRightIcon className="tool-disclosure__chevron" />
            ) : null}
          </CollapsibleTrigger>
          {hasDetails ? (
            <CollapsibleContent className="tool-disclosure__content">
              {activity?.sections?.map((section) => (
                <section key={section.label} className="tool-detail">
                  <h4>{section.label}</h4>
                  <pre tabIndex={0} aria-label={section.label}>{section.content}</pre>
                </section>
              ))}
            </CollapsibleContent>
          ) : null}
        </MarkerContent>
      </Marker>
    </Collapsible>
  )
}
