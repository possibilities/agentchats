import { RadioIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { CodexTranscriptDetail } from "@/types/codex-db"

export interface SessionControlsProps {
  detail: CodexTranscriptDetail
  watching: boolean
  watchDisabled: boolean
  onDetailChange: (detail: CodexTranscriptDetail) => void
  onToggleWatch: () => void
}

export function SessionControls({
  detail,
  watching,
  watchDisabled,
  onDetailChange,
  onToggleWatch,
}: SessionControlsProps) {
  return (
    <div className="session-controls">
      <ToggleGroup
        value={[detail]}
        onValueChange={(values) => {
          const next = values[0]
          if (next === "messages" || next === "full") onDetailChange(next)
        }}
        aria-label="Transcript density"
        className="density-control"
      >
        <ToggleGroupItem value="messages" aria-label="Messages only">
          Messages
        </ToggleGroupItem>
        <ToggleGroupItem value="full" aria-label="Full transcript">
          Full
        </ToggleGroupItem>
      </ToggleGroup>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleWatch}
        aria-pressed={watching}
        disabled={watchDisabled}
        className="watch-control"
        title={
          watching
            ? "Stop watching this thread"
            : "Follow new messages in this thread"
        }
      >
        <RadioIcon data-icon="inline-start" />
        {watching ? "Watching" : "Watch live"}
      </Button>
    </div>
  )
}
