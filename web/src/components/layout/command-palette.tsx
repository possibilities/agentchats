import { useEffect, useRef, useState } from "react"
import { SearchIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"

export interface AppCommand {
  id: string
  label: string
  context?: string
  run: () => void
  disabled?: boolean
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: AppCommand[]
}) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const matches = commands.filter(
    (command) =>
      !command.disabled &&
      `${command.label} ${command.context ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  )
  const index = Math.min(selected, Math.max(0, matches.length - 1))
  useEffect(() => {
    document
      .getElementById(`command-${index}`)
      ?.scrollIntoView({ block: "nearest" })
  }, [index, query])
  const run = (command: AppCommand) => {
    onOpenChange(false)
    command.run()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="command-palette" initialFocus={input}>
        <DialogHeader>
          <DialogTitle>Commands</DialogTitle>
          <DialogDescription className="sr-only">
            Find an action or switch sessions. Use the arrow keys and Enter to
            select.
          </DialogDescription>
        </DialogHeader>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            value={query}
            placeholder="Find an action or session…"
            aria-label="Find a command"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-autocomplete="list"
            aria-activedescendant={
              matches.length ? `command-${index}` : undefined
            }
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                setSelected(
                  matches.length
                    ? (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        matches.length) %
                        matches.length
                    : 0,
                )
              } else if (event.key === "Enter" && matches[index]) {
                event.preventDefault()
                run(matches[index])
              }
            }}
          />
        </InputGroup>
        <div
          id="command-results"
          role="listbox"
          aria-label="Commands and sessions"
          className="command-palette__results"
        >
          {matches.map((command, itemIndex) => (
            <button
              type="button"
              role="option"
              aria-selected={itemIndex === index}
              id={`command-${itemIndex}`}
              key={command.id}
              tabIndex={-1}
              onPointerMove={() => setSelected(itemIndex)}
              onClick={() => run(command)}
            >
              <span>{command.label}</span>
              {command.context ? <small>{command.context}</small> : null}
            </button>
          ))}
          {matches.length === 0 ? (
            <p className="command-palette__empty">
              No matching commands or sessions.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
