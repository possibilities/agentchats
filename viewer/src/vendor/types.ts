// Vendored from opencode @ 4643e65ad6334de3e4e68dedc201d5fbb828c9fe
// packages/sdk/js/src/v2/gen/types.gen.ts — the v1 session wire schema the
// TUI renderer consumes. Trimmed to the transcript surface; resync against
// upstream deliberately, never edit shapes ad hoc.

export type SnapshotFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type Session = {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: Array<SnapshotFileDiff>
  }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  share?: { url: string }
  title: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  metadata?: { [key: string]: unknown }
  time: { created: number; updated: number; compacting?: number; archived?: number }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}

export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  summary?: { title?: string; body?: string; diffs: Array<SnapshotFileDiff> }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
  tools?: { [key: string]: boolean }
}

export type ProviderAuthError = { name: "ProviderAuthError"; data: { providerID: string; message: string } }
export type UnknownError = { name: "UnknownError"; data: { message: string; ref?: string } }
export type MessageOutputLengthError = { name: "MessageOutputLengthError"; data: { [key: string]: unknown } }
export type MessageAbortedError = { name: "MessageAbortedError"; data: { message: string } }
export type StructuredOutputError = { name: "StructuredOutputError"; data: { message: string; retries: number } }
export type ContextOverflowError = {
  name: "ContextOverflowError"
  data: { message: string; responseBody?: string }
}
export type ContentFilterError = { name: "ContentFilterError"; data: { message: string } }
export type ApiError = {
  name: "APIError"
  data: {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: { [key: string]: string }
    responseBody?: string
    metadata?: { [key: string]: string }
  }
}
export type MessageError =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | StructuredOutputError
  | ContextOverflowError
  | ContentFilterError
  | ApiError

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: MessageError
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  structured?: unknown
  variant?: string
  finish?: string
}

export type Message = UserMessage | AssistantMessage

export type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: number; end?: number }
  metadata?: { [key: string]: unknown }
}

export type SubtaskPart = {
  id: string
  sessionID: string
  messageID: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

export type ReasoningPart = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: { [key: string]: unknown }
  time: { start: number; end?: number }
}

export type FilePartSourceText = { value: string; start: number; end: number }
export type FileSource = { text: FilePartSourceText; type: "file"; path: string }
export type Range = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}
export type SymbolSource = {
  text: FilePartSourceText
  type: "symbol"
  path: string
  range: Range
  name: string
  kind: number
}
export type ResourceSource = { text: FilePartSourceText; type: "resource"; clientName: string; uri: string }
export type FilePartSource = FileSource | SymbolSource | ResourceSource

export type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: FilePartSource
}

export type ToolStatePending = { status: "pending"; input: { [key: string]: unknown }; raw: string }
export type ToolStateRunning = {
  status: "running"
  input: { [key: string]: unknown }
  title?: string
  metadata?: { [key: string]: unknown }
  time: { start: number }
}
export type ToolStateCompleted = {
  status: "completed"
  input: { [key: string]: unknown }
  output: string
  title: string
  metadata: { [key: string]: unknown }
  time: { start: number; end: number; compacted?: number }
  attachments?: Array<FilePart>
}
export type ToolStateError = {
  status: "error"
  input: { [key: string]: unknown }
  error: string
  metadata?: { [key: string]: unknown }
  time: { start: number; end: number }
}
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: { [key: string]: unknown }
}

export type StepStartPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-start"
  snapshot?: string
}

export type StepFinishPart = {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type SnapshotPart = { id: string; sessionID: string; messageID: string; type: "snapshot"; snapshot: string }
export type PatchPart = {
  id: string
  sessionID: string
  messageID: string
  type: "patch"
  hash: string
  files: Array<string>
}
export type AgentPart = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  source?: { value: string; start: number; end: number }
}
export type RetryPart = {
  id: string
  sessionID: string
  messageID: string
  type: "retry"
  attempt: number
  error: ApiError
  time: { created: number }
}
export type CompactionPart = {
  id: string
  sessionID: string
  messageID: string
  type: "compaction"
  auto: boolean
  overflow?: boolean
  tail_start_id?: string
}

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

export type SessionStatus =
  | { type: "idle" }
  | {
      type: "retry"
      attempt: number
      message: string
      action?: {
        reason: string
        provider: string
        title: string
        message: string
        label: string
        link?: string
      }
      next: number
    }
  | { type: "busy" }

// Provider/Model carry far more upstream; the renderer only resolves display
// names through Model.name(), so the trimmed shape keeps what that path reads.
export type Model = {
  id: string
  providerID: string
  name: string
  [key: string]: unknown
}

export type Provider = {
  id: string
  name: string
  models: { [key: string]: Model }
  [key: string]: unknown
}
