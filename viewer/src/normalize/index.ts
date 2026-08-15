// Format detection and normalizer construction for a session file path.
import path from "node:path"
import { createClaudeNormalizer } from "./claude"
import { createCodexNormalizer } from "./codex"
import { createPiNormalizer } from "./pi"
import { isRecord, type Normalizer, type Sink } from "./shared"

export type SessionFormat = "claude" | "codex" | "pi"

export function detectFormat(filePath: string, firstLine?: string): SessionFormat | undefined {
  if (filePath.includes("/.claude/projects/")) return "claude"
  if (filePath.includes("/.codex/sessions/")) return "codex"
  if (filePath.includes("/.pi/agent/sessions/")) return "pi"
  if (firstLine) {
    try {
      const record = JSON.parse(firstLine)
      if (isRecord(record)) {
        if (record.payload !== undefined && record.ordinal !== undefined) return "codex"
        if (record.sessionId !== undefined || record.parentUuid !== undefined) return "claude"
        if (record.type === "session" && record.cwd !== undefined) return "pi"
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

export function sessionIDFor(filePath: string) {
  // "ses_" matches opencode's branded session id prefix.
  return "ses_" + path.basename(filePath).replace(/\.jsonl$/, "")
}

export function createNormalizer(format: SessionFormat, sessionID: string, sink: Sink): Normalizer {
  if (format === "claude") return createClaudeNormalizer({ sessionID, sink })
  if (format === "codex") return createCodexNormalizer({ sessionID, sink })
  return createPiNormalizer({ sessionID, sink })
}
