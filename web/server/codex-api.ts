import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { Connect } from "vite"

import type {
  CodexThreadDetailResponse,
  CodexThreadItemRecord,
  CodexThreadItemsResponse,
  CodexThreadListResponse,
  CodexThreadRecord,
  CodexTranscriptDetail,
  CodexTurnStatus,
} from "../src/types/codex-db.ts"

const MESSAGE_ITEM_TYPES = ["userMessage", "agentMessage"] as const
const FULL_ITEM_TYPES = [
  ...MESSAGE_ITEM_TYPES,
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
] as const
const MAX_FILE_DIFF_CHARS = 200_000
const MAX_COMMAND_CHARS = 12_000
const MAX_TOOL_DETAIL_CHARS = 40_000

interface StateThreadRow {
  id: string
  title: string
  cwd: string
  rollout_path: string
  source: string
  thread_source: string | null
  model: string | null
  git_branch: string | null
  preview: string
  updated_at_ms: number | null
  updated_at: number
  recency_at_ms: number | null
  has_user_event: number
}

interface ThreadItemRow {
  thread_id: string
  turn_id: string
  item_id: string
  rollout_ordinal: number
  created_at_ms: number
  item_type: string
  item_json: string
}

interface CountRow {
  count: number
}

interface OrdinalRow {
  latest_ordinal: number | null
}

interface StatusRow {
  status: CodexTurnStatus
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maximum = MAX_TOOL_DETAIL_CHARS) {
  if (typeof value !== "string") return undefined
  return value.length > maximum ? `${value.slice(0, maximum)}\n… output truncated` : value
}

function boundedJson(value: unknown) {
  if (value === undefined || value === null) return undefined
  try {
    return boundedText(JSON.stringify(value, null, 2))
  } catch {
    return boundedText(String(value))
  }
}

function sanitizeItem(itemType: string, value: unknown): unknown {
  if (!isObject(value)) return null

  if (itemType === "userMessage") {
    const content = Array.isArray(value.content)
      ? value.content.flatMap((part) =>
          isObject(part) && typeof part.text === "string" ? [{ text: part.text }] : [],
        )
      : []
    return { content, text: typeof value.text === "string" ? value.text : undefined }
  }

  if (itemType === "agentMessage") {
    return { text: typeof value.text === "string" ? value.text : "" }
  }

  if (itemType === "commandExecution") {
    return {
      command: boundedText(value.command, MAX_COMMAND_CHARS),
      cwd: boundedText(value.cwd, 2_000),
      output: boundedText(value.aggregatedOutput),
      status: value.status,
      exitCode: value.exitCode,
      durationMs: value.durationMs,
    }
  }

  if (itemType === "fileChange") {
    const changes = Array.isArray(value.changes)
      ? value.changes.flatMap((change) =>
          isObject(change) && typeof change.path === "string"
            ? (() => {
                const kind = isObject(change.kind) ? change.kind : null
                const diff = typeof change.diff === "string" ? change.diff : ""
                return [
                  {
                    path: change.path,
                    kind: kind && typeof kind.type === "string" ? kind.type : "update",
                    movePath:
                      kind && typeof kind.move_path === "string"
                        ? kind.move_path
                        : undefined,
                    diff: diff.slice(0, MAX_FILE_DIFF_CHARS),
                    diffTruncated: diff.length > MAX_FILE_DIFF_CHARS,
                  },
                ]
              })()
            : [],
        )
      : []
    return { changes, status: value.status }
  }

  if (itemType === "mcpToolCall") {
    return {
      server: value.server,
      tool: value.tool,
      status: value.status,
      durationMs: value.durationMs,
      argumentsText: boundedJson(value.arguments),
      resultText: boundedJson(value.result),
      errorText: boundedJson(value.error),
    }
  }

  if (itemType === "webSearch") {
    return {
      query: value.query,
      resultCount: Array.isArray(value.results) ? value.results.length : 0,
      actionText: boundedJson(value.action),
      resultsText: boundedJson(value.results),
    }
  }

  return null
}

function codexHome() {
  const configured = process.env.CODEX_HOME?.trim()
  if (!configured) return path.join(homedir(), ".codex")
  if (configured === "~") return homedir()
  if (configured.startsWith("~/")) {
    return path.join(homedir(), configured.slice(2))
  }
  return path.resolve(configured)
}

function openReadOnly(databasePath: string) {
  if (!existsSync(databasePath)) {
    throw new Error(`Codex database not found: ${databasePath}`)
  }

  const database = new DatabaseSync(databasePath, { readOnly: true })
  database.exec("PRAGMA query_only = ON")
  return database
}

function withDatabases<T>(
  callback: (state: DatabaseSync, history: DatabaseSync) => T,
) {
  const root = codexHome()
  const state = openReadOnly(path.join(root, "state_5.sqlite"))
  const history = openReadOnly(path.join(root, "thread_history_1.sqlite"))

  try {
    return callback(state, history)
  } finally {
    history.close()
    state.close()
  }
}

function latestStatus(history: DatabaseSync, threadId: string) {
  const row = history
    .prepare(
      `SELECT status
       FROM thread_turns
       WHERE thread_id = ?
       ORDER BY rollout_ordinal DESC
       LIMIT 1`,
    )
    .get(threadId) as StatusRow | undefined

  return row?.status ?? null
}

function visibleItemCount(history: DatabaseSync, threadId: string) {
  const placeholders = MESSAGE_ITEM_TYPES.map(() => "?").join(", ")
  const row = history
    .prepare(
      `SELECT COUNT(*) AS count
       FROM thread_items
       WHERE thread_id = ? AND item_type IN (${placeholders})`,
    )
    .get(threadId, ...MESSAGE_ITEM_TYPES) as unknown as CountRow

  return Number(row.count)
}

function mapThread(
  row: StateThreadRow,
  history: DatabaseSync,
): CodexThreadRecord {
  return {
    id: row.id,
    title: row.title || row.preview || "Untitled Codex thread",
    cwd: row.cwd,
    rolloutPath: row.rollout_path,
    source: row.source,
    threadSource: row.thread_source,
    model: row.model,
    gitBranch: row.git_branch,
    preview: row.preview,
    updatedAtMs: row.updated_at_ms ?? row.updated_at * 1000,
    recencyAtMs: row.recency_at_ms ?? row.updated_at_ms ?? row.updated_at * 1000,
    hasUserEvent: Boolean(row.has_user_event),
    messageCount: visibleItemCount(history, row.id),
    turnStatus: latestStatus(history, row.id),
  }
}

function parseItem(row: ThreadItemRow): CodexThreadItemRecord | null {
  try {
    return {
      threadId: row.thread_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      rolloutOrdinal: Number(row.rollout_ordinal),
      createdAtMs: Number(row.created_at_ms),
      itemType: row.item_type,
      item: sanitizeItem(row.item_type, JSON.parse(row.item_json) as unknown),
    }
  } catch {
    return null
  }
}

function visibleItems(
  history: DatabaseSync,
  threadId: string,
  detail: CodexTranscriptDetail,
  afterOrdinal?: number,
) {
  const itemTypes = detail === "full" ? FULL_ITEM_TYPES : MESSAGE_ITEM_TYPES
  const placeholders = itemTypes.map(() => "?").join(", ")
  const afterClause = afterOrdinal === undefined ? "" : "AND rollout_ordinal > ?"
  const parameters: Array<string | number> = [threadId, ...itemTypes]
  if (afterOrdinal !== undefined) parameters.push(afterOrdinal)

  const rows = history
    .prepare(
      `SELECT thread_id, turn_id, item_id, rollout_ordinal, created_at_ms,
              item_type, item_json
       FROM thread_items
       WHERE thread_id = ?
         AND item_type IN (${placeholders})
         ${afterClause}
       ORDER BY rollout_ordinal ASC`,
    )
    .all(...parameters) as unknown as ThreadItemRow[]

  return rows.flatMap((row) => {
    const item = parseItem(row)
    return item ? [item] : []
  })
}

function latestOrdinal(history: DatabaseSync, threadId: string) {
  const row = history
    .prepare(
      `SELECT MAX(rollout_ordinal) AS latest_ordinal
       FROM thread_items
       WHERE thread_id = ?`,
    )
    .get(threadId) as unknown as OrdinalRow

  return Number(row.latest_ordinal ?? -1)
}

function threadRow(state: DatabaseSync, threadId: string) {
  return state
    .prepare(
      `SELECT id, title, cwd, rollout_path, source, thread_source, model,
              git_branch, preview, updated_at_ms, updated_at, recency_at_ms,
              has_user_event
       FROM threads
       WHERE id = ? AND archived = 0`,
    )
    .get(threadId) as StateThreadRow | undefined
}

function listThreads(limit: number): CodexThreadListResponse {
  return withDatabases((state, history) => {
    const rows = state
      .prepare(
        `SELECT id, title, cwd, rollout_path, source, thread_source, model,
                git_branch, preview, updated_at_ms, updated_at, recency_at_ms,
                has_user_event
         FROM threads
         WHERE archived = 0
         ORDER BY COALESCE(recency_at_ms, updated_at_ms, 0) DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as StateThreadRow[]

    return { threads: rows.map((row) => mapThread(row, history)) }
  })
}

function getThread(
  threadId: string,
  detail: CodexTranscriptDetail,
): CodexThreadDetailResponse | null {
  return withDatabases((state, history) => {
    const row = threadRow(state, threadId)
    if (!row) return null

    const status = latestStatus(history, threadId)
    const thread = mapThread(row, history)
    return {
      thread: { ...thread, turnStatus: status },
      items: visibleItems(history, threadId, detail),
      latestOrdinal: latestOrdinal(history, threadId),
      turnStatus: status,
    }
  })
}

function getItems(
  threadId: string,
  afterOrdinal: number,
  detail: CodexTranscriptDetail,
): CodexThreadItemsResponse | null {
  return withDatabases((state, history) => {
    if (!threadRow(state, threadId)) return null
    return {
      items: visibleItems(history, threadId, detail, afterOrdinal),
      latestOrdinal: latestOrdinal(history, threadId),
      turnStatus: latestStatus(history, threadId),
    }
  })
}

function sendJson(
  response: Parameters<Connect.NextHandleFunction>[1],
  statusCode: number,
  body: unknown,
) {
  response.statusCode = statusCode
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.end(JSON.stringify(body))
}

function parseBoundedInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), maximum) : fallback
}

function transcriptDetail(value: string | null): CodexTranscriptDetail {
  return value === "full" ? "full" : "messages"
}

export function codexApiMiddleware(): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (request.method !== "GET" || !request.url?.startsWith("/api/threads")) {
      next()
      return
    }

    try {
      const url = new URL(request.url, "http://localhost")
      const detail = transcriptDetail(url.searchParams.get("detail"))

      if (url.pathname === "/api/threads") {
        const limit = parseBoundedInteger(url.searchParams.get("limit"), 50, 100)
        sendJson(response, 200, listThreads(Math.max(limit, 1)))
        return
      }

      const itemsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/items$/)
      if (itemsMatch) {
        const threadId = decodeURIComponent(itemsMatch[1])
        const afterOrdinal = parseBoundedInteger(
          url.searchParams.get("after_ordinal"),
          -1,
          Number.MAX_SAFE_INTEGER,
        )
        const result = getItems(threadId, afterOrdinal, detail)
        sendJson(response, result ? 200 : 404, result ?? { error: "Thread not found" })
        return
      }

      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/)
      if (threadMatch) {
        const threadId = decodeURIComponent(threadMatch[1])
        const result = getThread(threadId, detail)
        sendJson(response, result ? 200 : 404, result ?? { error: "Thread not found" })
        return
      }

      sendJson(response, 404, { error: "API route not found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex API failed"
      sendJson(response, 500, { error: message })
    }
  }
}
