import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  clearRetirementPending,
  expectedRawMirrorRoot,
  markRetirementPending,
  retirePiRawMirror,
  retiredConversationIds,
  retirementPendingStatus,
  verifyClaimedWithCass,
} from "../scripts/retire-pi-raw-mirror.mjs";

const homes = [];
const PUBLICATION_OWNER_NAME_FOR_TEST = /^\.publication\.owner\.[0-9a-f]{64}\.json$/;
const RESTORATION_CLEANUP_NAME_FOR_TEST = "terminal.restoration.json";
const PHASE_RECEIPTS_FOR_TEST = {
  claiming: { previous: "prepared", name: "phase.01.claiming.json" },
  claimed: { previous: "claiming", name: "phase.02.claimed.json" },
  verified: { previous: "claimed", name: "phase.03.verified.json" },
  deleting: { previous: "verified", name: "phase.04.deleting.json" },
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixtureHome() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "agentchats-raw-mirror-"));
  homes.push(home);
  chmodSync(home, 0o700);
  const root = expectedRawMirrorRoot(home);
  privateDirectory(join(root, "manifests"));
  privateDirectory(join(root, "blobs", "blake3"));
  return { home, root };
}

function manifestDocument({
  home,
  idCharacter,
  blobCharacter,
  blobSize,
  provider = "pi_agent",
  originalPath,
}) {
  const manifestId = `doctor-raw-mirror-manifest-id-v1-${idCharacter.repeat(64)}`;
  const blob = blobCharacter.repeat(64);
  const sourcePath =
    originalPath ??
    (provider === "pi_agent"
      ? join(home, ".pi", "agent", "sessions", `${idCharacter}.jsonl`)
      : join(home, ".codex", "sessions", `${idCharacter}.jsonl`));
  return {
    schema_version: 1,
    manifest_kind: "cass_raw_session_mirror_v1",
    manifest_id: manifestId,
    blob_hash_algorithm: "blake3",
    blob_relative_path: `blobs/blake3/${blob.slice(0, 2)}/${blob}.raw`,
    blob_blake3: blob,
    blob_size_bytes: blobSize,
    provider,
    source_id: "local",
    origin_kind: "local",
    origin_host: null,
    original_path: sourcePath,
    redacted_original_path: `[${provider}]/${idCharacter}.jsonl`,
    original_path_blake3: "d".repeat(64),
    captured_at_ms: 1,
    source_mtime_ms: 1,
    source_size_bytes: blobSize,
    compression: { state: "none", algorithm: null, uncompressed_size_bytes: blobSize },
    encryption: { state: "none", algorithm: null, key_id: null, envelope_version: null },
    db_links: [
      { conversation_id: 1, message_count: 1, source_path: sourcePath, started_at_ms: 1 },
    ],
    verification: {
      status: "captured",
      verifier: "cass_indexer",
      content_blake3: blob,
      verified_at_ms: 1,
    },
    manifest_blake3: `doctor-raw-mirror-manifest-v1-${"e".repeat(64)}`,
  };
}

function writeCapture({ home, root }, options) {
  const bytes = options.bytes ?? Buffer.from(`${options.idCharacter}-session`);
  const manifest = manifestDocument({ ...options, home, blobSize: bytes.length });
  const manifestPath = join(root, "manifests", `${manifest.manifest_id}.json`);
  const blobPath = join(root, manifest.blob_relative_path);
  privateDirectory(dirname(blobPath));
  writeFileSync(blobPath, bytes, { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return { manifest, manifestPath, blobPath };
}

function applyRetirement(home, overrides = {}) {
  return retirePiRawMirror({
    home,
    apply: true,
    lockAssertion: () => {},
    exclusionAssertion: () => {},
    claimedVerifier: () => {},
    ...overrides,
  });
}

function simulatedCrash(message) {
  const error = new Error(message);
  error.simulatedCrash = true;
  return error;
}

function operationDirectories(root) {
  return readdirSync(root).filter((name) => name.startsWith(".agentchats-retirement."));
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

async function killDuringPhaseReceiptWrite(fixture, phase = "claiming") {
  const childPath = join(fixture.home, `partial-${phase}-receipt.mjs`);
  const moduleUrl = new URL("../scripts/retire-pi-raw-mirror.mjs", import.meta.url).href;
  writeFileSync(
    childPath,
    `
import { writeSync } from "node:fs";
import { retirePiRawMirror } from ${JSON.stringify(moduleUrl)};
const blocker = new Int32Array(new SharedArrayBuffer(4));
retirePiRawMirror({
  home: ${JSON.stringify(fixture.home)},
  apply: true,
  lockAssertion: () => {},
  exclusionAssertion: () => {},
  claimedVerifier: () => {},
  hooks: {
    phaseReceiptWriteChunkBytes: 1,
    afterPhaseReceiptChunk: ({ phase, offset, total }) => {
      if (phase === ${JSON.stringify(phase)} && offset === 1 && offset < total) {
        writeSync(1, "partial-phase-ready\\n");
        Atomics.wait(blocker, 0, 0);
      }
    },
  },
});
`,
    { mode: 0o600 },
  );
  chmodSync(childPath, 0o600);

  const child = spawn(process.execPath, [childPath], { stdio: ["ignore", "pipe", "pipe"] });
  const exitPromise = once(child, "exit");
  let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.once("data", (chunk) => {
          if (chunk.toString().includes("partial-phase-ready")) resolve();
          else reject(new Error(`unexpected partial-phase child output: ${chunk}`));
        });
        child.once("error", reject);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("partial-phase child did not pause")), 5000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exitPromise;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function fakeCassVerifier(fixture, retired) {
  const path = join(fixture.home, "fake-cass-verifier.mjs");
  const report = {
    raw_mirror: {
      status: "verified",
      manifests: [
        {
          manifest_id: retired.manifest.manifest_id,
          provider: "pi_agent",
          status: "verified",
          blob_checksum_status: "matched",
          manifest_checksum_status: "matched",
        },
      ],
      summary: {
        manifest_count: 1,
        verified_blob_count: 1,
        missing_blob_count: 0,
        checksum_mismatch_count: 0,
        manifest_checksum_mismatch_count: 0,
        manifest_checksum_not_recorded_count: 0,
        invalid_manifest_count: 0,
        interrupted_capture_count: 0,
        duplicate_blob_reference_count: 0,
        total_blob_bytes: Number(retired.manifest.blob_size_bytes),
      },
    },
  };
  writeFileSync(
    path,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(report)}\n`)});\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function writeForeignCapture(fixture) {
  return writeCapture(fixture, {
    idCharacter: "b",
    blobCharacter: "3",
    provider: "codex",
    bytes: Buffer.from("foreign-session"),
  });
}

function assertForeignCapturePreserved(foreign) {
  assert.match(readFileSync(foreign.manifestPath, "utf8"), /"provider": "codex"/);
  assert.equal(readFileSync(foreign.blobPath, "utf8"), "foreign-session");
}

async function killAtRetirementBoundary(fixture, boundary, { cassBin = null } = {}) {
  const childPath = join(
    fixture.home,
    `kill-${boundary.name.replaceAll(/[^a-z0-9]+/g, "-")}.mjs`,
  );
  const moduleUrl = new URL("../scripts/retire-pi-raw-mirror.mjs", import.meta.url).href;
  const marker = `retirement-boundary:${boundary.name}`;
  writeFileSync(
    childPath,
    `
import { writeSync } from "node:fs";
import { retirePiRawMirror } from ${JSON.stringify(moduleUrl)};

const boundary = ${JSON.stringify(boundary)};
const blocker = new Int32Array(new SharedArrayBuffer(4));
function pause(name, details = {}) {
  if (name !== boundary.name) return;
  const match = boundary.match ?? {};
  if (match.targetName !== undefined && details.targetName !== match.targetName) return;
  if (match.kind !== undefined && details.entry?.kind !== match.kind) return;
  if (match.index !== undefined && details.index !== match.index) return;
  if (match.phase !== undefined && details.phase !== match.phase) return;
  if (match.partial === true && !(details.offset > 0 && details.offset < details.total)) return;
  writeSync(1, ${JSON.stringify(`${marker}\n`)});
  Atomics.wait(blocker, 0, 0);
}

const hooks = {
  publicationOwnerWriteChunkBytes: boundary.name === "publication-owner-chunk" ? 1 : undefined,
  publicationWriteChunkBytes: boundary.name === "restoration-receipt-chunk" ? 1 : undefined,
  afterPublicationOwnerCreate: (details) => pause("publication-owner-create", details),
  afterPublicationOwnerChunk: (details) => pause("publication-owner-chunk", details),
  afterPublicationTargetCreate: (details) => pause("restoration-receipt-create", details),
  afterPublicationTargetChunk: (details) => pause("restoration-receipt-chunk", details),
  afterVerificationLink: (details) => pause("verification-link", details),
  afterVerificationLinkUnlink: (details) => pause("verification-link-unlink", details),
  afterRestorationCleanupPublished: (details) => pause("restoration-receipt-published", details),
  afterRestorationDirectoryRmdir: (details) => pause("restoration-directory-rmdir", details),
  afterRestorationPhaseReceiptUnlink: (details) => pause("restoration-phase-unlink", details),
  afterRestorationIdentityUnlink: (details) => pause("restoration-identity-unlink", details),
  afterRestorationStateUnlink: (details) => pause("restoration-state-unlink", details),
  afterRestorationReceiptUnlink: (details) => pause("restoration-receipt-unlink", details),
  afterRestorationOperationRmdir: (details) => pause("restoration-operation-rmdir", details),
  afterJournalPhase: (phase) => {
    if (boundary.forceAutomaticRestoration === true && phase === "verified") {
      throw new Error("force automatic restoration before deleting");
    }
  },
  afterDelete: (details) => pause("payload-delete", details),
  afterPhaseReceiptUnlink: (details) => pause("phase-receipt-unlink", details),
  afterIdentityUnlink: (details) => pause("identity-unlink", details),
  afterStateUnlink: (details) => pause("state-unlink", details),
  afterDeletingReceiptUnlink: (details) => pause("deleting-receipt-unlink", details),
  afterOperationRmdir: (details) => pause("operation-rmdir", details),
};
const options = {
  home: ${JSON.stringify(fixture.home)},
  apply: true,
  lockAssertion: () => {},
  exclusionAssertion: () => {},
  hooks,
};
if (${cassBin === null ? "false" : "true"}) {
  options.cassBin = ${JSON.stringify(cassBin)};
} else {
  options.claimedVerifier = () => {};
}
retirePiRawMirror(options);
`,
    { mode: 0o600 },
  );
  chmodSync(childPath, 0o600);

  const child = spawn(process.execPath, [childPath], { stdio: ["ignore", "pipe", "pipe"] });
  const exitPromise = once(child, "exit");
  let stdout = "";
  let stderr = "";
  let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          if (stdout.includes(marker)) resolve();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (!stdout.includes(marker)) {
            reject(
              new Error(
                `retirement child exited before ${boundary.name}: code=${code} signal=${signal}\n${stderr}`,
              ),
            );
          }
        });
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`retirement child did not pause at ${boundary.name}\n${stderr}`)),
          5000,
        );
      }),
    ]);
    clearTimeout(timer);
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exitPromise;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exitPromise;
    }
  }
}

function verificationViewPaths(operation, entry) {
  const source = join(operation, "claimed", ...entry.relative_path.split("/"));
  const destination = join(
    operation,
    "verify-data",
    "raw-mirror",
    "v1",
    ...entry.relative_path.split("/"),
  );
  return { source, destination };
}

function assertStableRetirement(fixture, retired, foreign) {
  const resumed = applyRetirement(fixture.home);
  assert.ok(resumed.changed || resumed.manifest_count === 0);
  const stable = applyRetirement(fixture.home);
  assert.equal(stable.changed, false);
  assert.equal(stable.manifest_count, 0);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);
  assertForeignCapturePreserved(foreign);
  assert.deepEqual(operationDirectories(fixture.root), []);
}

function leavePreparedTransaction(fixture, blobCharacter = "2") {
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterJournalPhase: (phase) => {
            if (phase === "prepared") throw simulatedCrash("leave prepared transaction");
          },
        },
      }),
    /leave prepared transaction/,
  );
  const names = operationDirectories(fixture.root);
  assert.equal(names.length, 1);
  return { retired, operation: join(fixture.root, names[0]) };
}

function leaveVerifiedTransaction(fixture) {
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterJournalPhase: (phase) => {
            if (phase === "verified") {
              throw simulatedCrash("leave verified transaction for restoration cleanup");
            }
          },
        },
      }),
    /leave verified transaction for restoration cleanup/,
  );
  const names = operationDirectories(fixture.root);
  assert.equal(names.length, 1);
  return { retired, operation: join(fixture.root, names[0]) };
}

function phaseReceiptBytes(operation, stateBytes, phase) {
  const spec = PHASE_RECEIPTS_FOR_TEST[phase];
  return Buffer.from(
    `${JSON.stringify({
      schema_version: 1,
      operation: basename(operation),
      journal_sha256: createHash("sha256").update(stateBytes).digest("hex"),
      previous_phase: spec.previous,
      phase,
    })}\n`,
  );
}

function retirementReceiptPath(home) {
  return join(home, ".local", "state", "agentchats", "pi-retirement-v1.pending.json");
}

function cassDatabasePath(fixture) {
  const path = join(dirname(dirname(fixture.root)), "agent_search.db");
  writeFileSync(path, "main database placeholder\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

test("first-install assertions prove daemon state while treating an absent archive as empty", () => {
  const fixture = fixtureHome();
  const tracePath = join(fixture.home, "assertion-trace");
  const result = runInstallerAssertionHarness(
    fixture.home,
    `
TRACE_PATH="$HOME/assertion-trace"
assert_cass_writer_lock() { :; }
run_with_timeout() {
    description=$2
    printf '%s\\n' "$description" >>"$TRACE_PATH"
    case "$description" in
        'Cass semantic retirement proof')
            printf '%s\\n' '{"rebuild":{"active":false},"semantic":{"fast_tier":{"present":false},"quality_tier":{"present":false},"backlog":{"pending_work":false},"checkpoint":{"active":false}},"daemon_runtime":{"state":"not-running","observation":{"run_lock_present":false,"socket_present":false,"socket_connectable":false}}}'
            ;;
        *) return 97 ;;
    esac
}
cass_pi_agent_row_count_locked() { printf '0\\n'; }
cass_pi_conversation_count_locked() { printf '0\\n'; }
assert_no_semantic_retirement_state_locked
assert_cass_archive_retirement_locked
`,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(tracePath, "utf8"), "Cass semantic retirement proof\n");
});

test("an absent archive does not bypass a running Cass daemon", () => {
  const fixture = fixtureHome();
  const result = runInstallerAssertionHarness(
    fixture.home,
    `
assert_cass_writer_lock() { :; }
run_with_timeout() {
    printf '%s\\n' '{"rebuild":{"active":false},"semantic":{"fast_tier":{"present":false},"quality_tier":{"present":false},"backlog":{"pending_work":false},"checkpoint":{"active":false}},"daemon_runtime":{"state":"running","observation":{"run_lock_present":true,"socket_present":true,"socket_connectable":true}}}'
}
assert_no_semantic_retirement_state_locked
`,
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /semantic tiers, backlog, checkpoint, daemon, or rebuild state could retain retired connector data/,
  );
});

test("a symlinked Cass data root is rejected even when no raw mirror exists", () => {
  const fixture = fixtureHome();
  const dataDir = dirname(dirname(fixture.root));
  const outside = join(fixture.home, "foreign-cass-data");
  privateDirectory(outside);
  rmSync(dataDir, { recursive: true });
  symlinkSync(outside, dataDir, "dir");

  const result = runInstallerAssertionHarness(
    fixture.home,
    "assert_cass_data_directory\n",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cass data path component is not a real directory/);
  assert.equal(realpathSync(dataDir), realpathSync(outside));
});

test("a group-writable Cass data path component is rejected", () => {
  const fixture = fixtureHome();
  const component = join(fixture.home, "Library", "Application Support");
  chmodSync(component, 0o770);

  const result = runInstallerAssertionHarness(
    fixture.home,
    "assert_cass_data_directory\n",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cass data path component is group\/world writable/);
});

for (const suffix of ["-wal", "-shm", "-journal", ".foreign-sidecar"]) {
  test(`an orphaned agent_search.db${suffix} refuses an absent main database`, () => {
    const fixture = fixtureHome();
    const dataDir = dirname(dirname(fixture.root));
    const sidecar = join(dataDir, `agent_search.db${suffix}`);
    writeFileSync(sidecar, "foreign\n", { mode: 0o600 });
    chmodSync(sidecar, 0o600);

    const result = runInstallerAssertionHarness(
      fixture.home,
      "assert_cass_database_path\n",
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /orphaned Cass database sidecar/);
    assert.equal(readFileSync(sidecar, "utf8"), "foreign\n");
  });
}

test("a main DB does not authorize a symlinked canonical Cass sidecar", () => {
  const fixture = fixtureHome();
  const database = cassDatabasePath(fixture);
  const outside = join(fixture.home, "foreign-wal");
  const sidecar = `${database}-wal`;
  writeFileSync(outside, "foreign\n", { mode: 0o600 });
  chmodSync(outside, 0o600);
  symlinkSync(outside, sidecar);

  const result = runInstallerAssertionHarness(fixture.home, "assert_cass_database_path\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sidecar is not a regular owned file/);
  assert.equal(readFileSync(outside, "utf8"), "foreign\n");
  assert.equal(readFileSync(sidecar, "utf8"), "foreign\n");
});

test("a hard-linked main DB is preserved and refused", () => {
  const fixture = fixtureHome();
  const database = cassDatabasePath(fixture);
  const secondLink = join(fixture.home, "second-database-link");
  linkSync(database, secondLink);

  const result = runInstallerAssertionHarness(fixture.home, "assert_cass_database_path\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cass archive database has hard links/);
  assert.equal(readFileSync(database, "utf8"), "main database placeholder\n");
  assert.equal(readFileSync(secondLink, "utf8"), "main database placeholder\n");
});

test("a main DB does not authorize a hard-linked canonical Cass sidecar", () => {
  const fixture = fixtureHome();
  const database = cassDatabasePath(fixture);
  const sidecar = `${database}-shm`;
  const secondLink = join(fixture.home, "second-shm-link");
  writeFileSync(sidecar, "shared\n", { mode: 0o600 });
  chmodSync(sidecar, 0o600);
  linkSync(sidecar, secondLink);

  const result = runInstallerAssertionHarness(fixture.home, "assert_cass_database_path\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sidecar has hard links/);
  assert.equal(readFileSync(sidecar, "utf8"), "shared\n");
  assert.equal(readFileSync(secondLink, "utf8"), "shared\n");
});

test("a main DB does not authorize an unsafe-mode canonical Cass sidecar", () => {
  const fixture = fixtureHome();
  const database = cassDatabasePath(fixture);
  const sidecar = `${database}-wal-cert`;
  writeFileSync(sidecar, "certificate\n", { mode: 0o660 });
  chmodSync(sidecar, 0o660);

  const result = runInstallerAssertionHarness(fixture.home, "assert_cass_database_path\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sidecar is group\/world writable/);
  assert.equal(readFileSync(sidecar, "utf8"), "certificate\n");
});

test("a main DB preserves and refuses an unknown prefix occupant", () => {
  const fixture = fixtureHome();
  const database = cassDatabasePath(fixture);
  const foreign = `${database}.foreign-sidecar`;
  writeFileSync(foreign, "foreign\n", { mode: 0o600 });
  chmodSync(foreign, 0o600);

  const result = runInstallerAssertionHarness(fixture.home, "assert_cass_database_path\n");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing unknown Cass archive database sidecar/);
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
});

test("a main DB accepts Cass 0.6.25's canonical on-machine sidecars", () => {
  const fixture = fixtureHome();
  const database = cassDatabasePath(fixture);
  const suffixes = [
    "-fsqlite-ns-gate",
    "-fsqlite-ns-use",
    "-shm",
    "-wal",
    "-wal-cert",
    "-wal-cert-head",
  ];
  for (const suffix of suffixes) {
    writeFileSync(`${database}${suffix}`, `${suffix}\n`, { mode: 0o644 });
    chmodSync(`${database}${suffix}`, 0o644);
  }

  const result = runInstallerAssertionHarness(fixture.home, "assert_cass_database_path\n");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const suffix of suffixes) {
    assert.equal(readFileSync(`${database}${suffix}`, "utf8"), `${suffix}\n`);
  }
});

test("the durable retry receipt converges after a crash at its empty published state", () => {
  const fixture = fixtureHome();
  const receiptPath = retirementReceiptPath(fixture.home);
  assert.equal(retirementPendingStatus({ home: fixture.home }), false);

  assert.throws(
    () =>
      markRetirementPending({
        home: fixture.home,
        hooks: {
          afterReceiptCreate: () => {
            throw simulatedCrash("crash after empty receipt publication");
          },
        },
      }),
    /crash after empty receipt publication/,
  );
  assert.equal(readFileSync(receiptPath).length, 0);
  assert.equal(retirementPendingStatus({ home: fixture.home }), true);

  assert.equal(markRetirementPending({ home: fixture.home }), true);
  assert.deepEqual(
    JSON.parse(readFileSync(receiptPath, "utf8")),
    { schema_version: 1, retirement: "pi_agent", state: "pending" },
  );
  assert.equal(markRetirementPending({ home: fixture.home }), false);
  assert.equal(clearRetirementPending({ home: fixture.home }), true);
  assert.equal(retirementPendingStatus({ home: fixture.home }), false);
  assert.equal(clearRetirementPending({ home: fixture.home }), false);
});

test("the durable retry receipt completes only an exact canonical prefix", () => {
  const fixture = fixtureHome();
  assert.throws(
    () =>
      markRetirementPending({
        home: fixture.home,
        hooks: {
          afterReceiptCreate: () => {
            throw simulatedCrash("leave a partial receipt target");
          },
        },
      }),
    /leave a partial receipt target/,
  );
  const receiptPath = retirementReceiptPath(fixture.home);
  const canonical = Buffer.from(
    `${JSON.stringify({ schema_version: 1, retirement: "pi_agent", state: "pending" })}\n`,
  );
  writeFileSync(receiptPath, canonical.subarray(0, 19), { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  assert.equal(retirementPendingStatus({ home: fixture.home }), true);
  assert.equal(markRetirementPending({ home: fixture.home }), true);
  assert.deepEqual(readFileSync(receiptPath), canonical);

  assert.equal(clearRetirementPending({ home: fixture.home }), true);
  writeFileSync(receiptPath, "foreign\n", { mode: 0o600 });
  chmodSync(receiptPath, 0o600);
  assert.throws(
    () => retirementPendingStatus({ home: fixture.home }),
    /unexpected content/,
  );
  assert.equal(readFileSync(receiptPath, "utf8"), "foreign\n");
});

test("the durable retry receipt refuses symlinks and hard links", () => {
  const symlinkFixture = fixtureHome();
  const symlinkPath = retirementReceiptPath(symlinkFixture.home);
  privateDirectory(dirname(symlinkPath));
  const outside = join(symlinkFixture.home, "outside-receipt");
  writeFileSync(outside, "foreign\n", { mode: 0o600 });
  symlinkSync(outside, symlinkPath);
  assert.throws(
    () => retirementPendingStatus({ home: symlinkFixture.home }),
    /non-regular or symlink/,
  );
  assert.equal(readFileSync(outside, "utf8"), "foreign\n");

  const hardlinkFixture = fixtureHome();
  assert.equal(markRetirementPending({ home: hardlinkFixture.home }), true);
  const hardlinkPath = retirementReceiptPath(hardlinkFixture.home);
  linkSync(hardlinkPath, join(hardlinkFixture.home, "second-receipt-link"));
  assert.throws(
    () => retirementPendingStatus({ home: hardlinkFixture.home }),
    /hard links/,
  );
});

test("dry-run, apply, and rerun remove only exact retired captures", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "1" });
  const active = writeCapture(fixture, {
    idCharacter: "b",
    blobCharacter: "2",
    provider: "codex",
  });

  const dryRun = retirePiRawMirror({ home: fixture.home });
  assert.deepEqual(
    { manifests: dryRun.manifest_count, blobs: dryRun.blob_count, changed: dryRun.changed },
    { manifests: 1, blobs: 1, changed: false },
  );
  assert.equal(dryRun.bytes, Buffer.byteLength("a-session"));
  assert.equal(dryRun.peak_extra_payload_bytes, 0);
  assert.equal(dryRun.verification_link_count, 2);
  assert.ok(dryRun.peak_extra_receipt_bytes_upper_bound > 0);
  assert.ok(dryRun.peak_extra_receipt_bytes_upper_bound < 8 * 1024 * 1024);
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);

  const applied = applyRetirement(fixture.home);
  assert.equal(applied.changed, true);
  assert.throws(() => readFileSync(retired.manifestPath), /ENOENT/);
  assert.throws(() => readFileSync(retired.blobPath), /ENOENT/);
  assert.match(readFileSync(active.manifestPath, "utf8"), /"provider": "codex"/);
  assert.equal(readFileSync(active.blobPath, "utf8"), "b-session");

  const rerun = applyRetirement(fixture.home);
  assert.deepEqual(
    { manifests: rerun.manifest_count, blobs: rerun.blob_count, changed: rerun.changed },
    { manifests: 0, blobs: 0, changed: false },
  );
  assert.equal(rerun.peak_extra_payload_bytes, 0);
  assert.equal(rerun.peak_extra_receipt_bytes_upper_bound, 0);
  assert.equal(rerun.verification_link_count, 0);
});

test("retired conversation ids come only from validated retired manifests", () => {
  const fixture = fixtureHome();
  const capture = writeCapture(fixture, { idCharacter: "a", blobCharacter: "1" });
  const manifest = {
    ...capture.manifest,
    db_links: [
      {
        ...capture.manifest.db_links[0],
        conversation_id: 42,
      },
    ],
  };
  writeFileSync(capture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(capture.manifestPath, 0o600);
  assert.deepEqual(retiredConversationIds({ home: fixture.home }), [42]);
});

test("refuses a content-addressed blob shared with an active provider", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "3" });
  const activeManifest = manifestDocument({
    home: fixture.home,
    idCharacter: "b",
    blobCharacter: "3",
    blobSize: Buffer.byteLength("a-session"),
    provider: "codex",
  });
  const activePath = join(fixture.root, "manifests", `${activeManifest.manifest_id}.json`);
  writeFileSync(activePath, `${JSON.stringify(activeManifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(activePath, 0o600);

  assert.throws(
    () => applyRetirement(fixture.home),
    /shared raw-mirror blob/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
});

test("refuses target-provider manifests with foreign source provenance", () => {
  const fixture = fixtureHome();
  writeCapture(fixture, {
    idCharacter: "a",
    blobCharacter: "4",
    originalPath: join(fixture.home, ".codex", "sessions", "foreign.jsonl"),
  });
  assert.throws(
    () => applyRetirement(fixture.home),
    /inconsistent retired-provider provenance/,
  );
});

test("refuses symlinked manifest entries before deleting an exact target", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "5" });
  const outside = join(fixture.home, "outside.json");
  writeFileSync(outside, "{}", { mode: 0o600 });
  const hostile = join(
    fixture.root,
    "manifests",
    `doctor-raw-mirror-manifest-id-v1-${"c".repeat(64)}.json`,
  );
  symlinkSync(outside, hostile);

  assert.throws(
    () => applyRetirement(fixture.home),
    /unexpected manifest directory entry/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
});

test("refuses hard-linked target blobs", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "6" });
  linkSync(retired.blobPath, join(fixture.home, "second-link.raw"));
  assert.throws(
    () => applyRetirement(fixture.home),
    /hard links/,
  );
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
});

test("lock or exclusion refusal leaves every target live and creates no journal", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "7" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        lockAssertion: () => {
          throw new Error("writer lock unavailable");
        },
      }),
    /writer lock unavailable/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assert.deepEqual(operationDirectories(fixture.root), []);

  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        exclusionAssertion: () => {
          throw new Error("connector is not excluded");
        },
      }),
    /connector is not excluded/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("a verification mismatch restores the exact live capture before refusing", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "8" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        claimedVerifier: () => {
          throw new Error("canonical verification mismatch");
        },
      }),
    /canonical verification mismatch/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("a new active reference after claim aborts and restores the target", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "9" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterClaims: () => {
            const active = manifestDocument({
              home: fixture.home,
              idCharacter: "b",
              blobCharacter: "9",
              blobSize: Buffer.byteLength("a-session"),
              provider: "codex",
            });
            const activePath = join(fixture.root, "manifests", `${active.manifest_id}.json`);
            writeFileSync(activePath, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
            chmodSync(activePath, 0o600);
          },
        },
      }),
    /live provider now references/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("source replacement immediately before rename is quarantined and never deleted", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "a" });
  const held = join(fixture.home, "held-manifest.json");
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          beforeClaimRename: ({ source, index }) => {
            if (index !== 0) return;
            renameSync(source, held);
            writeFileSync(source, "{}\n", { mode: 0o600 });
            chmodSync(source, 0o600);
          },
        },
      }),
    /journal receipt/,
  );
  assert.match(readFileSync(held, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assert.equal(operationDirectories(fixture.root).length, 1);
});

test("a claim destination occupant prevents rename and deletion", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "b" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          beforeClaimRename: ({ destination, index }) => {
            if (index !== 0) return;
            writeFileSync(destination, "foreign\n", { mode: 0o600 });
            chmodSync(destination, 0o600);
          },
        },
      }),
    /destination became occupied/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assert.equal(operationDirectories(fixture.root).length, 1);
});

test("unknown manifest fields are refused before quarantine", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "c" });
  const document = JSON.parse(readFileSync(retired.manifestPath, "utf8"));
  document.untrusted_extension = true;
  writeFileSync(retired.manifestPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(retired.manifestPath, 0o600);
  assert.throws(() => retirePiRawMirror({ home: fixture.home }), /unexpected key set/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
});

test("verification sidecars refuse retirement because current Cass cannot corroborate them", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "d" });
  const verification = join(fixture.root, "verification");
  privateDirectory(verification);
  writeFileSync(join(verification, `${retired.manifest.manifest_id}.json`), "{}\n", {
    mode: 0o600,
  });
  assert.throws(
    () => retirePiRawMirror({ home: fixture.home }),
    /verification sidecars are present/,
  );
  assert.match(readFileSync(retired.manifestPath, "utf8"), /pi_agent/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
});

for (const phase of ["prepared", "claiming", "claimed", "verified", "deleting"]) {
  test(`resumes safely after a crash at the durable ${phase} phase`, () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "e" });
    assert.throws(
      () =>
        applyRetirement(fixture.home, {
          hooks: {
            afterJournalPhase: (current) => {
              if (current === phase) throw simulatedCrash(`crash at ${phase}`);
            },
          },
        }),
      new RegExp(`crash at ${phase}`),
    );
    assert.equal(operationDirectories(fixture.root).length, 1);
    const resumed = applyRetirement(fixture.home);
    assert.ok(resumed.changed || resumed.manifest_count === 0);
    assert.equal(existsSync(retired.manifestPath), false);
    assert.equal(existsSync(retired.blobPath), false);
    assert.deepEqual(operationDirectories(fixture.root), []);
  });
}

test("the prepared journal is immutable and later phases are append-only receipts", () => {
  const fixture = fixtureHome();
  writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterJournalPhase: (phase) => {
            if (phase === "deleting") throw simulatedCrash("inspect durable receipts");
          },
        },
      }),
    /inspect durable receipts/,
  );
  const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
  const journal = JSON.parse(readFileSync(join(operation, "state.json"), "utf8"));
  assert.equal(journal.phase, "prepared");
  assert.deepEqual(
    readdirSync(operation).filter((name) => name.startsWith("phase.")),
    [
      "phase.01.claiming.json",
      "phase.02.claimed.json",
      "phase.03.verified.json",
      "phase.04.deleting.json",
    ],
  );
});

test("an exact partial prepared journal converges through its durable owner", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          journalWriteChunkBytes: 1,
          afterPublicationTargetChunk: ({ targetName, offset }) => {
            if (targetName === "state.json" && offset === 1) {
              throw simulatedCrash("leave partial prepared journal");
            }
          },
        },
      }),
    /leave partial prepared journal/,
  );
  const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
  assert.equal(readFileSync(join(operation, "state.json")).length, 1);
  assert.ok(readdirSync(operation).some((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name)));
  assert.equal(retirePiRawMirror({ home: fixture.home }).pending_phase, "journal-writing");

  applyRetirement(fixture.home);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("SIGKILL during a partial phase receipt converges only through its exact owner", async () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "3" });
  await killDuringPhaseReceiptWrite(fixture);

  const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
  const names = readdirSync(operation);
  const owner = names.find((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name));
  const receipt = join(operation, PHASE_RECEIPTS_FOR_TEST.claiming.name);
  assert.ok(owner);
  assert.equal(readFileSync(receipt).length, 1);
  assert.equal(retirePiRawMirror({ home: fixture.home }).pending_phase, "prepared");

  applyRetirement(fixture.home);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

for (const boundary of [
  {
    name: "publication-owner-create",
    match: { targetName: "state.json" },
    expectedBytes: 0,
    label: "empty publication-owner creation",
  },
  {
    name: "publication-owner-chunk",
    match: { targetName: "state.json", partial: true },
    expectedBytes: 1,
    label: "partial publication-owner write",
  },
]) {
  test(`SIGKILL during ${boundary.label} regenerates only its deterministic owner`, async () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
    const foreign = writeForeignCapture(fixture);

    await killAtRetirementBoundary(fixture, boundary);

    const operations = operationDirectories(fixture.root);
    assert.equal(operations.length, 1);
    const operation = join(fixture.root, operations[0]);
    const names = readdirSync(operation);
    const owner = names.find((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name));
    assert.ok(owner);
    assert.equal(readFileSync(join(operation, owner)).length, boundary.expectedBytes);
    assert.equal(existsSync(join(operation, "state.json")), false);
    assert.equal(retirePiRawMirror({ home: fixture.home }).pending_phase, "journal-writing");

    assertStableRetirement(fixture, retired, foreign);
  });
}

for (const boundary of [
  {
    name: "verification-link",
    match: { kind: "manifest" },
    label: "manifest verification-view link",
    entryKind: "manifest",
    expectedState: "linked",
  },
  {
    name: "verification-link",
    match: { kind: "blob" },
    label: "blob verification-view link",
    entryKind: "blob",
    expectedState: "linked",
  },
  {
    name: "verification-link-unlink",
    match: { kind: "manifest" },
    label: "manifest verification-view unlink",
    entryKind: "manifest",
    expectedState: "unlinked",
  },
  {
    name: "verification-link-unlink",
    match: { kind: "blob" },
    label: "blob verification-view unlink",
    entryKind: "blob",
    expectedState: "unlinked",
  },
]) {
  test(`SIGKILL after ${boundary.label} resumes the exact journal-authenticated view`, async () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, {
      idCharacter: "a",
      blobCharacter: "2",
      bytes: Buffer.from("a-session"),
    });
    const foreign = writeForeignCapture(fixture);
    const cassBin = fakeCassVerifier(fixture, retired);

    await killAtRetirementBoundary(fixture, boundary, { cassBin });

    const operations = operationDirectories(fixture.root);
    assert.equal(operations.length, 1);
    const operation = join(fixture.root, operations[0]);
    const journal = JSON.parse(readFileSync(join(operation, "state.json"), "utf8"));
    const entry =
      boundary.entryKind === "manifest" ? journal.manifests[0] : journal.blobs[0];
    const { source, destination } = verificationViewPaths(operation, entry);

    if (boundary.expectedState === "linked") {
      const sourceMetadata = lstatSync(source, { bigint: true });
      const destinationMetadata = lstatSync(destination, { bigint: true });
      assert.equal(sourceMetadata.dev, destinationMetadata.dev);
      assert.equal(sourceMetadata.ino, destinationMetadata.ino);
      assert.equal(sourceMetadata.nlink, 2n);
      assert.equal(destinationMetadata.nlink, 2n);
    } else {
      assert.equal(existsSync(destination), false);
      assert.equal(lstatSync(source, { bigint: true }).nlink, 1n);
    }

    verifyClaimedWithCass({ opPath: operation, journal, cassBin });
    for (const candidate of [...journal.manifests, ...journal.blobs]) {
      const paths = verificationViewPaths(operation, candidate);
      assert.equal(existsSync(paths.destination), false);
      assert.equal(lstatSync(paths.source, { bigint: true }).nlink, 1n);
    }
    assertStableRetirement(fixture, retired, foreign);
  });
}

for (const boundary of [
  {
    name: "payload-delete",
    match: { index: 0 },
    label: "manifest payload unlink",
    assertKilledState: ({ operation, retired }) => {
      assert.equal(
        existsSync(join(operation, "claimed", "manifests", basename(retired.manifestPath))),
        false,
      );
      assert.equal(
        existsSync(join(operation, "claimed", ...retired.manifest.blob_relative_path.split("/"))),
        true,
      );
    },
  },
  {
    name: "payload-delete",
    match: { index: 1 },
    label: "blob payload unlink",
    assertKilledState: ({ operation, retired }) => {
      assert.equal(
        existsSync(join(operation, "claimed", "manifests", basename(retired.manifestPath))),
        false,
      );
      assert.equal(
        existsSync(join(operation, "claimed", ...retired.manifest.blob_relative_path.split("/"))),
        false,
      );
    },
  },
  ...["verified", "claimed", "claiming"].map((phase) => ({
    name: "phase-receipt-unlink",
    match: { phase },
    label: `${phase} phase-receipt unlink`,
    assertKilledState: ({ operation }) => {
      assert.equal(existsSync(join(operation, PHASE_RECEIPTS_FOR_TEST[phase].name)), false);
      assert.equal(existsSync(join(operation, PHASE_RECEIPTS_FOR_TEST.deleting.name)), true);
    },
  })),
  {
    name: "identity-unlink",
    label: "journal-identity unlink",
    assertKilledState: ({ operation }) => {
      assert.equal(existsSync(join(operation, "state.identity.json")), false);
      assert.equal(existsSync(join(operation, "state.json")), true);
    },
  },
  {
    name: "state-unlink",
    label: "prepared-journal unlink",
    assertKilledState: ({ operation }) => {
      assert.equal(existsSync(join(operation, "state.json")), false);
      assert.equal(existsSync(join(operation, PHASE_RECEIPTS_FOR_TEST.deleting.name)), true);
    },
  },
  {
    name: "deleting-receipt-unlink",
    label: "terminal deleting-receipt unlink",
    assertKilledState: ({ operation }) => {
      assert.deepEqual(readdirSync(operation), []);
    },
  },
  {
    name: "operation-rmdir",
    label: "final operation-directory removal",
    assertKilledState: ({ fixture }) => {
      assert.deepEqual(operationDirectories(fixture.root), []);
    },
  },
]) {
  test(`SIGKILL after ${boundary.label} converges without consuming a foreign capture`, async () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
    const foreign = writeForeignCapture(fixture);

    await killAtRetirementBoundary(fixture, boundary);

    const operations = operationDirectories(fixture.root);
    const operation = operations.length === 1 ? join(fixture.root, operations[0]) : null;
    if (boundary.name === "operation-rmdir") assert.equal(operation, null);
    else assert.ok(operation);
    boundary.assertKilledState({ fixture, operation, retired });
    assertForeignCapturePreserved(foreign);

    assertStableRetirement(fixture, retired, foreign);
  });
}

for (const boundary of [
  {
    name: "publication-owner-create",
    match: { targetName: RESTORATION_CLEANUP_NAME_FOR_TEST },
    label: "empty restoration-owner creation",
    expectedOwnerBytes: 0,
    expectedReceiptBytes: null,
  },
  {
    name: "publication-owner-chunk",
    match: { targetName: RESTORATION_CLEANUP_NAME_FOR_TEST, partial: true },
    label: "partial restoration-owner write",
    expectedOwnerBytes: 1,
    expectedReceiptBytes: null,
  },
  {
    name: "restoration-receipt-create",
    match: { targetName: RESTORATION_CLEANUP_NAME_FOR_TEST },
    label: "empty restoration receipt creation",
    expectedOwnerBytes: "complete",
    expectedReceiptBytes: 0,
  },
  {
    name: "restoration-receipt-chunk",
    match: { targetName: RESTORATION_CLEANUP_NAME_FOR_TEST, partial: true },
    label: "partial restoration receipt write",
    expectedOwnerBytes: "complete",
    expectedReceiptBytes: 1,
  },
  {
    name: "restoration-receipt-published",
    label: "durable restoration receipt publication",
    expectedOwnerBytes: null,
    expectedReceiptBytes: "complete",
  },
]) {
  test(`SIGKILL during ${boundary.label} converges through its exact cleanup proof`, async () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
    const foreign = writeForeignCapture(fixture);

    await killAtRetirementBoundary(fixture, {
      ...boundary,
      forceAutomaticRestoration: true,
    });

    const operations = operationDirectories(fixture.root);
    assert.equal(operations.length, 1);
    const operation = join(fixture.root, operations[0]);
    const names = readdirSync(operation);
    const owner = names.find((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name));
    const receiptPath = join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST);
    if (boundary.expectedOwnerBytes === null) {
      assert.equal(owner, undefined);
    } else {
      assert.ok(owner);
      const ownerSize = readFileSync(join(operation, owner)).length;
      if (boundary.expectedOwnerBytes === "complete") assert.ok(ownerSize > 1);
      else assert.equal(ownerSize, boundary.expectedOwnerBytes);
    }
    if (boundary.expectedReceiptBytes === null) {
      assert.equal(existsSync(receiptPath), false);
    } else {
      const receiptSize = readFileSync(receiptPath).length;
      if (boundary.expectedReceiptBytes === "complete") assert.ok(receiptSize > 1);
      else assert.equal(receiptSize, boundary.expectedReceiptBytes);
    }
    assert.match(readFileSync(retired.manifestPath, "utf8"), /"provider": "pi_agent"/);
    assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
    assertForeignCapturePreserved(foreign);

    assertStableRetirement(fixture, retired, foreign);
  });
}

for (const boundary of [
  ...[0, 1, 2, 3, 4].map((index) => ({
    name: "restoration-directory-rmdir",
    match: { index },
    label: `restoration directory removal ${index}`,
    assertKilledState: ({ operation }) => {
      assert.equal(existsSync(join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST)), true);
    },
  })),
  ...["verified", "claimed", "claiming"].map((phase) => ({
    name: "restoration-phase-unlink",
    match: { phase },
    label: `restoration ${phase} phase-receipt unlink`,
    assertKilledState: ({ operation }) => {
      assert.equal(existsSync(join(operation, PHASE_RECEIPTS_FOR_TEST[phase].name)), false);
      assert.equal(existsSync(join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST)), true);
    },
  })),
  {
    name: "restoration-identity-unlink",
    label: "restoration journal-identity unlink",
    assertKilledState: ({ fixture, operation }) => {
      assert.equal(existsSync(join(operation, "state.identity.json")), false);
      assert.equal(existsSync(join(operation, "state.json")), true);
      assert.equal(existsSync(join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST)), true);
      assert.equal(retirePiRawMirror({ home: fixture.home }).pending_transaction, true);
    },
  },
  {
    name: "restoration-state-unlink",
    label: "restoration prepared-journal unlink",
    assertKilledState: ({ fixture, operation }) => {
      assert.equal(existsSync(join(operation, "state.json")), false);
      assert.equal(existsSync(join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST)), true);
      assert.equal(retirePiRawMirror({ home: fixture.home }).pending_transaction, true);
    },
  },
  {
    name: "restoration-receipt-unlink",
    label: "terminal restoration-receipt unlink",
    assertKilledState: ({ operation }) => {
      assert.deepEqual(readdirSync(operation), []);
    },
  },
  {
    name: "restoration-operation-rmdir",
    label: "restoration operation-directory removal",
    assertKilledState: ({ fixture }) => {
      assert.deepEqual(operationDirectories(fixture.root), []);
    },
  },
]) {
  test(`SIGKILL after ${boundary.label} resumes without losing restored targets`, async () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
    const foreign = writeForeignCapture(fixture);

    await killAtRetirementBoundary(fixture, {
      ...boundary,
      forceAutomaticRestoration: true,
    });

    const operations = operationDirectories(fixture.root);
    const operation = operations.length === 1 ? join(fixture.root, operations[0]) : null;
    if (boundary.name === "restoration-operation-rmdir") assert.equal(operation, null);
    else assert.ok(operation);
    boundary.assertKilledState({ fixture, operation });
    assert.match(readFileSync(retired.manifestPath, "utf8"), /"provider": "pi_agent"/);
    assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
    assertForeignCapturePreserved(foreign);

    assertStableRetirement(fixture, retired, foreign);
  });
}

test("restoration cleanup resumes after coalescing a different live inode", async () => {
  const fixture = fixtureHome();
  const { retired } = leaveVerifiedTransaction(fixture);
  const foreign = writeForeignCapture(fixture);
  writeFileSync(retired.blobPath, "a-session", { mode: 0o600 });
  chmodSync(retired.blobPath, 0o600);
  const recreatedInode = lstatSync(retired.blobPath, { bigint: true }).ino;

  await killAtRetirementBoundary(fixture, {
    name: "restoration-identity-unlink",
  });

  const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
  assert.equal(existsSync(join(operation, "state.identity.json")), false);
  assert.equal(existsSync(join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST)), true);
  assert.equal(lstatSync(retired.blobPath, { bigint: true }).ino, recreatedInode);
  assertStableRetirement(fixture, retired, foreign);
});

for (const failure of [
  {
    hook: "afterRestorationIdentityUnlink",
    code: "ENOSPC",
    label: "journal-identity unlink",
  },
  {
    hook: "afterRestorationStateUnlink",
    code: "EIO",
    label: "prepared-journal unlink",
  },
]) {
  test(`${failure.code} after restoration ${failure.label} remains resumable`, () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "2" });
    const foreign = writeForeignCapture(fixture);
    const cleanupError = new Error(`simulated restoration ${failure.code}`);
    cleanupError.code = failure.code;

    assert.throws(
      () =>
        applyRetirement(fixture.home, {
          claimedVerifier: () => {
            throw new Error("force automatic restoration");
          },
          hooks: {
            [failure.hook]: () => {
              throw cleanupError;
            },
          },
        }),
      new RegExp(`automatic restoration also refused: simulated restoration ${failure.code}`),
    );
    const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
    assert.equal(existsSync(join(operation, RESTORATION_CLEANUP_NAME_FOR_TEST)), true);
    assert.match(readFileSync(retired.manifestPath, "utf8"), /"provider": "pi_agent"/);
    assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
    assertForeignCapturePreserved(foreign);

    assertStableRetirement(fixture, retired, foreign);
  });
}

test("replacing immutable state.json is refused and the replacement is preserved", () => {
  const fixture = fixtureHome();
  const { operation } = leavePreparedTransaction(fixture, "4");
  const statePath = join(operation, "state.json");
  const replacement = JSON.parse(readFileSync(statePath, "utf8"));
  replacement.manifests[0].sha256 = "f".repeat(64);
  renameSync(statePath, join(fixture.home, "original-state.json"));
  writeFileSync(statePath, `${JSON.stringify(replacement, null, 2)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);

  assert.throws(
    () => applyRetirement(fixture.home),
    /identity receipt does not match the immutable prepared state/,
  );
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).manifests[0].sha256, "f".repeat(64));
});

test("an occupied next phase path makes O_EXCL refuse without replacing the occupant", () => {
  const fixture = fixtureHome();
  leavePreparedTransaction(fixture, "5");
  let receiptPath;
  let operation;
  let occupied = false;
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterPublicationOwnerSync: ({ opPath, targetName }) => {
            if (!occupied && targetName === PHASE_RECEIPTS_FOR_TEST.claiming.name) {
              occupied = true;
              operation = opPath;
              receiptPath = join(opPath, targetName);
              writeFileSync(receiptPath, "foreign occupant\n", { mode: 0o600 });
              chmodSync(receiptPath, 0o600);
            }
          },
        },
      }),
    /path is already occupied/,
  );
  assert.ok(operation);
  assert.ok(receiptPath);
  assert.equal(readFileSync(receiptPath, "utf8"), "foreign occupant\n");
  assert.equal(readdirSync(operation).some((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name)), false);
});

test("a malformed phase receipt is refused and preserved", () => {
  const fixture = fixtureHome();
  const { operation } = leavePreparedTransaction(fixture, "6");
  const receiptPath = join(operation, PHASE_RECEIPTS_FOR_TEST.claiming.name);
  writeFileSync(receiptPath, "foreign\n", { mode: 0o600 });
  chmodSync(receiptPath, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /not an exact canonical prefix/);
  assert.equal(readFileSync(receiptPath, "utf8"), "foreign\n");
});

test("a duplicate phase artifact is refused and preserved", () => {
  const fixture = fixtureHome();
  const { operation } = leavePreparedTransaction(fixture, "7");
  const duplicate = join(operation, "phase.01.claiming.duplicate.json");
  writeFileSync(duplicate, "duplicate\n", { mode: 0o600 });
  chmodSync(duplicate, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /unexpected retirement operation occupant/);
  assert.equal(readFileSync(duplicate, "utf8"), "duplicate\n");
});

test("an out-of-order phase receipt is refused and preserved", () => {
  const fixture = fixtureHome();
  const { operation } = leavePreparedTransaction(fixture, "8");
  const stateBytes = readFileSync(join(operation, "state.json"));
  const receiptPath = join(operation, PHASE_RECEIPTS_FOR_TEST.claimed.name);
  const bytes = phaseReceiptBytes(operation, stateBytes, "claimed");
  writeFileSync(receiptPath, bytes, { mode: 0o600 });
  chmodSync(receiptPath, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /out-of-order claimed retirement phase receipt/);
  assert.deepEqual(readFileSync(receiptPath), bytes);
});

test("an exact phase prefix without its owner is refused and preserved", () => {
  const fixture = fixtureHome();
  const { operation } = leavePreparedTransaction(fixture, "9");
  const stateBytes = readFileSync(join(operation, "state.json"));
  const receiptPath = join(operation, PHASE_RECEIPTS_FOR_TEST.claiming.name);
  const prefix = phaseReceiptBytes(operation, stateBytes, "claiming").subarray(0, 17);
  writeFileSync(receiptPath, prefix, { mode: 0o600 });
  chmodSync(receiptPath, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /phase receipt is partial without an owner/);
  assert.deepEqual(readFileSync(receiptPath), prefix);
});

test("dry-run exposes an interrupted transaction so installer recovery can acquire the lock", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "d" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterJournalPhase: (phase) => {
            if (phase === "prepared") throw simulatedCrash("crash before installer apply");
          },
        },
      }),
    /crash before installer apply/,
  );

  const preflight = retirePiRawMirror({ home: fixture.home });
  assert.equal(preflight.pending_transaction, true);
  assert.equal(preflight.pending_phase, "prepared");
  assert.equal(preflight.manifest_count, 1);

  applyRetirement(fixture.home);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

for (const index of [0, 1]) {
  test(`resumes safely after a crash following claim ${index}`, () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "f" });
    assert.throws(
      () =>
        applyRetirement(fixture.home, {
          hooks: {
            afterClaim: ({ index: claimedIndex }) => {
              if (claimedIndex === index) throw simulatedCrash(`crash after claim ${index}`);
            },
          },
        }),
      new RegExp(`crash after claim ${index}`),
    );
    applyRetirement(fixture.home);
    assert.equal(existsSync(retired.manifestPath), false);
    assert.equal(existsSync(retired.blobPath), false);
    assert.deepEqual(operationDirectories(fixture.root), []);
  });

  test(`resumes safely after deletion ${index} was durably unlinked`, () => {
    const fixture = fixtureHome();
    const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "0" });
    assert.throws(
      () =>
        applyRetirement(fixture.home, {
          hooks: {
            afterDelete: ({ index: deletedIndex }) => {
              if (deletedIndex === index) throw simulatedCrash(`crash after delete ${index}`);
            },
          },
        }),
      new RegExp(`crash after delete ${index}`),
    );
    applyRetirement(fixture.home);
    assert.equal(existsSync(retired.manifestPath), false);
    assert.equal(existsSync(retired.blobPath), false);
    assert.deepEqual(operationDirectories(fixture.root), []);
  });
}

test("the inherited Homebrew flock is observed as an exclusive lock", () => {
  const fixture = fixtureHome();
  const dataDir = dirname(dirname(fixture.root));
  const lockPath = join(dataDir, "index-run.lock");
  writeFileSync(lockPath, "", { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  const finder = spawnSync("/bin/sh", ["-c", "command -v flock"], { encoding: "utf8" });
  assert.equal(finder.status, 0);
  const flockBin = finder.stdout.trim();
  const childPath = join(fixture.home, "lock-check.mjs");
  const moduleUrl = new URL("../scripts/retire-pi-raw-mirror.mjs", import.meta.url).href;
  writeFileSync(
    childPath,
    `import { assertCassWriterLock } from ${JSON.stringify(moduleUrl)};\nassertCassWriterLock({ root: process.env.RAW_ROOT });\n`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'exec 9>>"$LOCK_PATH"; "$FLOCK_BIN" -x 9; AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$FLOCK_BIN" node "$LOCK_CHILD"',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FLOCK_BIN: flockBin,
        LOCK_CHILD: childPath,
        LOCK_PATH: lockPath,
        RAW_ROOT: fixture.root,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("an unlocked inherited descriptor cannot borrow another process's Cass lock", async () => {
  const fixture = fixtureHome();
  const dataDir = dirname(dirname(fixture.root));
  const lockPath = join(dataDir, "index-run.lock");
  writeFileSync(lockPath, "", { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  const finder = spawnSync("/bin/sh", ["-c", "command -v flock"], { encoding: "utf8" });
  assert.equal(finder.status, 0);
  const flockBin = finder.stdout.trim();
  const childPath = join(fixture.home, "lock-owner-check.mjs");
  const moduleUrl = new URL("../scripts/retire-pi-raw-mirror.mjs", import.meta.url).href;
  writeFileSync(
    childPath,
    `import { assertCassWriterLock } from ${JSON.stringify(moduleUrl)};\nassertCassWriterLock({ root: process.env.RAW_ROOT });\n`,
    { mode: 0o600 },
  );

  const holder = spawn(
    flockBin,
    ["-x", lockPath, "-c", "printf 'ready\\n'; read release"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let startTimer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        holder.stdout.once("data", (data) => {
          if (data.toString().includes("ready")) resolve();
          else reject(new Error(`unexpected lock-holder output: ${data}`));
        });
        holder.once("error", reject);
      }),
      new Promise((_, reject) => {
        startTimer = setTimeout(() => reject(new Error("lock holder did not start")), 5000);
      }),
    ]);
    clearTimeout(startTimer);
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        'exec 9>>"$LOCK_PATH"; AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$FLOCK_BIN" node "$LOCK_CHILD"',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FLOCK_BIN: flockBin,
          LOCK_CHILD: childPath,
          LOCK_PATH: lockPath,
          RAW_ROOT: fixture.root,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not own Cass's exclusive lock/);
  } finally {
    clearTimeout(startTimer);
    holder.stdin.write("\n");
    holder.stdin.end();
    await once(holder, "exit");
  }
});

test("a crash after journal unlink leaves a provably empty operation that converges", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "1" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterStateUnlink: () => {
            throw simulatedCrash("crash after state unlink");
          },
        },
      }),
    /crash after state unlink/,
  );
  const operations = operationDirectories(fixture.root);
  assert.equal(operations.length, 1);
  assert.deepEqual(readdirSync(join(fixture.root, operations[0])), ["phase.04.deleting.json"]);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);

  const resumed = applyRetirement(fixture.home);
  assert.equal(resumed.manifest_count, 0);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("a journal-less operation never authorizes shaped-file deletion", () => {
  const fixture = fixtureHome();
  const operation = join(
    fixture.root,
    `.agentchats-retirement.${"a".repeat(32)}`,
  );
  privateDirectory(operation);
  const shaped = join(operation, `phase.01.claiming.${"b".repeat(32)}.json`);
  writeFileSync(shaped, "foreign", { mode: 0o600 });
  chmodSync(shaped, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /journal-less retirement operation is not empty/);
  assert.throws(() => applyRetirement(fixture.home), /journal-less retirement operation is not empty/);
  assert.equal(readFileSync(shaped, "utf8"), "foreign");
});

test("a regenerable partial owner cannot authorize a same-user foreign prepared journal", () => {
  const fixture = fixtureHome();
  writeCapture(fixture, { idCharacter: "a", blobCharacter: "a" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterPublicationOwnerCreate: ({ targetName }) => {
            if (targetName === "state.json") throw simulatedCrash("leave partial state owner");
          },
        },
      }),
    /leave partial state owner/,
  );
  const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
  const ownerName = readdirSync(operation).find((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name));
  assert.ok(ownerName);
  const owner = join(operation, ownerName);
  const state = join(operation, "state.json");
  writeFileSync(state, "foreign", { mode: 0o600 });
  chmodSync(state, 0o600);

  assert.throws(
    () => applyRetirement(fixture.home),
    /not an exact canonical prefix/,
  );
  assert.ok(readFileSync(owner).length > 0);
  assert.equal(readFileSync(state, "utf8"), "foreign");
});

test("a foreign occupant preserves a valid partial phase receipt and its owner", () => {
  const fixture = fixtureHome();
  writeCapture(fixture, { idCharacter: "a", blobCharacter: "4" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          phaseReceiptWriteChunkBytes: 1,
          afterPhaseReceiptChunk: ({ phase, offset }) => {
            if (phase === "claiming" && offset === 1) {
              throw simulatedCrash("crash with a valid partial phase receipt");
            }
          },
        },
      }),
    /crash with a valid partial phase receipt/,
  );
  const operation = join(fixture.root, operationDirectories(fixture.root)[0]);
  const owner = readdirSync(operation).find((name) => PUBLICATION_OWNER_NAME_FOR_TEST.test(name));
  const receipt = PHASE_RECEIPTS_FOR_TEST.claiming.name;
  assert.ok(owner);
  assert.equal(readFileSync(join(operation, receipt)).length, 1);
  const foreign = join(operation, "foreign");
  writeFileSync(foreign, "foreign\n", { mode: 0o600 });
  chmodSync(foreign, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /unexpected retirement operation occupant/);
  assert.equal(readFileSync(foreign, "utf8"), "foreign\n");
  assert.equal(existsSync(join(operation, owner)), true);
  assert.equal(readFileSync(join(operation, receipt)).length, 1);
  assert.equal(existsSync(join(operation, "state.json")), true);
});

test("an identical foreign inode at a verification-view name is refused and preserved", () => {
  const fixture = fixtureHome();
  writeCapture(fixture, { idCharacter: "a", blobCharacter: "3" });
  let foreignPath;
  let foreignInode;
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        claimedVerifier: ({ opPath, journal }) => {
          const entry = journal.manifests[0];
          const source = join(opPath, "claimed", ...entry.relative_path.split("/"));
          foreignPath = join(
            opPath,
            "verify-data",
            "raw-mirror",
            "v1",
            ...entry.relative_path.split("/"),
          );
          privateDirectory(dirname(foreignPath));
          writeFileSync(foreignPath, readFileSync(source), { mode: 0o600 });
          chmodSync(foreignPath, 0o600);
          foreignInode = lstatSync(foreignPath, { bigint: true }).ino;
        },
      }),
    /verification view name is occupied by a foreign inode/,
  );
  assert.equal(lstatSync(foreignPath, { bigint: true }).ino, foreignInode);
  assert.match(readFileSync(foreignPath, "utf8"), /"provider": "pi_agent"/);
  assert.equal(operationDirectories(fixture.root).length, 1);
});

test("a foreign third hard link blocks verification cleanup without consuming any link", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "4" });
  const cassBin = fakeCassVerifier(fixture, retired);
  const foreignLink = join(fixture.home, "foreign-third-link");
  let source;
  let destination;

  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        claimedVerifier: ({ opPath, journal }) =>
          verifyClaimedWithCass({
            opPath,
            journal,
            cassBin,
            hooks: {
              afterVerificationLink: (details) => {
                if (details.entry.kind !== "manifest") return;
                ({ source, destination } = details);
                linkSync(source, foreignLink);
              },
            },
          }),
      }),
    /3 hard links/,
  );

  const sourceMetadata = lstatSync(source, { bigint: true });
  const destinationMetadata = lstatSync(destination, { bigint: true });
  const foreignMetadata = lstatSync(foreignLink, { bigint: true });
  assert.equal(sourceMetadata.ino, destinationMetadata.ino);
  assert.equal(sourceMetadata.ino, foreignMetadata.ino);
  assert.equal(sourceMetadata.nlink, 3n);
  assert.equal(operationDirectories(fixture.root).length, 1);
});

test("an ENOSPC link-publication failure restores every target without payload copying", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "5" });
  const foreign = writeForeignCapture(fixture);
  const cassBin = fakeCassVerifier(fixture, retired);

  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        claimedVerifier: ({ opPath, journal }) =>
          verifyClaimedWithCass({
            opPath,
            journal,
            cassBin,
            hooks: {
              beforeVerificationLink: ({ entry }) => {
                if (entry.kind !== "blob") return;
                const error = new Error("simulated verification-link ENOSPC");
                error.code = "ENOSPC";
                throw error;
              },
            },
          }),
      }),
    /simulated verification-link ENOSPC/,
  );

  assert.match(readFileSync(retired.manifestPath, "utf8"), /"provider": "pi_agent"/);
  assert.equal(readFileSync(retired.blobPath, "utf8"), "a-session");
  assertForeignCapturePreserved(foreign);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("every verification-view link is gone before claimed reproof and deletion", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "6" });
  const cassBin = fakeCassVerifier(fixture, retired);
  let checkedAfterDoctor = false;
  let checkedBeforeDelete = 0;
  let activeOperation;
  let activeJournal;
  const assertNoVerificationLinks = ({ allowDeleted = false } = {}) => {
    for (const entry of [...activeJournal.manifests, ...activeJournal.blobs]) {
      const { source, destination } = verificationViewPaths(activeOperation, entry);
      assert.equal(existsSync(destination), false);
      if (allowDeleted && !existsSync(source)) continue;
      assert.equal(lstatSync(source, { bigint: true }).nlink, 1n);
    }
  };

  const applied = retirePiRawMirror({
    home: fixture.home,
    apply: true,
    cassBin,
    lockAssertion: () => {},
    exclusionAssertion: () => {},
    hooks: {
      afterDoctor: ({ opPath, journal }) => {
        activeOperation = opPath;
        activeJournal = journal;
        assertNoVerificationLinks();
        checkedAfterDoctor = true;
      },
      beforeDelete: () => {
        assertNoVerificationLinks({ allowDeleted: true });
        checkedBeforeDelete += 1;
      },
    },
  });

  assert.equal(applied.changed, true);
  assert.equal(checkedAfterDoctor, true);
  assert.equal(checkedBeforeDelete, 2);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("pre-deleting recovery coalesces an identical recreated live target", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "4" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterClaim: ({ index }) => {
            if (index === 1) throw simulatedCrash("crash after blob claim");
          },
        },
      }),
    /crash after blob claim/,
  );
  writeFileSync(retired.blobPath, "a-session", { mode: 0o600 });
  chmodSync(retired.blobPath, 0o600);

  applyRetirement(fixture.home);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.equal(existsSync(retired.blobPath), false);
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("pre-deleting recovery refuses a mismatched recreated live target", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "5" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterClaim: ({ index }) => {
            if (index === 1) throw simulatedCrash("crash after blob claim");
          },
        },
      }),
    /crash after blob claim/,
  );
  writeFileSync(retired.blobPath, "foreign bytes", { mode: 0o600 });
  chmodSync(retired.blobPath, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /does not match the journaled content/);
  assert.equal(operationDirectories(fixture.root).length, 1);
});

test("deleting recovery preserves an identical blob with active-provider provenance", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "6" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterJournalPhase: (phase) => {
            if (phase === "deleting") throw simulatedCrash("crash before deletion");
          },
        },
      }),
    /crash before deletion/,
  );
  const active = writeCapture(fixture, {
    idCharacter: "b",
    blobCharacter: "6",
    provider: "codex",
    bytes: Buffer.from("a-session"),
  });

  applyRetirement(fixture.home);
  assert.equal(existsSync(retired.manifestPath), false);
  assert.match(readFileSync(active.manifestPath, "utf8"), /"provider": "codex"/);
  assert.equal(readFileSync(active.blobPath, "utf8"), "a-session");
  assert.deepEqual(operationDirectories(fixture.root), []);
});

test("deleting recovery refuses an identical but unreferenced recreated blob", () => {
  const fixture = fixtureHome();
  const retired = writeCapture(fixture, { idCharacter: "a", blobCharacter: "7" });
  assert.throws(
    () =>
      applyRetirement(fixture.home, {
        hooks: {
          afterJournalPhase: (phase) => {
            if (phase === "deleting") throw simulatedCrash("crash before deletion");
          },
        },
      }),
    /crash before deletion/,
  );
  writeFileSync(retired.blobPath, "a-session", { mode: 0o600 });
  chmodSync(retired.blobPath, 0o600);

  assert.throws(() => applyRetirement(fixture.home), /no active-provider provenance/);
  assert.equal(operationDirectories(fixture.root).length, 1);
});

test("a replaced live lock path is rejected before mutation", () => {
  const fixture = fixtureHome();
  const dataDir = dirname(dirname(fixture.root));
  const lockPath = join(dataDir, "index-run.lock");
  const movedLock = join(dataDir, "index-run.lock.old");
  writeFileSync(lockPath, "", { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  const finder = spawnSync("/bin/sh", ["-c", "command -v flock"], { encoding: "utf8" });
  assert.equal(finder.status, 0);
  const flockBin = finder.stdout.trim();
  const helper = new URL("../scripts/retire-pi-raw-mirror.mjs", import.meta.url).pathname;
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'exec 9>>"$LOCK_PATH"; "$FLOCK_BIN" -x 9; mv "$LOCK_PATH" "$MOVED_LOCK"; : >"$LOCK_PATH"; chmod 600 "$LOCK_PATH"; AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$FLOCK_BIN" HOME="$FIXTURE_HOME" node "$HELPER" --assert-lock',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_HOME: fixture.home,
        FLOCK_BIN: flockBin,
        HELPER: helper,
        LOCK_PATH: lockPath,
        MOVED_LOCK: movedLock,
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /descriptor is not Cass's index-run.lock inode/);
});

test("receipt CLI mutation requires and retains Cass's exact writer lock", () => {
  const fixture = fixtureHome();
  const dataDir = dirname(dirname(fixture.root));
  const lockPath = join(dataDir, "index-run.lock");
  writeFileSync(lockPath, "", { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  const finder = spawnSync("/bin/sh", ["-c", "command -v flock"], { encoding: "utf8" });
  assert.equal(finder.status, 0);
  const flockBin = finder.stdout.trim();
  const helper = new URL("../scripts/retire-pi-raw-mirror.mjs", import.meta.url).pathname;

  const unlocked = spawnSync(process.execPath, [helper, "--mark-pending"], {
    encoding: "utf8",
    env: { ...process.env, FLOCK_BIN: flockBin, HOME: fixture.home },
  });
  assert.notEqual(unlocked.status, 0);
  assert.match(unlocked.stderr, /requires the inherited Cass writer-lock descriptor/);
  assert.equal(existsSync(retirementReceiptPath(fixture.home)), false);

  const locked = spawnSync(
    "/bin/bash",
    [
      "-c",
      'exec 9>>"$LOCK_PATH"; "$FLOCK_BIN" -x 9; AGENTCHATS_RETIREMENT_LOCK_FD=9 node "$HELPER" --mark-pending; AGENTCHATS_RETIREMENT_LOCK_FD=9 node "$HELPER" --clear-pending',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FLOCK_BIN: flockBin,
        HELPER: helper,
        HOME: fixture.home,
        LOCK_PATH: lockPath,
      },
    },
  );
  assert.equal(locked.status, 0, locked.stderr || locked.stdout);
  const lines = locked.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { pending: true, changed: true },
    { pending: false, changed: true },
  ]);
  assert.equal(existsSync(retirementReceiptPath(fixture.home)), false);
});

test(
  "installed Cass rejects forged canonical metadata and corrupt bytes before accepting a real capture",
  { skip: !process.env.CASS_BIN_INTEGRATION },
  () => {
    const cassBin = process.env.CASS_BIN_INTEGRATION;
    const home = mkdtempSync(join(realpathSync(tmpdir()), "agentchats-cass-integration-"));
    homes.push(home);
    chmodSync(home, 0o700);
    const root = expectedRawMirrorRoot(home);
    const dataDir = dirname(dirname(root));
    const piRoot = join(home, ".pi", "agent");
    const sessions = join(piRoot, "sessions", "--integration--");
    privateDirectory(sessions);
    const sessionPath = join(
      sessions,
      "2026-08-31T00-00-00-000Z_abc12345-1234-5678-9abc-def012345678.jsonl",
    );
    writeFileSync(
      sessionPath,
      [
        '{"type":"session","id":"abc12345-1234-5678-9abc-def012345678","timestamp":"2026-08-31T00:00:00.000Z","cwd":"/tmp/integration","provider":"anthropic","modelId":"test","thinkingLevel":"off"}',
        '{"type":"message","timestamp":"2026-08-31T00:00:01.000Z","message":{"role":"user","content":"integration proof"}}',
        '{"type":"message","timestamp":"2026-08-31T00:00:02.000Z","message":{"role":"assistant","content":"verified"}}',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(sessionPath, 0o600);

    const capabilities = spawnSync(cassBin, ["capabilities", "--json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(capabilities.status, 0, capabilities.stderr || capabilities.stdout);
    const connectors = JSON.parse(capabilities.stdout).connectors;
    assert.ok(connectors.includes("pi_agent"));
    const disabled = connectors.filter((connector) => connector !== "pi_agent");
    const xdgConfig = join(home, ".config");
    privateDirectory(join(xdgConfig, "cass"));
    writeFileSync(
      join(xdgConfig, "cass", "sources.toml"),
      `disabled_agents = ${JSON.stringify(disabled)}\n`,
      { mode: 0o600 },
    );

    const cassEnvironment = {
      ...process.env,
      CASS_DATA_DIR: dataDir,
      HOME: home,
      PI_CODING_AGENT_DIR: piRoot,
      XDG_CONFIG_HOME: xdgConfig,
    };
    const indexed = spawnSync(cassBin, ["index", "--full", "--force-rebuild"], {
      encoding: "utf8",
      env: cassEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);

    const plan = retirePiRawMirror({ home });
    assert.equal(plan.manifest_count, 1);
    assert.equal(plan.blob_count, 1);
    const manifestName = readdirSync(join(root, "manifests"))[0];
    const manifestPath = join(root, "manifests", manifestName);
    const originalManifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(originalManifestBytes.toString("utf8"));
    const blobPath = join(root, ...manifest.blob_relative_path.split("/"));
    const originalBlobBytes = readFileSync(blobPath);

    const forgedSuffix = manifest.manifest_blake3.endsWith("0") ? "1" : "0";
    const forged = {
      ...manifest,
      manifest_blake3: `${manifest.manifest_blake3.slice(0, -1)}${forgedSuffix}`,
    };
    writeFileSync(manifestPath, `${JSON.stringify(forged, null, 2)}\n`, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    assert.throws(
      () =>
        applyRetirement(home, {
          cassBin,
          claimedVerifier: undefined,
        }),
      /fully verify|corroborate|verification summary/,
    );
    assert.equal(existsSync(manifestPath), true);
    assert.equal(existsSync(blobPath), true);
    assert.deepEqual(operationDirectories(root), []);

    writeFileSync(manifestPath, originalManifestBytes, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    const corruptBlob = Buffer.from(originalBlobBytes);
    corruptBlob[0] ^= 0xff;
    writeFileSync(blobPath, corruptBlob, { mode: 0o600 });
    chmodSync(blobPath, 0o600);
    assert.throws(
      () =>
        applyRetirement(home, {
          cassBin,
          claimedVerifier: undefined,
        }),
      /fully verify|corroborate|verification summary/,
    );
    assert.equal(existsSync(manifestPath), true);
    assert.equal(existsSync(blobPath), true);
    assert.deepEqual(operationDirectories(root), []);

    writeFileSync(blobPath, originalBlobBytes, { mode: 0o600 });
    chmodSync(blobPath, 0o600);
    const applied = retirePiRawMirror({
      home,
      apply: true,
      cassBin,
      lockAssertion: () => {},
      exclusionAssertion: () => {},
    });
    assert.equal(applied.changed, true);
    assert.equal(existsSync(manifestPath), false);
    assert.equal(existsSync(blobPath), false);
    assert.deepEqual(operationDirectories(root), []);
  },
);
