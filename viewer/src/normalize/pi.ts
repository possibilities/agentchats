// Pi (~/.pi/agent/sessions/<workspace>/<ts>_<uuid>.jsonl) → opencode v1.
//
// Entries are typed records: session / session_info / model_change /
// thinking_level_change / message / custom_message, with .message carrying
// {role, content[], timestamp} and roles user | assistant | toolResult.
// Assistant content blocks: text, thinking, toolCall {id, name, arguments};
// toolResult messages: {toolCallId, toolName, content[], isError}.
// Verified against live session files and ~/src/pi/packages/coding-agent.
import type { AssistantMessage, Session, ToolPart, UserMessage } from "../vendor/types"
import { contentText, isRecord, parseTime, seq, str, textsToUnifiedDiff, type Normalizer, type Sink } from "./shared"

const TOOL_NAMES: Record<string, string> = {
  bash: "bash",
  edit: "edit",
  write: "write",
  read: "read",
  grep: "grep",
  find: "glob",
  glob: "glob",
}

export function createPiNormalizer(input: { sessionID: string; sink: Sink }): Normalizer {
  const { sessionID, sink } = input
  let counter = 0
  const id = (prefix: string) => seq(prefix, ++counter)

  let session: Session | undefined
  let provider = "unknown"
  let model = ""
  let lastUser: UserMessage | undefined
  const openTools = new Map<string, ToolPart>()
  let turnOpen = false

  function ensureSession(record: Record<string, unknown>, at: number) {
    if (session) {
      session.time.updated = at
      return session
    }
    session = {
      id: sessionID,
      slug: sessionID,
      projectID: "agentchats-viewer",
      directory: str(record.cwd) ?? process.cwd(),
      title: "",
      version: String(record.version ?? ""),
      time: { created: at, updated: at },
    }
    sink.session({ ...session })
    return session
  }

  function mapInput(name: string, raw: unknown): Record<string, unknown> {
    const args = isRecord(raw) ? { ...raw } : {}
    const display = TOOL_NAMES[name.toLowerCase()]
    if ((display === "edit" || display === "write" || display === "read") && typeof args.path === "string") {
      args.filePath = args.path
      delete args.path
    }
    return args
  }

  function pushUser(at: number, text: string) {
    const message: UserMessage = {
      id: id("msg"),
      sessionID,
      role: "user",
      time: { created: at },
      agent: "you",
      model: { providerID: provider, modelID: model },
    }
    lastUser = message
    turnOpen = true
    sink.message({ ...message })
    sink.part({ id: id("prt"), sessionID, messageID: message.id, type: "text", text })
    if (session && !session.title) {
      session.title = text.replace(/\s+/g, " ").slice(0, 80)
      sink.session({ ...session })
    }
  }

  function pushAssistant(at: number, message: Record<string, unknown>) {
    const content = Array.isArray(message.content) ? message.content : []
    const hasToolCall = content.some((block) => isRecord(block) && block.type === "toolCall")
    const usage = isRecord(message.usage) ? message.usage : {}
    const num = (value: unknown) => (typeof value === "number" ? value : 0)

    const info: AssistantMessage = {
      id: id("msg"),
      sessionID,
      role: "assistant",
      time: { created: at },
      parentID: lastUser?.id ?? "",
      modelID: str(message.model) ?? model,
      providerID: str(message.provider) ?? provider,
      mode: "pi",
      agent: "pi",
      path: { cwd: session?.directory ?? "", root: session?.directory ?? "" },
      cost: 0,
      tokens: {
        input: num(usage.input),
        output: num(usage.output),
        reasoning: 0,
        cache: { read: num(usage.cacheRead), write: num(usage.cacheWrite) },
      },
    }
    sink.message({ ...info })

    for (const raw of content) {
      if (!isRecord(raw)) continue
      if (raw.type === "text" && str(raw.text)?.trim()) {
        sink.part({ id: id("prt"), sessionID, messageID: info.id, type: "text", text: raw.text as string })
      } else if (raw.type === "thinking" && str(raw.thinking)?.trim()) {
        sink.part({
          id: id("prt"),
          sessionID,
          messageID: info.id,
          type: "reasoning",
          text: raw.thinking as string,
          time: { start: at, end: at },
        })
      } else if (raw.type === "toolCall") {
        const name = str(raw.name) ?? "tool"
        const part: ToolPart = {
          id: id("prt"),
          sessionID,
          messageID: info.id,
          type: "tool",
          callID: str(raw.id) ?? id("call"),
          tool: TOOL_NAMES[name.toLowerCase()] ?? name,
          state: { status: "running", input: mapInput(name, raw.arguments), time: { start: at } },
        }
        openTools.set(part.callID, part)
        sink.part({ ...part })
      }
    }

    const stop = str(message.stopReason)
    info.time.completed = at
    info.finish = hasToolCall || stop === "toolUse" ? "tool-calls" : stop === "aborted" ? "stop" : "stop"
    if (stop === "aborted") info.error = { name: "MessageAbortedError", data: { message: "interrupted" } }
    if (info.finish !== "tool-calls") turnOpen = false
    sink.message({ ...info })
  }

  function completeTool(at: number, message: Record<string, unknown>) {
    const callID = str(message.toolCallId) ?? ""
    const part = openTools.get(callID)
    if (!part) return
    openTools.delete(callID)
    const output = contentText(message.content)
    const running = part.state
    const start = running.status === "running" ? running.time.start : at
    if (message.isError === true) {
      part.state = { status: "error", input: running.input, error: output, time: { start, end: at } }
      sink.part({ ...part })
      return
    }
    const metadata: Record<string, unknown> = {}
    const input = { ...running.input }
    if (part.tool === "bash") metadata.output = output
    if (part.tool === "write") metadata.diagnostics = {}
    if (part.tool === "edit") {
      const filePath = str(input.filePath) ?? ""
      const edits = Array.isArray(input.edits) ? input.edits : [input]
      const diffs = edits
        .filter(isRecord)
        .map((edit) => {
          const oldText = str(edit.oldText)
          const newText = str(edit.newText)
          if (oldText === undefined || newText === undefined) return ""
          return textsToUnifiedDiff(filePath, oldText, newText)
        })
        .filter(Boolean)
      if (diffs.length) metadata.diff = diffs.join("\n")
    }
    part.state = {
      status: "completed",
      input,
      output,
      title: "",
      metadata,
      time: { start, end: at },
    }
    sink.part({ ...part })
  }

  return {
    push(raw: unknown) {
      if (!isRecord(raw)) return
      const type = str(raw.type)
      if (type === "session") {
        ensureSession(raw, parseTime(raw.timestamp))
        return
      }
      if (type === "session_info") {
        const name = str(raw.name)
        if (name && session) {
          session.title = name
          sink.session({ ...session })
        }
        return
      }
      if (type === "model_change") {
        provider = str(raw.provider) ?? provider
        model = str(raw.modelId) ?? model
        return
      }
      if (type !== "message") return
      const message = raw.message
      if (!isRecord(message)) return
      const at = parseTime(message.timestamp ?? raw.timestamp)
      ensureSession(raw, at)
      const role = str(message.role)
      if (role === "user") {
        const text = contentText(message.content)
        if (text.trim()) pushUser(at, text)
      } else if (role === "assistant") {
        pushAssistant(at, message)
      } else if (role === "toolResult") {
        completeTool(at, message)
      }
    },
    busy() {
      return turnOpen || openTools.size > 0
    },
  }
}
