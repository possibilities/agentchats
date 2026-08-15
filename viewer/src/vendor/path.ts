// Vendored from opencode @ 4643e65ad6 — util/path.ts plus abbreviateHome from runtime.tsx.
import { realpathSync } from "node:fs"
import path, { win32 } from "node:path"

export function normalizePath(input: string, platform: string) {
  if (platform !== "win32") return input
  const resolved = win32.normalize(win32.resolve(input.replaceAll("/", "\\")))
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const relative = path.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return input
  return "~" + path.sep + relative
}

export function formatPath(input: string | undefined, base: string, home: string) {
  if (typeof input !== "string" || !input) return ""
  const absolute = path.isAbsolute(input) ? input : path.resolve(base, input)
  const relative = path.relative(base, absolute)
  if (!relative) return "."
  if (relative !== ".." && !relative.startsWith(".." + path.sep)) return relative
  return abbreviateHome(absolute, home)
}
