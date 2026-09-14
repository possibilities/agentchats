export type PersistedFollowUpMode = "steer" | "queue"

export interface PersistedComposerRecovery {
  clientId: string
  text: string
  error: string
}

export interface PersistedComposerPending {
  clientId: string
  text: string
  mode: "send" | PersistedFollowUpMode
  pageId: string
}

export interface PersistedComposerEditing {
  id: string
  text: string
  savedDraft: string
  pageId: string
}

export interface PersistedComposerState {
  draft: string
  followUpMode: PersistedFollowUpMode
  recoveries: PersistedComposerRecovery[]
  pending: PersistedComposerPending[]
  editing: PersistedComposerEditing | null
}

interface PersistedComposerSlot {
  tabId: string
  updatedAt: number
  state: PersistedComposerState
}

interface PersistedComposerRecord {
  version: 2
  tabId: string
  updatedAt: number
  state: PersistedComposerState
}

export interface LoadedComposerState {
  state: PersistedComposerState
  changed: boolean
  storageAvailable: boolean
}

const STORAGE_PREFIX = "@agentchats/transcript:composer:v2:"
const TAB_ID_KEY = "@agentchats/transcript:composer-tab:v1"
const UNKNOWN_DELIVERY =
  "Delivery status is unknown after reload. This text was not resent."
const RECOVERED_DRAFT =
  "Draft recovered from another browser session. It was not sent."
const RECOVERED_EDIT =
  "Queued edit recovered from another browser session. Review it before sending."
const PAGE_ID_SYMBOL = Symbol.for("@agentchats/transcript/composer-page-id")
const TAB_ID_SYMBOL = Symbol.for("@agentchats/transcript/composer-tab-id")
const MEMORY_SYMBOL = Symbol.for("@agentchats/transcript/composer-memory-v2")

let fallbackSequence = 0

function createId(kind: string) {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `agentchats-${kind}-${Date.now()}-${++fallbackSequence}`
  )
}

const pageGlobal = globalThis as unknown as Record<PropertyKey, unknown>
const existingPageId = pageGlobal[PAGE_ID_SYMBOL]
export const composerPageId =
  typeof existingPageId === "string" ? existingPageId : createId("page")
pageGlobal[PAGE_ID_SYMBOL] = composerPageId
const existingMemory = pageGlobal[MEMORY_SYMBOL]
const memory =
  existingMemory instanceof Map
    ? (existingMemory as Map<
        string,
        {
          state: PersistedComposerState
          dirty: boolean
          storageAvailable: boolean
          blocked: boolean
        }
      >)
    : new Map<
        string,
        {
          state: PersistedComposerState
          dirty: boolean
          storageAvailable: boolean
          blocked: boolean
        }
      >()
pageGlobal[MEMORY_SYMBOL] = memory

function readTabId() {
  const cached = pageGlobal[TAB_ID_SYMBOL]
  if (typeof cached === "string") return cached
  if (typeof window === "undefined") return "server"
  try {
    const stored = window.sessionStorage.getItem(TAB_ID_KEY)
    if (stored) {
      pageGlobal[TAB_ID_SYMBOL] = stored
      return stored
    }
    const created = createId("tab")
    window.sessionStorage.setItem(TAB_ID_KEY, created)
    pageGlobal[TAB_ID_SYMBOL] = created
    return created
  } catch {
    const fallback = createId("tab")
    pageGlobal[TAB_ID_SYMBOL] = fallback
    return fallback
  }
}

export function composerStorageKey(scope: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`
}

function composerMemoryKey(scope: string) {
  return composerSlotKey(scope, readTabId())
}

function composerSlotKey(scope: string, tabId: string) {
  return `${composerStorageKey(scope)}:${encodeURIComponent(tabId)}`
}

export function cacheComposerState(
  scope: string | undefined,
  state: PersistedComposerState,
) {
  if (scope) {
    const key = composerMemoryKey(scope)
    const previous = memory.get(key)
    memory.set(key, {
      state,
      dirty: true,
      storageAvailable: previous?.storageAvailable ?? true,
      blocked: previous?.blocked ?? false,
    })
  }
}

export function emptyComposerState(defaultValue = ""): PersistedComposerState {
  return {
    draft: defaultValue,
    followUpMode: "steer",
    recoveries: [],
    pending: [],
    editing: null,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null
}

function parseRecovery(value: unknown): PersistedComposerRecovery | null {
  if (!isObject(value)) return null
  const clientId = stringValue(value.clientId)
  const text = stringValue(value.text)
  const error = stringValue(value.error)
  return clientId && text !== null && error
    ? { clientId, text, error }
    : null
}

function parsePending(value: unknown): PersistedComposerPending | null {
  if (!isObject(value)) return null
  const clientId = stringValue(value.clientId)
  const text = stringValue(value.text)
  const pageId = stringValue(value.pageId)
  const mode = value.mode
  return clientId && text !== null && pageId &&
    (mode === "send" || mode === "steer" || mode === "queue")
    ? { clientId, text, pageId, mode }
    : null
}

function parseEditing(value: unknown): PersistedComposerEditing | null {
  if (!isObject(value)) return null
  const id = stringValue(value.id)
  const text = stringValue(value.text)
  const savedDraft = stringValue(value.savedDraft)
  const pageId = stringValue(value.pageId)
  return id && text !== null && savedDraft !== null && pageId
    ? { id, text, savedDraft, pageId }
    : null
}

function parseState(value: unknown): PersistedComposerState | null {
  if (!isObject(value)) return null
  const draft = stringValue(value.draft)
  if (draft === null) return null
  return {
    draft,
    followUpMode: value.followUpMode === "queue" ? "queue" : "steer",
    recoveries: Array.isArray(value.recoveries)
      ? value.recoveries.flatMap((entry) => {
          const recovery = parseRecovery(entry)
          return recovery ? [recovery] : []
        })
      : [],
    pending: Array.isArray(value.pending)
      ? value.pending.flatMap((entry) => {
          const pending = parsePending(entry)
          return pending ? [pending] : []
        })
      : [],
    editing: parseEditing(value.editing),
  }
}

function parseRecord(value: unknown): PersistedComposerRecord | null {
  if (
    !isObject(value) ||
    value.version !== 2 ||
    typeof value.tabId !== "string" ||
    typeof value.updatedAt !== "number"
  )
    return null
  const state = parseState(value.state)
  return state
    ? { version: 2, tabId: value.tabId, updatedAt: value.updatedAt, state }
    : null
}

function uniqueByClientId<T extends { clientId: string }>(values: T[]) {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value.clientId)) return false
    seen.add(value.clientId)
    return true
  })
}

function recoverPending(
  state: PersistedComposerState,
  observed: ReadonlySet<string>,
) {
  const pending: PersistedComposerPending[] = []
  const recoveries = state.recoveries.filter(
    (entry) => !observed.has(entry.clientId),
  )
  for (const entry of state.pending) {
    if (observed.has(entry.clientId)) continue
    if (entry.pageId === composerPageId) pending.push(entry)
    else
      recoveries.push({
        clientId: entry.clientId,
        text: entry.text,
        error: UNKNOWN_DELIVERY,
      })
  }
  return {
    ...state,
    recoveries: uniqueByClientId(recoveries),
    pending: uniqueByClientId(pending),
  }
}

function recoverOtherSlots(
  slots: readonly PersistedComposerSlot[],
  observed: ReadonlySet<string>,
  defaultValue: string,
) {
  const ordered = slots.toSorted(
    (left, right) => right.updatedAt - left.updatedAt,
  )
  const newest = ordered[0]?.state
  const recoveries: PersistedComposerRecovery[] = []
  for (const slot of ordered) {
    const slotId = slot.tabId
    const state = slot.state
    recoveries.push(
      ...state.recoveries.filter((entry) => !observed.has(entry.clientId)),
    )
    for (const pending of state.pending)
      if (!observed.has(pending.clientId))
        recoveries.push({
          clientId: pending.clientId,
          text: pending.text,
          error: UNKNOWN_DELIVERY,
        })
    if (state.draft)
      recoveries.push({
        clientId: `recovered-draft:${slotId}`,
        text: state.draft,
        error: RECOVERED_DRAFT,
      })
    if (state.editing?.text)
      recoveries.push({
        clientId: `recovered-edit:${slotId}:${state.editing.id}`,
        text: state.editing.text,
        error: RECOVERED_EDIT,
      })
  }
  return {
    ...emptyComposerState(defaultValue),
    followUpMode: newest?.followUpMode ?? "steer",
    recoveries: uniqueByClientId(recoveries),
  }
}

export function loadComposerState(
  scope: string | undefined,
  defaultValue: string,
  observedSubmissionIds: readonly string[],
): LoadedComposerState {
  const fallback = emptyComposerState(defaultValue)
  if (!scope || typeof window === "undefined")
    return { state: fallback, changed: false, storageAvailable: true }

  const observed = new Set(observedSubmissionIds)
  const cached = memory.get(composerMemoryKey(scope))
  if (cached) {
    const state = recoverPending(cached.state, observed)
    return {
      state,
      changed:
        cached.dirty ||
        state.pending.length !== cached.state.pending.length ||
        state.recoveries.length !== cached.state.recoveries.length,
      storageAvailable: cached.storageAvailable,
    }
  }

  const tabId = readTabId()
  const slotKey = composerSlotKey(scope, tabId)
  let serialized: string | null
  try {
    serialized = window.localStorage.getItem(slotKey)
  } catch {
    memory.set(composerMemoryKey(scope), {
      state: fallback,
      dirty: false,
      storageAvailable: false,
      blocked: true,
    })
    return { state: fallback, changed: false, storageAvailable: false }
  }
  if (!serialized) {
    const otherSlots: PersistedComposerSlot[] = []
    try {
      const prefix = `${composerStorageKey(scope)}:`
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index)
        if (!key?.startsWith(prefix) || key === slotKey) continue
        const candidate = window.localStorage.getItem(key)
        if (!candidate) continue
        const record = parseRecord(JSON.parse(candidate))
        if (record)
          otherSlots.push({
            tabId: record.tabId,
            updatedAt: record.updatedAt,
            state: record.state,
          })
      }
    } catch {
      return { state: fallback, changed: false, storageAvailable: false }
    }
    const state = recoverOtherSlots(otherSlots, observed, defaultValue)
    return {
      state,
      changed: state.recoveries.length > 0 || state.followUpMode !== "steer",
      storageAvailable: true,
    }
  }

  let record: PersistedComposerRecord | null
  try {
    record = parseRecord(JSON.parse(serialized))
  } catch {
    record = null
  }
  if (!record)
    memory.set(composerMemoryKey(scope), {
      state: fallback,
      dirty: false,
      storageAvailable: false,
      blocked: true,
    })
  if (!record)
    return { state: fallback, changed: false, storageAvailable: false }

  const state = recoverPending(record.state, observed)
  return {
    state,
    changed:
      state.pending.length !== record.state.pending.length ||
      state.recoveries.length !== record.state.recoveries.length,
    storageAvailable: true,
  }
}

export function writeComposerState(
  scope: string | undefined,
  state: PersistedComposerState,
) {
  if (!scope || typeof window === "undefined") return true
  cacheComposerState(scope, state)
  if (memory.get(composerMemoryKey(scope))?.blocked) return false
  try {
    const tabId = readTabId()
    window.localStorage.setItem(
      composerSlotKey(scope, tabId),
      JSON.stringify({ version: 2, tabId, updatedAt: Date.now(), state }),
    )
    memory.set(composerMemoryKey(scope), {
      state,
      dirty: false,
      storageAvailable: true,
      blocked: false,
    })
    return true
  } catch {
    memory.set(composerMemoryKey(scope), {
      state,
      dirty: true,
      storageAvailable: false,
      blocked: false,
    })
    return false
  }
}
