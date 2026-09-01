import { isAbsolute, join } from "node:path";

/** A preserved copy of a transcript store, indexed alongside the live one.
 * Opt-in: this machine's Claude archive holds tens of thousands of sessions
 * the harness has long since pruned, and indexing them costs gigabytes, so
 * the operator decides rather than discovering it. */
export interface ArchiveRoot {
  path: string;
  agent: "claude_code" | "codex";
}

export interface AgentchatsConfig {
  auxiliaryCodexOriginators: ReadonlySet<string>;
  archives: readonly ArchiveRoot[];
}

const EMPTY_CONFIG: AgentchatsConfig = {
  auxiliaryCodexOriginators: new Set<string>(),
  archives: [],
};

export function agentchatsConfigPath(
  env: Record<string, string | undefined>,
): string {
  const configured = env["XDG_CONFIG_HOME"];
  if (configured !== undefined && configured !== "" && isAbsolute(configured)) {
    return join(configured, "agentchats", "config.json");
  }
  const home = env["HOME"];
  if (home === undefined || home === "") {
    throw new Error("HOME is unset; cannot resolve the Agentchats config path");
  }
  return join(home, ".config", "agentchats", "config.json");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown key "${unknown[0]}"`);
}

export function decodeAgentchatsConfig(value: unknown): AgentchatsConfig {
  const root = object(value, "config");
  onlyKeys(root, ["auxiliary", "archives"], "config");

  const archives: ArchiveRoot[] = [];
  const rawArchives = root["archives"];
  if (rawArchives !== undefined) {
    if (!Array.isArray(rawArchives)) throw new Error("config.archives must be an array");
    rawArchives.forEach((value, index) => {
      const entry = object(value, `config.archives[${index}]`);
      onlyKeys(entry, ["path", "agent"], `config.archives[${index}]`);
      const path = entry["path"];
      const agent = entry["agent"];
      if (typeof path !== "string" || !isAbsolute(path)) {
        throw new Error(`config.archives[${index}].path must be an absolute path`);
      }
      if (agent !== "claude_code" && agent !== "codex") {
        throw new Error(`config.archives[${index}].agent must be claude_code or codex`);
      }
      archives.push({ path, agent });
    });
  }

  if (root["auxiliary"] === undefined) return { ...EMPTY_CONFIG, archives };

  const auxiliary = object(root["auxiliary"], "config.auxiliary");
  onlyKeys(auxiliary, ["codex-originators"], "config.auxiliary");
  const rawOriginators = auxiliary["codex-originators"];
  if (rawOriginators === undefined) return { ...EMPTY_CONFIG, archives };
  if (!Array.isArray(rawOriginators)) {
    throw new Error("config.auxiliary.codex-originators must be an array of strings");
  }
  const originators = new Set<string>();
  rawOriginators.forEach((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`config.auxiliary.codex-originators[${index}] must be a non-empty string`);
    }
    originators.add(value.trim());
  });
  return { auxiliaryCodexOriginators: originators, archives };
}

export async function loadAgentchatsConfig(
  env: Record<string, string | undefined>,
): Promise<AgentchatsConfig> {
  const path = agentchatsConfigPath(env);
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_CONFIG;
  let value: unknown;
  try {
    value = await file.json();
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    return decodeAgentchatsConfig(value);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
