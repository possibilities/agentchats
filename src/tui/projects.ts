import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One local project offered by the search scope picker. */
export interface ProjectChoice {
  path: string;
  display: string;
}

export const DEFAULT_PROJECT_ROOTS = ["~/code", "~/src"] as const;

export function projectDisplayPath(path: string, home: string): string {
  if (path === home) return "~";
  return home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The AgentLaunch project rule: offer each configured root and its immediate
 * directories, including directory symlinks. Missing roots are harmless.
 * This is a bounded filesystem scan, independent of transcript volume.
 */
export function scanProjectPaths(roots: readonly string[], home: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const base = expandTilde(root, home);
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    if (!seen.has(base)) {
      seen.add(base);
      paths.push(base);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(base, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(path).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!isDirectory || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/** The opening project leads; the scanned roots and children follow. */
export function discoverProjectChoices(
  currentProject: string,
  home: string,
  roots: readonly string[] = DEFAULT_PROJECT_ROOTS,
): ProjectChoice[] {
  const paths = [currentProject];
  const seen = new Set(paths);
  for (const path of scanProjectPaths(roots, home)) {
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths.map((path) => ({ path, display: projectDisplayPath(path, home) }));
}
