import { useDeferredValue, useState } from "react"
import { SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { formatRelativeTime } from "@/lib/relative-time"
import type { SessionSummary } from "@/types/session-summary"

interface SessionSidebarProps {
  sessions: SessionSummary[]
  activeSessionId: string | null
  loading: boolean
  error: string | null
  onSelect: (id: string) => void
  onRefresh: () => void
  onCommands: () => void
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  loading,
  error,
  onSelect,
  onRefresh,
  onCommands,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const { isMobile, setOpenMobile } = useSidebar()
  const filtered = sessions.filter((session) =>
    `${session.title} ${session.workspace ?? ""} ${session.id}`
      .toLowerCase()
      .includes(deferredQuery),
  )
  return (
    <Sidebar
      collapsible="offcanvas"
      className="session-sidebar"
      aria-label="Session history"
    >
      <SidebarContent>
        <div className="session-index">
          <div className="session-index__heading">
            <h2>
              Sessions{" "}
              <span className="session-index__count">{sessions.length}</span>
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open commands"
              onClick={onCommands}
            >
              <SlidersHorizontalIcon />
            </Button>
          </div>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Find a session"
              placeholder="Find a session…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setQuery("")}
                  aria-label="Clear session search"
                >
                  <XIcon />
                </Button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </div>
        <SidebarGroup className="session-list">
          <SidebarGroupContent>
            <SidebarMenu aria-label="Recent sessions">
              {loading && sessions.length === 0 ? (
                <li className="session-sidebar-state" role="status">
                  Opening session index…
                </li>
              ) : null}
              {error ? (
                <li className="session-sidebar-state is-error" role="alert">
                  {error}
                  <Button variant="ghost" size="sm" onClick={onRefresh}>
                    Retry session index
                  </Button>
                </li>
              ) : null}
              {!loading && !error && sessions.length === 0 ? (
                <li className="session-sidebar-state">
                  No local sessions yet.
                  <br />
                  Start a conversation in Codex, then refresh the session index.
                  <Button variant="ghost" size="sm" onClick={onRefresh}>
                    Refresh sessions
                  </Button>
                </li>
              ) : null}
              {query && filtered.length === 0 ? (
                <li className="session-sidebar-state">
                  No sessions match “{query}”.
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setQuery("")}
                  >
                    Clear search
                  </Button>
                </li>
              ) : null}
              {filtered.map((session) => (
                <SidebarMenuItem key={session.id}>
                  <SidebarMenuButton
                    size="lg"
                    isActive={session.id === activeSessionId}
                    aria-current={
                      session.id === activeSessionId ? "page" : undefined
                    }
                    title={session.title}
                    onClick={() => {
                      onSelect(session.id)
                      if (isMobile) setOpenMobile(false)
                    }}
                  >
                    <span className="session-row">
                      <span className="session-row__context">
                        {session.workspace || "Codex"}
                        <span>{formatRelativeTime(session.updatedAt)}</span>
                      </span>
                      <span className="session-row__title">
                        {session.title}
                      </span>
                      <span className="session-row__meta">
                        {session.messageCount} messages
                        {session.status === "working" ? (
                          <span className="session-row__working">
                            ● working
                          </span>
                        ) : session.status === "attention" ? (
                          <span className="session-row__attention">
                            ! needs attention
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
