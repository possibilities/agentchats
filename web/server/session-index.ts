import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

import { indexPath, type Environ } from "../../src/store/paths.ts"
import { sessions } from "../../src/store/query.ts"
import { SCHEMA_VERSION, storedSchemaVersion } from "../../src/store/schema.ts"

/** Discovery shares the CLI's query layer, without its write-capable opener.
 * The reader never creates, migrates, refreshes, or prunes the session index. */
export function indexedCodexSessions(limit: number, env: Environ) {
  const file = indexPath(env)
  if (!existsSync(file)) {
    throw new Error("Session index not found. Run agentchats index, then refresh sessions.")
  }
  const database = new Database(file, { readonly: true })
  try {
    database.exec("PRAGMA query_only = ON")
    if (storedSchemaVersion(database) !== SCHEMA_VERSION) {
      throw new Error("Session index needs rebuilding. Run agentchats index, then refresh sessions.")
    }
    return sessions(database, { agent: "codex", resumableOnly: true, limit })
  } finally {
    database.close()
  }
}
