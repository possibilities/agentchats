import { sessionsArgs, type CassRunner } from "./cass.ts";

/** One indexed project offered by the search scope picker. */
export interface ProjectChoice {
  path: string;
  display: string;
}

export type ProjectChoicesResult =
  | { ok: true; projects: ProjectChoice[] }
  | { ok: false; error: string };

export function projectDisplayPath(path: string, home: string): string {
  if (path === home) return "~";
  return home !== "" && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Cass returns sessions newest first. Keep the first occurrence of each
 * workspace so the project list follows recent activity, while always
 * leading with the project the picker opened on.
 */
export function parseProjectChoices(
  stdout: string,
  currentProject: string,
  home: string,
): ProjectChoice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = {};
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  const paths = [currentProject];
  const seen = new Set(paths);
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      const workspace = (session as Record<string, unknown>)["workspace"];
      if (typeof workspace !== "string" || workspace === "" || seen.has(workspace)) continue;
      seen.add(workspace);
      paths.push(workspace);
    }
  }
  return paths.map((path) => ({ path, display: projectDisplayPath(path, home) }));
}

/** `sessions --limit 0` is cass's complete recent-session listing. */
export async function loadProjectChoices(
  runner: CassRunner,
  currentProject: string,
  home: string,
): Promise<ProjectChoicesResult> {
  const result = await runner(sessionsArgs(null, 0));
  return result.ok
    ? { ok: true, projects: parseProjectChoices(result.stdout, currentProject, home) }
    : result;
}
