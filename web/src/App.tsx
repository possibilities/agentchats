import { useEffect, useRef, useState } from "react"
import { SlidersHorizontalIcon } from "lucide-react"
import { ChatPane } from "@/components/chat/chat-pane"
import {
  CommandPalette,
  type AppCommand,
} from "@/components/layout/command-palette"
import { SessionControls } from "@/components/layout/session-controls"
import { SessionSidebar } from "@/components/layout/session-sidebar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  fetchSessions,
  fetchThread,
  fetchThreadItems,
  type CodexThreadView,
} from "@/lib/api/codex"
import type { SessionSummary } from "@/types/session-summary"
import type { CodexTranscriptDetail } from "@/types/codex-db"

const TRANSCRIPT_DETAIL_KEY = "agentchats-reader:transcript-detail"
const EMPTY_MESSAGES: CodexThreadView["thread"]["messages"] = []
function requestedThreadId() {
  return new URLSearchParams(window.location.search).get("thread")
}
function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Unable to read local history."
}
function storedTranscriptDetail(): CodexTranscriptDetail {
  try {
    return sessionStorage.getItem(TRANSCRIPT_DETAIL_KEY) === "full"
      ? "full"
      : "messages"
  } catch {
    return "messages"
  }
}

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    requestedThreadId,
  )
  const [activeView, setActiveView] = useState<
    (CodexThreadView & { detail: CodexTranscriptDetail }) | null
  >(null)
  const [detail, setDetail] = useState<CodexTranscriptDetail>(
    storedTranscriptDetail,
  )
  const [watching, setWatching] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState<string | null>(null)
  const [threadLoading, setThreadLoading] = useState(true)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [sessionsRevision, setSessionsRevision] = useState(0)
  const [threadRevision, setThreadRevision] = useState(0)
  const [collapseRevision, setCollapseRevision] = useState(0)
  const [commandsOpen, setCommandsOpen] = useState(false)
  const latestOrdinal = useRef(-1)
  const knownIds = useRef(new Set<string>())

  useEffect(() => {
    const controller = new AbortController()
    fetchSessions(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        const openedId = requestedThreadId()
        setSessions((current) => {
          const opened = current.find((session) => session.id === openedId)
          return opened && !next.some((session) => session.id === opened.id)
            ? [opened, ...next]
            : next
        })
        setActiveSessionId((current) => current ?? next[0]?.id ?? null)
        if (!next.length && !openedId) setThreadLoading(false)
        setSessionsError(null)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSessionsError(errorMessage(error))
          if (!requestedThreadId()) setThreadLoading(false)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSessionsLoading(false)
      })
    return () => controller.abort()
  }, [sessionsRevision])

  useEffect(() => {
    if (!activeSessionId) return
    const controller = new AbortController()
    fetchThread(activeSessionId, detail, controller.signal)
      .then((view) => {
        if (controller.signal.aborted) return
        latestOrdinal.current = view.latestOrdinal
        knownIds.current = new Set(
          view.thread.messages.map((message) => message.id),
        )
        setActiveView({ ...view, detail })
        setThreadError(null)
        setSessions((current) => {
          const replacement = { ...view.summary, status: view.status }
          return current.some((session) => session.id === view.thread.id)
            ? current.map((session) =>
                session.id === view.thread.id ? replacement : session,
              )
            : [replacement, ...current]
        })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setThreadError(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setThreadLoading(false)
      })
    const url = new URL(window.location.href)
    url.searchParams.set("thread", activeSessionId)
    window.history.replaceState(null, "", url)
    return () => controller.abort()
  }, [activeSessionId, detail, threadRevision])

  const ready =
    activeView?.thread.id === activeSessionId &&
    activeView?.detail === detail &&
    !threadLoading
  useEffect(() => {
    if (!watching || !activeSessionId || !ready) return
    const controller = new AbortController()
    let timer: number | undefined
    const poll = async () => {
      try {
        const update = await fetchThreadItems(
          activeSessionId,
          latestOrdinal.current,
          detail,
          controller.signal,
        )
        if (controller.signal.aborted) return
        const appended = update.messages.filter(
          (message) => !knownIds.current.has(message.id),
        )
        for (const message of appended) knownIds.current.add(message.id)
        latestOrdinal.current = Math.max(
          latestOrdinal.current,
          update.latestOrdinal,
        )
        setActiveView((current) => {
          if (
            !current ||
            current.thread.id !== activeSessionId ||
            current.detail !== detail
          )
            return current
          if (!appended.length && current.status === update.status)
            return current
          return {
            ...current,
            status: update.status,
            latestOrdinal: latestOrdinal.current,
            thread: {
              ...current.thread,
              messages: appended.length
                ? [...current.thread.messages, ...appended]
                : current.thread.messages,
            },
          }
        })
        const count = appended.filter(
          (message) => message.role === "user" || message.role === "assistant",
        ).length
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSessionId
              ? {
                  ...session,
                  status: update.status,
                  updatedAt: appended.at(-1)?.createdAt ?? session.updatedAt,
                  messageCount: session.messageCount + count,
                }
              : session,
          ),
        )
        setThreadError(null)
      } catch (error) {
        if (!controller.signal.aborted) setThreadError(errorMessage(error))
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(poll, 1000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeSessionId, detail, ready, watching])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+K is available across the operator's stack; Cmd+K belongs to skhd.
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault()
        setCommandsOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const selectSession = (id: string) => {
    if (id === activeSessionId) return
    setWatching(false)
    setThreadLoading(true)
    setThreadError(null)
    setActiveView(null)
    setActiveSessionId(id)
  }
  const changeDetail = (next: CodexTranscriptDetail) => {
    if (next === detail) return
    try {
      sessionStorage.setItem(TRANSCRIPT_DETAIL_KEY, next)
    } catch {
      /* Session-local state still works. */
    }
    setThreadLoading(Boolean(activeSessionId))
    setThreadError(null)
    setDetail(next)
  }
  const refreshSessions = () => setSessionsRevision((current) => current + 1)
  const retryThread = () => {
    setThreadLoading(true)
    setThreadRevision((current) => current + 1)
  }
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  )
  const messages = activeView?.thread.messages ?? EMPTY_MESSAGES
  const visibleMessages =
    detail === "messages"
      ? messages.filter(
          (message) => message.role === "user" || message.role === "assistant",
        )
      : messages
  const watchDisabled = !ready && !watching
  const controls = {
    detail,
    watching,
    watchDisabled,
    onDetailChange: changeDetail,
    onToggleWatch: () => setWatching((current) => !current),
  }
  const commands: AppCommand[] = [
    {
      id: "messages",
      label: "Show messages only",
      context: "Transcript",
      run: () => changeDetail("messages"),
    },
    {
      id: "full",
      label: "Show full transcript",
      context: "Transcript",
      run: () => changeDetail("full"),
    },
    {
      id: "collapse",
      label: "Collapse all activity",
      context: "Transcript",
      disabled: detail !== "full",
      run: () => setCollapseRevision((current) => current + 1),
    },
    {
      id: "watch",
      label: watching ? "Stop watching" : "Watch live",
      context: "Selected session",
      disabled: watchDisabled,
      run: controls.onToggleWatch,
    },
    {
      id: "refresh",
      label: "Refresh sessions",
      context: "Session index",
      run: refreshSessions,
    },
    ...sessions.map((session) => ({
      id: session.id,
      label: session.title,
      context: session.workspace ?? "Codex",
      run: () => selectSession(session.id),
    })),
  ]

  return (
    <TooltipProvider>
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      <SidebarProvider
        className="h-svh min-h-0 overflow-hidden"
        style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
      >
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={sessionsLoading}
          error={sessionsError}
          onSelect={selectSession}
          onRefresh={refreshSessions}
          onCommands={() => setCommandsOpen(true)}
        />
        <SidebarInset className="min-h-0 overflow-hidden">
          <div className="conversation-shell">
            <div className="conversation-toolbar">
              <div className="conversation-toolbar__context">
                <SidebarTrigger aria-label="Toggle session history" />
                <span title={activeSession?.cwd}>
                  {activeSession?.workspace || "Conversations"}
                </span>
                {activeSession?.model ? (
                  <span className="toolbar-model">{activeSession.model}</span>
                ) : null}
              </div>
              <div className="conversation-toolbar__actions">
                <SessionControls {...controls} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open commands"
                  title="Commands (Ctrl+K)"
                  onClick={() => setCommandsOpen(true)}
                >
                  <SlidersHorizontalIcon />
                </Button>
              </div>
            </div>
            {threadError ? (
              <Alert variant="destructive" className="history-error">
                <AlertTitle>
                  {activeView
                    ? "Live history interrupted"
                    : "Could not open this conversation"}
                </AlertTitle>
                <AlertDescription>{threadError}</AlertDescription>
                <Button variant="outline" size="sm" onClick={retryThread}>
                  Retry history
                </Button>
              </Alert>
            ) : null}
            <ChatPane
              id={activeSessionId ?? "empty"}
              title={
                activeView?.thread.title ??
                activeSession?.title ??
                "Conversations"
              }
              session={activeSession}
              messages={visibleMessages}
              watching={watching}
              active={activeView?.status === "working"}
              collapseRevision={collapseRevision}
              loading={threadLoading}
              full={detail === "full"}
            />
          </div>
        </SidebarInset>
        {commandsOpen ? (
          <CommandPalette
            open
            onOpenChange={setCommandsOpen}
            commands={commands}
          />
        ) : null}
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
