/**
 * Where the session index lives. It is derived state over the live
 * transcript stores — every row is recomputed from a file on disk — so it
 * belongs in XDG *state*, the directory whose contract is "losing this
 * costs time, not data". `AGENTCHATS_INDEX` overrides for tests and for the
 * operator who keeps the database on another volume.
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Environ = Record<string, string | undefined>;

/** The path that means "open a throwaway database in RAM"; SQLite's own
 * spelling, honored here so tests and dry runs never touch the disk. */
export const MEMORY_INDEX = ":memory:";

/** Relative XDG overrides are ignored per the basedir spec, not honored badly. */
function xdgBase(env: Environ, name: string, home: string, fallback: string[]): string {
  const value = env[name];
  return value !== undefined && isAbsolute(value) ? value : join(home, ...fallback);
}

export function stateDirectory(env: Environ, home: string): string {
  return join(xdgBase(env, "XDG_STATE_HOME", home, [".local", "state"]), "agentchats");
}

/**
 * The database path, in precedence order: the explicit override, the XDG
 * state directory, the spec's default. The override is resolved against the
 * working directory so a relative value still names one fixed file no
 * matter which directory the CLI is invoked from.
 */
export function indexPath(env: Environ): string {
  const override = env["AGENTCHATS_INDEX"];
  if (override !== undefined && override.trim() !== "") {
    const value = override.trim();
    if (value === MEMORY_INDEX) return value;
    const home = env["HOME"];
    const expanded =
      home !== undefined && home !== "" && (value === "~" || value.startsWith("~/"))
        ? join(home, value.slice(1))
        : value;
    return resolve(expanded);
  }
  const home = env["HOME"];
  if (home === undefined || home === "") {
    throw new Error("HOME is unset; cannot resolve the Agentchats index path");
  }
  return join(stateDirectory(env, home), "index.db");
}

/** Created on demand and kept private: the transcripts are the operator's,
 * and so is every excerpt of them this index holds. */
export function ensureIndexDirectory(path: string): void {
  if (path === MEMORY_INDEX || path === "") return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}
