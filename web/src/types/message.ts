export type MessageRole = "user" | "assistant" | "system" | "tool"

export type MessageStatus =
  | "complete"
  | "working"
  | "streaming"
  | "error"

export interface ToolActivity {
  name: string
  detail: string
  state: "queued" | "running" | "complete" | "error"
  meta?: string
  sections?: ToolDetailSection[]
}

export interface ToolDetailSection {
  label: string
  content: string
}

export interface FileChange {
  path: string
  kind: string
  movePath?: string
  diff: string
  diffTruncated: boolean
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  /** Omit when the source does not report a timestamp. */
  createdAt?: string
  status: MessageStatus
  toolActivity?: ToolActivity
  fileChanges?: FileChange[]
}
