// agentchats view — entry point. Resolve a session file (positional path, or
// newest in a workspace via cass), normalize it into the store, follow it
// live, and render the transcript.
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { createSignal } from "solid-js"
import { render } from "@opentui/solid"
import { getTreeSitterClient, addDefaultParsers } from "@opentui/core"
import { App } from "./app"
import { paths } from "./config"
import { discoverSessions } from "./discover"
import { createNormalizer, detectFormat, sessionIDFor } from "./normalize/index"
import { setSessionStatus, upsertMessage, upsertPart, upsertSession } from "./store"
import { tailFile } from "./tail"
import parsers from "./vendor/parsers-config"

function usage(): never {
  console.error(`Usage: agentchats view [<session.jsonl>] [--workspace <dir>] [--current]

Open a coding-agent session transcript — Claude Code, Codex, or Pi — and
follow it live. With no arguments, the newest session for the current git
project opens. Actions live in the ctrl+k palette.`)
  process.exit(64)
}

function callerCwd(): string {
  return process.env.AGENTCHATS_CALLER_PWD || process.cwd()
}

function gitRoot(from: string): string {
  try {
    return execFileSync("git", ["-C", from, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return from
  }
}

function resolveSessionPath(): string {
  const args = process.argv.slice(2)
  let workspace: string | undefined
  let positional: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--workspace") {
      workspace = args[++index]
      if (!workspace) usage()
    } else if (arg === "--current") {
      workspace = undefined
    } else if (arg === "-h" || arg === "--help") {
      usage()
    } else if (!arg.startsWith("-")) {
      positional = arg
    } else {
      usage()
    }
  }
  if (positional) {
    const resolved = path.isAbsolute(positional) ? positional : path.resolve(callerCwd(), positional)
    if (!existsSync(resolved)) {
      console.error(`agentchats view: no such session file: ${resolved}`)
      process.exit(1)
    }
    return resolved
  }
  const scope = workspace ? path.resolve(callerCwd(), workspace) : gitRoot(callerCwd())
  let sessions
  try {
    sessions = discoverSessions(scope)
  } catch (error) {
    console.error(`agentchats view: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  if (sessions.length === 0) {
    console.error(`agentchats view: no sessions recorded for ${scope}`)
    process.exit(1)
  }
  return sessions[0].path
}

const sessionPath = resolveSessionPath()
const format = detectFormat(sessionPath, undefined)
if (!format) {
  console.error(`agentchats view: unrecognized session format: ${sessionPath}`)
  process.exit(1)
}
const sessionID = sessionIDFor(sessionPath)

addDefaultParsers(parsers.parsers)
for (const filetype of ["markdown", "typescript", "javascript"]) {
  void getTreeSitterClient().preloadParser(filetype)
}

const [gone, setGone] = createSignal(false)

const normalizer = createNormalizer(format, sessionID, {
  session(session) {
    paths.directory = session.directory
    upsertSession(session)
  },
  message: upsertMessage,
  part: upsertPart,
})

let initialLoadDone = false
void tailFile({
  path: sessionPath,
  live: true,
  onLine(line) {
    try {
      normalizer.push(JSON.parse(line))
    } catch {
      // A malformed line is the harness's problem, not a reason to die.
    }
  },
  onBatch() {
    initialLoadDone = true
    setSessionStatus(sessionID, normalizer.busy() ? { type: "busy" } : { type: "idle" })
  },
  onGone() {
    if (initialLoadDone) setGone(true)
  },
})

function quit() {
  process.exit(0)
}

await render(() => <App sessionID={sessionID} live={true} gone={gone} onQuit={quit} />, {
  targetFps: 30,
  exitOnCtrlC: true,
})
