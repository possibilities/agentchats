// Session discovery through cass (`cass sessions --json`), scoped and deduped
// the same way bin/agentchats state does: strict workspace match, collapse
// duplicate index rows by path, newest first. cass is the discovery surface;
// the files themselves are the fidelity surface.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

export type DiscoveredSession = {
  path: string
  agent: string
  workspace: string
  title: string
  modified: string
}

function cassBin(): string | undefined {
  const home = os.homedir()
  const candidates = [path.join(home, ".local/bin/cass")]
  try {
    const found = execFileSync("/usr/bin/which", ["cass"], { encoding: "utf8" }).trim()
    if (found) candidates.unshift(found)
  } catch {}
  return candidates.find((candidate) => existsSync(candidate))
}

export function discoverSessions(workspace: string, limit = 10): DiscoveredSession[] {
  const cass = cassBin()
  if (!cass) throw new Error("cass is not installed; run: ~/code/agentchats/scripts/install.sh --install")
  let raw: string
  try {
    raw = execFileSync(cass, ["sessions", "--workspace", workspace, "--limit", String(limit), "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    throw new Error("the session index cannot serve; run: cass triage --json")
  }
  const parsed = JSON.parse(raw) as { sessions?: Array<Record<string, unknown>> }
  const rows = (parsed.sessions ?? [])
    .filter((row) => row.workspace === workspace)
    .map((row) => ({
      path: String(row.path ?? ""),
      agent: String(row.agent ?? ""),
      workspace: String(row.workspace ?? ""),
      title: String(row.title ?? ""),
      modified: String(row.modified ?? ""),
    }))
    .filter((row) => row.path)
  const byPath = new Map<string, DiscoveredSession>()
  for (const row of rows) {
    const existing = byPath.get(row.path)
    if (!existing || existing.modified < row.modified) byPath.set(row.path, row)
  }
  return [...byPath.values()].sort((a, b) => (a.modified < b.modified ? 1 : -1))
}
