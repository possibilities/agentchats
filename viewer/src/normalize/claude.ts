// Claude Code (~/.claude/projects/<workspace>/<uuid>.jsonl) → opencode v1.
//
// Record shapes verified against live session files on this machine
// (2026-08): user/assistant lines carry an Anthropic API message under
// .message; one assistant message id spans several lines, one content block
// per line; tool results arrive as user-role lines whose line-level
// toolUseResult carries the rich, tool-specific result object. Files are
// rendered in file order — rewind branches (parentUuid trees) are shown as
// they happened, not resolved.
import type { AssistantMessage, Part, Session, ToolPart, UserMessage } from "../vendor/types"
import {
  contentText,
  hunksToUnifiedDiff,
  isRecord,
  parseTime,
  seq,
  str,
  type Normalizer,
  type Sink,
  type StructuredHunk,
} from "./shared"

const TOOL_NAMES: Record<string, string> = {
  bash: "bash",
  edit: "edit",
  multiedit: "edit",
  write: "write",
  read: "read",
  grep: "grep",
  glob: "glob",
  webfetch: "webfetch",
  websearch: "websearch",
  task: "task",
  agent: "task",
  todowrite: "todowrite",
  askuserquestion: "question",
  skill: "skill",
}

export function claudeToolName(name: string) {
  return TOOL_NAMES[name.toLowerCase()] ?? name
}

type OpenTool = { part: ToolPart; name: string }

export function createClaudeNormalizer(input: { sessionID: string; sink: Sink }): Normalizer {
  const { sessionID, sink } = input
  let counter = 0
  const id = (prefix: string) => seq(prefix, ++counter)

  let session: Session | undefined
  let lastUser: UserMessage | undefined
  let assistant: AssistantMessage | undefined
  let assistantSourceID: string | undefined
  let openThinking: { part: Part & { type: "reasoning" } } | undefined
  const openTools = new Map<string, OpenTool>()
  let sawFirstUserText = false
  // A turn is open from a user prompt until an assistant message finishes for
  // a reason other than tool-calls; that is the live "working" window.
  let turnOpen = false

  let directoryKnown = false

  function ensureSession(record: Record<string, unknown>) {
    if (session) {
      // Early records (custom-title) carry no cwd; adopt it when it appears.
      if (!directoryKnown && str(record.cwd)) {
        session.directory = record.cwd as string
        directoryKnown = true
        sink.session({ ...session })
      }
      return session
    }
    directoryKnown = str(record.cwd) !== undefined
    session = {
      id: sessionID,
      slug: sessionID,
      projectID: "agentchats-viewer",
      directory: str(record.cwd) ?? process.cwd(),
      title: "",
      version: str(record.version) ?? "",
      time: { created: parseTime(record.timestamp), updated: parseTime(record.timestamp) },
    }
    sink.session({ ...session })
    return session
  }

  function touch(record: Record<string, unknown>) {
    const current = ensureSession(record)
    current.time.updated = parseTime(record.timestamp)
  }

  function closeThinking(at: number) {
    if (!openThinking) return
    openThinking.part.time.end = at
    sink.part({ ...openThinking.part })
    openThinking = undefined
  }

  function finishAssistant(at: number, finish: string | undefined) {
    if (!assistant) return
    closeThinking(at)
    if (!assistant.time.completed) assistant.time.completed = at
    if (finish) assistant.finish = finish
    if (finish && finish !== "tool-calls") turnOpen = false
    sink.message({ ...assistant })
    assistant = undefined
    assistantSourceID = undefined
  }

  function mapFinish(stopReason: unknown): string | undefined {
    const reason = str(stopReason)
    if (!reason) return undefined
    if (reason === "end_turn" || reason === "stop_sequence") return "stop"
    if (reason === "tool_use") return "tool-calls"
    if (reason === "max_tokens") return "length"
    return reason
  }

  function pushUserText(record: Record<string, unknown>, text: string) {
    const at = parseTime(record.timestamp)
    finishAssistant(at, undefined)
    const message: UserMessage = {
      id: id("msg"),
      sessionID,
      role: "user",
      time: { created: at },
      agent: "you",
      model: { providerID: "anthropic", modelID: "" },
    }
    lastUser = message
    turnOpen = true
    sink.message({ ...message })
    sink.part({ id: id("prt"), sessionID, messageID: message.id, type: "text", text })
    if (!sawFirstUserText && session && !session.title && !text.startsWith("/")) {
      session.title = text.replace(/\s+/g, " ").slice(0, 80)
      sink.session({ ...session })
    }
    if (!text.startsWith("/")) sawFirstUserText = true
  }

  function ensureAssistant(record: Record<string, unknown>, message: Record<string, unknown>) {
    const sourceID = str(message.id) ?? "unknown"
    if (assistant && assistantSourceID === sourceID) return assistant
    const at = parseTime(record.timestamp)
    finishAssistant(at, undefined)
    assistant = {
      id: id("msg"),
      sessionID,
      role: "assistant",
      time: { created: at },
      parentID: lastUser?.id ?? "",
      modelID: str(message.model) ?? "",
      providerID: "anthropic",
      mode: "claude",
      agent: "claude",
      path: { cwd: session?.directory ?? "", root: session?.directory ?? "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    assistantSourceID = sourceID
    sink.message({ ...assistant })
    return assistant
  }

  function applyUsage(message: Record<string, unknown>) {
    if (!assistant) return
    const usage = message.usage
    if (!isRecord(usage)) return
    const num = (value: unknown) => (typeof value === "number" ? value : 0)
    assistant.tokens = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      reasoning: 0,
      cache: { read: num(usage.cache_read_input_tokens), write: num(usage.cache_creation_input_tokens) },
    }
  }

  function toolInput(name: string, raw: unknown): Record<string, unknown> {
    const input = isRecord(raw) ? { ...raw } : {}
    const display = claudeToolName(name)
    if (display === "edit" || display === "write" || display === "read") {
      if (typeof input.file_path === "string") {
        input.filePath = input.file_path
        delete input.file_path
      }
    }
    return input
  }

  function completeTool(record: Record<string, unknown>, block: Record<string, unknown>) {
    const callID = str(block.tool_use_id)
    if (!callID) return
    const open = openTools.get(callID)
    if (!open) return
    openTools.delete(callID)
    const at = parseTime(record.timestamp)
    const output = contentText(block.content)
    const running = open.part.state
    const start = running.status === "running" ? running.time.start : at
    if (block.is_error === true) {
      open.part.state = {
        status: "error",
        input: running.input,
        error: output,
        time: { start, end: at },
      }
      sink.part({ ...open.part })
      return
    }
    const metadata = toolMetadata(open, record, output)
    open.part.state = {
      status: "completed",
      input: metadata.input ?? running.input,
      output,
      title: "",
      metadata: metadata.metadata,
      time: { start, end: at },
    }
    sink.part({ ...open.part })
  }

  // The line-level toolUseResult carries the rich result object; map it to the
  // metadata fields each opencode tool renderer reads.
  function toolMetadata(
    open: OpenTool,
    record: Record<string, unknown>,
    output: string,
  ): { metadata: Record<string, unknown>; input?: Record<string, unknown> } {
    const display = open.part.tool
    const result = isRecord(record.toolUseResult) ? record.toolUseResult : {}
    const input = { ...open.part.state.input }

    if (display === "bash") {
      const stdout = str(result.stdout) ?? output
      const stderr = str(result.stderr)
      return { metadata: { output: [stdout, stderr].filter(Boolean).join("\n") } }
    }
    if (display === "edit") {
      const filePath = str(input.filePath) ?? str(result.filePath) ?? ""
      const patches: StructuredHunk[] | undefined = Array.isArray(result.structuredPatch)
        ? (result.structuredPatch as StructuredHunk[])
        : undefined
      if (patches?.length) {
        return { metadata: { diff: hunksToUnifiedDiff(filePath, patches) }, input }
      }
      return { metadata: {} }
    }
    if (display === "write") {
      if (typeof input.content !== "string" && str(result.content)) input.content = result.content
      // diagnostics present (even empty) switches the renderer to the full
      // file panel, which is what the harness shows on write.
      return { metadata: { diagnostics: {} }, input }
    }
    if (display === "grep") {
      const count =
        (typeof result.numMatches === "number" && result.numMatches) ||
        (typeof result.numFiles === "number" && result.numFiles) ||
        undefined
      return { metadata: count === undefined ? {} : { matches: count } }
    }
    if (display === "glob") {
      const count = typeof result.numFiles === "number" ? result.numFiles : undefined
      return { metadata: count === undefined ? {} : { count } }
    }
    if (display === "todowrite") {
      return { metadata: { todos: input.todos } }
    }
    if (display === "question") {
      const answers = Array.isArray(result.answers) ? result.answers : undefined
      return { metadata: answers ? { answers } : {} }
    }
    return { metadata: {} }
  }

  function pushAssistantBlocks(record: Record<string, unknown>, message: Record<string, unknown>) {
    const current = ensureAssistant(record, message)
    const at = parseTime(record.timestamp)
    const content = Array.isArray(message.content) ? message.content : []
    for (const raw of content) {
      if (!isRecord(raw)) continue
      if (raw.type === "text" && str(raw.text)?.trim()) {
        closeThinking(at)
        sink.part({ id: id("prt"), sessionID, messageID: current.id, type: "text", text: raw.text as string })
      } else if (raw.type === "thinking" && str(raw.thinking)?.trim()) {
        closeThinking(at)
        const part: Part & { type: "reasoning" } = {
          id: id("prt"),
          sessionID,
          messageID: current.id,
          type: "reasoning",
          text: raw.thinking as string,
          time: { start: at },
        }
        openThinking = { part }
        sink.part({ ...part })
      } else if (raw.type === "tool_use") {
        closeThinking(at)
        const name = str(raw.name) ?? "tool"
        const part: ToolPart = {
          id: id("prt"),
          sessionID,
          messageID: current.id,
          type: "tool",
          callID: str(raw.id) ?? id("call"),
          tool: claudeToolName(name),
          state: { status: "running", input: toolInput(name, raw.input), time: { start: at } },
        }
        openTools.set(part.callID, { part, name })
        sink.part({ ...part })
      }
    }
    applyUsage(message)
    const finish = mapFinish(message.stop_reason)
    if (finish) {
      finishAssistant(at, finish)
    } else {
      sink.message({ ...current })
    }
  }

  function pushUser(record: Record<string, unknown>) {
    const message = record.message
    if (!isRecord(message)) return
    const at = parseTime(record.timestamp)
    const content = message.content

    if (typeof content === "string") {
      if (record.isMeta === true) return
      if (content.includes("<command-name>")) {
        const name = content.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim()
        const args = content.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim()
        if (name) pushUserText(record, [name, args].filter(Boolean).join(" "))
        return
      }
      if (content.includes("<local-command-stdout>")) return
      if (content.trim()) pushUserText(record, content)
      return
    }

    if (!Array.isArray(content)) return
    const toolResults = content.filter((block) => isRecord(block) && block.type === "tool_result")
    for (const block of toolResults) {
      closeThinking(at)
      completeTool(record, block as Record<string, unknown>)
    }
    if (record.isMeta === true) return
    const text = content
      .filter((block) => isRecord(block) && block.type === "text")
      .map((block) => str((block as Record<string, unknown>).text) ?? "")
      .filter((value) => value.trim())
      .join("\n\n")
    if (text.trim()) pushUserText(record, text)
  }

  return {
    push(raw: unknown) {
      if (!isRecord(raw)) return
      if (raw.isSidechain === true) return
      const type = str(raw.type)
      if (type !== "user" && type !== "assistant" && type !== "custom-title" && type !== "summary") return
      touch(raw)
      if (type === "custom-title") {
        const title = str(raw.customTitle) ?? str(raw.title)
        if (title && session) {
          session.title = title
          sink.session({ ...session })
        }
        return
      }
      if (type === "summary") {
        const summary = str(raw.summary)
        if (summary && session && !session.title) {
          session.title = summary
          sink.session({ ...session })
        }
        return
      }
      if (type === "user") pushUser(raw)
      if (type === "assistant") {
        const message = raw.message
        if (isRecord(message)) pushAssistantBlocks(raw, message)
      }
    },
    busy() {
      return turnOpen || openTools.size > 0
    },
  }
}
