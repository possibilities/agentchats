import { useId, useRef, useState } from "react"
import { ArrowUpIcon, ChevronDownIcon, LoaderCircleIcon, SquareIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "../components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../components/ui/input-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu"

export type TranscriptFollowUpMode = "steer" | "queue"
type ActionResult = void | Promise<void>

export interface TranscriptSubmission {
  /** Host-visible identity for optimistic rendering and exact transport reconciliation. */
  clientId: string
  mode: "send" | TranscriptFollowUpMode
}

let submissionSequence = 0

function createSubmissionClientId() {
  return globalThis.crypto?.randomUUID?.() ??
    `agentchats-${Date.now()}-${++submissionSequence}`
}

export interface TranscriptQueuedMessage {
  id: string
  text: string
  pausedReason?: string
  disabled?: boolean
  canSteer?: boolean
  canResume?: boolean
}

export interface TranscriptComposerProps {
  /** Change with the host's view incarnation to reset drafts and in-flight UI. */
  transcriptId: string
  /** An agent turn is running. This does not disable entering follow-ups. */
  active?: boolean
  /** A host request is awaiting acknowledgment, independently of agent activity. */
  pending?: boolean
  /** Keep true after interrupt acknowledgment until the terminal turn event. */
  stopping?: boolean
  disabled?: boolean
  /** Keep one Send action visible through active and pending host states. */
  alwaysShowSend?: boolean
  /** Clear accepted input before awaiting the callback and retain explicit failure recovery. */
  optimisticSubmit?: boolean
  /** Defaults to the Codex desktop setting, steer. */
  followUpMode?: TranscriptFollowUpMode
  onFollowUpModeChange?: (mode: TranscriptFollowUpMode) => void
  onSend?: (text: string, submission: TranscriptSubmission) => ActionResult
  onSteer?: (text: string, submission: TranscriptSubmission) => ActionResult
  onQueue?: (text: string, submission: TranscriptSubmission) => ActionResult
  /** Omit to show noninteractive working status instead of Stop. */
  onInterrupt?: () => ActionResult
  /** Host-owned FIFO. This component never drains or retries it automatically. */
  queue?: readonly TranscriptQueuedMessage[]
  onSteerQueued?: (id: string) => ActionResult
  onResumeQueued?: (id: string) => ActionResult
  /** Save edited text in the existing queue position; never submit a new turn. */
  onEditQueued?: (id: string, text: string) => ActionResult
  onRemoveQueued?: (id: string) => ActionResult
  /** Pause/exclude this row from host dispatch while its text is in the composer. */
  onEditingQueuedChange?: (id: string | null) => ActionResult
  defaultValue?: string
  placeholder?: string
  className?: string
  "aria-label"?: string
}

/** Desktop-style Agent input. Hosts own queue state, transport and turn identity. */
export function TranscriptComposer(props: TranscriptComposerProps) {
  return <Composer key={props.transcriptId} {...props} />
}

function Composer({
  active = false,
  pending = false,
  stopping = false,
  disabled = false,
  alwaysShowSend = false,
  optimisticSubmit = false,
  followUpMode,
  onFollowUpModeChange,
  onSend,
  onSteer,
  onQueue,
  onInterrupt,
  queue = [],
  onSteerQueued,
  onResumeQueued,
  onEditQueued,
  onRemoveQueued,
  onEditingQueuedChange,
  defaultValue = "",
  placeholder = "Message Agent…",
  className,
  "aria-label": label = "Message Agent",
}: TranscriptComposerProps) {
  const inputId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const locked = useRef(false)
  const draftRef = useRef(defaultValue)
  const [draft, setDraft] = useState(defaultValue)
  const [localMode, setLocalMode] = useState<TranscriptFollowUpMode>("steer")
  const [operation, setOperation] = useState<string | null>(null)
  const [submissionPending, setSubmissionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recoveries, setRecoveries] = useState<
    Array<{ clientId: string; text: string; error: string }>
  >([])
  const [editing, setEditing] = useState<{
    id: string
    savedDraft: string
  } | null>(null)
  const mode = followUpMode ?? localMode
  const unavailable = disabled || pending || operation !== null || stopping
  const editedRow = editing ? queue.find((row) => row.id === editing.id) : null
  const action = !active ? onSend : mode === "steer" ? onSteer : onQueue
  const actionLabel = editing
    ? "Save queued message"
    : !active
      ? "Send"
      : mode === "steer"
        ? "Steer"
        : "Queue"
  const canSubmit =
    draft.trim().length > 0 &&
    !unavailable &&
    (editing
      ? Boolean(editedRow && !editedRow.disabled && onEditQueued)
      : Boolean(action))
  const showStop =
    !alwaysShowSend && !editing && active && draft.trim().length === 0

  function updateDraft(value: string) {
    draftRef.current = value
    setDraft(value)
  }

  function failureMessage(cause: unknown) {
    return cause instanceof Error
      ? cause.message
      : "The request failed. Your text has been kept."
  }

  async function run(
    name: string,
    callback: () => ActionResult,
    accepted?: () => ActionResult,
  ) {
    if (locked.current || unavailable) return
    locked.current = true
    setOperation(name)
    setError(null)
    try {
      await callback()
      await accepted?.()
    } catch (cause) {
      setError(failureMessage(cause))
    } finally {
      locked.current = false
      setOperation(null)
    }
  }

  async function runSubmission(
    name: string,
    callback: () => ActionResult,
    text: string,
    submission: TranscriptSubmission,
  ) {
    if (locked.current || unavailable) return
    locked.current = true
    setOperation(name)
    setSubmissionPending(true)
    setError(null)
    if (optimisticSubmit) {
      updateDraft("")
      input.current?.focus()
    }
    try {
      await callback()
      if (!optimisticSubmit) {
        updateDraft("")
        input.current?.focus()
      }
    } catch (cause) {
      const message = failureMessage(cause)
      if (optimisticSubmit) {
        if (draftRef.current.length === 0) {
          updateDraft(text)
          setError(message)
        } else {
          setRecoveries((current) => [
            ...current,
            { clientId: submission.clientId, text, error: message },
          ])
        }
      } else setError(message)
    } finally {
      locked.current = false
      setSubmissionPending(false)
      setOperation(null)
    }
  }

  async function finishEditing() {
    if (!editing) return
    await onEditingQueuedChange?.(null)
    updateDraft(editing.savedDraft)
    setEditing(null)
    input.current?.focus()
  }

  function submit(invertMode = false) {
    if (!canSubmit) return
    const text = draft.trim()
    if (editing && onEditQueued) {
      void run("Saving…", () => onEditQueued(editing.id, text), finishEditing)
      return
    }
    const submitMode = invertMode ? (mode === "steer" ? "queue" : "steer") : mode
    const send = !active ? onSend : submitMode === "steer" ? onSteer : onQueue
    if (!send) return
    const submission: TranscriptSubmission = {
      clientId: createSubmissionClientId(),
      mode: active ? submitMode : "send",
    }
    void runSubmission(
      !active ? "Sending…" : submitMode === "steer" ? "Steering…" : "Queueing…",
      () => send(text, submission),
      text,
      submission,
    )
  }

  function edit(row: TranscriptQueuedMessage) {
    if (unavailable || row.disabled) return
    void run(
      "Opening edit…",
      () => onEditingQueuedChange?.(row.id),
      () => {
        setEditing({ id: row.id, savedDraft: editing?.savedDraft ?? draft })
        updateDraft(row.text)
        input.current?.focus()
      },
    )
  }

  return (
    <div
      className={cn("agentchats-transcript transcript-composer", className)}
      data-always-show-send={alwaysShowSend || undefined}
    >
      {alwaysShowSend && active ? (
        <span className="transcript-composer__working" role="status">
          Working
        </span>
      ) : null}
      <div className="transcript-composer__content">
        {queue.length > 0 ? (
          <section className="transcript-queue" aria-label="Queued messages">
            <p className="transcript-composer__label">
              Queued messages · {queue.length}
            </p>
            <ol>
              {queue.map((row) => (
                <li key={row.id} aria-label={`Queued message: ${row.text}`}>
                  <p className="transcript-queue__text">{row.text}</p>
                  {row.pausedReason ? (
                    <p className="transcript-queue__reason" role="status">
                      {row.pausedReason}
                    </p>
                  ) : null}
                  <div className="transcript-queue__actions">
                    {onSteerQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          unavailable ||
                          row.disabled ||
                          !active ||
                          row.canSteer === false ||
                          editing?.id === row.id
                        }
                        onClick={() =>
                          void run("Steering…", () => onSteerQueued(row.id))
                        }
                      >
                        Steer
                      </Button>
                    ) : null}
                    {onResumeQueued && row.pausedReason ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={
                          unavailable ||
                          row.disabled ||
                          row.canResume !== true ||
                          editing?.id === row.id
                        }
                        onClick={() =>
                          void run("Resuming…", () => onResumeQueued(row.id))
                        }
                      >
                        Resume
                      </Button>
                    ) : null}
                    {onEditQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={unavailable || row.disabled}
                        onClick={() => edit(row)}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {onRemoveQueued ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={unavailable || row.disabled}
                        onClick={() =>
                          void run(
                            "Removing…",
                            () => onRemoveQueued(row.id),
                            () => {
                              if (editing?.id === row.id) return finishEditing()
                            },
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <form
          aria-label={label}
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {editing ? <p className="transcript-composer__label">Edit queued message</p> : null}
          <InputGroup>
            <InputGroupTextarea
              ref={input}
              id={inputId}
              aria-label={editing ? "Edit queued message" : label}
              aria-describedby={
                error || recoveries.length > 0 ? `${inputId}-error` : undefined
              }
              aria-invalid={Boolean(error || recoveries.length > 0)}
              placeholder={placeholder}
              value={draft}
              disabled={disabled}
              readOnly={
                optimisticSubmit
                  ? operation !== null && !submissionPending
                  : pending || operation !== null || stopping
              }
              onChange={(event) => {
                updateDraft(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return
                const invert =
                  active && event.shiftKey && (event.metaKey || event.ctrlKey)
                if (event.shiftKey && !invert) return
                event.preventDefault()
                submit(invert)
              }}
            />
            <InputGroupAddon align="block-end">
              {editing ? (
                <InputGroupButton
                  disabled={unavailable}
                  onClick={() => void run("Closing edit…", finishEditing)}
                >
                  Cancel edit
                </InputGroupButton>
              ) : onSteer || onQueue ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<InputGroupButton className="transcript-composer__mode" />}
                    disabled={unavailable}
                    aria-label="Follow-up behavior"
                  >
                    {mode === "steer" ? "Steer" : "Queue"} while running
                    <ChevronDownIcon
                      data-icon="inline-end"
                      aria-hidden="true"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    portalClassName="agentchats-transcript"
                    side="top"
                    className="transcript-composer__menu"
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>
                        While Agent is running
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={mode}
                        onValueChange={(value) => {
                          if (value !== "steer" && value !== "queue") return
                          setLocalMode(value)
                          onFollowUpModeChange?.(value)
                        }}
                      >
                        <DropdownMenuRadioItem
                          value="steer"
                          disabled={!onSteer}
                          closeOnClick
                        >
                          Steer current turn
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem
                          value="queue"
                          disabled={!onQueue}
                          closeOnClick
                        >
                          Queue for next turn
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <span className="transcript-composer__status" role="status">
                {stopping && onInterrupt
                  ? "Stopping…"
                  : (operation ?? (pending ? "Sending…" : ""))}
              </span>
              {alwaysShowSend ? (
                <InputGroupButton
                  type="submit"
                  size="sm"
                  variant="default"
                  disabled={!canSubmit}
                >
                  <ArrowUpIcon data-icon="inline-start" aria-hidden="true" />
                  {editing ? "Save queued message" : "Send"}
                </InputGroupButton>
              ) : (showStop || stopping) && !onInterrupt ? (
                <span className="transcript-composer__progress" role="status">
                  <LoaderCircleIcon aria-hidden="true" />
                  {stopping ? "Stopping…" : "Working…"}
                </span>
              ) : showStop || stopping ? (
                <InputGroupButton
                  size="sm"
                  variant="secondary"
                  disabled={unavailable || !onInterrupt}
                  aria-label="Stop Agent"
                  onClick={() => {
                    if (onInterrupt) void run("Stopping…", onInterrupt)
                  }}
                >
                  <SquareIcon data-icon="inline-start" aria-hidden="true" />
                  Stop
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  size="sm"
                  variant="default"
                  disabled={!canSubmit}
                >
                  <ArrowUpIcon data-icon="inline-start" aria-hidden="true" />
                  {actionLabel}
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
          {error || recoveries.length > 0 ? (
            <div
              className="transcript-composer__error"
              id={`${inputId}-error`}
            >
              {error ? <p role="alert">{error}</p> : null}
              {recoveries.map((recovery) => (
                <div
                  className="transcript-composer__recovery"
                  key={recovery.clientId}
                  role="alert"
                >
                  <div>
                    <p className="transcript-composer__recovery-error">
                      {recovery.error}
                    </p>
                    <p>{recovery.text}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      updateDraft(
                        draftRef.current.length > 0
                          ? `${draftRef.current}\n\n${recovery.text}`
                          : recovery.text,
                      )
                      setRecoveries((current) =>
                        current.filter(
                          (entry) => entry.clientId !== recovery.clientId,
                        ),
                      )
                      input.current?.focus()
                    }}
                  >
                    Restore sent text
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setRecoveries((current) =>
                        current.filter(
                          (entry) => entry.clientId !== recovery.clientId,
                        ),
                      )
                    }
                  >
                    Dismiss sent text
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </form>
      </div>
    </div>
  )
}
