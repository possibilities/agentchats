// Shared contract and helpers for the per-store normalizers. A normalizer
// turns one harness's raw JSONL records into opencode v1 sessions, messages,
// and parts (the shapes the vendored renderer consumes), incrementally: push()
// accepts records in file order and re-emits any object it mutates.
import type { Message, Part, Session } from "../vendor/types"

export type Sink = {
  session(session: Session): void
  message(message: Message): void
  part(part: Part): void
}

export type Normalizer = {
  push(record: unknown): void
  // Trailing evidence says the harness is mid-turn (live view shows working).
  busy(): boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function seq(prefix: string, n: number) {
  return `${prefix}_${String(n).padStart(8, "0")}`
}

export function parseTime(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

// Join an Anthropic/Pi-style content-block array (or plain string) to text.
export function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (!isRecord(block)) return ""
      if (typeof block.text === "string") return block.text
      if (block.type === "image") return "[image]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

// jsdiff-style structured hunks (Claude Code's toolUseResult.structuredPatch)
// rendered back to a unified diff for the <diff> renderable.
export type StructuredHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export function hunksToUnifiedDiff(filePath: string, hunks: StructuredHunk[]): string {
  const out = [`--- a/${filePath}`, `+++ b/${filePath}`]
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    out.push(...hunk.lines)
  }
  return out.join("\n") + "\n"
}

// Line-level diff of two strings (Pi edits carry oldText/newText, no patch).
// Plain LCS on lines, with a size guard that degrades to whole-block
// replacement; line numbers are real because both sides are complete.
export function textsToUnifiedDiff(filePath: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  let body: string[]
  if (oldLines.length * newLines.length > 250_000) {
    body = [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)]
  } else {
    body = lcsDiff(oldLines, newLines)
  }
  const deletions = body.filter((line) => line.startsWith("-")).length
  const additions = body.filter((line) => line.startsWith("+")).length
  const context = body.length - deletions - additions
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${context + deletions} +1,${context + additions} @@`,
    ...body,
  ].join("\n") + "\n"
}

function lcsDiff(a: string[], b: string[]): string[] {
  const rows = a.length
  const cols = b.length
  const table: Uint32Array = new Uint32Array((rows + 1) * (cols + 1))
  const at = (i: number, j: number) => i * (cols + 1) + j
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)])
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      out.push(`-${a[i]}`)
      i++
    } else {
      out.push(`+${b[j]}`)
      j++
    }
  }
  while (i < rows) out.push(`-${a[i++]}`)
  while (j < cols) out.push(`+${b[j++]}`)
  return out
}

// Codex apply_patch envelope → the per-file shape opencode's ApplyPatch
// renderer expects (parseApplyPatchFiles). Codex patches carry no line
// numbers; hunks are re-numbered from 1, which keeps the ± content exact
// while the gutter numbers stay approximate for Update File patches.
export type PatchFile = {
  type: "add" | "update" | "delete" | "move"
  relativePath: string
  filePath: string
  patch: string
  deletions: number
  movePath?: string
}

export function codexPatchToFiles(patch: string): PatchFile[] {
  const lines = patch.split("\n")
  const files: PatchFile[] = []
  let current: { type: PatchFile["type"]; path: string; movePath?: string; body: string[] } | undefined

  const flush = () => {
    if (!current) return
    const body = current.body
    const deletions = body.filter((line) => line.startsWith("-")).length
    let text: string
    if (current.type === "delete") {
      text = ""
    } else {
      // Split into hunks at "@@" markers (or one whole-body hunk), then
      // renumber from 1 with real counts so the diff parser accepts it.
      const hunks: string[][] = []
      let hunk: string[] | undefined
      for (const line of body) {
        if (line.startsWith("@@")) {
          if (hunk?.length) hunks.push(hunk)
          hunk = []
        } else {
          ;(hunk ??= []).push(line)
        }
      }
      if (hunk?.length) hunks.push(hunk)
      let oldLine = 1
      let newLine = 1
      const withHunks: string[] = []
      for (const lines of hunks) {
        const removed = lines.filter((line) => line.startsWith("-")).length
        const added = lines.filter((line) => line.startsWith("+")).length
        const context = lines.length - removed - added
        withHunks.push(`@@ -${oldLine},${context + removed} +${newLine},${context + added} @@`)
        withHunks.push(...lines)
        oldLine += context + removed
        newLine += context + added
      }
      text = [`--- a/${current.path}`, `+++ b/${current.movePath ?? current.path}`, ...withHunks].join("\n") + "\n"
    }
    files.push({
      type: current.type,
      relativePath: current.movePath ?? current.path,
      filePath: current.path,
      patch: text,
      deletions,
      movePath: current.movePath,
    })
    current = undefined
  }

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue
    const add = line.match(/^\*\*\* Add File: (.+)$/)
    const update = line.match(/^\*\*\* Update File: (.+)$/)
    const del = line.match(/^\*\*\* Delete File: (.+)$/)
    const move = line.match(/^\*\*\* Move to: (.+)$/)
    if (add) {
      flush()
      current = { type: "add", path: add[1].trim(), body: [] }
    } else if (update) {
      flush()
      current = { type: "update", path: update[1].trim(), body: [] }
    } else if (del) {
      flush()
      current = { type: "delete", path: del[1].trim(), body: [] }
    } else if (move && current) {
      current.type = "move"
      current.movePath = move[1].trim()
    } else if (current) {
      current.body.push(line)
    }
  }
  flush()
  return files
}
