/**
 * The index schema, and the one rule that governs it: this database is a
 * cache. Every column is recomputed from a transcript file that is still on
 * disk, so a database written by a different schema version is deleted and
 * rebuilt rather than migrated. Losing it costs one reindex — far cheaper
 * than carrying migration code, and forever cheaper than a half-migrated
 * index that lies about what the sessions said.
 *
 * Both FTS tables are external-content: FTS5 keeps only the inverted index
 * and reads the text back through the base table, which halves the space a
 * 500 MB corpus costs. The price is that FTS5 cannot see writes to the
 * content table on its own, so the six triggers below are load-bearing, not
 * boilerplate — without them the index silently drifts. Cascade deletes
 * from `sessions` do fire the delete trigger (verified against SQLite
 * 3.51.0), which is what lets ingest replace a session with one DELETE.
 *
 * `sessions_fts` indexes metadata, not conversation: a session's title, the
 * workspace it ran in, and the path of the transcript itself. That is what
 * makes file archaeology work — "which sessions touched agentbrowse?"
 * answers from the workspace and the filename even when no message body
 * ever spells the word. Replaying real historical queries against a
 * body-only index lost 110 documents to exactly this.
 */

import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { ensureIndexDirectory, MEMORY_INDEX } from "./paths.ts";

/** 2 adds `sessions_fts`. An index written by version 1 has no metadata
 * table to backfill, so it is discarded and rebuilt — which is the whole
 * point of versioning a cache. */
export const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  workspace TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  human_turns INTEGER NOT NULL DEFAULT 0,
  thread_source TEXT,
  originator TEXT,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions (workspace);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_agent ON sessions (agent);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  line INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title,
  workspace,
  source_path,
  content='sessions',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts (rowid, title, workspace, source_path)
  VALUES (new.id, new.title, new.workspace, new.source_path);
END;
CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts (sessions_fts, rowid, title, workspace, source_path)
  VALUES ('delete', old.id, old.title, old.workspace, old.source_path);
END;
CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
  INSERT INTO sessions_fts (sessions_fts, rowid, title, workspace, source_path)
  VALUES ('delete', old.id, old.title, old.workspace, old.source_path);
  INSERT INTO sessions_fts (rowid, title, workspace, source_path)
  VALUES (new.id, new.title, new.workspace, new.source_path);
END;
`;

/**
 * WAL so a `funk` reindex and a live TUI search do not block each other;
 * `synchronous = normal` because a torn write after a crash costs a
 * rebuild, not data; foreign keys on because the cascade from `sessions`
 * to `messages` is how a session is replaced atomically. The busy timeout
 * is what turns "database is locked" during a concurrent index into a short
 * wait instead of an error in the picker.
 */
export function applyPragmas(db: Database): void {
  db.run("PRAGMA journal_mode = wal");
  db.run("PRAGMA synchronous = normal");
  db.run("PRAGMA foreign_keys = on");
  db.run("PRAGMA busy_timeout = 5000");
}

/** Null for a database that has never been written: a fresh file is not a
 * version mismatch, it is an empty index. A non-integer value counts as a
 * mismatch, because whatever wrote it is not this build. */
export function storedSchemaVersion(db: Database): number | null {
  const table = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta' LIMIT 1")
    .get();
  if (table === null) return null;
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  if (row === null) return null;
  const version = Number(row.value);
  return Number.isInteger(version) ? version : Number.NaN;
}

/** Idempotent: every statement is `IF NOT EXISTS`, so calling this on an
 * up-to-date database is a no-op that only restamps the version. */
export function createSchema(db: Database): void {
  db.transaction(() => {
    db.run(SCHEMA_SQL);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  })();
}

/** WAL and shared-memory sidecars go with the database; leaving them behind
 * would let SQLite recover the very pages we meant to discard. */
function discardIndex(path: string): void {
  if (path === MEMORY_INDEX || path === "") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

/**
 * Open the index at `path`, rebuilding from empty when the file on disk was
 * written by another schema version. Callers get a database that is already
 * pragma'd, versioned and ready to write.
 */
export function openIndex(path: string): Database {
  ensureIndexDirectory(path);
  let db = new Database(path, { create: true });
  applyPragmas(db);
  const stored = storedSchemaVersion(db);
  if (stored !== null && stored !== SCHEMA_VERSION) {
    db.close();
    discardIndex(path);
    db = new Database(path, { create: true });
    applyPragmas(db);
  }
  try {
    createSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
