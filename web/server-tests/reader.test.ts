import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createServer, type Server } from "node:http"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createSchema } from "../../src/store/schema.ts"
import { readerApiMiddleware } from "../server/reader-api.ts"
import { createCodexTranscriptSource } from "../src/transcript/codex"

let directory: string
let base: string
let server: Server
let index: Database
let state: Database
let history: Database
let files: string[]
let readerEnv: Record<string, string | undefined>

function indexSession(id: string, agent = "codex", archived = 0, updated = "2026-09-13") {
  index.query(`INSERT INTO sessions
    (agent, session_id, source_path, updated_at, archived, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)`)
    .run(agent, id, `/transcripts/${id}`, updated, archived, updated)
}
function thread(id: string, archived = 0, updated = 100) {
  state.query(`INSERT INTO threads VALUES (?, ?, '/workspace/demo', '', 'cli', 'user',
    'model', 'main', 'preview', ?, 0, ?, 1, ?)`)
    .run(id, `Title ${id}`, updated, updated, archived)
}
function item(ordinal: number, type: string, value: unknown, id = "indexed") {
  history.query("INSERT INTO thread_items VALUES (?, 'turn', ?, ?, 1000, ?, ?)")
    .run(id, `item-${ordinal}`, ordinal, type, JSON.stringify(value))
}
async function get(route: string, init?: RequestInit) {
  const response = await fetch(`${base}${route}`, init)
  return { response, body: await response.json() as any }
}

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "agentchats-reader-test-"))
  const codex = path.join(directory, ".codex")
  mkdirSync(codex)
  files = [path.join(directory, "index.db"), path.join(codex, "state_5.sqlite"), path.join(codex, "thread_history_1.sqlite")]
  index = new Database(files[0]!, { create: true })
  createSchema(index)
  state = new Database(files[1]!, { create: true })
  state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    source TEXT, thread_source TEXT, model TEXT, git_branch TEXT, preview TEXT,
    updated_at_ms INTEGER, updated_at INTEGER, recency_at_ms INTEGER, has_user_event INTEGER, archived INTEGER)`)
  history = new Database(files[2]!, { create: true })
  history.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
    rollout_ordinal INTEGER, created_at_ms INTEGER, item_type TEXT, item_json TEXT);
    CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT)`)
  readerEnv = { HOME: directory, AGENTCHATS_INDEX: files[0] }
  const middleware = readerApiMiddleware(readerEnv)
  server = createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404
    response.end()
  }))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No listening address")
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  index.close()
  state.close()
  history.close()
  rmSync(directory, { recursive: true, force: true })
})

test("discovery uses index order and eligibility, never an independent Codex list", async () => {
  indexSession("indexed")
  thread("indexed", 0, 1)
  indexSession("older", "codex", 0, "2026-09-12")
  thread("older", 0, 9999)
  thread("not-indexed", 0, 99999)
  indexSession("claude", "claude_code")
  indexSession("archive", "codex", 1)
  indexSession("codex-archived")
  thread("codex-archived", 1)
  indexSession("gone-from-codex")
  const { response, body } = await get("/api/threads")
  expect(response.status).toBe(200)
  expect(body.threads.map((entry: any) => entry.id)).toEqual(["indexed", "older"])
  expect(body.threads[0].title).toBe("Title indexed")
  expect((await get("/api/threads?limit=1")).body.threads.length).toBeLessThanOrEqual(1)
})

test("missing and incompatible indexes fail with recovery advice without creating or rebuilding them", async () => {
  index.query("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run()
  const before = readFileSync(files[0]!)
  expect((await get("/api/threads")).body.error).toContain("Run agentchats index")
  expect(readFileSync(files[0]!)).toEqual(before)
  rmSync(files[0]!)
  expect((await get("/api/threads")).body.error).toContain("Session index not found")
  expect(existsSync(files[0]!)).toBe(false)
})

test("empty Codex index is usable even without Codex databases", async () => {
  indexSession("claude", "claude_code")
  rmSync(files[1]!)
  rmSync(files[2]!)
  expect((await get("/api/threads")).body).toEqual({ threads: [] })
})

test("deep links and follow read Codex before a session has been indexed", async () => {
  thread("indexed")
  item(0, "userMessage", { content: [{ text: "Hello" }] })
  item(1, "reasoning", { text: "Hidden" })
  item(2, "commandExecution", { command: "pwd", aggregatedOutput: "x".repeat(50_000), status: "completed" })
  item(3, "fileChange", { changes: [{ path: "app.ts", kind: { type: "update" }, diff: "x".repeat(200_001) }] })
  history.query("INSERT INTO thread_turns VALUES ('indexed', 0, 'completed')").run()
  const before = files.map((file) => readFileSync(file))
  const messages = await get("/api/threads/indexed?detail=messages")
  expect(messages.response.status).toBe(200)
  expect(messages.body.items.map((record: any) => record.rolloutOrdinal)).toEqual([0])
  expect(messages.body.latestOrdinal).toBe(3)
  expect(messages.body.turnStatus).toBe("completed")
  const full = (await get("/api/threads/indexed?detail=full")).body
  expect(full.items.map((record: any) => record.itemType)).toEqual(["userMessage", "commandExecution", "fileChange"])
  expect(full.items[1].item.output).toBe("x".repeat(50_000))
  expect(full.items[2].item.changes[0].diff).toBe("x".repeat(200_001))
  expect(full.items[2].item.changes[0].diffTruncated).toBe(false)
  expect(files.map((file) => readFileSync(file))).toEqual(before)
  expect((await get("/api/threads/indexed/items?after_ordinal=-1")).body.items).toHaveLength(1)
  item(4, "agentMessage", { text: "New committed reply" })
  const update = (await get("/api/threads/indexed/items?after_ordinal=3")).body
  expect(update.items.map((record: any) => record.rolloutOrdinal)).toEqual([4])
  expect(update.latestOrdinal).toBe(4)
  expect((await get("/api/threads/indexed/items?after_ordinal=4")).body.items).toEqual([])
})

test("full tool payloads survive committed storage, HTTP, and the shared Codex source on load and poll", async () => {
  thread("indexed")
  const command = `  cat <<'END'\n${"command body\n".repeat(1_100)}COMMAND_TAIL\nEND\n`
  const cwd = `/workspace/${"nested/".repeat(300)}CWD_TAIL`
  const output = `  ${"output line\n".repeat(4_000)}OUTPUT_TAIL\n\n`
  const args = { prompt: "argument ".repeat(5_001) + "ARGUMENT_TAIL", enabled: false, count: 0 }
  const result = { content: [{ type: "text", text: "result ".repeat(6_000) + "RESULT_TAIL" }], structuredContent: { ok: true } }
  const error = { message: "failure ".repeat(5_001) + "ERROR_TAIL" }
  const query = `  ${"long search query ".repeat(30)}QUERY_TAIL\n`
  const action = { type: "search", queries: [query, "secondary ".repeat(4_001) + "ACTION_TAIL"] }
  const results = [{ url: "https://example.test", snippet: "snippet ".repeat(5_001) + "SEARCH_RESULT_TAIL" }]
  item(0, "commandExecution", { command, cwd, aggregatedOutput: output, status: "completed", exitCode: 0 })
  item(1, "mcpToolCall", { server: "fixtures", tool: "inspect", arguments: args, result, error, status: "failed" })
  item(2, "webSearch", { query, action, results })
  item(3, "webSearch", { query })
  item(4, "mcpToolCall", { server: "fixtures", tool: "empty", arguments: {}, result: null, error: null })

  const source = createCodexTranscriptSource({ baseUrl: `${base}/api` })
  const options = { id: "indexed", detail: "full" as const, signal: new AbortController().signal }
  const loaded = await source.load(options)
  const polled = await source.poll({ ...options, cursor: "-1" })
  for (const snapshot of [loaded, polled]) {
    const tools = snapshot.messages.map((message) => message.toolActivity!)
    expect(tools[0]!.detail).toBe(command)
    expect(tools[0]!.sections).toEqual([
      { label: "Command", content: command },
      { label: "Working directory", content: cwd },
      { label: "Output", content: output },
    ])
    expect(tools[1]!.state).toBe("error")
    expect(tools[1]!.sections).toEqual([
      { label: "Tool", content: "fixtures.inspect" },
      { label: "Arguments", content: JSON.stringify(args, null, 2) },
      { label: "Result", content: JSON.stringify(result, null, 2) },
      { label: "Error", content: JSON.stringify(error, null, 2) },
    ])
    expect(tools[2]!.detail).toBe(query)
    expect(tools[2]!.sections).toEqual([
      { label: "Query", content: query },
      { label: "Action", content: JSON.stringify(action, null, 2) },
      { label: "Results", content: JSON.stringify(results, null, 2) },
    ])
    expect(tools[3]!.sections).toEqual([{ label: "Query", content: query }])
    expect(tools[4]!.sections).toEqual([
      { label: "Tool", content: "fixtures.empty" },
      { label: "Arguments", content: "{}" },
    ])
  }
})

test("missing or archived threads return 404, including polling and bound hostile IDs", async () => {
  thread("archived", 1)
  for (const id of ["missing", "archived", "' OR 1=1 --"]) {
    for (const suffix of ["", "/items"]) {
      expect((await get(`/api/threads/${encodeURIComponent(id)}${suffix}`)).response.status).toBe(404)
    }
  }
})

test("API is local-origin, read-only, and non-cacheable", async () => {
  expect((await get("/api/threads", { method: "POST" })).response.status).toBe(405)
  for (const headers of [
    { Origin: "https://example.com" },
    { Host: "attacker.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    expect((await get("/api/threads", { headers })).response.status).toBe(403)
  }
  const { response } = await get("/api/threads", { headers: { Origin: base } })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})


test("the exact HTTPS portless origin is accepted, without trusting arbitrary forwarded hosts", async () => {
  const headers = { Host: "agentchats.localhost", Origin: "https://agentchats.localhost", "X-Forwarded-Proto": "https" }
  expect((await get("/api/threads", { headers })).response.status).toBe(403)
  readerEnv.PORTLESS_URL = "https://agentchats.localhost"
  expect((await get("/api/threads", { headers })).response.status).toBe(200)
  expect((await get("/api/threads", { headers: { ...headers, Host: "agentchats.localhost:443" } })).response.status).toBe(200)
  for (const override of [
    { Host: "another.localhost" },
    { Origin: "https://another.localhost" },
    { Origin: "http://agentchats.localhost" },
    { "X-Forwarded-Proto": "http" },
    { "Sec-Fetch-Site": "cross-site" },
    { Host: "attacker.example", "X-Forwarded-Host": "agentchats.localhost" },
  ] as Record<string, string>[]) {
    expect((await get("/api/threads", { headers: { ...headers, ...override } })).response.status).toBe(403)
  }
})
