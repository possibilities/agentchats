// Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) → opencode v1.
//
// Rollout lines are {timestamp, type, payload}. The transcript lives in
// response_item payloads (message / reasoning / *_tool_call{,_output}); codex
// has no assistant-message envelope, so tool calls and reasoning between user
// prompts are grouped under a synthesized assistant message per step, and an
// assistant text item closes the turn. Verified against live rollouts on this
// machine (custom_tool_call name "exec", string input, structured output
// array) plus the standard shell/function_call forms.
import type { AssistantMessage, Session, ToolPart, UserMessage } from "../vendor/types"
import { codexPatchToFiles, isRecord, parseTime, seq, str, type Normalizer, type Sink } from "./shared"

const SKIP_USER_PREFIXES = [
  "<user_instructions",
  "<environment_context",
  "<ENVIRONMENT_CONTEXT",
  "<turn_context",
  "<permissions",
  "<repo_workflow",
  "<recommended_plugins",
  "# AGENTS.md",
]

export function createCodexNormalizer(input: { sessionID: string; sink: Sink }): Normalizer {
  const { sessionID, sink } = input
  let counter = 0
  const id = (prefix: string) => seq(prefix, ++counter)

  let session: Session | undefined
  let model = ""
  let lastUser: UserMessage | undefined
  let assistant: AssistantMessage | undefined
  const openTools = new Map<string, ToolPart>()
  let turnOpen = false

  function ensureSession(at: number, meta?: Record<string, unknown>) {
    if (session) {
      session.time.updated = at
      return session
    }
    session = {
      id: sessionID,
      slug: sessionID,
      projectID: "agentchats-viewer",
      directory: str(meta?.cwd) ?? process.cwd(),
      title: "",
      version: str(meta?.cli_version) ?? "",
      time: { created: at, updated: at },
    }
    sink.session({ ...session })
    return session
  }

  function finishAssistant(at: number, finish: string) {
    if (!assistant) return
    assistant.time.completed = at
    assistant.finish = finish
    if (finish !== "tool-calls") turnOpen = false
    sink.message({ ...assistant })
    assistant = undefined
  }

  function ensureAssistant(at: number) {
    if (assistant) return assistant
    assistant = {
      id: id("msg"),
      sessionID,
      role: "assistant",
      time: { created: at },
      parentID: lastUser?.id ?? "",
      modelID: model,
      providerID: "openai",
      mode: "codex",
      agent: "codex",
      path: { cwd: session?.directory ?? "", root: session?.directory ?? "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    sink.message({ ...assistant })
    return assistant
  }

  function pushUser(at: number, text: string) {
    finishAssistant(at, "stop")
    const message: UserMessage = {
      id: id("msg"),
      sessionID,
      role: "user",
      time: { created: at },
      agent: "you",
      model: { providerID: "openai", modelID: model },
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

  function joinContent(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
      .map((block) => (isRecord(block) ? (str(block.text) ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  }

  function openTool(at: number, callID: string, tool: string, args: Record<string, unknown>) {
    const current = ensureAssistant(at)
    const part: ToolPart = {
      id: id("prt"),
      sessionID,
      messageID: current.id,
      type: "tool",
      callID,
      tool,
      state: { status: "running", input: args, time: { start: at } },
    }
    openTools.set(callID, part)
    sink.part({ ...part })
  }

  function mapCall(at: number, payload: Record<string, unknown>) {
    const callID = str(payload.call_id) ?? str(payload.id) ?? id("call")
    const name = str(payload.name) ?? "tool"
    const rawInput = payload.input ?? payload.arguments

    if (name === "shell" || name === "local_shell" || name === "container.exec") {
      let args: Record<string, unknown> = {}
      const parsed = typeof rawInput === "string" ? tryParse(rawInput) : rawInput
      if (isRecord(parsed)) {
        const command = parsed.command
        args = {
          command: Array.isArray(command) ? command.join(" ") : str(command) ?? "",
          ...(str(parsed.workdir) ? { workdir: parsed.workdir } : {}),
        }
      }
      openTool(at, callID, "bash", args)
      return
    }
    if (name === "exec") {
      // Codemode: the input is a JS snippet driving tools.exec_command.
      openTool(at, callID, "bash", { command: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput) })
      return
    }
    if (name === "apply_patch") {
      const patch = typeof rawInput === "string" ? rawInput : (str(isRecord(rawInput) ? rawInput.input : "") ?? "")
      openTool(at, callID, "apply_patch", { patch })
      return
    }
    if (name === "update_plan") {
      const parsed = typeof rawInput === "string" ? tryParse(rawInput) : rawInput
      const plan = isRecord(parsed) && Array.isArray(parsed.plan) ? parsed.plan : []
      const todos = plan
        .filter(isRecord)
        .map((item) => ({ content: str(item.step) ?? "", status: str(item.status) ?? "pending" }))
      openTool(at, callID, "todowrite", { todos })
      return
    }
    if (name === "web_search" || payload.type === "web_search_call") {
      const parsed = typeof rawInput === "string" ? tryParse(rawInput) : rawInput
      const action = isRecord(payload.action) ? payload.action : isRecord(parsed) ? parsed : {}
      openTool(at, callID, "websearch", { query: str(action.query) ?? "" })
      return
    }
    const parsed = typeof rawInput === "string" ? (tryParse(rawInput) ?? { input: rawInput }) : rawInput
    openTool(at, callID, name, isRecord(parsed) ? parsed : {})
  }

  function completeCall(at: number, payload: Record<string, unknown>) {
    const callID = str(payload.call_id) ?? ""
    const part = openTools.get(callID)
    if (!part) return
    openTools.delete(callID)
    const output = joinContent(payload.output)
    const running = part.state
    const start = running.status === "running" ? running.time.start : at
    const metadata: Record<string, unknown> = {}
    if (part.tool === "bash") metadata.output = output
    if (part.tool === "todowrite") metadata.todos = running.input.todos
    if (part.tool === "apply_patch") {
      const files = codexPatchToFiles(str(running.input.patch) ?? "")
      if (files.length) metadata.files = files
    }
    part.state = {
      status: "completed",
      input: running.input,
      output,
      title: "",
      metadata,
      time: { start, end: at },
    }
    sink.part({ ...part })
  }

  function pushResponseItem(at: number, payload: Record<string, unknown>) {
    const type = str(payload.type)
    if (type === "message") {
      const role = str(payload.role)
      const text = joinContent(payload.content)
      if (!text.trim()) return
      if (role === "user") {
        if (SKIP_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return
        pushUser(at, text)
        return
      }
      if (role === "assistant") {
        const current = ensureAssistant(at)
        sink.part({ id: id("prt"), sessionID, messageID: current.id, type: "text", text })
        finishAssistant(at, "stop")
      }
      return
    }
    if (type === "reasoning") {
      const summary = Array.isArray(payload.summary)
        ? payload.summary
            .map((block) => (isRecord(block) ? (str(block.text) ?? "") : ""))
            .filter(Boolean)
            .join("\n\n")
        : ""
      const content = Array.isArray(payload.content)
        ? payload.content
            .map((block) => (isRecord(block) ? (str(block.text) ?? "") : ""))
            .filter(Boolean)
            .join("\n\n")
        : ""
      const text = [summary, content].filter(Boolean).join("\n\n")
      if (!text.trim()) return
      const current = ensureAssistant(at)
      sink.part({
        id: id("prt"),
        sessionID,
        messageID: current.id,
        type: "reasoning",
        text,
        time: { start: at, end: at },
      })
      return
    }
    if (type === "custom_tool_call" || type === "function_call" || type === "web_search_call") {
      mapCall(at, payload)
      return
    }
    if (type === "local_shell_call") {
      const action = isRecord(payload.action) ? payload.action : {}
      const command = Array.isArray(action.command) ? action.command.join(" ") : (str(action.command) ?? "")
      openTool(at, str(payload.call_id) ?? id("call"), "bash", { command })
      return
    }
    if (type === "custom_tool_call_output" || type === "function_call_output") {
      completeCall(at, payload)
      return
    }
  }

  return {
    push(raw: unknown) {
      if (!isRecord(raw)) return
      const at = parseTime(raw.timestamp)
      const type = str(raw.type)
      const payload = isRecord(raw.payload) ? raw.payload : {}
      if (type === "session_meta") {
        ensureSession(at, payload)
        return
      }
      if (type === "turn_context") {
        ensureSession(at, payload)
        model = str(payload.model) ?? model
        return
      }
      if (type === "compacted") {
        ensureSession(at)
        const message: UserMessage = {
          id: id("msg"),
          sessionID,
          role: "user",
          time: { created: at },
          agent: "you",
          model: { providerID: "openai", modelID: model },
        }
        sink.message({ ...message })
        sink.part({ id: id("prt"), sessionID, messageID: message.id, type: "compaction", auto: true })
        return
      }
      if (type !== "response_item") return
      ensureSession(at)
      pushResponseItem(at, payload)
    },
    busy() {
      return turnOpen || openTools.size > 0
    },
  }
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
