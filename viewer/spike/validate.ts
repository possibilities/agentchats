// Spike: run the normalizers over real session files and decode every emitted
// message and part against opencode's own v1 Effect schemas (from the pinned
// checkout at ~/src/opencode, bun-installed). This is the fidelity gate the
// sketch calls for — it must pass before the viewer is trusted.
//
//   bun spike/validate.ts <session.jsonl> [...more]
//   bun spike/validate.ts --newest        # newest claude, codex, and pi files
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
// Use opencode's own effect instance so schema classes and decoder agree.
import { Effect, Schema } from "/Users/arthack/src/opencode/packages/schema/node_modules/effect/dist/index.js"
import { SessionV1 } from "/Users/arthack/src/opencode/packages/schema/src/v1/session.ts"
import { createNormalizer, detectFormat, sessionIDFor } from "../src/normalize/index"
import type { Message, Part, Session } from "../src/vendor/types"

function newestFiles(): string[] {
  const globs = [
    "ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -3",
    "ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -3",
    "find ~/.pi/agent/sessions -name '*.jsonl' 2>/dev/null | head -3",
  ]
  return globs.flatMap((cmd) => {
    try {
      return execSync(cmd, { shell: "/bin/bash", encoding: "utf8" }).trim().split("\n").filter(Boolean)
    } catch {
      return []
    }
  })
}

const args = process.argv.slice(2)
const files = args.includes("--newest") ? newestFiles() : args

const decodeMessage = Schema.decodeUnknownEffect(SessionV1.Info)
const decodePart = Schema.decodeUnknownEffect(SessionV1.Part)

let failures = 0

for (const file of files) {
  const format = detectFormat(file)
  if (!format) {
    console.log(`SKIP (unknown format): ${file}`)
    continue
  }
  const messages: Message[] = []
  const parts = new Map<string, Part>()
  const sessions: Session[] = []
  const byID = new Map<string, Message>()
  const sink = {
    session: (s: Session) => sessions.push(s),
    message: (m: Message) => {
      byID.set(m.id, m)
      if (!messages.find((row) => row.id === m.id)) messages.push(m)
    },
    part: (p: Part) => parts.set(p.id, p),
  }
  const normalizer = createNormalizer(format, sessionIDFor(file), sink)
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  for (const line of lines) {
    try {
      normalizer.push(JSON.parse(line))
    } catch (error) {
      console.log(`  parse error: ${String(error).slice(0, 120)}`)
    }
  }

  const partTypes = new Map<string, number>()
  const toolNames = new Map<string, number>()
  for (const part of parts.values()) {
    partTypes.set(part.type, (partTypes.get(part.type) ?? 0) + 1)
    if (part.type === "tool") toolNames.set(part.tool, (toolNames.get(part.tool) ?? 0) + 1)
  }

  let bad = 0
  const complaints: string[] = []
  for (const message of byID.values()) {
    const result = Effect.runSyncExit(decodeMessage(message))
    if (result._tag === "Failure") {
      bad++
      if (complaints.length < 3) complaints.push(`message ${message.id}: ${String(result.cause).slice(0, 300)}`)
    }
  }
  for (const part of parts.values()) {
    const result = Effect.runSyncExit(decodePart(part))
    if (result._tag === "Failure") {
      bad++
      if (complaints.length < 6) complaints.push(`part ${part.id} (${part.type}): ${String(result.cause).slice(0, 300)}`)
    }
  }
  failures += bad

  const histogram = [...partTypes.entries()].map(([k, v]) => `${k}:${v}`).join(" ")
  const tools = [...toolNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" ")
  console.log(`${format.padEnd(6)} ${lines.length} lines → ${byID.size} msgs, ${parts.size} parts | ${histogram}`)
  if (tools) console.log(`       tools: ${tools}`)
  console.log(`       schema: ${bad === 0 ? "ALL DECODE OK" : `${bad} FAILURES`} · busy=${normalizer.busy()} · title=${JSON.stringify(sessions.at(-1)?.title ?? "").slice(0, 60)}`)
  for (const complaint of complaints) console.log(`       ✗ ${complaint}`)
}

process.exit(failures > 0 ? 1 : 0)
