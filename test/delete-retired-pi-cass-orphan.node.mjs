import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { createInterface } from "node:readline";

import {
  CassOrphanDeletionRefusal,
  deleteCass0625OrphanAgent,
} from "../scripts/delete-retired-pi-cass-orphan.mjs";
import {
  expectedRawMirrorRoot,
  retiredConversationIds,
} from "../scripts/retire-pi-raw-mirror.mjs";

const sqlite = "/usr/bin/sqlite3";
const flock = existsSync("/opt/homebrew/bin/flock") ? "/opt/homebrew/bin/flock" : "/usr/bin/flock";
const homes = [];
const keepers = [];

afterEach(async () => {
  for (const { child, exitPromise, lines } of keepers.splice(0)) {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.stdin.end(".quit\n");
    await exitPromise;
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixtureHome() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "agentchats-cass-orphan-"));
  homes.push(home);
  chmodSync(home, 0o700);
  let current = home;
  for (const component of [
    "Library",
    "Application Support",
    "com.coding-agent-search.coding-agent-search",
  ]) {
    current = join(current, component);
    mkdirSync(current, { mode: 0o700 });
    chmodSync(current, 0o700);
  }
  return {
    home,
    database: join(current, "agent_search.db"),
  };
}

function runSqlite(database, sql) {
  const result = spawnSync(sqlite, [database, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeValidatedRetiredManifest(fixture, conversationIds) {
  const normalizedIds = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
  const root = expectedRawMirrorRoot(fixture.home);
  const manifests = join(root, "manifests");
  const blobRoot = join(root, "blobs", "blake3");
  const blobHash = "a".repeat(64);
  const manifestId = `doctor-raw-mirror-manifest-id-v1-${"b".repeat(64)}`;
  const originalPath = join(fixture.home, ".pi", "agent", "sessions", "integration.jsonl");
  mkdirSync(join(root, "v1"), { recursive: true, mode: 0o700 });
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  mkdirSync(join(blobRoot, blobHash.slice(0, 2)), { recursive: true, mode: 0o700 });
  for (const directory of [root, join(root, "v1"), manifests, join(root, "blobs"), blobRoot, join(blobRoot, blobHash.slice(0, 2))]) {
    chmodSync(directory, 0o700);
  }
  const blobPath = join(blobRoot, blobHash.slice(0, 2), `${blobHash}.raw`);
  writeFileSync(blobPath, "x", { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  const manifest = {
    schema_version: 1,
    manifest_kind: "cass_raw_session_mirror_v1",
    manifest_id: manifestId,
    blob_hash_algorithm: "blake3",
    blob_relative_path: `blobs/blake3/${blobHash.slice(0, 2)}/${blobHash}.raw`,
    blob_blake3: blobHash,
    blob_size_bytes: 1,
    provider: "pi_agent",
    source_id: "local",
    origin_kind: "local",
    origin_host: null,
    original_path: originalPath,
    redacted_original_path: "[pi_agent]/integration.jsonl",
    original_path_blake3: "c".repeat(64),
    captured_at_ms: 1,
    source_mtime_ms: 1,
    source_size_bytes: 1,
    compression: { state: "none", algorithm: null, uncompressed_size_bytes: 1 },
    encryption: { state: "none", algorithm: null, key_id: null, envelope_version: null },
    db_links: normalizedIds.map((conversationId) => ({
      conversation_id: conversationId,
      message_count: 1,
      source_path: originalPath,
      started_at_ms: 1,
    })),
    verification: { status: "captured", verifier: "cass_indexer", content_blake3: blobHash, verified_at_ms: 1 },
    manifest_blake3: `doctor-raw-mirror-manifest-v1-${"d".repeat(64)}`,
  };
  const manifestPath = join(manifests, `${manifestId}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return manifestPath;
}

function runInstallerAssertionHarness(home, body) {
  const installerPath = new URL("../scripts/install.sh", import.meta.url).pathname;
  const source = readFileSync(installerPath, "utf8");
  const marker = "\ntrap release_cass_writer_lock_on_exit EXIT\n";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, "installer function boundary must remain discoverable");
  const harnessPath = join(home, "install-retirement-assertions.bash");
  writeFileSync(harnessPath, `${source.slice(0, markerIndex)}\n${body}\n`, { mode: 0o700 });
  chmodSync(harnessPath, 0o700);
  return spawnSync("/bin/bash", [harnessPath], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function archiveSchema() {
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE meta ("key" TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta("key", value) VALUES ('schema_version', '20');
CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')));
INSERT INTO _schema_migrations(version, name) VALUES
  (13, 'full_schema_v13'), (14, 'fts_contentless'),
  (15, 'conversation_tail_state_cache'), (16, 'drop_redundant_message_conv_idx'),
  (17, 'drop_message_created_idx'), (18, 'conversation_tail_state_hot_table'),
  (19, 'conversation_external_lookup'), (20, 'conversation_external_tail_lookup');
CREATE TABLE agents (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, version TEXT, kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE workspaces (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT);
CREATE TABLE sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, host_label TEXT, machine_id TEXT, platform TEXT, config_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO sources(id, kind, created_at, updated_at) VALUES ('local', 'local', 0, 0);
CREATE TABLE conversations (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id), workspace_id INTEGER REFERENCES workspaces(id), source_id TEXT NOT NULL DEFAULT 'local' REFERENCES sources(id), external_id TEXT, title TEXT, source_path TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, approx_tokens INTEGER, metadata_json TEXT, origin_host TEXT, metadata_bin BLOB, total_input_tokens INTEGER, total_output_tokens INTEGER, total_cache_read_tokens INTEGER, total_cache_creation_tokens INTEGER, grand_total_tokens INTEGER, estimated_cost_usd REAL, primary_model TEXT, api_call_count INTEGER, tool_call_count INTEGER, user_message_count INTEGER, assistant_message_count INTEGER, last_message_idx INTEGER, last_message_created_at INTEGER);
CREATE UNIQUE INDEX idx_conversations_provenance ON conversations(source_id, agent_id, external_id);
CREATE INDEX idx_conversations_agent_started ON conversations(agent_id, started_at DESC);
CREATE INDEX idx_conversations_source_id ON conversations(source_id);
CREATE INDEX idx_conversations_source_path ON conversations(source_path);
CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, idx INTEGER NOT NULL, role TEXT NOT NULL, author TEXT, created_at INTEGER, content TEXT NOT NULL, extra_json TEXT, extra_bin BLOB, UNIQUE (conversation_id, idx));
CREATE TABLE snippets (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, file_path TEXT, start_line INTEGER, end_line INTEGER, language TEXT, snippet_text TEXT);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE conversation_tags (conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (conversation_id, tag_id));
CREATE TABLE conversation_tail_state (conversation_id INTEGER PRIMARY KEY, ended_at INTEGER, last_message_idx INTEGER, last_message_created_at INTEGER);
CREATE TABLE conversation_external_lookup (lookup_key TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL);
CREATE TABLE conversation_external_tail_lookup (lookup_key TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL, ended_at INTEGER, last_message_idx INTEGER, last_message_created_at INTEGER);
CREATE TABLE daily_stats (day_id INTEGER NOT NULL, agent_slug TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT 'all', session_count INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, total_chars INTEGER NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL, PRIMARY KEY (day_id, agent_slug, source_id));
CREATE INDEX idx_daily_stats_agent ON daily_stats(agent_slug, day_id);
CREATE INDEX idx_daily_stats_source ON daily_stats(source_id, day_id);
CREATE TABLE embedding_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, db_path TEXT NOT NULL, model_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', total_docs INTEGER NOT NULL DEFAULT 0, completed_docs INTEGER NOT NULL DEFAULT 0, error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT);
CREATE UNIQUE INDEX idx_embedding_jobs_active ON embedding_jobs(db_path, model_id) WHERE status IN ('pending', 'running');
CREATE TABLE token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, conversation_id INTEGER NOT NULL, agent_id INTEGER NOT NULL, workspace_id INTEGER, source_id TEXT NOT NULL DEFAULT 'local', timestamp_ms INTEGER NOT NULL, day_id INTEGER NOT NULL, model_name TEXT, model_family TEXT, model_tier TEXT, service_tier TEXT, provider TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, thinking_tokens INTEGER, total_tokens INTEGER, estimated_cost_usd REAL, role TEXT NOT NULL, content_chars INTEGER NOT NULL, has_tool_calls INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0, data_source TEXT NOT NULL DEFAULT 'api', UNIQUE (message_id));
CREATE INDEX idx_token_usage_day ON token_usage(day_id, agent_id);
CREATE INDEX idx_token_usage_conv ON token_usage(conversation_id);
CREATE INDEX idx_token_usage_model ON token_usage(model_family, day_id);
CREATE INDEX idx_token_usage_workspace ON token_usage(workspace_id, day_id);
CREATE INDEX idx_token_usage_timestamp ON token_usage(timestamp_ms);
CREATE TABLE token_daily_stats (day_id INTEGER NOT NULL, agent_slug TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT 'all', model_family TEXT NOT NULL DEFAULT 'all', api_call_count INTEGER NOT NULL DEFAULT 0, user_message_count INTEGER NOT NULL DEFAULT 0, assistant_message_count INTEGER NOT NULL DEFAULT 0, tool_message_count INTEGER NOT NULL DEFAULT 0, total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0, total_cache_read_tokens INTEGER NOT NULL DEFAULT 0, total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0, total_thinking_tokens INTEGER NOT NULL DEFAULT 0, grand_total_tokens INTEGER NOT NULL DEFAULT 0, total_content_chars INTEGER NOT NULL DEFAULT 0, total_tool_calls INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0.0, session_count INTEGER NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL, PRIMARY KEY (day_id, agent_slug, source_id, model_family));
CREATE INDEX idx_token_daily_stats_agent ON token_daily_stats(agent_slug, day_id);
CREATE INDEX idx_token_daily_stats_model ON token_daily_stats(model_family, day_id);
CREATE TABLE message_metrics (message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, created_at_ms INTEGER NOT NULL, hour_id INTEGER NOT NULL, day_id INTEGER NOT NULL, agent_slug TEXT NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL DEFAULT 'local', role TEXT NOT NULL, content_chars INTEGER NOT NULL, content_tokens_est INTEGER NOT NULL, api_input_tokens INTEGER, api_output_tokens INTEGER, api_cache_read_tokens INTEGER, api_cache_creation_tokens INTEGER, api_thinking_tokens INTEGER, api_service_tier TEXT, api_data_source TEXT NOT NULL DEFAULT 'estimated', tool_call_count INTEGER NOT NULL DEFAULT 0, has_tool_calls INTEGER NOT NULL DEFAULT 0, has_plan INTEGER NOT NULL DEFAULT 0, model_name TEXT, model_family TEXT NOT NULL DEFAULT 'unknown', model_tier TEXT NOT NULL DEFAULT 'unknown', provider TEXT NOT NULL DEFAULT 'unknown');
CREATE INDEX idx_mm_hour ON message_metrics(hour_id);
CREATE INDEX idx_mm_day ON message_metrics(day_id);
CREATE INDEX idx_mm_agent_hour ON message_metrics(agent_slug, hour_id);
CREATE INDEX idx_mm_agent_day ON message_metrics(agent_slug, day_id);
CREATE INDEX idx_mm_workspace_hour ON message_metrics(workspace_id, hour_id);
CREATE INDEX idx_mm_source_hour ON message_metrics(source_id, hour_id);
CREATE INDEX idx_mm_model_family_day ON message_metrics(model_family, day_id);
CREATE INDEX idx_mm_provider_day ON message_metrics(provider, day_id);
CREATE TABLE usage_hourly (hour_id INTEGER NOT NULL, agent_slug TEXT NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL DEFAULT 'local', message_count INTEGER NOT NULL DEFAULT 0, user_message_count INTEGER NOT NULL DEFAULT 0, assistant_message_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0, plan_message_count INTEGER NOT NULL DEFAULT 0, api_coverage_message_count INTEGER NOT NULL DEFAULT 0, content_tokens_est_total INTEGER NOT NULL DEFAULT 0, content_tokens_est_user INTEGER NOT NULL DEFAULT 0, content_tokens_est_assistant INTEGER NOT NULL DEFAULT 0, api_tokens_total INTEGER NOT NULL DEFAULT 0, api_input_tokens_total INTEGER NOT NULL DEFAULT 0, api_output_tokens_total INTEGER NOT NULL DEFAULT 0, api_cache_read_tokens_total INTEGER NOT NULL DEFAULT 0, api_cache_creation_tokens_total INTEGER NOT NULL DEFAULT 0, api_thinking_tokens_total INTEGER NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL DEFAULT 0, plan_content_tokens_est_total INTEGER NOT NULL DEFAULT 0, plan_api_tokens_total INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_id, agent_slug, workspace_id, source_id));
CREATE INDEX idx_uh_agent ON usage_hourly(agent_slug, hour_id);
CREATE INDEX idx_uh_workspace ON usage_hourly(workspace_id, hour_id);
CREATE INDEX idx_uh_source ON usage_hourly(source_id, hour_id);
CREATE TABLE usage_daily (day_id INTEGER NOT NULL, agent_slug TEXT NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL DEFAULT 'local', message_count INTEGER NOT NULL DEFAULT 0, user_message_count INTEGER NOT NULL DEFAULT 0, assistant_message_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0, plan_message_count INTEGER NOT NULL DEFAULT 0, api_coverage_message_count INTEGER NOT NULL DEFAULT 0, content_tokens_est_total INTEGER NOT NULL DEFAULT 0, content_tokens_est_user INTEGER NOT NULL DEFAULT 0, content_tokens_est_assistant INTEGER NOT NULL DEFAULT 0, api_tokens_total INTEGER NOT NULL DEFAULT 0, api_input_tokens_total INTEGER NOT NULL DEFAULT 0, api_output_tokens_total INTEGER NOT NULL DEFAULT 0, api_cache_read_tokens_total INTEGER NOT NULL DEFAULT 0, api_cache_creation_tokens_total INTEGER NOT NULL DEFAULT 0, api_thinking_tokens_total INTEGER NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL DEFAULT 0, plan_content_tokens_est_total INTEGER NOT NULL DEFAULT 0, plan_api_tokens_total INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day_id, agent_slug, workspace_id, source_id));
CREATE INDEX idx_ud_agent ON usage_daily(agent_slug, day_id);
CREATE INDEX idx_ud_workspace ON usage_daily(workspace_id, day_id);
CREATE INDEX idx_ud_source ON usage_daily(source_id, day_id);
CREATE TABLE usage_models_daily (day_id INTEGER NOT NULL, agent_slug TEXT NOT NULL, workspace_id INTEGER NOT NULL DEFAULT 0, source_id TEXT NOT NULL DEFAULT 'local', model_family TEXT NOT NULL DEFAULT 'unknown', model_tier TEXT NOT NULL DEFAULT 'unknown', message_count INTEGER NOT NULL DEFAULT 0, user_message_count INTEGER NOT NULL DEFAULT 0, assistant_message_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0, plan_message_count INTEGER NOT NULL DEFAULT 0, api_coverage_message_count INTEGER NOT NULL DEFAULT 0, content_tokens_est_total INTEGER NOT NULL DEFAULT 0, content_tokens_est_user INTEGER NOT NULL DEFAULT 0, content_tokens_est_assistant INTEGER NOT NULL DEFAULT 0, api_tokens_total INTEGER NOT NULL DEFAULT 0, api_input_tokens_total INTEGER NOT NULL DEFAULT 0, api_output_tokens_total INTEGER NOT NULL DEFAULT 0, api_cache_read_tokens_total INTEGER NOT NULL DEFAULT 0, api_cache_creation_tokens_total INTEGER NOT NULL DEFAULT 0, api_thinking_tokens_total INTEGER NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day_id, agent_slug, workspace_id, source_id, model_family, model_tier));
CREATE INDEX idx_umd_model_day ON usage_models_daily(model_family, day_id);
CREATE INDEX idx_umd_agent_day ON usage_models_daily(agent_slug, day_id);
CREATE INDEX idx_umd_workspace_day ON usage_models_daily(workspace_id, day_id);
CREATE INDEX idx_umd_source_day ON usage_models_daily(source_id, day_id);
INSERT INTO agents(slug, name, kind, created_at, updated_at) VALUES ('pi_agent', 'Pi', 'local', 0, 0);
`;
}

function createArchive(database) {
  runSqlite(database, archiveSchema());
  chmodSync(database, 0o600);
}

function fakeCassBin(home, version = "cass 0.6.25") {
  const cassBin = join(home, `cass-${version.replaceAll(/[^a-zA-Z0-9.-]/g, "-")}`);
  writeFileSync(
    cassBin,
    `#!/bin/sh
[ "$PWD" = / ] || { printf 'foreign cwd\n' >&2; exit 65; }
[ "$HOME" = '${home}' ] || { printf 'foreign HOME\n' >&2; exit 65; }
[ -z "\${XDG_DATA_HOME+x}\${XDG_CONFIG_HOME+x}\${CASS_DATA_DIR+x}\${CASS_DB_PATH+x}\${CASS_IGNORE_SOURCES_CONFIG+x}\${CASS_EXCLUDE_PATHS+x}\${CASS_DAEMON_SOCKET+x}\${PI_CODING_AGENT_DIR+x}\${PI_SESSIONS_DIR+x}\${CODEX_HOME+x}" ] || { printf 'unsanitized environment\n' >&2; exit 65; }
if { true >&9; } 2>/dev/null; then printf 'inherited fd9\n' >&2; exit 65; fi
[ "$1" = --version ] || exit 64
printf '%s\\n' '${version}'
`,
    { mode: 0o700 },
  );
  chmodSync(cassBin, 0o700);
  return cassBin;
}

async function withCassAuthority(fixture, cassBin, operation) {
  const lockPath = join(dirname(fixture.database), "index-run.lock");
  const lockFd = openSync(lockPath, "a", 0o600);
  chmodSync(lockPath, 0o600);
  const acquired = spawnSync(flock, ["-x", "3"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", lockFd],
  });
  assert.equal(acquired.status, 0, acquired.stderr || acquired.stdout);
  const previousLockFd = process.env.AGENTCHATS_RETIREMENT_LOCK_FD;
  process.env.AGENTCHATS_RETIREMENT_LOCK_FD = String(lockFd);
  try {
    return await operation({ cassBin, flockBin: flock });
  } finally {
    if (previousLockFd === undefined) delete process.env.AGENTCHATS_RETIREMENT_LOCK_FD;
    else process.env.AGENTCHATS_RETIREMENT_LOCK_FD = previousLockFd;
    closeSync(lockFd);
  }
}

async function authorizedDelete(fixture, options = {}) {
  const { cassBin = fakeCassBin(fixture.home), ...rest } = options;
  return withCassAuthority(fixture, cassBin, ({ flockBin }) =>
    deleteCass0625OrphanAgent({
      home: fixture.home,
      databasePath: fixture.database,
      cassBin,
      flockBin,
      ...rest,
    }),
  );
}

async function createWalArchive(database) {
  const child = spawn(sqlite, ["-batch", database], { stdio: ["pipe", "pipe", "pipe"] });
  const exitPromise = once(child, "exit");
  child.stdout.setEncoding("utf8");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(
    `${[
      ".bail on",
      "PRAGMA journal_mode = WAL;",
      archiveSchema(),
      "PRAGMA wal_checkpoint(TRUNCATE);",
      ".print __archive_ready__",
    ].join("\n")}\n`,
  );
  for (;;) {
    const line = await iterator.next();
    assert.equal(line.done, false, "SQLite keeper exited before fixture publication");
    if (line.value === "__archive_ready__") break;
  }
  chmodSync(database, 0o600);
  keepers.push({ child, exitPromise, lines });
}

function retiredRows(database) {
  return Number(runSqlite(database, "SELECT COUNT(*) FROM agents WHERE slug = 'pi_agent';"));
}

function expectedReceipt(deleted = 1) {
  return {
    schema_version: 20,
    deleted,
    agents: 0,
    conversations: 0,
    snippets: 0,
    conversation_tags: 0,
    conversation_tail_state: 0,
    conversation_external_lookup: 0,
    conversation_external_tail_lookup: 0,
    daily_stats: 0,
    token_daily_stats: 0,
    message_metrics: 0,
    usage_hourly: 0,
    usage_daily: 0,
    usage_models_daily: 0,
    token_usage: 0,
    active_embedding_jobs: 0,
    foreign_key_violations: 0,
    referential_inconsistencies: 0,
    quick_check: "ok",
  };
}

function swapInForeignDatabase(fixture) {
  const original = join(fixture.home, "opened-original.db");
  renameSync(fixture.database, original);
  createArchive(fixture.database);
  return original;
}

for (const variable of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "CASS_DATA_DIR",
  "CASS_DB_PATH",
  "CASS_HOME",
  "CASS_IGNORE_SOURCES_CONFIG",
  "CASS_EXCLUDE_PATH",
  "CASS_EXCLUDE_PATHS",
  "CASS_DAEMON_SOCKET",
  "CASS_AIDER_DATA_ROOT",
  "CASS_ANTIGRAVITY_DATA_ROOT",
  "CASS_CURSOR_PROJECTS_ROOT",
  "CASS_OPENHANDS_DATA_ROOT",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_HOME",
  "CODEX_HOME",
  "GEMINI_HOME",
  "GOOSE_PATH_ROOT",
  "GROK_HOME",
  "HERMES_HOME",
  "KIMI_CODE_HOME",
  "OPENCODE_STORAGE_ROOT",
  "PI_CODING_AGENT_DIR",
  "PI_SESSIONS_DIR",
]) {
  test(`${variable} refuses a split retirement boundary before inspection`, () => {
    const installer = new URL("../scripts/install.sh", import.meta.url).pathname;
    const result = spawnSync(installer, ["--check"], {
      encoding: "utf8",
      env: { ...process.env, [variable]: "/private/tmp/foreign-cass-boundary" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${variable} would override`));
  });
}

test("one nofollow SQLite connection deletes the exact orphan and reopens cleanly", async () => {
  const fixture = fixtureHome();
  await createWalArchive(fixture.database);
  writeFileSync(join(fixture.home, ".sqliterc"), ".quit\n", { mode: 0o600 });

  assert.deepEqual(
    await authorizedDelete(fixture),
    expectedReceipt(),
  );
  assert.equal(retiredRows(fixture.database), 0);
  assert.equal(runSqlite(fixture.database, "PRAGMA integrity_check;"), "ok");
  assert.deepEqual(
    await authorizedDelete(fixture, { mode: "proof" }),
    expectedReceipt(0),
  );
});

test("a global trigger is refused before destructive SQL", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    "CREATE TRIGGER foreign_trigger AFTER DELETE ON agents BEGIN SELECT 1; END;",
  );
  await assert.rejects(authorizedDelete(fixture), /contains a trigger/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("a global view is refused before destructive SQL", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(fixture.database, "CREATE VIEW foreign_view AS SELECT * FROM agents;");
  await assert.rejects(authorizedDelete(fixture), /contains a view/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("a critical table_xinfo change is refused", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(fixture.database, "ALTER TABLE agents ADD COLUMN foreign_column TEXT;");
  await assert.rejects(authorizedDelete(fixture), /table_xinfo mismatch: agents/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("meta and migration history must agree on exact schema v20", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(fixture.database, "DELETE FROM _schema_migrations WHERE version = 19;");
  await assert.rejects(authorizedDelete(fixture), /_schema_migrations is inconsistent/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("an added retirement-reference surface is refused", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    "CREATE TABLE foreign_retirement_cache (id INTEGER PRIMARY KEY, agent_slug TEXT);",
  );
  await assert.rejects(authorizedDelete(fixture), /unexpected retirement-reference surface/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("a missing critical index is refused", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(fixture.database, "DROP INDEX idx_daily_stats_agent;");
  await assert.rejects(authorizedDelete(fixture), /index schema mismatch: daily_stats/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("a changed partial-index predicate is refused", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    `DROP INDEX idx_embedding_jobs_active;
     CREATE UNIQUE INDEX idx_embedding_jobs_active
       ON embedding_jobs(db_path, model_id) WHERE status = 'pending';`,
  );
  await assert.rejects(
    authorizedDelete(fixture),
    /index definition mismatch: idx_embedding_jobs_active/,
  );
  assert.equal(retiredRows(fixture.database), 1);
});

test("a changed critical foreign key is refused", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    `PRAGMA writable_schema = ON;
     UPDATE sqlite_schema
        SET sql = replace(sql, ' PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE', ' PRIMARY KEY')
      WHERE type = 'table' AND name = 'message_metrics';
     PRAGMA writable_schema = OFF;
     PRAGMA schema_version = 999;`,
  );
  await assert.rejects(authorizedDelete(fixture), /foreign-key schema mismatch: message_metrics/);
  assert.equal(retiredRows(fixture.database), 1);
});

test("a foreign-key violation is refused before orphan deletion", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    `INSERT INTO agents(slug, name, kind, created_at, updated_at) VALUES ('active', 'Active', 'local', 0, 0);
     INSERT INTO conversations(agent_id, source_id, source_path)
       SELECT id, 'missing-source', '/active' FROM agents WHERE slug = 'active';`,
  );
  await assert.rejects(authorizedDelete(fixture), /foreign-key violations/);
  assert.equal(retiredRows(fixture.database), 1);
});

const implicitReferenceFixtures = [
  ["snippets", "INSERT INTO snippets(id, message_id) VALUES (1, 999);"],
  ["conversation_tags", "INSERT INTO tags(id, name) VALUES (1, 'foreign'); INSERT INTO conversation_tags(conversation_id, tag_id) VALUES (999, 1);"],
  ["conversation_tail_state", "INSERT INTO conversation_tail_state(conversation_id) VALUES (999);"],
  ["conversation_external_lookup", "INSERT INTO conversation_external_lookup(lookup_key, conversation_id) VALUES ('foreign', 999);"],
  ["conversation_external_tail_lookup", "INSERT INTO conversation_external_tail_lookup(lookup_key, conversation_id) VALUES ('foreign', 999);"],
];

for (const [table, sql] of implicitReferenceFixtures) {
  test(`a dangling ${table} row is refused before orphan deletion`, async () => {
    const fixture = fixtureHome();
    createArchive(fixture.database);
    runSqlite(fixture.database, `PRAGMA foreign_keys = OFF; ${sql}`);
    await assert.rejects(authorizedDelete(fixture), /referential inconsistencies|foreign-key violations/);
    assert.equal(retiredRows(fixture.database), 1);
  });
}

test("cleanup removes only an explicitly proven retired tail-cache row", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(fixture.database, "PRAGMA foreign_keys = OFF; INSERT INTO conversation_tail_state(conversation_id) VALUES (999);");
  assert.deepEqual(
    await authorizedDelete(fixture, {
      mode: "cleanup",
      retiredConversationIds: [999],
    }),
    expectedReceipt(1),
  );
  assert.equal(retiredRows(fixture.database), 0);
  assert.equal(runSqlite(fixture.database, "SELECT COUNT(*) FROM conversation_tail_state;"), "0");
});

test("cleanup removes the exact twelve live raw-proven orphan tail rows and preserves provenance", async () => {
  const fixture = fixtureHome();
  const retiredIds = [1, 2, 3, 4, 5, 6, 1727, 1728, 2107, 2108, 2109, 2125];
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    `DELETE FROM agents WHERE slug = 'pi_agent';
     INSERT INTO agents(slug, name, kind, created_at, updated_at)
       VALUES ('codex', 'Codex', 'local', 0, 0), ('claude_code', 'Claude', 'local', 0, 0);
     INSERT INTO conversation_tail_state(conversation_id)
       VALUES ${retiredIds.map((id) => `(${id})`).join(",")};`,
  );
  const manifestPath = writeValidatedRetiredManifest(fixture, retiredIds);
  assert.deepEqual(retiredConversationIds({ home: fixture.home }), retiredIds);

  assert.deepEqual(
    await authorizedDelete(fixture, { mode: "cleanup" }),
    expectedReceipt(0),
  );
  assert.equal(runSqlite(fixture.database, "SELECT COUNT(*) FROM conversation_tail_state;"), "0");
  assert.equal(existsSync(manifestPath), true, "archive cleanup must not consume raw provenance");
});

test("cleanup rolls back every raw-proven tail deletion when one unrelated orphan remains", async () => {
  const fixture = fixtureHome();
  const retiredIds = [1, 2, 3, 4, 5, 6, 1727, 1728, 2107, 2108, 2109, 2125];
  const unrelatedId = 9999;
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    `DELETE FROM agents WHERE slug = 'pi_agent';
     INSERT INTO conversation_tail_state(conversation_id)
       VALUES ${[...retiredIds, unrelatedId].map((id) => `(${id})`).join(",")};`,
  );
  const manifestPath = writeValidatedRetiredManifest(fixture, retiredIds);

  await assert.rejects(
    authorizedDelete(fixture, { mode: "cleanup" }),
    /conversation_tail_state_inconsistencies=1/,
  );
  assert.equal(
    runSqlite(fixture.database, "SELECT COUNT(*) FROM conversation_tail_state;"),
    String(retiredIds.length + 1),
  );
  assert.equal(existsSync(manifestPath), true);
});

test("installer retry gate cleans before inspect only for the proved resumable state", () => {
  const fixture = fixtureHome();
  const tracePath = join(fixture.home, "retry-cleanup-trace");
  const result = runInstallerAssertionHarness(
    fixture.home,
    `
TRACE_PATH="$HOME/retry-cleanup-trace"
assert_no_semantic_runtime_retirement_state_locked() { printf 'runtime-proof\\n' >>"$TRACE_PATH"; }
cleanup_cass_0625_orphan_agent_locked() { printf 'cleanup\\n' >>"$TRACE_PATH"; }
cass_archive_helper_locked() { printf '%s\\n' "$1" >>"$TRACE_PATH"; printf '{"mode":"%s"}\\n' "$1"; }
inspect_cass_archive_after_retry_cleanup_locked 1 1 0 12 0 1 >/dev/null
inspect_cass_archive_after_retry_cleanup_locked 0 1 12 12 0 0 >/dev/null
`,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(tracePath, "utf8"), "runtime-proof\ncleanup\ninspect\ninspect\n");
});

test("a mismatched external lookup key is refused before orphan deletion", async () => {
  const fixture = fixtureHome();
  createArchive(fixture.database);
  runSqlite(
    fixture.database,
    `INSERT INTO agents(slug, name, kind, created_at, updated_at) VALUES ('active', 'Active', 'local', 0, 0);
     INSERT INTO conversations(agent_id, source_id, external_id, source_path)
       SELECT id, 'local', 'session', '/active' FROM agents WHERE slug = 'active';
     INSERT INTO conversation_external_lookup(lookup_key, conversation_id)
       SELECT 'foreign', id FROM conversations WHERE source_path = '/active';`,
  );
  await assert.rejects(authorizedDelete(fixture), /referential inconsistencies/);
  assert.equal(retiredRows(fixture.database), 1);
});

const derivedFixtures = [
  [
    "conversations",
    "INSERT INTO conversations(agent_id, source_path) SELECT id, '/retired' FROM agents WHERE slug = 'pi_agent';",
  ],
  ["daily_stats", "INSERT INTO daily_stats(day_id, agent_slug, last_updated) VALUES (1, 'pi_agent', 0);"],
  ["token_daily_stats", "INSERT INTO token_daily_stats(day_id, agent_slug, last_updated) VALUES (1, 'pi_agent', 0);"],
  ["usage_hourly", "INSERT INTO usage_hourly(hour_id, agent_slug) VALUES (1, 'pi_agent');"],
  ["usage_daily", "INSERT INTO usage_daily(day_id, agent_slug) VALUES (1, 'pi_agent');"],
  ["usage_models_daily", "INSERT INTO usage_models_daily(day_id, agent_slug) VALUES (1, 'pi_agent');"],
  [
    "message_metrics",
    `INSERT INTO agents(slug, name, kind, created_at, updated_at) VALUES ('active', 'Active', 'local', 0, 0);
     INSERT INTO conversations(agent_id, source_path) SELECT id, '/active' FROM agents WHERE slug = 'active';
     INSERT INTO messages(conversation_id, idx, role, content) SELECT id, 0, 'user', 'active' FROM conversations WHERE source_path = '/active';
     INSERT INTO message_metrics(message_id, created_at_ms, hour_id, day_id, agent_slug, role, content_chars, content_tokens_est)
       SELECT id, 0, 0, 0, 'pi_agent', 'user', 1, 1 FROM messages;`,
  ],
  [
    "token_usage",
    `INSERT INTO agents(slug, name, kind, created_at, updated_at) VALUES ('active', 'Active', 'local', 0, 0);
     INSERT INTO conversations(agent_id, source_path) SELECT id, '/active' FROM agents WHERE slug = 'active';
     INSERT INTO messages(conversation_id, idx, role, content) SELECT id, 0, 'user', 'active' FROM conversations WHERE source_path = '/active';
     INSERT INTO token_usage(message_id, conversation_id, agent_id, timestamp_ms, day_id, role, content_chars)
       SELECT m.id, c.id, p.id, 0, 0, 'user', 1
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         CROSS JOIN agents p WHERE p.slug = 'pi_agent';`,
  ],
];

for (const [table, sql] of derivedFixtures) {
  test(`a retired ${table} row blocks the exact orphan deletion`, async () => {
    const fixture = fixtureHome();
    createArchive(fixture.database);
    runSqlite(fixture.database, sql);
    await assert.rejects(authorizedDelete(fixture), new RegExp(`${table} rows`));
    assert.equal(retiredRows(fixture.database), 1);
  });
}

for (const boundary of ["afterConnectionOpen", "beforeDelete", "afterDeleteBeforeCommit"]) {
  test(`a regular-file swap at ${boundary} preserves both the foreign and opened databases`, async () => {
    const fixture = fixtureHome();
    await createWalArchive(fixture.database);
    let original;

    await assert.rejects(
      authorizedDelete(fixture, {
        hooks: {
          [boundary]: () => {
            original = swapInForeignDatabase(fixture);
          },
        },
      }),
      CassOrphanDeletionRefusal,
    );

    assert.ok(original && existsSync(original));
    assert.equal(retiredRows(fixture.database), 1);
    assert.equal(retiredRows(original), 1);
    assert.equal(runSqlite(fixture.database, "PRAGMA integrity_check;"), "ok");
    assert.equal(runSqlite(original, "PRAGMA integrity_check;"), "ok");
  });
}

test("a stalled SQLite proof is killed and its immediate transaction rolls back", async () => {
  const fixture = fixtureHome();
  await createWalArchive(fixture.database);

  await assert.rejects(
    authorizedDelete(fixture, {
      stageTimeoutMs: 50,
      hooks: {
        beforeDelete: ({ child }) => child.kill("SIGSTOP"),
      },
    }),
    /timed out waiting for staged sqlite proof/,
  );

  assert.equal(retiredRows(fixture.database), 1);
  assert.equal(runSqlite(fixture.database, "PRAGMA integrity_check;"), "ok");
});

test("cleanup refuses without the live writer lock", async () => {
  const fixture = fixtureHome();
  await createWalArchive(fixture.database);
  const previousLockFd = process.env.AGENTCHATS_RETIREMENT_LOCK_FD;
  delete process.env.AGENTCHATS_RETIREMENT_LOCK_FD;
  try {
    await assert.rejects(
      deleteCass0625OrphanAgent({
        home: fixture.home,
        databasePath: fixture.database,
        cassBin: fakeCassBin(fixture.home),
        flockBin: flock,
      }),
      /writer lock/,
    );
  } finally {
    if (previousLockFd !== undefined) process.env.AGENTCHATS_RETIREMENT_LOCK_FD = previousLockFd;
  }
  assert.equal(retiredRows(fixture.database), 1);
});

test("cleanup refuses a Cass version other than 0.6.25", async () => {
  const fixture = fixtureHome();
  await createWalArchive(fixture.database);
  const cassBin = fakeCassBin(fixture.home, "cass 0.6.27");
  await assert.rejects(
    withCassAuthority(fixture, cassBin, ({ flockBin }) =>
      deleteCass0625OrphanAgent({
        home: fixture.home,
        databasePath: fixture.database,
        cassBin,
        flockBin,
      }),
    ),
    /pinned to cass 0\.6\.25/,
  );
  assert.equal(retiredRows(fixture.database), 1);
});

test("a mode change before deletion is a refusal and rolls back", async () => {
  const fixture = fixtureHome();
  await createWalArchive(fixture.database);
  await assert.rejects(
    authorizedDelete(fixture, {
      hooks: { beforeDelete: () => chmodSync(fixture.database, 0o400) },
    }),
    CassOrphanDeletionRefusal,
  );
  assert.equal(retiredRows(fixture.database), 1);
  assert.equal(runSqlite(fixture.database, "PRAGMA integrity_check;"), "ok");
});

test(
  "Cass 0.6.25 rebuild clears derived rows before exact orphan cleanup",
  { skip: !process.env.CASS_BIN_INTEGRATION },
  async () => {
    const cassBin = process.env.CASS_BIN_INTEGRATION;
    const fixture = fixtureHome();
    const piRoot = join(fixture.home, ".pi", "agent");
    const sessions = join(piRoot, "sessions", "--integration--");
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    chmodSync(join(fixture.home, ".pi"), 0o700);
    chmodSync(join(fixture.home, ".pi", "agent"), 0o700);
    chmodSync(join(piRoot, "sessions"), 0o700);
    chmodSync(sessions, 0o700);
    const sessionPath = join(
      sessions,
      "2026-08-31T00-00-00-000Z_abc12345-1234-5678-9abc-def012345678.jsonl",
    );
    writeFileSync(
      sessionPath,
      [
        '{"type":"session","id":"abc12345-1234-5678-9abc-def012345678","timestamp":"2026-08-31T00:00:00.000Z","cwd":"/tmp/integration","provider":"anthropic","modelId":"test","thinkingLevel":"off"}',
        '{"type":"message","timestamp":"2026-08-31T00:00:01.000Z","message":{"role":"user","content":"orphan integration proof"}}',
        '{"type":"message","timestamp":"2026-08-31T00:00:02.000Z","message":{"role":"assistant","content":"verified"}}',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(sessionPath, 0o600);

    const codexSessions = join(fixture.home, ".codex", "sessions", "2026", "08", "31");
    mkdirSync(codexSessions, { recursive: true, mode: 0o700 });
    for (const component of [
      join(fixture.home, ".codex"),
      join(fixture.home, ".codex", "sessions"),
      join(fixture.home, ".codex", "sessions", "2026"),
      join(fixture.home, ".codex", "sessions", "2026", "08"),
      codexSessions,
    ]) {
      chmodSync(component, 0o700);
    }
    const codexSession = join(codexSessions, "rollout-2026-08-31T00-00-00-active.jsonl");
    writeFileSync(
      codexSession,
      [
        '{"timestamp":"2026-08-31T00:00:00.000Z","type":"session_meta","payload":{"id":"active-codex","cwd":"/tmp/integration","cli_version":"0.42.0"}}',
        '{"timestamp":"2026-08-31T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"active connector proof"}]}}',
        '{"timestamp":"2026-08-31T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"retained"}]}}',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(codexSession, 0o600);

    const capabilities = spawnSync(cassBin, ["capabilities", "--json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(capabilities.status, 0, capabilities.stderr || capabilities.stdout);
    const connectors = JSON.parse(capabilities.stdout).connectors;
    const xdgConfig = join(fixture.home, ".config");
    mkdirSync(join(xdgConfig, "cass"), { recursive: true, mode: 0o700 });
    chmodSync(xdgConfig, 0o700);
    chmodSync(join(xdgConfig, "cass"), 0o700);
    writeFileSync(
      join(xdgConfig, "cass", "sources.toml"),
      `disabled_agents = ${JSON.stringify(connectors.filter((connector) => !["pi_agent", "codex"].includes(connector)))}\n`,
      { mode: 0o600 },
    );
    const cassEnvironment = {
      ...process.env,
      CODEX_HOME: join(fixture.home, ".codex"),
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: piRoot,
      XDG_CONFIG_HOME: xdgConfig,
    };
    const version = spawnSync(cassBin, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.equal(version.stdout.trim(), "cass 0.6.25");
    const indexed = spawnSync(cassBin, ["index", "--full", "--force-rebuild"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
    const excluded = spawnSync(cassBin, ["sources", "agents", "exclude", "pi_agent"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(excluded.status, 0, excluded.stderr || excluded.stdout);
    assert.equal(retiredRows(fixture.database), 0);
    runSqlite(
      fixture.database,
      "INSERT INTO agents(slug, name, version, kind, created_at, updated_at) VALUES ('pi_agent', 'Pi', NULL, 'local', 0, 0);",
    );
    const repeated = spawnSync(cassBin, ["sources", "agents", "exclude", "pi_agent"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.equal(retiredRows(fixture.database), 1, "Cass 0.6.25 should expose its orphan bug");

    // Cass's supported exclusion can leave denormalized rollups behind even
    // after canonical conversations reach zero. Rebuild from the now-disabled
    // connector set first; direct SQL remains limited to the final zero-ref
    // orphan and must never broaden into analytics cleanup.
    const retirementRebuild = spawnSync(cassBin, ["index", "--full", "--force-rebuild"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(retirementRebuild.status, 0, retirementRebuild.stderr || retirementRebuild.stdout);
    for (const table of [
      "daily_stats",
      "token_daily_stats",
      "message_metrics",
      "usage_hourly",
      "usage_daily",
      "usage_models_daily",
      "token_usage",
    ]) {
      const predicate = table === "token_usage"
        ? "agent_id IN (SELECT id FROM agents WHERE slug = 'pi_agent')"
        : "agent_slug = 'pi_agent'";
      assert.equal(Number(runSqlite(fixture.database, `SELECT COUNT(*) FROM ${table} WHERE ${predicate};`)), 0);
    }
    const orphanBeforeCleanup = retiredRows(fixture.database);
    assert.ok([0, 1].includes(orphanBeforeCleanup));
    // The fixture has one Pi conversation, so Cass's known v20 exclusion
    // bug leaves its deterministic conversation id in the no-FK tail cache.
    // Prove that id through the validated raw-mirror manifest; production
    // cleanup must never trust a SELECT over conversation_tail_state itself.
    const retirementManifestPath = writeValidatedRetiredManifest(fixture, 1);
    assert.deepEqual(retiredConversationIds({ home: fixture.home }), [1]);
    assert.deepEqual(
      await authorizedDelete(fixture, {
        cassBin,
        mode: "cleanup",
      }),
      expectedReceipt(orphanBeforeCleanup),
    );
    assert.equal(
      existsSync(retirementManifestPath),
      true,
      "the integration helper must consume provenance without deleting it",
    );
    assert.equal(retiredRows(fixture.database), 0);
    assert.equal(runSqlite(fixture.database, "PRAGMA integrity_check;"), "ok");
    const rebuilt = spawnSync(cassBin, ["index", "--full", "--force-rebuild"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
    const reopened = spawnSync(cassBin, ["stats", "--json"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(reopened.status, 0, reopened.stderr || reopened.stdout);
    assert.equal(
      JSON.parse(reopened.stdout).by_agent.some((entry) => entry.agent === "pi_agent"),
      false,
    );
    const search = spawnSync(cassBin, ["search", "", "--robot", "--agent", "pi_agent", "--limit", "1"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(search.status, 0, search.stderr || search.stdout);
    assert.equal(
      JSON.parse(search.stdout).hits.filter((hit) => hit.agent === "pi_agent").length,
      0,
      search.stdout,
    );

    rmSync(join(dirname(fixture.database), "raw-mirror"), { recursive: true, force: true });
    const fixtureBin = join(fixture.home, ".local", "bin");
    mkdirSync(fixtureBin, { recursive: true, mode: 0o700 });
    chmodSync(join(fixture.home, ".local"), 0o700);
    chmodSync(fixtureBin, 0o700);
    symlinkSync(cassBin, join(fixtureBin, "cass"));
    const proofEnvironment = { ...process.env, HOME: fixture.home };
    for (const variable of [
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "CASS_DATA_DIR",
      "CASS_DB_PATH",
      "CASS_HOME",
      "CASS_IGNORE_SOURCES_CONFIG",
      "CASS_EXCLUDE_PATH",
      "CASS_EXCLUDE_PATHS",
      "CASS_DAEMON_SOCKET",
      "CASS_AIDER_DATA_ROOT",
      "CASS_ANTIGRAVITY_DATA_ROOT",
      "CASS_CURSOR_PROJECTS_ROOT",
      "CASS_OPENHANDS_DATA_ROOT",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_HOME",
      "CODEX_HOME",
      "GEMINI_HOME",
      "GOOSE_PATH_ROOT",
      "GROK_HOME",
      "HERMES_HOME",
      "KIMI_CODE_HOME",
      "OPENCODE_STORAGE_ROOT",
      "PI_CODING_AGENT_DIR",
      "PI_SESSIONS_DIR",
    ]) delete proofEnvironment[variable];
    const installer = new URL("../scripts/install.sh", import.meta.url).pathname;
    const completion = spawnSync(installer, ["--retirement-proof"], {
      encoding: "utf8",
      env: proofEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(completion.status, 0, completion.stderr || completion.stdout);
    assert.deepEqual(JSON.parse(completion.stdout), {
      schema_version: 1,
      retirement: "pi_agent",
      complete: true,
      connector_disabled: true,
      archive_rows: 0,
      archive: {
        schema_version: 20,
        agents: 0,
        conversations: 0,
        snippets: 0,
        conversation_tags: 0,
        conversation_tail_state: 0,
        conversation_external_lookup: 0,
        conversation_external_tail_lookup: 0,
        daily_stats: 0,
        token_daily_stats: 0,
        message_metrics: 0,
        usage_hourly: 0,
        usage_daily: 0,
        usage_models_daily: 0,
        token_usage: 0,
        foreign_key_violations: 0,
        referential_inconsistencies: 0,
        quick_check: "ok",
      },
      search_hit_count: 0,
      search_hits: [],
      raw_manifests: 0,
      raw_blobs: 0,
      rebuild_pending: false,
      semantic_state: false,
      daemon_running: false,
    });
  },
);
