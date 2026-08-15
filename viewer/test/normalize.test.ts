import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createNormalizer, detectFormat, type SessionFormat } from "../src/normalize/index"
import type { Message, Part, Session, ToolPart } from "../src/vendor/types"

function run(format: SessionFormat, fixture: string) {
  const messages = new Map<string, Message>()
  const parts = new Map<string, Part>()
  let session: Session | undefined
  const normalizer = createNormalizer(format, "ses_test", {
    session: (value) => (session = value),
    message: (value) => messages.set(value.id, value),
    part: (value) => parts.set(value.id, value),
  })
  const busyTrace: boolean[] = []
  const file = path.join(import.meta.dir, "fixtures", fixture)
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    normalizer.push(JSON.parse(line))
    busyTrace.push(normalizer.busy())
  }
  const ordered = [...messages.values()]
  return { session, messages: ordered, parts: [...parts.values()], busyTrace, normalizer }
}

function tools(parts: Part[]): ToolPart[] {
  return parts.filter((part): part is ToolPart => part.type === "tool")
}

describe("claude normalizer", () => {
  const result = run("claude", "claude.jsonl")

  test("session carries the custom title and directory", () => {
    expect(result.session?.title).toBe("flaky-retry-fix")
    expect(result.session?.directory).toBe("/tmp/proj")
  })

  test("messages alternate and assistants close with a finish", () => {
    const roles = result.messages.map((message) => message.role)
    expect(roles[0]).toBe("user")
    const finals = result.messages.filter((message) => message.role === "assistant" && message.finish === "stop")
    expect(finals.length).toBe(1)
  })

  test("bash completes with stdout metadata", () => {
    const bash = tools(result.parts).find((part) => part.tool === "bash")
    expect(bash?.state.status).toBe("completed")
    expect(bash?.state.status === "completed" && bash.state.metadata.output).toContain("retries too fast")
  })

  test("edit synthesizes a unified diff from structuredPatch", () => {
    const edit = tools(result.parts).find((part) => part.tool === "edit")
    expect(edit?.state.status).toBe("completed")
    const diff = edit?.state.status === "completed" ? String(edit.state.metadata.diff) : ""
    expect(diff).toContain("+retry(backoff)")
    expect(diff).toContain("-retry(0)")
    expect(diff).toContain("@@ -10,3 +10,3 @@")
    expect(edit?.state.input.filePath).toBe("/tmp/proj/api/client.ts")
  })

  test("busy through the turn, idle after the final stop", () => {
    expect(result.busyTrace.at(1)).toBe(true)
    expect(result.busyTrace.at(-1)).toBe(false)
    expect(result.normalizer.busy()).toBe(false)
  })
})

describe("codex normalizer", () => {
  const result = run("codex", "codex.jsonl")

  test("session comes from session_meta, title from first prompt", () => {
    expect(result.session?.directory).toBe("/tmp/proj")
    expect(result.session?.title).toBe("List the files here")
  })

  test("reasoning summary becomes a reasoning part", () => {
    const reasoning = result.parts.find((part) => part.type === "reasoning")
    expect(reasoning && "text" in reasoning && reasoning.text).toContain("Scanning the directory")
  })

  test("exec maps to bash with output metadata", () => {
    const bash = tools(result.parts).find((part) => part.tool === "bash")
    expect(bash?.state.input.command).toBe("ls -la")
    expect(bash?.state.status === "completed" && bash.state.metadata.output).toContain("a.txt")
  })

  test("assistant text closes the turn", () => {
    const finals = result.messages.filter((message) => message.role === "assistant" && message.finish === "stop")
    expect(finals.length).toBe(1)
    expect(result.normalizer.busy()).toBe(false)
  })
})

describe("pi normalizer", () => {
  const result = run("pi", "pi.jsonl")

  test("session name and model changes apply", () => {
    expect(result.session?.title).toBe("probe run")
    const assistant = result.messages.find((message) => message.role === "assistant")
    expect(assistant?.role === "assistant" && assistant.modelID).toBe("claude-sonnet-5")
  })

  test("thinking becomes a reasoning part", () => {
    const reasoning = result.parts.find((part) => part.type === "reasoning")
    expect(reasoning && "text" in reasoning && reasoning.text).toContain("listing first")
  })

  test("edit synthesizes a diff from oldText/newText", () => {
    const edit = tools(result.parts).find((part) => part.tool === "edit")
    const diff = edit?.state.status === "completed" ? String(edit.state.metadata.diff) : ""
    expect(diff).toContain("-const b = 2")
    expect(diff).toContain("+const b = 3")
    expect(edit?.state.input.filePath).toBe("x.ts")
  })

  test("idle after the final stop", () => {
    expect(result.normalizer.busy()).toBe(false)
  })
})

describe("format detection", () => {
  test("detects by store path", () => {
    expect(detectFormat("/Users/x/.claude/projects/p/s.jsonl")).toBe("claude")
    expect(detectFormat("/Users/x/.codex/sessions/2026/08/15/rollout-x.jsonl")).toBe("codex")
    expect(detectFormat("/Users/x/.pi/agent/sessions/w/s.jsonl")).toBe("pi")
  })

  test("sniffs by first line when the path is foreign", () => {
    expect(detectFormat("/tmp/x.jsonl", '{"ordinal":1,"payload":{},"timestamp":"t","type":"session_meta"}')).toBe(
      "codex",
    )
    expect(detectFormat("/tmp/x.jsonl", '{"type":"session","cwd":"/tmp","id":"s"}')).toBe("pi")
    expect(detectFormat("/tmp/x.jsonl", '{"type":"user","sessionId":"s","parentUuid":null}')).toBe("claude")
  })
})
