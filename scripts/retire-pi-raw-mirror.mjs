#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const RAW_MIRROR_COMPONENTS = [
  "Library",
  "Application Support",
  "com.coding-agent-search.coding-agent-search",
  "raw-mirror",
  "v1",
];
const MANIFEST_KIND = "cass_raw_session_mirror_v1";
const MANIFEST_ID = /^doctor-raw-mirror-manifest-id-v1-[0-9a-f]{64}$/;
const BLAKE3 = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET_PROVIDER = "pi_agent";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_STATE_IDENTITY_BYTES = 16 * 1024;
const CASS_COMMAND_TIMEOUT_SECONDS = 1800;
const TIMEOUT_RUNNER = fileURLToPath(new URL("./run-with-timeout", import.meta.url));
const RECEIPT_DOCUMENT = {
  schema_version: 1,
  retirement: "pi_agent",
  state: "pending",
};
const RECEIPT_BYTES = Buffer.from(`${JSON.stringify(RECEIPT_DOCUMENT)}\n`);
const OPERATION_PREFIX = ".agentchats-retirement.";
const OPERATION_NAME = /^\.agentchats-retirement\.[0-9a-f]{32}$/;
const PUBLICATION_OWNER_NAME = /^\.publication\.owner\.([0-9a-f]{64})\.json$/;
const STATE_IDENTITY_NAME = "state.identity.json";
const PHASE_SPECS = Object.freeze([
  { previous: "prepared", phase: "claiming", name: "phase.01.claiming.json" },
  { previous: "claiming", phase: "claimed", name: "phase.02.claimed.json" },
  { previous: "claimed", phase: "verified", name: "phase.03.verified.json" },
  { previous: "verified", phase: "deleting", name: "phase.04.deleting.json" },
]);
const PHASE_BY_NAME = new Map(PHASE_SPECS.map((spec) => [spec.name, spec]));
const PHASE_BY_PHASE = new Map(PHASE_SPECS.map((spec) => [spec.phase, spec]));
const RESTORATION_CLEANUP_NAME = "terminal.restoration.json";
const RESTORABLE_PHASES = new Set(["prepared", "claiming", "claimed", "verified"]);
const JOURNAL_KEYS = ["schema_version", "operation", "phase", "manifests", "blobs"];
const JOURNAL_ENTRY_KEYS = ["relative_path", "identity", "sha256"];
const IDENTITY_KEYS = ["dev", "ino", "uid", "mode", "nlink", "size", "mtime_ns"];
const STATE_IDENTITY_KEYS = ["schema_version", "operation", "journal_sha256", "identity"];
const PHASE_RECEIPT_KEYS = [
  "schema_version",
  "operation",
  "journal_sha256",
  "previous_phase",
  "phase",
];
const DELETING_PHASE_RECEIPT_KEYS = [...PHASE_RECEIPT_KEYS, "journal_base64"];
const RESTORATION_CLEANUP_KEYS = [
  "schema_version",
  "operation",
  "journal_sha256",
  "restored_from_phase",
  "journal_base64",
];
const PUBLICATION_OWNER_KEYS = [
  "schema_version",
  "operation",
  "target_name",
  "target_sha256",
  "target_base64",
];
const MAX_PUBLICATION_OWNER_BYTES = 3 * MAX_MANIFEST_BYTES;
const MANIFEST_KEYS = [
  "schema_version",
  "manifest_kind",
  "manifest_id",
  "blob_hash_algorithm",
  "blob_blake3",
  "blob_relative_path",
  "blob_size_bytes",
  "provider",
  "source_id",
  "origin_kind",
  "origin_host",
  "original_path",
  "redacted_original_path",
  "original_path_blake3",
  "captured_at_ms",
  "source_mtime_ms",
  "source_size_bytes",
  "compression",
  "encryption",
  "db_links",
  "verification",
  "manifest_blake3",
];
const COMPRESSION_KEYS = ["state", "algorithm", "uncompressed_size_bytes"];
const ENCRYPTION_KEYS = ["state", "algorithm", "key_id", "envelope_version"];
const DB_LINK_KEYS = ["conversation_id", "message_count", "source_path", "started_at_ms"];
const VERIFICATION_KEYS = ["status", "verifier", "content_blake3", "verified_at_ms"];

export class RetirementRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "RetirementRefusal";
  }
}

function refuse(message) {
  throw new RetirementRefusal(message);
}

function modeBits(metadata) {
  return Number(metadata.mode & 0o777n);
}

function currentUid() {
  if (typeof process.getuid !== "function") refuse("ownership checks require a Unix user id");
  return BigInt(process.getuid());
}

function lstatMaybe(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function exactKeys(value, keys, description) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse(`${description} is not an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    refuse(`${description} has an unexpected key set`);
  }
}

function requireOwnedDirectory(path, { privateMode = false } = {}) {
  const metadata = lstatMaybe(path);
  if (!metadata) refuse(`required directory is missing: ${path}`);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    refuse(`refusing non-directory or symlink path: ${path}`);
  }
  if (metadata.uid !== currentUid()) refuse(`refusing directory owned by another user: ${path}`);
  const mode = modeBits(metadata);
  if ((mode & 0o022) !== 0) {
    refuse(`refusing group/world-writable directory ${path} (${mode.toString(8)})`);
  }
  if (privateMode && mode !== 0o700) {
    refuse(`expected mode 0700 on ${path}, found ${mode.toString(8).padStart(4, "0")}`);
  }
  return metadata;
}

function requireOwnedFileMetadata(
  path,
  metadata,
  expectedMode = 0o600,
  allowedLinks = [1n],
) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    refuse(`refusing non-regular or symlink file: ${path}`);
  }
  if (metadata.uid !== currentUid()) refuse(`refusing file owned by another user: ${path}`);
  const mode = modeBits(metadata);
  if (mode !== expectedMode) {
    refuse(
      `expected mode ${expectedMode.toString(8).padStart(4, "0")} on ${path}, found ${mode
        .toString(8)
        .padStart(4, "0")}`,
    );
  }
  if (!allowedLinks.includes(metadata.nlink)) {
    refuse(`refusing file with ${metadata.nlink} hard links: ${path}`);
  }
}

function sameOpenIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function serializedIdentity(metadata) {
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    uid: metadata.uid.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
    mtime_ns: metadata.mtimeNs.toString(),
  };
}

function identityMatches(metadata, expected) {
  return IDENTITY_KEYS.every((key) => {
    const field = key === "mtime_ns" ? "mtimeNs" : key;
    return metadata[field].toString() === expected[key];
  });
}

function identityMatchesExceptLinkCount(metadata, expected) {
  return IDENTITY_KEYS.filter((key) => key !== "nlink").every((key) => {
    const field = key === "mtime_ns" ? "mtimeNs" : key;
    return metadata[field].toString() === expected[key];
  });
}

function inspectSecureFile(
  path,
  {
    expectedSize,
    maxBytes,
    minBytes = 1,
    includeBytes = false,
    allowedLinks = [1n],
  } = {},
) {
  const before = lstatMaybe(path);
  if (!before) refuse(`required file is missing: ${path}`);
  requireOwnedFileMetadata(path, before, 0o600, allowedLinks);
  if (expectedSize !== undefined && before.size !== BigInt(expectedSize)) {
    refuse(`file size does not match its manifest: ${path}`);
  }
  if (
    maxBytes !== undefined &&
    (before.size < BigInt(minBytes) || before.size > BigInt(maxBytes))
  ) {
    refuse(`file size is outside the safe range: ${path}`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    refuse(`could not securely open ${path}: ${error.message}`);
  }

  try {
    const opened = fstatSync(descriptor, { bigint: true });
    requireOwnedFileMetadata(path, opened, 0o600, allowedLinks);
    if (!sameOpenIdentity(before, opened)) refuse(`file changed while it was opened: ${path}`);

    const hash = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      if (includeBytes) chunks.push(Buffer.from(chunk));
      total += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameOpenIdentity(opened, after) || BigInt(total) !== opened.size) {
      refuse(`file changed while it was read: ${path}`);
    }
    return {
      identity: before,
      sha256: hash.digest("hex"),
      bytes: includeBytes ? Buffer.concat(chunks, total) : undefined,
    };
  } finally {
    closeSync(descriptor);
  }
}

function requireObject(value, field, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse(`manifest ${path} has invalid ${field}`);
  }
}

function requireString(value, field, path, { nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    refuse(`manifest ${path} has invalid ${field}`);
  }
}

function requireInteger(value, field, path, { nullable = false, nonnegative = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) {
    refuse(`manifest ${path} has invalid ${field}`);
  }
}

function isDescendant(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function readSecureManifest(path) {
  const inspected = inspectSecureFile(path, {
    maxBytes: MAX_MANIFEST_BYTES,
    includeBytes: true,
  });
  let manifest;
  try {
    manifest = JSON.parse(inspected.bytes.toString("utf8"));
  } catch (error) {
    refuse(`malformed JSON manifest ${path}: ${error.message}`);
  }
  return { manifest, identity: inspected.identity, sha256: inspected.sha256 };
}

function validateManifest(path, manifest, home) {
  exactKeys(manifest, MANIFEST_KEYS, `manifest ${path}`);
  if (manifest.schema_version !== 1 || manifest.manifest_kind !== MANIFEST_KIND) {
    refuse(`manifest ${path} is not a supported raw-mirror v1 manifest`);
  }
  requireString(manifest.manifest_id, "manifest_id", path);
  if (!MANIFEST_ID.test(manifest.manifest_id)) refuse(`manifest ${path} has an invalid manifest_id`);
  if (basename(path) !== `${manifest.manifest_id}.json`) {
    refuse(`manifest filename does not match manifest_id: ${path}`);
  }
  if (manifest.blob_hash_algorithm !== "blake3" || !BLAKE3.test(manifest.blob_blake3)) {
    refuse(`manifest ${path} has an invalid blob digest contract`);
  }
  const expectedBlob = `blobs/blake3/${manifest.blob_blake3.slice(0, 2)}/${manifest.blob_blake3}.raw`;
  if (manifest.blob_relative_path !== expectedBlob) {
    refuse(`manifest ${path} has an invalid content-addressed blob path`);
  }
  requireInteger(manifest.blob_size_bytes, "blob_size_bytes", path, { nonnegative: true });
  requireString(manifest.provider, "provider", path);
  requireString(manifest.source_id, "source_id", path);
  requireString(manifest.origin_kind, "origin_kind", path);
  if (manifest.origin_host !== null && typeof manifest.origin_host !== "string") {
    refuse(`manifest ${path} has invalid origin_host`);
  }
  requireString(manifest.original_path, "original_path", path);
  if (!isAbsolute(manifest.original_path)) refuse(`manifest ${path} has a non-absolute original_path`);
  requireString(manifest.redacted_original_path, "redacted_original_path", path);
  if (!BLAKE3.test(manifest.original_path_blake3)) {
    refuse(`manifest ${path} has an invalid original_path_blake3`);
  }
  requireInteger(manifest.captured_at_ms, "captured_at_ms", path);
  requireInteger(manifest.source_mtime_ms, "source_mtime_ms", path, { nullable: true });
  requireInteger(manifest.source_size_bytes, "source_size_bytes", path, { nonnegative: true });

  exactKeys(manifest.compression, COMPRESSION_KEYS, `manifest ${path} compression`);
  requireString(manifest.compression.state, "compression.state", path);
  if (manifest.compression.algorithm !== null && typeof manifest.compression.algorithm !== "string") {
    refuse(`manifest ${path} has invalid compression.algorithm`);
  }
  requireInteger(
    manifest.compression.uncompressed_size_bytes,
    "compression.uncompressed_size_bytes",
    path,
    { nullable: true, nonnegative: true },
  );

  exactKeys(manifest.encryption, ENCRYPTION_KEYS, `manifest ${path} encryption`);
  requireString(manifest.encryption.state, "encryption.state", path);
  for (const field of ["algorithm", "key_id"]) {
    if (manifest.encryption[field] !== null && typeof manifest.encryption[field] !== "string") {
      refuse(`manifest ${path} has invalid encryption.${field}`);
    }
  }
  requireInteger(manifest.encryption.envelope_version, "encryption.envelope_version", path, {
    nullable: true,
    nonnegative: true,
  });

  if (!Array.isArray(manifest.db_links)) refuse(`manifest ${path} has invalid db_links`);
  for (const [index, link] of manifest.db_links.entries()) {
    exactKeys(link, DB_LINK_KEYS, `manifest ${path} db_links[${index}]`);
    requireInteger(link.conversation_id, `db_links[${index}].conversation_id`, path, {
      nullable: true,
      nonnegative: true,
    });
    requireInteger(link.message_count, `db_links[${index}].message_count`, path, {
      nonnegative: true,
    });
    requireString(link.source_path, `db_links[${index}].source_path`, path);
    requireInteger(link.started_at_ms, `db_links[${index}].started_at_ms`, path, {
      nullable: true,
    });
  }

  exactKeys(manifest.verification, VERIFICATION_KEYS, `manifest ${path} verification`);
  requireString(manifest.verification.status, "verification.status", path);
  requireString(manifest.verification.verifier, "verification.verifier", path);
  if (
    manifest.verification.content_blake3 !== null &&
    !BLAKE3.test(manifest.verification.content_blake3)
  ) {
    refuse(`manifest ${path} has invalid verification.content_blake3`);
  }
  requireInteger(manifest.verification.verified_at_ms, "verification.verified_at_ms", path, {
    nullable: true,
  });
  if (typeof manifest.manifest_blake3 !== "string" || !/^doctor-raw-mirror-manifest-v1-[0-9a-f]{64}$/.test(manifest.manifest_blake3)) {
    refuse(`manifest ${path} has an invalid manifest_blake3`);
  }

  const targetSessionRoot = join(home, ".pi", "agent", "sessions");
  const hasTargetProvider = manifest.provider === TARGET_PROVIDER;
  const hasTargetPath = isDescendant(targetSessionRoot, manifest.original_path);
  if (hasTargetProvider !== hasTargetPath) {
    refuse(`manifest ${path} has inconsistent retired-provider provenance`);
  }
  if (hasTargetProvider) {
    if (
      manifest.source_id !== "local" ||
      manifest.origin_kind !== "local" ||
      manifest.origin_host !== null ||
      manifest.compression.state !== "none" ||
      manifest.encryption.state !== "none" ||
      manifest.verification.status !== "captured" ||
      manifest.verification.verifier !== "cass_indexer" ||
      manifest.verification.content_blake3 !== manifest.blob_blake3 ||
      !manifest.redacted_original_path.startsWith(`[${TARGET_PROVIDER}]/`)
    ) {
      refuse(`manifest ${path} does not match the exact retired local-capture contract`);
    }
    for (const [index, link] of manifest.db_links.entries()) {
      if (link.source_path !== manifest.original_path) {
        refuse(`manifest ${path} has foreign db_links[${index}].source_path`);
      }
    }
  }
  return { target: hasTargetProvider, expectedBlob };
}

export function expectedRawMirrorRoot(home = homedir()) {
  return join(resolve(home), ...RAW_MIRROR_COMPONENTS);
}

function validateRoot(home, root) {
  const resolvedHome = resolve(home);
  const expected = expectedRawMirrorRoot(resolvedHome);
  if (resolve(root) !== expected) refuse(`refusing unexpected raw-mirror root: ${root}`);
  if (!lstatMaybe(expected)) return false;

  let current = resolvedHome;
  requireOwnedDirectory(current);
  if (realpathSync(current) !== current) refuse(`refusing symlinked home path: ${current}`);
  for (const component of RAW_MIRROR_COMPONENTS) {
    current = join(current, component);
    requireOwnedDirectory(current, { privateMode: component === "raw-mirror" || component === "v1" });
    if (realpathSync(current) !== current) {
      refuse(`refusing symlinked raw-mirror path component: ${current}`);
    }
  }
  return true;
}

function requireNoVerificationSidecars(root) {
  const verificationDirectory = join(root, "verification");
  if (!lstatMaybe(verificationDirectory)) return;
  requireOwnedDirectory(verificationDirectory, { privateMode: true });
  if (realpathSync(verificationDirectory) !== verificationDirectory) {
    refuse(`refusing symlinked verification directory: ${verificationDirectory}`);
  }
  const entries = readdirSync(verificationDirectory);
  if (entries.length > 0) {
    refuse(
      `raw-mirror verification sidecars are present but this Cass release cannot corroborate them: ${verificationDirectory}`,
    );
  }
}

function scanManifestGraph({ home, root }) {
  if (!validateRoot(home, root)) return { references: new Map(), targets: [] };
  requireNoVerificationSidecars(root);
  const manifestsDirectory = join(root, "manifests");
  requireOwnedDirectory(manifestsDirectory, { privateMode: true });
  const entries = readdirSync(manifestsDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const references = new Map();
  const targets = [];
  for (const entry of entries) {
    const manifestPath = join(manifestsDirectory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      refuse(`refusing unexpected manifest directory entry: ${manifestPath}`);
    }
    if (!/^doctor-raw-mirror-manifest-id-v1-[0-9a-f]{64}\.json$/.test(entry.name)) {
      refuse(`refusing unexpected manifest filename: ${manifestPath}`);
    }
    const { manifest, identity, sha256 } = readSecureManifest(manifestPath);
    const validated = validateManifest(manifestPath, manifest, home);
    const reference = {
      manifestPath,
      relativePath: relative(root, manifestPath),
      manifest,
      identity,
      sha256,
      target: validated.target,
    };
    const existing = references.get(validated.expectedBlob) ?? [];
    existing.push(reference);
    references.set(validated.expectedBlob, existing);
    if (validated.target) targets.push(reference);
  }
  return { references, targets };
}

function buildPlan({ home, root }) {
  if (!validateRoot(home, root)) return { manifests: [], blobs: [], bytes: 0 };
  const graph = scanManifestGraph({ home, root });
  const blobs = [];
  const seenBlobs = new Map();
  for (const target of graph.targets) {
    const blobRelativePath = target.manifest.blob_relative_path;
    const allReferences = graph.references.get(blobRelativePath) ?? [];
    if (allReferences.some((reference) => !reference.target)) {
      refuse(`refusing shared raw-mirror blob referenced by an active provider: ${blobRelativePath}`);
    }
    const previousSize = seenBlobs.get(blobRelativePath);
    if (previousSize !== undefined && previousSize !== target.manifest.blob_size_bytes) {
      refuse(`target manifests disagree about raw-mirror blob size: ${blobRelativePath}`);
    }
    if (previousSize !== undefined) continue;
    seenBlobs.set(blobRelativePath, target.manifest.blob_size_bytes);

    const blobPath = join(root, blobRelativePath);
    const prefixDirectory = dirname(blobPath);
    requireOwnedDirectory(join(root, "blobs"), { privateMode: true });
    requireOwnedDirectory(join(root, "blobs", "blake3"), { privateMode: true });
    requireOwnedDirectory(prefixDirectory, { privateMode: true });
    if (realpathSync(prefixDirectory) !== prefixDirectory) {
      refuse(`refusing symlinked raw-mirror blob directory: ${prefixDirectory}`);
    }
    const inspected = inspectSecureFile(blobPath, {
      expectedSize: target.manifest.blob_size_bytes,
    });
    blobs.push({
      path: blobPath,
      relativePath: blobRelativePath,
      identity: inspected.identity,
      sha256: inspected.sha256,
      size: target.manifest.blob_size_bytes,
    });
  }
  return {
    manifests: graph.targets.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath)),
    blobs: blobs.sort((left, right) => left.path.localeCompare(right.path)),
    bytes: blobs.reduce((total, blob) => total + blob.size, 0),
  };
}

// The Cass exclusion path can leave the retired conversation's no-FK tail
// cache row behind even after its canonical conversation is gone. Expose the
// conversation ids from the same fully validated raw-mirror plan so the
// archive helper can remove only cache rows with independently proven Pi
// provenance. A missing raw mirror is an empty plan; callers must still refuse
// any unproven dangling cache rows.
export function retiredConversationIds({ home = homedir() } = {}) {
  const resolvedHome = resolve(home);
  const root = expectedRawMirrorRoot(resolvedHome);
  const plan = buildPlan({ home: resolvedHome, root });
  return [
    ...new Set(
      plan.manifests.flatMap((entry) =>
        entry.manifest.db_links
          .map((link) => link.conversation_id)
          .filter((id) => Number.isSafeInteger(id) && id >= 0),
      ),
    ),
  ].sort((left, right) => left - right);
}

function planKey(plan) {
  return JSON.stringify({
    manifests: plan.manifests.map((entry) => ({
      path: entry.relativePath,
      identity: serializedIdentity(entry.identity),
      sha256: entry.sha256,
    })),
    blobs: plan.blobs.map((entry) => ({
      path: entry.relativePath,
      identity: serializedIdentity(entry.identity),
      sha256: entry.sha256,
    })),
  });
}

function scanLiveReferences({ home, root, targetBlobPaths }) {
  const graph = scanManifestGraph({ home, root });
  if (graph.targets.length > 0) refuse("a retired-provider manifest reappeared during retirement");
  for (const blobPath of targetBlobPaths) {
    const references = graph.references.get(blobPath) ?? [];
    if (references.length > 0) {
      refuse(`a live provider now references a claimed raw-mirror blob: ${blobPath}`);
    }
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensurePrivateDirectory(path) {
  const existing = lstatMaybe(path);
  if (existing) {
    requireOwnedDirectory(path, { privateMode: true });
    if (realpathSync(path) !== path) refuse(`refusing symlinked private directory: ${path}`);
    return;
  }
  const parent = dirname(path);
  requireOwnedDirectory(parent, { privateMode: true });
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  requireOwnedDirectory(path, { privateMode: true });
  fsyncDirectory(parent);
}

function retirementReceiptPath(home = homedir()) {
  return join(resolve(home), ".local", "state", "agentchats", "pi-retirement-v1.pending.json");
}

function ensureOwnedDirectory(path, { createMode = 0o700, privateMode = false } = {}) {
  if (!lstatMaybe(path)) {
    const parent = dirname(path);
    requireOwnedDirectory(parent);
    mkdirSync(path, { mode: createMode });
    chmodSync(path, createMode);
    fsyncDirectory(parent);
  }
  const metadata = requireOwnedDirectory(path, { privateMode });
  if (realpathSync(path) !== path) refuse(`refusing symlinked receipt directory: ${path}`);
  return metadata;
}

function ensureReceiptDirectory(home) {
  const resolvedHome = resolve(home);
  requireOwnedDirectory(resolvedHome);
  if (realpathSync(resolvedHome) !== resolvedHome) refuse(`refusing symlinked home path: ${resolvedHome}`);
  ensureOwnedDirectory(join(resolvedHome, ".local"));
  ensureOwnedDirectory(join(resolvedHome, ".local", "state"));
  const directory = join(resolvedHome, ".local", "state", "agentchats");
  ensureOwnedDirectory(directory, {
    privateMode: true,
  });
  return directory;
}

function readRetirementReceipt(home, { required = false, allowPartial = false } = {}) {
  const path = retirementReceiptPath(home);
  if (!lstatMaybe(path)) {
    if (required) refuse(`retirement-pending receipt is missing: ${path}`);
    return null;
  }
  const inspected = inspectSecureFile(path, {
    maxBytes: RECEIPT_BYTES.length,
    minBytes: 0,
    includeBytes: true,
  });
  if (inspected.bytes.equals(RECEIPT_BYTES)) {
    return {
      path,
      state: "complete",
      identity: inspected.identity,
      sha256: inspected.sha256,
      bytes: inspected.bytes,
    };
  }
  if (
    allowPartial &&
    inspected.bytes.length < RECEIPT_BYTES.length &&
    RECEIPT_BYTES.subarray(0, inspected.bytes.length).equals(inspected.bytes)
  ) {
    return {
      path,
      state: "partial",
      identity: inspected.identity,
      sha256: inspected.sha256,
      bytes: inspected.bytes,
    };
  }
  refuse("retirement-pending receipt has unexpected content");
}

export function retirementPendingStatus({ home = homedir() } = {}) {
  return readRetirementReceipt(resolve(home), { allowPartial: true }) !== null;
}

export function markRetirementPending({ home = homedir(), hooks = {} } = {}) {
  const resolvedHome = resolve(home);
  const directory = ensureReceiptDirectory(resolvedHome);
  const path = retirementReceiptPath(resolvedHome);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let receipt = readRetirementReceipt(resolvedHome, { allowPartial: true });
  if (receipt?.state === "complete") return false;

  let descriptor;
  let created = false;
  if (!receipt) {
    try {
      descriptor = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      receipt = readRetirementReceipt(resolvedHome, { required: true, allowPartial: true });
      if (receipt.state === "complete") return false;
    }
  }

  if (!created) {
    descriptor = openSync(path, constants.O_RDWR | noFollow);
  }

  try {
    if (created) {
      fchmodSync(descriptor, 0o600);
      fsyncDirectory(directory);
    }
    const opened = fstatSync(descriptor, { bigint: true });
    requireOwnedFileMetadata(path, opened);
    if (created) {
      receipt = {
        path,
        state: "partial",
        identity: opened,
        bytes: Buffer.alloc(0),
      };
      hooks.afterReceiptCreate?.({ path });
    } else if (!sameOpenIdentity(receipt.identity, opened)) {
      refuse("retirement-pending receipt changed before completion");
    }
    let offset = receipt.bytes.length;
    while (offset < RECEIPT_BYTES.length) {
      const count = writeSync(
        descriptor,
        RECEIPT_BYTES,
        offset,
        RECEIPT_BYTES.length - offset,
        offset,
      );
      if (count <= 0) refuse("could not complete retirement-pending receipt");
      offset += count;
    }
    fsyncSync(descriptor);
    hooks.afterReceiptWrite?.({ path });
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(directory);
  readRetirementReceipt(resolvedHome, { required: true });
  return true;
}

export function clearRetirementPending({ home = homedir() } = {}) {
  const resolvedHome = resolve(home);
  const receipt = readRetirementReceipt(resolvedHome);
  if (!receipt) return false;
  requireSecureRecord(
    receipt.path,
    { identity: serializedIdentity(receipt.identity), sha256: receipt.sha256 },
    "retirement-pending receipt",
  );
  unlinkSync(receipt.path);
  fsyncDirectory(dirname(receipt.path));
  return true;
}

function ensureRelativeDirectories(base, relativePath) {
  let current = base;
  ensurePrivateDirectory(current);
  for (const component of dirname(relativePath).split(sep)) {
    if (!component || component === "." || component === "..") {
      refuse(`refusing invalid relative directory component in ${relativePath}`);
    }
    current = join(current, component);
    ensurePrivateDirectory(current);
  }
}

function secureRecordMatches(path, entry) {
  const inspected = inspectSecureFile(path);
  return identityMatches(inspected.identity, entry.identity) && inspected.sha256 === entry.sha256;
}

function requireSecureRecord(path, entry, description) {
  if (!secureRecordMatches(path, entry)) refuse(`${description} does not match its journal receipt: ${path}`);
}

function entryFromPlan(relativePath, identity, sha256) {
  return {
    relative_path: relativePath,
    identity: serializedIdentity(identity),
    sha256,
  };
}

function operationPath(root, operation) {
  if (!OPERATION_NAME.test(operation)) refuse(`invalid retirement operation name: ${operation}`);
  const path = join(root, operation);
  if (dirname(path) !== root) refuse(`retirement operation escaped the raw-mirror root: ${path}`);
  return path;
}

function validateJournalEntry(entry, kind) {
  exactKeys(entry, JOURNAL_ENTRY_KEYS, `${kind} journal entry`);
  exactKeys(entry.identity, IDENTITY_KEYS, `${kind} journal identity`);
  for (const key of IDENTITY_KEYS) {
    if (typeof entry.identity[key] !== "string" || !/^[0-9]+$/.test(entry.identity[key])) {
      refuse(`${kind} journal identity has invalid ${key}`);
    }
  }
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
    refuse(`${kind} journal entry has an invalid sha256`);
  }
  if (typeof entry.relative_path !== "string") refuse(`${kind} journal entry has no path`);
  if (
    kind === "manifest" &&
    !/^manifests\/doctor-raw-mirror-manifest-id-v1-[0-9a-f]{64}\.json$/.test(
      entry.relative_path,
    )
  ) {
    refuse(`manifest journal entry has a non-canonical path: ${entry.relative_path}`);
  }
  if (
    kind === "blob" &&
    !/^blobs\/blake3\/[0-9a-f]{2}\/[0-9a-f]{64}\.raw$/.test(entry.relative_path)
  ) {
    refuse(`blob journal entry has a non-canonical path: ${entry.relative_path}`);
  }
  const components = entry.relative_path.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    refuse(`${kind} journal entry has an unsafe path: ${entry.relative_path}`);
  }
}

function validateJournal(journal, operation) {
  exactKeys(journal, JOURNAL_KEYS, "retirement journal");
  if (journal.schema_version !== 1) refuse("retirement journal has an unsupported schema");
  if (journal.operation !== operation) refuse("retirement journal operation name does not match");
  if (journal.phase !== "prepared") {
    refuse("retirement journal is not the immutable prepared state");
  }
  if (!Array.isArray(journal.manifests) || journal.manifests.length === 0) {
    refuse("retirement journal has no manifests");
  }
  if (!Array.isArray(journal.blobs) || journal.blobs.length === 0) {
    refuse("retirement journal has no blobs");
  }
  journal.manifests.forEach((entry) => validateJournalEntry(entry, "manifest"));
  journal.blobs.forEach((entry) => validateJournalEntry(entry, "blob"));
  for (const entries of [journal.manifests, journal.blobs]) {
    const paths = entries.map((entry) => entry.relative_path);
    if (new Set(paths).size !== paths.length) refuse("retirement journal repeats a target path");
  }
  return journal;
}

function journalPath(opPath) {
  return join(opPath, "state.json");
}

function stateIdentityPath(opPath) {
  return join(opPath, STATE_IDENTITY_NAME);
}

function canonicalDocumentBytes(document, { pretty = false } = {}) {
  return Buffer.from(`${JSON.stringify(document, null, pretty ? 2 : undefined)}\n`);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicationOwnerDocument(operation, targetName, targetBytes) {
  return {
    schema_version: 1,
    operation,
    target_name: targetName,
    target_sha256: sha256Bytes(targetBytes),
    target_base64: targetBytes.toString("base64"),
  };
}

function publicationOwnerBytes(operation, targetName, targetBytes) {
  return canonicalDocumentBytes(publicationOwnerDocument(operation, targetName, targetBytes));
}

function publicationOwnerPath(opPath, ownerBytes) {
  return join(opPath, `.publication.owner.${sha256Bytes(ownerBytes)}.json`);
}

function inspectPublicationOwner(path, operation) {
  if (!PUBLICATION_OWNER_NAME.test(basename(path))) {
    refuse(`invalid retirement publication owner name: ${path}`);
  }
  const inspected = inspectSecureFile(path, {
    maxBytes: MAX_PUBLICATION_OWNER_BYTES,
    minBytes: 0,
    includeBytes: true,
  });
  let document;
  try {
    document = JSON.parse(inspected.bytes.toString("utf8"));
  } catch (error) {
    refuse(`retirement publication owner receipt is malformed: ${error.message}`);
  }
  exactKeys(document, PUBLICATION_OWNER_KEYS, "retirement publication owner receipt");
  if (document.schema_version !== 1) {
    refuse("retirement publication owner receipt has an unsupported schema");
  }
  if (document.operation !== operation) {
    refuse("retirement publication owner receipt operation does not match");
  }
  if (typeof document.target_name !== "string" || basename(document.target_name) !== document.target_name) {
    refuse("retirement publication owner receipt has an unsafe target name");
  }
  if (typeof document.target_sha256 !== "string" || !SHA256.test(document.target_sha256)) {
    refuse("retirement publication owner receipt has an invalid target digest");
  }
  if (typeof document.target_base64 !== "string") {
    refuse("retirement publication owner receipt has invalid target bytes");
  }
  const targetBytes = Buffer.from(document.target_base64, "base64");
  if (targetBytes.toString("base64") !== document.target_base64) {
    refuse("retirement publication owner receipt has non-canonical target bytes");
  }
  if (sha256Bytes(targetBytes) !== document.target_sha256) {
    refuse("retirement publication owner receipt target digest does not match its bytes");
  }
  const canonical = canonicalDocumentBytes(document);
  if (!canonical.equals(inspected.bytes)) {
    refuse("retirement publication owner receipt is not canonical");
  }
  return {
    document,
    targetBytes,
    receipt: {
      identity: serializedIdentity(inspected.identity),
      sha256: inspected.sha256,
    },
  };
}

function writePublicationOwner(opPath, targetName, targetBytes, hooks = {}) {
  const operation = basename(opPath);
  const bytes = publicationOwnerBytes(operation, targetName, targetBytes);
  const path = publicationOwnerPath(opPath, bytes);
  writeCanonicalTarget(opPath, basename(path), bytes, {
    hooks: { ...hooks, publicationOwnerTargetName: targetName },
    description: "retirement publication owner receipt",
  });
  return { path, ...inspectPublicationOwner(path, operation) };
}

function inspectCanonicalPrefix(path, expectedBytes, description) {
  const inspected = inspectSecureFile(path, {
    maxBytes: expectedBytes.length,
    minBytes: 0,
    includeBytes: true,
  });
  if (!expectedBytes.subarray(0, inspected.bytes.length).equals(inspected.bytes)) {
    refuse(`${description} is not an exact canonical prefix`);
  }
  return {
    complete: inspected.bytes.length === expectedBytes.length,
    bytes: inspected.bytes,
    receipt: {
      identity: serializedIdentity(inspected.identity),
      sha256: inspected.sha256,
    },
    identity: inspected.identity,
  };
}

function writeCanonicalTarget(
  opPath,
  targetName,
  targetBytes,
  { hooks = {}, requireAbsent = false, description = "retirement publication" } = {},
) {
  const targetPath = join(opPath, targetName);
  const existing = lstatMaybe(targetPath);
  if (existing && requireAbsent) {
    refuse(`${description} path is already occupied: ${targetPath}`);
  }
  let prefix = existing ? inspectCanonicalPrefix(targetPath, targetBytes, description) : null;

  let descriptor;
  let created = false;
  if (!prefix) {
    try {
      descriptor = openSync(
        targetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (error?.code === "EEXIST") {
        refuse(`${description} path became occupied: ${targetPath}`);
      }
      throw error;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    fsyncDirectory(opPath);
    prefix = {
      complete: targetBytes.length === 0,
      identity: fstatSync(descriptor, { bigint: true }),
    };
    created = true;
  } else if (!prefix.complete) {
    descriptor = openSync(targetPath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameOpenIdentity(prefix.identity, opened)) {
      closeSync(descriptor);
      refuse(`${description} changed before exact-prefix recovery: ${targetPath}`);
    }
  }

  try {
    if (created) {
      hooks.afterPublicationTargetCreate?.({ opPath, targetPath, targetName });
      if (PUBLICATION_OWNER_NAME.test(targetName)) {
        hooks.afterPublicationOwnerCreate?.({
          opPath,
          ownerPath: targetPath,
          targetName: hooks.publicationOwnerTargetName,
        });
      }
    }
    if (descriptor === undefined || prefix.complete) return prefix.receipt;
    const start = Number(prefix.identity.size);
    const requestedChunkSize = PUBLICATION_OWNER_NAME.test(targetName)
      ? hooks.publicationOwnerWriteChunkBytes ?? hooks.publicationWriteChunkBytes
      : targetName === "state.json"
        ? hooks.journalWriteChunkBytes
        : targetName.startsWith("phase.")
          ? hooks.phaseReceiptWriteChunkBytes
          : hooks.publicationWriteChunkBytes;
    const chunkSize =
      Number.isSafeInteger(requestedChunkSize) && requestedChunkSize > 0
        ? requestedChunkSize
        : targetBytes.length;
    let offset = start;
    while (offset < targetBytes.length) {
      const length = Math.min(chunkSize, targetBytes.length - offset);
      const count = writeSync(descriptor, targetBytes, offset, length, offset);
      if (count <= 0) refuse(`could not publish ${description}`);
      offset += count;
      hooks.afterPublicationTargetChunk?.({
        opPath,
        targetPath,
        targetName,
        offset,
        total: targetBytes.length,
      });
      if (PUBLICATION_OWNER_NAME.test(targetName)) {
        hooks.afterPublicationOwnerChunk?.({
          opPath,
          ownerPath: targetPath,
          targetName: hooks.publicationOwnerTargetName,
          offset,
          total: targetBytes.length,
        });
      }
      if (targetName.startsWith("phase.")) {
        hooks.afterPhaseReceiptChunk?.({
          opPath,
          targetPath,
          targetName,
          phase: PHASE_BY_NAME.get(targetName)?.phase,
          offset,
          total: targetBytes.length,
        });
      }
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(opPath);
  hooks.afterPublicationTargetSync?.({ opPath, targetPath, targetName });
  if (PUBLICATION_OWNER_NAME.test(targetName)) {
    hooks.afterPublicationOwnerSync?.({
      opPath,
      ownerPath: targetPath,
      targetName: hooks.publicationOwnerTargetName,
    });
  }
  const completed = inspectCanonicalPrefix(targetPath, targetBytes, description);
  if (!completed.complete) refuse(`${description} remained partial after publication`);
  return completed.receipt;
}

function removePublicationOwner(opPath, owner) {
  requireSecureRecord(
    owner.path,
    owner.receipt,
    "retirement publication owner receipt",
  );
  unlinkSync(owner.path);
  fsyncDirectory(opPath);
}

function publishExclusiveFile(opPath, targetName, targetBytes, hooks = {}) {
  requireOwnedDirectory(opPath, { privateMode: true });
  const owner = writePublicationOwner(opPath, targetName, targetBytes, hooks);
  try {
    const receipt = writeCanonicalTarget(opPath, targetName, targetBytes, {
      hooks,
      requireAbsent: true,
      description: `${targetName} publication`,
    });
    removePublicationOwner(opPath, owner);
    return receipt;
  } catch (error) {
    if (error instanceof RetirementRefusal && /path (?:is already|became) occupied/.test(error.message)) {
      removePublicationOwner(opPath, owner);
    }
    throw error;
  }
}

function inspectJournalFile(path, operation, description) {
  const inspected = inspectSecureFile(path, { maxBytes: MAX_MANIFEST_BYTES, includeBytes: true });
  let journal;
  try {
    journal = JSON.parse(inspected.bytes.toString("utf8"));
  } catch (error) {
    refuse(`${description} is malformed: ${error.message}`);
  }
  validateJournal(journal, operation);
  if (!canonicalDocumentBytes(journal, { pretty: true }).equals(inspected.bytes)) {
    refuse(`${description} is not canonical`);
  }
  return {
    journal,
    receipt: {
      identity: serializedIdentity(inspected.identity),
      sha256: inspected.sha256,
    },
  };
}

function readJournalFile(path, operation, description) {
  return inspectJournalFile(path, operation, description).journal;
}

function readJournal(opPath) {
  return readJournalFile(journalPath(opPath), basename(opPath), "retirement journal");
}

function stateIdentityDocument(operation, journalReceipt) {
  return {
    schema_version: 1,
    operation,
    journal_sha256: journalReceipt.sha256,
    identity: journalReceipt.identity,
  };
}

function inspectStateIdentity(path, operation, journalReceipt) {
  const inspected = inspectSecureFile(path, {
    maxBytes: MAX_STATE_IDENTITY_BYTES,
    includeBytes: true,
  });
  let document;
  try {
    document = JSON.parse(inspected.bytes.toString("utf8"));
  } catch (error) {
    refuse(`retirement journal identity receipt is malformed: ${error.message}`);
  }
  exactKeys(document, STATE_IDENTITY_KEYS, "retirement journal identity receipt");
  exactKeys(document.identity, IDENTITY_KEYS, "retirement journal identity");
  const expected = stateIdentityDocument(operation, journalReceipt);
  if (
    document.schema_version !== 1 ||
    document.operation !== operation ||
    document.journal_sha256 !== journalReceipt.sha256 ||
    JSON.stringify(document.identity) !== JSON.stringify(journalReceipt.identity)
  ) {
    refuse("retirement journal identity receipt does not match the immutable prepared state");
  }
  if (!canonicalDocumentBytes(document).equals(inspected.bytes)) {
    refuse("retirement journal identity receipt is not canonical");
  }
  return {
    document,
    receipt: {
      identity: serializedIdentity(inspected.identity),
      sha256: inspected.sha256,
    },
    expected,
  };
}

function writeStateIdentity(opPath, journalReceipt, hooks = {}, { requireAbsent = false } = {}) {
  const document = stateIdentityDocument(basename(opPath), journalReceipt);
  const bytes = canonicalDocumentBytes(document);
  if (bytes.length > MAX_STATE_IDENTITY_BYTES) {
    refuse("retirement journal identity receipt exceeds its recoverable size limit");
  }
  const receipt = writeCanonicalTarget(opPath, STATE_IDENTITY_NAME, bytes, {
    hooks,
    requireAbsent,
    description: "retirement journal identity receipt",
  });
  inspectStateIdentity(stateIdentityPath(opPath), basename(opPath), journalReceipt);
  return receipt;
}

function phaseReceiptDocument(operation, journalSha256, spec, journal) {
  const document = {
    schema_version: 1,
    operation,
    journal_sha256: journalSha256,
    previous_phase: spec.previous,
    phase: spec.phase,
  };
  if (spec.phase === "deleting") {
    if (!journal) refuse("deleting phase receipt requires the immutable prepared journal");
    document.journal_base64 = canonicalDocumentBytes(journal, { pretty: true }).toString("base64");
  }
  return document;
}

function inspectPhaseReceipt(path, operation, journalSha256, spec, journal) {
  const expected = phaseReceiptDocument(operation, journalSha256, spec, journal);
  const expectedBytes = canonicalDocumentBytes(expected);
  const prefix = inspectCanonicalPrefix(path, expectedBytes, `${spec.phase} phase receipt`);
  if (!prefix.complete) refuse(`${spec.phase} phase receipt is partial without an owner`);
  let document;
  try {
    document = JSON.parse(prefix.bytes.toString("utf8"));
  } catch (error) {
    refuse(`${spec.phase} phase receipt is malformed: ${error.message}`);
  }
  exactKeys(
    document,
    spec.phase === "deleting" ? DELETING_PHASE_RECEIPT_KEYS : PHASE_RECEIPT_KEYS,
    `${spec.phase} phase receipt`,
  );
  if (JSON.stringify(document) !== JSON.stringify(expected)) {
    refuse(`${spec.phase} phase receipt does not match its monotonic transition`);
  }
  return { document, receipt: prefix.receipt, expectedBytes };
}

function inspectStandaloneDeletingReceipt(path, operation) {
  const inspected = inspectSecureFile(path, { maxBytes: 2 * MAX_MANIFEST_BYTES, includeBytes: true });
  let document;
  try {
    document = JSON.parse(inspected.bytes.toString("utf8"));
  } catch (error) {
    refuse(`deleting phase receipt is malformed: ${error.message}`);
  }
  exactKeys(document, DELETING_PHASE_RECEIPT_KEYS, "deleting phase receipt");
  if (
    document.schema_version !== 1 ||
    document.operation !== operation ||
    document.previous_phase !== "verified" ||
    document.phase !== "deleting" ||
    typeof document.journal_sha256 !== "string" ||
    !SHA256.test(document.journal_sha256) ||
    typeof document.journal_base64 !== "string"
  ) {
    refuse("deleting phase receipt does not match its monotonic transition");
  }
  const journalBytes = Buffer.from(document.journal_base64, "base64");
  if (journalBytes.toString("base64") !== document.journal_base64) {
    refuse("deleting phase receipt has non-canonical journal bytes");
  }
  if (sha256Bytes(journalBytes) !== document.journal_sha256) {
    refuse("deleting phase receipt journal digest does not match its bytes");
  }
  let journal;
  try {
    journal = JSON.parse(journalBytes.toString("utf8"));
  } catch (error) {
    refuse(`deleting phase receipt contains malformed prepared state: ${error.message}`);
  }
  validateJournal(journal, operation);
  if (!canonicalDocumentBytes(journal, { pretty: true }).equals(journalBytes)) {
    refuse("deleting phase receipt does not bind canonical prepared state");
  }
  const expected = phaseReceiptDocument(operation, document.journal_sha256, PHASE_BY_PHASE.get("deleting"), journal);
  if (!canonicalDocumentBytes(expected).equals(inspected.bytes)) {
    refuse("deleting phase receipt is not canonical");
  }
  return {
    document,
    journal,
    journalBytes,
    receipt: {
      identity: serializedIdentity(inspected.identity),
      sha256: inspected.sha256,
    },
  };
}

function restorationCleanupDocument(operation, journalSha256, restoredFromPhase, journal) {
  if (!RESTORABLE_PHASES.has(restoredFromPhase)) {
    refuse(`invalid restoration cleanup source phase: ${restoredFromPhase}`);
  }
  return {
    schema_version: 1,
    operation,
    journal_sha256: journalSha256,
    restored_from_phase: restoredFromPhase,
    journal_base64: canonicalDocumentBytes(journal, { pretty: true }).toString("base64"),
  };
}

function inspectStandaloneRestorationCleanup(path, operation) {
  const inspected = inspectSecureFile(path, {
    maxBytes: 2 * MAX_MANIFEST_BYTES,
    includeBytes: true,
  });
  let document;
  try {
    document = JSON.parse(inspected.bytes.toString("utf8"));
  } catch (error) {
    refuse(`restoration cleanup receipt is malformed: ${error.message}`);
  }
  exactKeys(document, RESTORATION_CLEANUP_KEYS, "restoration cleanup receipt");
  if (
    document.schema_version !== 1 ||
    document.operation !== operation ||
    typeof document.journal_sha256 !== "string" ||
    !SHA256.test(document.journal_sha256) ||
    !RESTORABLE_PHASES.has(document.restored_from_phase) ||
    typeof document.journal_base64 !== "string"
  ) {
    refuse("restoration cleanup receipt has an invalid contract");
  }
  const journalBytes = Buffer.from(document.journal_base64, "base64");
  if (journalBytes.toString("base64") !== document.journal_base64) {
    refuse("restoration cleanup receipt has non-canonical journal bytes");
  }
  if (sha256Bytes(journalBytes) !== document.journal_sha256) {
    refuse("restoration cleanup receipt journal digest does not match its bytes");
  }
  let journal;
  try {
    journal = JSON.parse(journalBytes.toString("utf8"));
  } catch (error) {
    refuse(`restoration cleanup receipt contains malformed prepared state: ${error.message}`);
  }
  validateJournal(journal, operation);
  if (!canonicalDocumentBytes(journal, { pretty: true }).equals(journalBytes)) {
    refuse("restoration cleanup receipt does not bind canonical prepared state");
  }
  const expected = restorationCleanupDocument(
    operation,
    document.journal_sha256,
    document.restored_from_phase,
    journal,
  );
  if (!canonicalDocumentBytes(expected).equals(inspected.bytes)) {
    refuse("restoration cleanup receipt is not canonical");
  }
  return {
    document,
    journal,
    journalBytes,
    receipt: {
      identity: serializedIdentity(inspected.identity),
      sha256: inspected.sha256,
    },
  };
}

function publishPreparedJournal(opPath, journal, hooks = {}) {
  validateJournal(journal, basename(opPath));
  const journalBytes = canonicalDocumentBytes(journal, { pretty: true });
  const owner = writePublicationOwner(opPath, "state.json", journalBytes, hooks);
  let journalReceipt;
  try {
    journalReceipt = writeCanonicalTarget(opPath, "state.json", journalBytes, {
      hooks,
      requireAbsent: true,
      description: "immutable prepared retirement journal",
    });
  } catch (error) {
    if (error instanceof RetirementRefusal && /path (?:is already|became) occupied/.test(error.message)) {
      removePublicationOwner(opPath, owner);
    }
    throw error;
  }
  writeStateIdentity(opPath, journalReceipt, hooks, { requireAbsent: true });
  removePublicationOwner(opPath, owner);
  return journalReceipt;
}

function preparedJournal(operation, plan) {
  return {
    schema_version: 1,
    operation,
    phase: "prepared",
    manifests: plan.manifests.map((entry) =>
      entryFromPlan(entry.relativePath, entry.identity, entry.sha256),
    ),
    blobs: plan.blobs.map((entry) =>
      entryFromPlan(entry.relativePath, entry.identity, entry.sha256),
    ),
  };
}

function retirementOverhead(journal) {
  const journalBytes = canonicalDocumentBytes(journal, { pretty: true });
  const journalSha256 = sha256Bytes(journalBytes);
  const phaseBytes = PHASE_SPECS.map((spec) =>
    canonicalDocumentBytes(
      phaseReceiptDocument(journal.operation, journalSha256, spec, journal),
    ),
  );
  const restorationBytes = canonicalDocumentBytes(
    restorationCleanupDocument(journal.operation, journalSha256, "verified", journal),
  );
  const publicationTargets = [
    ["state.json", journalBytes],
    ...PHASE_SPECS.map((spec, index) => [spec.name, phaseBytes[index]]),
    [RESTORATION_CLEANUP_NAME, restorationBytes],
  ];
  for (const [targetName, targetBytes] of publicationTargets) {
    if (
      publicationOwnerBytes(journal.operation, targetName, targetBytes).length >
      MAX_PUBLICATION_OWNER_BYTES
    ) {
      refuse("retirement publication owner exceeds its recoverable size limit");
    }
  }
  if (journalBytes.length > MAX_MANIFEST_BYTES) {
    refuse("prepared retirement journal exceeds its recoverable size limit");
  }
  const deletingBytes = phaseBytes.at(-1);
  if (deletingBytes.length > 2 * MAX_MANIFEST_BYTES) {
    refuse("terminal deleting receipt exceeds its standalone recovery size limit");
  }
  if (restorationBytes.length > 2 * MAX_MANIFEST_BYTES) {
    refuse("terminal restoration receipt exceeds its standalone recovery size limit");
  }

  const stateOwnerBytes = publicationOwnerBytes(
    journal.operation,
    "state.json",
    journalBytes,
  );
  let durableBytes = journalBytes.length + MAX_STATE_IDENTITY_BYTES;
  let peakReceiptBytes = stateOwnerBytes.length + durableBytes;
  for (const [index, spec] of PHASE_SPECS.entries()) {
    const targetBytes = phaseBytes[index];
    const ownerBytes = publicationOwnerBytes(
      journal.operation,
      spec.name,
      targetBytes,
    );
    peakReceiptBytes = Math.max(
      peakReceiptBytes,
      durableBytes + ownerBytes.length + targetBytes.length,
    );
    durableBytes += targetBytes.length;
  }
  const preDeletingBytes =
    journalBytes.length +
    MAX_STATE_IDENTITY_BYTES +
    phaseBytes.slice(0, -1).reduce((total, bytes) => total + bytes.length, 0);
  const restorationOwnerBytes = publicationOwnerBytes(
    journal.operation,
    RESTORATION_CLEANUP_NAME,
    restorationBytes,
  );
  peakReceiptBytes = Math.max(
    peakReceiptBytes,
    preDeletingBytes + restorationOwnerBytes.length + restorationBytes.length,
  );
  return {
    peakExtraPayloadBytes: 0,
    peakExtraReceiptBytesUpperBound: peakReceiptBytes,
    verificationLinkCount: journal.manifests.length + journal.blobs.length,
  };
}

function setRetirementOverhead(result, journal) {
  const overhead = retirementOverhead(journal);
  result.peak_extra_payload_bytes = overhead.peakExtraPayloadBytes;
  result.peak_extra_receipt_bytes_upper_bound = overhead.peakExtraReceiptBytesUpperBound;
  result.verification_link_count = overhead.verificationLinkCount;
}

function createTransaction(root, plan, hooks = {}) {
  requireOwnedDirectory(root, { privateMode: true });
  const operation = `${OPERATION_PREFIX}${randomBytes(16).toString("hex")}`;
  const journal = preparedJournal(operation, plan);
  retirementOverhead(journal);
  const opPath = operationPath(root, operation);
  if (lstatMaybe(opPath)) refuse(`fresh retirement operation path already exists: ${opPath}`);
  mkdirSync(opPath, { mode: 0o700 });
  chmodSync(opPath, 0o700);
  requireOwnedDirectory(opPath, { privateMode: true });
  fsyncDirectory(root);
  const receipt = publishPreparedJournal(opPath, journal, hooks);
  hooks.afterJournalPhase?.("prepared", opPath);
  return { opPath, journal, receipt };
}

function discoverTransactions(root) {
  if (!lstatMaybe(root)) return [];
  requireOwnedDirectory(root, { privateMode: true });
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(OPERATION_PREFIX)) continue;
    const path = join(root, entry.name);
    if (!OPERATION_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      refuse(`refusing malformed retirement operation occupant: ${path}`);
    }
    requireOwnedDirectory(path, { privateMode: true });
    if (realpathSync(path) !== path) refuse(`refusing symlinked retirement operation: ${path}`);
    matches.push(path);
  }
  if (matches.length > 1) refuse("multiple retirement operations exist; refusing ambiguous recovery");
  return matches;
}

function journalEntries(journal) {
  return [
    ...journal.manifests.map((entry) => ({ ...entry, kind: "manifest" })),
    ...journal.blobs.map((entry) => ({ ...entry, kind: "blob" })),
  ];
}

function claimedPath(opPath, entry) {
  const base = join(opPath, "claimed");
  const path = join(base, ...entry.relative_path.split("/"));
  if (!isDescendant(base, path)) refuse(`claimed path escaped its operation: ${path}`);
  return path;
}

function originalPath(root, entry) {
  const path = join(root, ...entry.relative_path.split("/"));
  if (!isDescendant(root, path)) refuse(`journal path escaped the raw-mirror root: ${path}`);
  return path;
}

function verificationViewPath(opPath, entry) {
  const base = join(opPath, "verify-data", "raw-mirror", "v1");
  const path = join(base, ...entry.relative_path.split("/"));
  if (!isDescendant(base, path)) refuse(`verification path escaped its operation: ${path}`);
  return path;
}

function walkPrivateTree(path, base = path, entries = []) {
  requireOwnedDirectory(path, { privateMode: true });
  if (realpathSync(path) !== path) refuse(`refusing symlinked operation directory: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const rel = relative(base, child).split(sep).join("/");
    if (entry.isSymbolicLink()) refuse(`refusing symlink in retirement operation: ${child}`);
    if (entry.isDirectory()) {
      entries.push({ path: child, relativePath: rel, directory: true });
      walkPrivateTree(child, base, entries);
    } else if (entry.isFile()) {
      const metadata = lstatSync(child, { bigint: true });
      requireOwnedFileMetadata(child, metadata, 0o600, [1n, 2n]);
      entries.push({ path: child, relativePath: rel, directory: false });
    } else {
      refuse(`refusing non-file operation occupant: ${child}`);
    }
  }
  return entries;
}

function allowedOperationPaths(journal) {
  const files = new Set([
    "state.json",
    STATE_IDENTITY_NAME,
    RESTORATION_CLEANUP_NAME,
    ...PHASE_SPECS.map((spec) => spec.name),
  ]);
  const directories = new Set();
  const addFile = (path) => {
    files.add(path);
    let parent = dirname(path).split(sep).join("/");
    while (parent && parent !== ".") {
      directories.add(parent);
      parent = dirname(parent).split(sep).join("/");
    }
  };
  for (const entry of journalEntries(journal)) {
    addFile(`claimed/${entry.relative_path}`);
    addFile(`verify-data/raw-mirror/v1/${entry.relative_path}`);
  }
  return { files, directories };
}

function auditOperationTree(opPath, journal, { allowedJournalArtifacts = new Set() } = {}) {
  const { files, directories } = allowedOperationPaths(journal);
  for (const entry of walkPrivateTree(opPath)) {
    if (!entry.directory && allowedJournalArtifacts.has(entry.relativePath)) continue;
    const allowed = entry.directory
      ? directories.has(entry.relativePath)
      : files.has(entry.relativePath);
    if (!allowed) refuse(`unexpected retirement operation occupant: ${entry.path}`);
  }
}

function publicationOwnerEntries(entries, operation) {
  const shaped = entries.filter(
    (entry) => !entry.directory && entry.relativePath.startsWith(".publication.owner."),
  );
  for (const entry of shaped) {
    if (!PUBLICATION_OWNER_NAME.test(entry.relativePath)) {
      refuse(`malformed retirement publication owner occupant: ${entry.path}`);
    }
  }
  if (shaped.length > 1) refuse("multiple retirement publication owners exist");
  return shaped;
}

function publicationOwnerCandidate(operation, targetName, targetBytes) {
  const ownerBytes = publicationOwnerBytes(operation, targetName, targetBytes);
  return {
    ownerName: `.publication.owner.${sha256Bytes(ownerBytes)}.json`,
    ownerBytes,
    targetName,
    targetBytes,
  };
}

function resolvePublicationOwner(opPath, entry, candidates, { recover = false } = {}) {
  if (!entry) return null;
  const operation = basename(opPath);
  const candidate = candidates.find((item) => item.ownerName === entry.relativePath);
  if (!candidate) {
    refuse(`retirement publication owner does not match any authorized target: ${entry.path}`);
  }
  let prefix = inspectCanonicalPrefix(
    entry.path,
    candidate.ownerBytes,
    "retirement publication owner receipt",
  );
  if (!prefix.complete) {
    if (!recover) {
      return {
        document: publicationOwnerDocument(operation, candidate.targetName, candidate.targetBytes),
        partial: true,
        path: entry.path,
        relativePath: entry.relativePath,
        targetBytes: candidate.targetBytes,
      };
    }
    writeCanonicalTarget(opPath, entry.relativePath, candidate.ownerBytes, {
      description: "retirement publication owner receipt",
    });
    prefix = inspectCanonicalPrefix(
      entry.path,
      candidate.ownerBytes,
      "retirement publication owner receipt",
    );
    if (!prefix.complete) refuse("retirement publication owner receipt remained partial");
  }
  return {
    path: entry.path,
    relativePath: entry.relativePath,
    ...inspectPublicationOwner(entry.path, operation),
  };
}

function journalFromStateOwner(owner, operation) {
  if (owner.document.target_name !== "state.json") {
    refuse("journal-less retirement publication owner does not target state.json");
  }
  let journal;
  try {
    journal = JSON.parse(owner.targetBytes.toString("utf8"));
  } catch (error) {
    refuse(`prepared journal owner contains malformed state: ${error.message}`);
  }
  validateJournal(journal, operation);
  if (!canonicalDocumentBytes(journal, { pretty: true }).equals(owner.targetBytes)) {
    refuse("prepared journal owner does not bind canonical state bytes");
  }
  return journal;
}

function requireOwnerTarget(owner, targetName, targetBytes, description) {
  if (
    owner.document.target_name !== targetName ||
    owner.document.target_sha256 !== sha256Bytes(targetBytes) ||
    !owner.targetBytes.equals(targetBytes)
  ) {
    refuse(`${description} owner does not bind the expected target bytes`);
  }
}

function phaseReceiptEntries(entries) {
  const shaped = entries.filter(
    (entry) => entry.relativePath.startsWith("phase.") || entry.relativePath.startsWith(".phase."),
  );
  for (const entry of shaped) {
    if (entry.directory || !PHASE_BY_NAME.has(entry.relativePath)) {
      refuse(`unexpected or duplicate retirement phase receipt: ${entry.path}`);
    }
  }
  return new Map(shaped.map((entry) => [entry.relativePath, entry]));
}

function inspectRestorationCleanup(opPath, entries, ownerEntries) {
  if (ownerEntries.length > 0) return null;
  const receiptEntry = entries.find(
    (entry) => !entry.directory && entry.relativePath === RESTORATION_CLEANUP_NAME,
  );
  if (!receiptEntry) return null;
  const payloadFiles = entries.filter(
    (entry) =>
      !entry.directory &&
      (entry.relativePath.startsWith("claimed/") ||
        entry.relativePath.startsWith("verify-data/")),
  );
  if (payloadFiles.length > 0) {
    refuse("restoration cleanup receipt exists before every quarantined payload was restored");
  }

  const operation = basename(opPath);
  const restoration = inspectStandaloneRestorationCleanup(receiptEntry.path, operation);
  const journal = restoration.journal;
  auditOperationTree(opPath, journal);

  let journalReceipt = {
    identity: null,
    sha256: restoration.document.journal_sha256,
  };
  const statePath = journalPath(opPath);
  if (lstatMaybe(statePath)) {
    const inspected = inspectJournalFile(
      statePath,
      operation,
      "immutable prepared retirement journal",
    );
    requireJournalMatches(inspected.journal, journal);
    if (inspected.receipt.sha256 !== restoration.document.journal_sha256) {
      refuse("restoration cleanup receipt does not match the prepared journal");
    }
    journalReceipt = inspected.receipt;
  }

  let identityReceipt = null;
  const identityPath = stateIdentityPath(opPath);
  if (lstatMaybe(identityPath)) {
    if (!lstatMaybe(statePath)) {
      refuse("terminal restoration identity receipt remains without its prepared journal");
    }
    identityReceipt = inspectStateIdentity(
      identityPath,
      operation,
      journalReceipt,
    ).receipt;
  }

  const phaseEntries = phaseReceiptEntries(entries);
  const restoredIndex = PHASE_SPECS.findIndex(
    (spec) => spec.phase === restoration.document.restored_from_phase,
  );
  const receipts = new Map();
  for (const [index, spec] of PHASE_SPECS.entries()) {
    const entry = phaseEntries.get(spec.name);
    if (!entry) continue;
    if (restoredIndex === -1 || index > restoredIndex) {
      refuse(`${spec.phase} phase receipt is later than the restoration cleanup proof`);
    }
    const inspected = inspectPhaseReceipt(
      entry.path,
      operation,
      restoration.document.journal_sha256,
      spec,
      journal,
    );
    receipts.set(spec.name, inspected.receipt);
  }
  return {
    journal,
    journalReceipt,
    identityReceipt,
    phaseReceipts: receipts,
    restorationCleanupReceipt: restoration.receipt,
    phase: restoration.document.restored_from_phase,
    pendingPhase: "restoration-cleanup",
    terminalRestoration: true,
  };
}

function inspectTerminalCleanup(opPath, entries, ownerEntries) {
  if (ownerEntries.length > 0) return null;
  const deletingName = PHASE_BY_PHASE.get("deleting").name;
  const deletingCandidate = entries.find(
    (entry) => !entry.directory && entry.relativePath === deletingName,
  );
  if (!deletingCandidate) return null;
  const phaseEntries = phaseReceiptEntries(entries);
  const deletingEntry = phaseEntries.get(deletingName);
  const payloadFiles = entries.filter(
    (entry) =>
      !entry.directory &&
      (entry.relativePath.startsWith("claimed/") || entry.relativePath.startsWith("verify-data/")),
  );
  if (payloadFiles.length > 0) return null;

  const operation = basename(opPath);
  const deleting = inspectStandaloneDeletingReceipt(deletingEntry.path, operation);
  const journal = deleting.journal;
  auditOperationTree(opPath, journal);

  let journalReceipt = { identity: null, sha256: deleting.document.journal_sha256 };
  const statePath = journalPath(opPath);
  if (lstatMaybe(statePath)) {
    const inspected = inspectJournalFile(
      statePath,
      operation,
      "immutable prepared retirement journal",
    );
    requireJournalMatches(inspected.journal, journal);
    if (inspected.receipt.sha256 !== deleting.document.journal_sha256) {
      refuse("terminal deleting receipt does not match the prepared journal");
    }
    journalReceipt = inspected.receipt;
  }

  let identityReceipt = null;
  const identityPath = stateIdentityPath(opPath);
  if (lstatMaybe(identityPath)) {
    if (!lstatMaybe(statePath)) {
      refuse("terminal journal identity receipt remains without its prepared journal");
    }
    identityReceipt = inspectStateIdentity(
      identityPath,
      operation,
      journalReceipt,
    ).receipt;
  }

  const receipts = new Map();
  for (const spec of PHASE_SPECS) {
    const entry = phaseEntries.get(spec.name);
    if (!entry) continue;
    const inspected =
      spec.phase === "deleting"
        ? deleting
        : inspectPhaseReceipt(
            entry.path,
            operation,
            deleting.document.journal_sha256,
            spec,
            journal,
          );
    receipts.set(spec.name, inspected.receipt);
  }
  return {
    journal,
    journalReceipt,
    identityReceipt,
    phaseReceipts: receipts,
    deletingReceipt: deleting.receipt,
    phase: "deleting",
    pendingPhase: "deleting",
    terminalCleanup: true,
  };
}

function inspectJournalPublication(
  opPath,
  { recover = false, initialJournal = null, initialJournalFactory = null } = {},
) {
  const operation = basename(opPath);
  let entries = walkPrivateTree(opPath);
  let owners = publicationOwnerEntries(entries, operation);
  const ownerEntry = owners[0] ?? null;
  let owner = null;
  const statePath = journalPath(opPath);

  const restorationTerminal = inspectRestorationCleanup(opPath, entries, owners);
  if (restorationTerminal) return restorationTerminal;
  const terminal = inspectTerminalCleanup(opPath, entries, owners);
  if (terminal) return terminal;

  if (!lstatMaybe(statePath)) {
    if (entries.length === 0) {
      return { journal: null, pendingPhase: "journal-less", phase: null };
    }
    const candidateJournal = initialJournal ?? initialJournalFactory?.();
    if (entries.length !== 1 || !ownerEntry || !candidateJournal) {
      refuse(`journal-less retirement operation is not empty: ${opPath}`);
    }
    validateJournal(candidateJournal, operation);
    const journalBytes = canonicalDocumentBytes(candidateJournal, { pretty: true });
    owner = resolvePublicationOwner(
      opPath,
      ownerEntry,
      [publicationOwnerCandidate(operation, "state.json", journalBytes)],
      { recover },
    );
    journalFromStateOwner(owner, operation);
    if (recover) {
      removePublicationOwner(opPath, owner);
      entries = walkPrivateTree(opPath);
    }
    return { journal: null, pendingPhase: "journal-writing", phase: null };
  }

  let journal;
  let stateOwner = null;
  const candidateJournal = initialJournal ?? (ownerEntry ? initialJournalFactory?.() : null);
  if (
    ownerEntry &&
    candidateJournal?.manifests?.length > 0 &&
    candidateJournal?.blobs?.length > 0
  ) {
    validateJournal(candidateJournal, operation);
    const initialBytes = canonicalDocumentBytes(candidateJournal, { pretty: true });
    const initialCandidate = publicationOwnerCandidate(operation, "state.json", initialBytes);
    if (initialCandidate.ownerName === ownerEntry.relativePath) {
      owner = resolvePublicationOwner(opPath, ownerEntry, [initialCandidate], { recover });
      stateOwner = owner;
      journal = journalFromStateOwner(owner, operation);
    }
  }
  if (!journal) {
    journal = readJournal(opPath);
  }
  if (ownerEntry && !owner) {
    const journalBytes = canonicalDocumentBytes(journal, { pretty: true });
    const journalSha256 = sha256Bytes(journalBytes);
    const candidates = [publicationOwnerCandidate(operation, "state.json", journalBytes)];
    for (const spec of PHASE_SPECS) {
      const targetBytes = canonicalDocumentBytes(
        phaseReceiptDocument(operation, journalSha256, spec, journal),
      );
      candidates.push(publicationOwnerCandidate(operation, spec.name, targetBytes));
    }
    for (const restoredFromPhase of RESTORABLE_PHASES) {
      const targetBytes = canonicalDocumentBytes(
        restorationCleanupDocument(
          operation,
          journalSha256,
          restoredFromPhase,
          journal,
        ),
      );
      candidates.push(
        publicationOwnerCandidate(operation, RESTORATION_CLEANUP_NAME, targetBytes),
      );
    }
    owner = resolvePublicationOwner(opPath, ownerEntry, candidates, { recover });
    if (owner.document.target_name === "state.json") {
      stateOwner = owner;
      journal = journalFromStateOwner(owner, operation);
    }
  }
  if (stateOwner) {
    journal = journalFromStateOwner(stateOwner, operation);
  } else {
    readJournal(opPath);
  }

  auditOperationTree(opPath, journal, {
    allowedJournalArtifacts: new Set(owners.map((item) => item.relativePath)),
  });
  phaseReceiptEntries(entries);

  if (stateOwner) {
    const journalBytes = canonicalDocumentBytes(journal, { pretty: true });
    const prefix = inspectCanonicalPrefix(
      statePath,
      journalBytes,
      "immutable prepared retirement journal",
    );
    if (!prefix.complete && !recover) {
      if (entries.length !== 2) {
        refuse("partial prepared journal has unexpected companion artifacts");
      }
      return { journal, pendingPhase: "journal-writing", phase: null };
    }
    if (!prefix.complete) {
      writeCanonicalTarget(opPath, "state.json", journalBytes, {
        description: "immutable prepared retirement journal",
      });
    }
  }

  const inspectedJournal = inspectJournalFile(
    statePath,
    operation,
    "immutable prepared retirement journal",
  );
  const identityPath = stateIdentityPath(opPath);
  const identityBytes = canonicalDocumentBytes(
    stateIdentityDocument(operation, inspectedJournal.receipt),
  );
  const identityMetadata = lstatMaybe(identityPath);
  if (!identityMetadata) {
    if (!stateOwner) {
      refuse("immutable prepared retirement journal has no identity receipt");
    }
    if (!recover) {
      return { journal, pendingPhase: "journal-writing", phase: null };
    }
    writeStateIdentity(opPath, inspectedJournal.receipt, {}, { requireAbsent: true });
  } else {
    let identityPrefix;
    try {
      identityPrefix = inspectCanonicalPrefix(
        identityPath,
        identityBytes,
        "retirement journal identity receipt",
      );
    } catch (error) {
      if (!stateOwner && error instanceof RetirementRefusal) {
        refuse("retirement journal identity receipt does not match the immutable prepared state");
      }
      throw error;
    }
    if (!identityPrefix.complete) {
      if (!stateOwner) {
        refuse("partial retirement journal identity receipt has no prepared-state owner");
      }
      if (!recover) {
        return { journal, pendingPhase: "journal-writing", phase: null };
      }
      writeStateIdentity(opPath, inspectedJournal.receipt);
    }
    inspectStateIdentity(identityPath, operation, inspectedJournal.receipt);
  }

  if (stateOwner) {
    if (recover) {
      removePublicationOwner(opPath, stateOwner);
      entries = walkPrivateTree(opPath);
    }
    owner = null;
    owners = [];
  }

  const identity = inspectStateIdentity(identityPath, operation, inspectedJournal.receipt);
  const phaseEntries = phaseReceiptEntries(entries);
  const restorationOwner =
    owner?.document.target_name === RESTORATION_CLEANUP_NAME ? owner : null;
  const phaseOwner = restorationOwner ? null : owner;
  if (phaseOwner && !PHASE_BY_NAME.has(phaseOwner.document.target_name)) {
    refuse("retirement publication owner targets an unknown artifact");
  }

  const receipts = new Map();
  let phase = "prepared";
  let firstMissing = null;
  for (const [specIndex, spec] of PHASE_SPECS.entries()) {
    const entry = phaseEntries.get(spec.name);
    if (!entry) {
      if (!firstMissing) firstMissing = spec;
      continue;
    }
    if (firstMissing) {
      refuse(`out-of-order ${spec.phase} retirement phase receipt`);
    }
    const expectedBytes = canonicalDocumentBytes(
      phaseReceiptDocument(operation, inspectedJournal.receipt.sha256, spec, journal),
    );
    if (phaseOwner?.document.target_name === spec.name) {
      requireOwnerTarget(phaseOwner, spec.name, expectedBytes, `${spec.phase} phase receipt`);
      const prefix = inspectCanonicalPrefix(entry.path, expectedBytes, `${spec.phase} phase receipt`);
      if (!prefix.complete) {
        const later = PHASE_SPECS.slice(specIndex + 1).find((candidate) =>
          phaseEntries.has(candidate.name),
        );
        if (later) {
          refuse(`out-of-order ${later.phase} retirement phase receipt`);
        }
        if (!recover) {
          return {
            journal,
            journalReceipt: inspectedJournal.receipt,
            identityReceipt: identity.receipt,
            phaseReceipts: receipts,
            phase,
            pendingPhase: phase,
          };
        }
        writeCanonicalTarget(opPath, spec.name, expectedBytes, {
          description: `${spec.phase} phase receipt`,
        });
      }
    }
    const inspected = inspectPhaseReceipt(
      entry.path,
      operation,
      inspectedJournal.receipt.sha256,
      spec,
      journal,
    );
    receipts.set(spec.name, inspected.receipt);
    phase = spec.phase;
  }

  if (phaseOwner) {
    const spec = PHASE_BY_NAME.get(phaseOwner.document.target_name);
    const expectedBytes = canonicalDocumentBytes(
      phaseReceiptDocument(operation, inspectedJournal.receipt.sha256, spec, journal),
    );
    requireOwnerTarget(phaseOwner, spec.name, expectedBytes, `${spec.phase} phase receipt`);
    const targetExists = phaseEntries.has(spec.name);
    if (!targetExists) {
      if (spec.previous !== phase) {
        refuse(`out-of-order ${spec.phase} retirement publication owner`);
      }
      if (recover) removePublicationOwner(opPath, phaseOwner);
    } else if (recover) {
      removePublicationOwner(opPath, phaseOwner);
    }
  }

  if (restorationOwner) {
    if (!RESTORABLE_PHASES.has(phase)) {
      refuse(`restoration cleanup cannot begin from retirement phase ${phase}`);
    }
    const expectedBytes = canonicalDocumentBytes(
      restorationCleanupDocument(
        operation,
        inspectedJournal.receipt.sha256,
        phase,
        journal,
      ),
    );
    requireOwnerTarget(
      restorationOwner,
      RESTORATION_CLEANUP_NAME,
      expectedBytes,
      "restoration cleanup receipt",
    );
    const targetPath = join(opPath, RESTORATION_CLEANUP_NAME);
    if (lstatMaybe(targetPath)) {
      const prefix = inspectCanonicalPrefix(
        targetPath,
        expectedBytes,
        "restoration cleanup receipt",
      );
      if (!prefix.complete && recover) {
        writeCanonicalTarget(opPath, RESTORATION_CLEANUP_NAME, expectedBytes, {
          description: "restoration cleanup receipt",
        });
      }
      if (!prefix.complete && !recover) {
        return {
          journal,
          journalReceipt: inspectedJournal.receipt,
          identityReceipt: identity.receipt,
          phaseReceipts: receipts,
          phase,
          pendingPhase: "restoration-writing",
        };
      }
      if (recover) {
        removePublicationOwner(opPath, restorationOwner);
        entries = walkPrivateTree(opPath);
        const terminalRestoration = inspectRestorationCleanup(opPath, entries, []);
        if (!terminalRestoration) {
          refuse("durable restoration cleanup receipt disappeared during recovery");
        }
        return terminalRestoration;
      }
    } else if (recover) {
      removePublicationOwner(opPath, restorationOwner);
    }
  }

  return {
    journal,
    journalReceipt: inspectedJournal.receipt,
    identityReceipt: identity.receipt,
    phaseReceipts: receipts,
    phase,
    pendingPhase: phase,
  };
}

function requireJournalMatches(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse("immutable prepared retirement journal changed from the active transaction");
  }
}

function requireTransactionPhase(opPath, journal, expectedPhase) {
  const durable = inspectJournalPublication(opPath);
  if (!durable.journal) refuse("retirement transaction lost its prepared journal");
  requireJournalMatches(durable.journal, journal);
  if (durable.phase !== expectedPhase) {
    refuse(
      `retirement transaction phase was ${durable.phase}, expected ${expectedPhase}`,
    );
  }
  return durable;
}

function updateJournalPhase(opPath, journal, phase, hooks = {}) {
  const spec = PHASE_BY_PHASE.get(phase);
  if (!spec) refuse(`unknown retirement phase transition: ${phase}`);
  const durable = inspectJournalPublication(opPath, { recover: true });
  if (!durable.journal) refuse("retirement transaction lost its prepared journal");
  requireJournalMatches(durable.journal, journal);
  if (durable.phase !== spec.previous) {
    refuse(
      `out-of-order retirement phase transition from ${durable.phase} to ${phase}`,
    );
  }
  const bytes = canonicalDocumentBytes(
    phaseReceiptDocument(basename(opPath), durable.journalReceipt.sha256, spec, durable.journal),
  );
  publishExclusiveFile(opPath, spec.name, bytes, hooks);
  requireTransactionPhase(opPath, journal, phase);
  hooks.afterJournalPhase?.(phase, opPath);
  return phase;
}

function requireVerificationLink(source, destination, entry) {
  const sourceBefore = lstatMaybe(source);
  const destinationBefore = lstatMaybe(destination);
  if (!sourceBefore || !destinationBefore) {
    refuse("verification view link pair is incomplete");
  }
  requireOwnedFileMetadata(source, sourceBefore, 0o600, [1n, 2n]);
  requireOwnedFileMetadata(destination, destinationBefore, 0o600, [1n, 2n]);
  if (
    sourceBefore.dev !== destinationBefore.dev ||
    sourceBefore.ino !== destinationBefore.ino
  ) {
    refuse("verification view name is occupied by a foreign inode");
  }
  if (sourceBefore.nlink !== 2n || destinationBefore.nlink !== 2n) {
    refuse("verification view does not have the exact bounded link count");
  }
  if (!identityMatchesExceptLinkCount(sourceBefore, entry.identity)) {
    refuse("verification view is not the journaled source identity");
  }
  const inspected = inspectSecureFile(destination, {
    expectedSize: Number(entry.identity.size),
    allowedLinks: [2n],
  });
  if (inspected.sha256 !== entry.sha256) {
    refuse(`verification view does not match the journaled content: ${destination}`);
  }
  const sourceAfter = lstatMaybe(source);
  const destinationAfter = lstatMaybe(destination);
  if (
    !sourceAfter ||
    !destinationAfter ||
    !sameOpenIdentity(sourceBefore, sourceAfter) ||
    !sameOpenIdentity(destinationBefore, destinationAfter) ||
    !sameOpenIdentity(sourceAfter, destinationAfter)
  ) {
    refuse("verification view link pair changed while it was proved");
  }
}

function removeVerificationArtifacts(opPath, journal, hooks = {}) {
  auditOperationTree(opPath, journal);
  for (const entry of journalEntries(journal)) {
    const source = claimedPath(opPath, entry);
    const destination = verificationViewPath(opPath, entry);
    if (lstatMaybe(destination)) {
      requireVerificationLink(source, destination, entry);
      unlinkSync(destination);
      fsyncDirectory(dirname(destination));
      hooks.afterVerificationLinkUnlink?.({
        opPath,
        source,
        destination,
        entry,
      });
      reprovePath(source, entry, "claimed target after verification-view unlink");
    }
  }
}

function reproveRestoredTransaction(root, opPath, journal) {
  for (const entry of journalEntries(journal)) {
    const claimed = claimedPath(opPath, entry);
    const verification = verificationViewPath(opPath, entry);
    const live = originalPath(root, entry);
    if (lstatMaybe(claimed)) {
      refuse(`restoration cleanup still has a quarantined payload: ${claimed}`);
    }
    if (lstatMaybe(verification)) {
      refuse(`restoration cleanup still has a verification-view link: ${verification}`);
    }
    reproveEquivalentContent(live, entry, "restored live retirement target");
  }
}

function requireRestorationCleanup(opPath, journal, expectedPhase) {
  const durable = inspectJournalPublication(opPath);
  if (!durable.terminalRestoration) {
    refuse("retirement restoration lost its terminal cleanup proof");
  }
  requireJournalMatches(durable.journal, journal);
  if (durable.phase !== expectedPhase) {
    refuse(
      `restoration cleanup phase was ${durable.phase}, expected ${expectedPhase}`,
    );
  }
  return durable;
}

function publishRestorationCleanup(opPath, journal, phase, hooks = {}) {
  const durable = requireTransactionPhase(opPath, journal, phase);
  if (!RESTORABLE_PHASES.has(phase)) {
    refuse(`retirement phase ${phase} cannot enter restoration cleanup`);
  }
  const bytes = canonicalDocumentBytes(
    restorationCleanupDocument(
      basename(opPath),
      durable.journalReceipt.sha256,
      phase,
      journal,
    ),
  );
  publishExclusiveFile(opPath, RESTORATION_CLEANUP_NAME, bytes, hooks);
  const terminal = requireRestorationCleanup(opPath, journal, phase);
  hooks.afterRestorationCleanupPublished?.({ opPath, phase });
  return terminal;
}

function removeOperationTree(opPath, journal, hooks = {}, { expectedPhase } = {}) {
  if (expectedPhase === "deleting") {
    removeDeletingOperationTree(opPath, journal, hooks);
    return;
  }
  const durable = requireTransactionPhase(opPath, journal, expectedPhase);
  removeVerificationArtifacts(opPath, journal, hooks);
  auditOperationTree(opPath, journal);
  const entries = walkPrivateTree(opPath).sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? 1 : -1;
    return right.relativePath.length - left.relativePath.length;
  });
  const journalArtifacts = new Set([
    "state.json",
    STATE_IDENTITY_NAME,
    RESTORATION_CLEANUP_NAME,
    ...durable.phaseReceipts.keys(),
  ]);
  for (const entry of entries) {
    if (entry.directory) continue;
    if (journalArtifacts.has(entry.relativePath)) continue;
    refuse(`retirement operation still contains an unconsumed file: ${entry.path}`);
  }
  reproveRestoredTransaction(dirname(opPath), opPath, journal);
  publishRestorationCleanup(opPath, journal, expectedPhase, hooks);
  removeRestorationOperationTree(opPath, journal, expectedPhase, hooks);
}

function removeRestorationOperationTree(opPath, journal, phase, hooks = {}) {
  let durable = requireRestorationCleanup(opPath, journal, phase);
  reproveRestoredTransaction(dirname(opPath), opPath, journal);
  auditOperationTree(opPath, journal);
  let entries = walkPrivateTree(opPath).sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? 1 : -1;
    return right.relativePath.length - left.relativePath.length;
  });
  const journalArtifacts = new Set([
    "state.json",
    STATE_IDENTITY_NAME,
    RESTORATION_CLEANUP_NAME,
    ...PHASE_SPECS.map((spec) => spec.name),
  ]);
  for (const entry of entries) {
    if (entry.directory || journalArtifacts.has(entry.relativePath)) continue;
    refuse(`restoration cleanup contains an unconsumed file: ${entry.path}`);
  }
  let directoryIndex = 0;
  for (const entry of entries.filter((item) => item.directory)) {
    if (!lstatMaybe(entry.path)) continue;
    rmdirSync(entry.path);
    fsyncDirectory(dirname(entry.path));
    hooks.afterRestorationDirectoryRmdir?.({
      opPath,
      path: entry.path,
      index: directoryIndex,
    });
    directoryIndex += 1;
  }

  durable = requireRestorationCleanup(opPath, journal, phase);
  for (const spec of [...PHASE_SPECS].reverse()) {
    const receipt = durable.phaseReceipts.get(spec.name);
    const path = join(opPath, spec.name);
    if (!lstatMaybe(path)) continue;
    if (!receipt) refuse(`${spec.phase} phase receipt lost its restoration-cleanup proof`);
    requireSecureRecord(path, receipt, `${spec.phase} phase receipt`);
    unlinkSync(path);
    fsyncDirectory(opPath);
    hooks.afterRestorationPhaseReceiptUnlink?.({ opPath, path, phase: spec.phase });
  }

  durable = requireRestorationCleanup(opPath, journal, phase);
  const identityPath = stateIdentityPath(opPath);
  if (lstatMaybe(identityPath)) {
    if (!durable.identityReceipt) {
      refuse("journal identity receipt lost its restoration-cleanup proof");
    }
    requireSecureRecord(
      identityPath,
      durable.identityReceipt,
      "retirement journal identity receipt",
    );
    unlinkSync(identityPath);
    fsyncDirectory(opPath);
    hooks.afterRestorationIdentityUnlink?.({ opPath, path: identityPath });
  }

  durable = requireRestorationCleanup(opPath, journal, phase);
  const statePath = journalPath(opPath);
  if (lstatMaybe(statePath)) {
    if (!durable.journalReceipt?.identity) {
      refuse("prepared journal lost its restoration-cleanup proof");
    }
    requireSecureRecord(
      statePath,
      durable.journalReceipt,
      "immutable prepared retirement journal",
    );
    unlinkSync(statePath);
    fsyncDirectory(opPath);
    hooks.afterRestorationStateUnlink?.({ opPath, path: statePath });
  }

  durable = requireRestorationCleanup(opPath, journal, phase);
  reproveRestoredTransaction(dirname(opPath), opPath, journal);
  const restorationPath = join(opPath, RESTORATION_CLEANUP_NAME);
  requireSecureRecord(
    restorationPath,
    durable.restorationCleanupReceipt,
    "restoration cleanup receipt",
  );
  unlinkSync(restorationPath);
  fsyncDirectory(opPath);
  hooks.afterRestorationReceiptUnlink?.({ opPath, path: restorationPath });

  entries = walkPrivateTree(opPath);
  if (entries.length > 0) refuse(`restoration cleanup operation is not empty: ${opPath}`);
  rmdirSync(opPath);
  hooks.afterRestorationOperationRmdir?.({ opPath });
  fsyncDirectory(dirname(opPath));
}

function removeDeletingOperationTree(opPath, journal, hooks = {}) {
  let durable = requireTransactionPhase(opPath, journal, "deleting");
  removeVerificationArtifacts(opPath, journal, hooks);
  auditOperationTree(opPath, journal);
  let entries = walkPrivateTree(opPath).sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? 1 : -1;
    return right.relativePath.length - left.relativePath.length;
  });
  const journalArtifacts = new Set([
    "state.json",
    STATE_IDENTITY_NAME,
    ...PHASE_SPECS.map((spec) => spec.name),
  ]);
  for (const entry of entries) {
    if (entry.directory || journalArtifacts.has(entry.relativePath)) continue;
    refuse(`terminal retirement operation still contains an unconsumed file: ${entry.path}`);
  }
  for (const entry of entries.filter((item) => item.directory)) {
    if (!lstatMaybe(entry.path)) continue;
    rmdirSync(entry.path);
    fsyncDirectory(dirname(entry.path));
    hooks.afterOperationDirectoryRmdir?.({ opPath, path: entry.path });
  }

  durable = requireTransactionPhase(opPath, journal, "deleting");
  for (const spec of [...PHASE_SPECS].reverse()) {
    if (spec.phase === "deleting") continue;
    const receipt = durable.phaseReceipts.get(spec.name);
    const path = join(opPath, spec.name);
    if (!lstatMaybe(path)) continue;
    if (!receipt) refuse(`${spec.phase} phase receipt lost its terminal-cleanup proof`);
    requireSecureRecord(path, receipt, `${spec.phase} phase receipt`);
    unlinkSync(path);
    fsyncDirectory(opPath);
    hooks.afterPhaseReceiptUnlink?.({ opPath, path, phase: spec.phase });
  }

  durable = requireTransactionPhase(opPath, journal, "deleting");
  const identityPath = stateIdentityPath(opPath);
  if (lstatMaybe(identityPath)) {
    if (!durable.identityReceipt) {
      refuse("retirement journal identity receipt lost its terminal-cleanup proof");
    }
    requireSecureRecord(
      identityPath,
      durable.identityReceipt,
      "retirement journal identity receipt",
    );
    unlinkSync(identityPath);
    fsyncDirectory(opPath);
    hooks.afterIdentityUnlink?.({ opPath, path: identityPath });
  }

  durable = requireTransactionPhase(opPath, journal, "deleting");
  const statePath = journalPath(opPath);
  if (lstatMaybe(statePath)) {
    if (!durable.journalReceipt?.identity) {
      refuse("immutable prepared retirement journal lost its terminal-cleanup proof");
    }
    requireSecureRecord(
      statePath,
      durable.journalReceipt,
      "immutable prepared retirement journal",
    );
    unlinkSync(statePath);
    fsyncDirectory(opPath);
    hooks.afterStateUnlink?.({ opPath });
  }

  durable = requireTransactionPhase(opPath, journal, "deleting");
  const deletingSpec = PHASE_BY_PHASE.get("deleting");
  const deletingPath = join(opPath, deletingSpec.name);
  const deletingReceipt = durable.phaseReceipts.get(deletingSpec.name);
  if (!deletingReceipt) refuse("terminal deleting receipt lost its durable proof");
  requireSecureRecord(deletingPath, deletingReceipt, "deleting phase receipt");
  unlinkSync(deletingPath);
  fsyncDirectory(opPath);
  hooks.afterDeletingReceiptUnlink?.({ opPath, path: deletingPath });

  entries = walkPrivateTree(opPath);
  if (entries.length > 0) refuse(`terminal retirement operation is not empty: ${opPath}`);
  rmdirSync(opPath);
  hooks.afterOperationRmdir?.({ opPath });
  fsyncDirectory(dirname(opPath));
}

function defaultCassBin(home) {
  return process.env.CASS_BIN || join(home, ".local", "bin", "cass");
}

function runJsonCommand(
  command,
  args,
  {
    env = process.env,
    maxBuffer = 64 * 1024 * 1024,
    description = "Cass command",
    timeoutSeconds = CASS_COMMAND_TIMEOUT_SECONDS,
  } = {},
) {
  const result = spawnSync(TIMEOUT_RUNNER, [String(timeoutSeconds), description, command, ...args], {
    encoding: "utf8",
    env,
    maxBuffer,
  });
  if (result.error) refuse(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || "").trim();
    refuse(`${command} ${args.join(" ")} failed (${result.status}): ${diagnostic}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    refuse(`${command} returned malformed JSON: ${error.message}`);
  }
}

function requireCassDataDirectoryForRoot(root) {
  const dataDir = dirname(dirname(root));
  const home = dirname(dirname(dirname(dataDir)));
  const expected = join(home, ...RAW_MIRROR_COMPONENTS.slice(0, 3));
  if (dataDir !== expected) refuse(`Cass data directory has an unexpected shape: ${dataDir}`);

  let current = home;
  requireOwnedDirectory(current);
  if (realpathSync(current) !== current) refuse(`refusing symlinked home path: ${current}`);
  for (const component of RAW_MIRROR_COMPONENTS.slice(0, 3)) {
    current = join(current, component);
    requireOwnedDirectory(current);
    if (realpathSync(current) !== current) {
      refuse(`refusing symlinked Cass data path component: ${current}`);
    }
  }
  return dataDir;
}

export function assertCassWriterLock({
  root,
  flockBin = process.env.FLOCK_BIN || "/opt/homebrew/bin/flock",
}) {
  const dataDir = requireCassDataDirectoryForRoot(root);
  const lockPath = join(dataDir, "index-run.lock");
  const lockMetadata = lstatMaybe(lockPath);
  if (!lockMetadata) refuse(`Cass writer lock file is missing: ${lockPath}`);
  requireOwnedFileMetadata(lockPath, lockMetadata, modeBits(lockMetadata));
  if ((modeBits(lockMetadata) & 0o022) !== 0) {
    refuse(`Cass writer lock file is group/world writable: ${lockPath}`);
  }

  const fdText = process.env.AGENTCHATS_RETIREMENT_LOCK_FD;
  if (!fdText || !/^[0-9]+$/.test(fdText)) {
    refuse("apply requires the inherited Cass writer-lock descriptor");
  }
  const descriptor = Number(fdText);
  let inherited;
  try {
    inherited = fstatSync(descriptor, { bigint: true });
  } catch (error) {
    refuse(`could not inspect inherited Cass writer lock: ${error.message}`);
  }
  if (inherited.dev !== lockMetadata.dev || inherited.ino !== lockMetadata.ino) {
    refuse("inherited writer-lock descriptor is not Cass's index-run.lock inode");
  }

  const ownerProbe = spawnSync(flockBin, ["-n", "3"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", descriptor],
  });
  if (ownerProbe.error) {
    refuse(`could not acquire or re-enter the inherited Cass writer lock: ${ownerProbe.error.message}`);
  }
  if (ownerProbe.status !== 0) {
    refuse("the inherited writer-lock descriptor does not own Cass's exclusive lock");
  }

  const probe = spawnSync(flockBin, ["-n", lockPath, "true"], { encoding: "utf8" });
  if (probe.error) refuse(`could not verify Cass-compatible writer locking: ${probe.error.message}`);
  if (probe.status === 0) refuse("Cass writer lock is not held; refusing destructive cleanup");
  if (probe.status !== 1) {
    refuse(`Cass writer-lock compatibility probe failed unexpectedly (${probe.status})`);
  }
}

function assertTargetExcluded({ cassBin }) {
  const report = runJsonCommand(cassBin, ["sources", "agents", "list", "--json"], {
    description: "Cass connector-exclusion proof",
  });
  if (!Array.isArray(report.disabled_agents) || !report.disabled_agents.includes(TARGET_PROVIDER)) {
    refuse("the retired connector is not excluded inside the Cass writer-lock window");
  }
}

function reprovePath(path, entry, description) {
  const metadata = lstatMaybe(path);
  if (!metadata) refuse(`${description} disappeared: ${path}`);
  requireSecureRecord(path, entry, description);
}

function reproveEquivalentContent(path, entry, description) {
  const inspected = inspectSecureFile(path);
  if (
    inspected.sha256 !== entry.sha256 ||
    inspected.identity.size.toString() !== entry.identity.size
  ) {
    refuse(`${description} does not match the journaled content: ${path}`);
  }
}

function claimEntry({ root, opPath, entry, hooks, index }) {
  const source = originalPath(root, entry);
  const destination = claimedPath(opPath, entry);
  ensureRelativeDirectories(join(opPath, "claimed"), entry.relative_path);
  if (lstatMaybe(destination)) refuse(`claim destination is already occupied: ${destination}`);
  reprovePath(source, entry, "retirement source");
  hooks.beforeClaimRename?.({ entry, source, destination, index });
  if (lstatMaybe(destination)) refuse(`claim destination became occupied: ${destination}`);
  renameSync(source, destination);
  fsyncDirectory(dirname(source));
  fsyncDirectory(dirname(destination));
  reprovePath(destination, entry, "claimed retirement target");
  if (lstatMaybe(source)) refuse(`retirement source still exists after claim: ${source}`);
  hooks.afterClaim?.({ entry, source, destination, index });
}

function claimTransaction({ root, opPath, journal, hooks = {} }) {
  requireTransactionPhase(opPath, journal, "claiming");
  let index = 0;
  for (const entry of journal.manifests) {
    claimEntry({ root, opPath, entry: { ...entry, kind: "manifest" }, hooks, index });
    index += 1;
  }
  for (const entry of journal.blobs) {
    claimEntry({ root, opPath, entry: { ...entry, kind: "blob" }, hooks, index });
    index += 1;
  }
}

function reproveClaimed(opPath, journal) {
  for (const entry of journalEntries(journal)) {
    reprovePath(claimedPath(opPath, entry), entry, "claimed retirement target");
    if (lstatMaybe(originalPath(dirname(opPath), entry))) {
      refuse(`retirement target exists both live and claimed: ${entry.relative_path}`);
    }
  }
}

function restoreTransaction({ root, opPath, journal, phase, hooks = {} }) {
  requireTransactionPhase(opPath, journal, phase);
  removeVerificationArtifacts(opPath, journal, hooks);
  auditOperationTree(opPath, journal);
  const ordered = [
    ...journal.blobs.map((entry) => ({ ...entry, kind: "blob" })),
    ...journal.manifests.map((entry) => ({ ...entry, kind: "manifest" })),
  ];
  for (const entry of ordered) {
    const source = claimedPath(opPath, entry);
    const destination = originalPath(root, entry);
    const sourceMetadata = lstatMaybe(source);
    const destinationMetadata = lstatMaybe(destination);
    if (sourceMetadata && destinationMetadata) {
      reprovePath(source, entry, "quarantined retirement target");
      reproveEquivalentContent(destination, entry, "recreated live retirement target");
      unlinkSync(source);
      fsyncDirectory(dirname(source));
      reproveEquivalentContent(destination, entry, "coalesced live retirement target");
      continue;
    }
    if (!sourceMetadata && !destinationMetadata) {
      refuse(`retirement target is missing from both live and quarantine paths: ${entry.relative_path}`);
    }
    if (!sourceMetadata) {
      reproveEquivalentContent(destination, entry, "unclaimed retirement target");
      continue;
    }
    reprovePath(source, entry, "quarantined retirement target");
    if (lstatMaybe(destination)) refuse(`restore destination became occupied: ${destination}`);
    renameSync(source, destination);
    fsyncDirectory(dirname(source));
    fsyncDirectory(dirname(destination));
    reprovePath(destination, entry, "restored retirement target");
  }
  removeOperationTree(opPath, journal, hooks, { expectedPhase: phase });
}

function linkClaimedFile(source, destination, entry, verifyRoot, hooks = {}) {
  ensureRelativeDirectories(verifyRoot, entry.relative_path);
  const existingDestination = lstatMaybe(destination);
  if (existingDestination) {
    requireVerificationLink(source, destination, entry);
    return;
  }

  reprovePath(source, entry, "verification source");
  hooks.beforeVerificationLink?.({ source, destination, entry });
  let created = false;
  try {
    linkSync(source, destination);
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    requireVerificationLink(source, destination, entry);
  }
  fsyncDirectory(dirname(destination));
  if (created) hooks.afterVerificationLink?.({ source, destination, entry });
  requireVerificationLink(source, destination, entry);
}

export function verifyClaimedWithCass({ opPath, journal, cassBin, hooks = {} }) {
  const verifyDataDir = join(opPath, "verify-data");
  const verifyRawMirror = join(verifyDataDir, "raw-mirror");
  const verifyRoot = join(verifyRawMirror, "v1");
  ensurePrivateDirectory(verifyDataDir);
  ensurePrivateDirectory(verifyRawMirror);
  ensurePrivateDirectory(verifyRoot);

  for (const entry of journalEntries(journal)) {
    linkClaimedFile(
      claimedPath(opPath, entry),
      verificationViewPath(opPath, entry),
      entry,
      verifyRoot,
      hooks,
    );
  }

  const report = runJsonCommand(
    cassBin,
    ["doctor", "check", "--json", "--data-dir", verifyDataDir],
    {
      description: "full Cass raw-mirror verification",
      env: {
        ...process.env,
        CASS_DOCTOR_RAW_MIRROR_FULL_VERIFY: "1",
      },
    },
  );
  const rawMirror = report?.raw_mirror;
  if (!rawMirror || rawMirror.status !== "verified") {
    refuse("Cass did not fully verify the quarantined raw-mirror transaction");
  }
  const expectedManifestIds = journal.manifests
    .map((entry) => basename(entry.relative_path, ".json"))
    .sort();
  const manifests = Array.isArray(rawMirror.manifests) ? rawMirror.manifests : [];
  const actualManifestIds = manifests.map((entry) => entry.manifest_id).sort();
  if (
    actualManifestIds.length !== expectedManifestIds.length ||
    actualManifestIds.some((id, index) => id !== expectedManifestIds[index])
  ) {
    refuse("Cass verification returned a different manifest set than the retirement journal");
  }
  for (const manifest of manifests) {
    if (
      manifest.provider !== TARGET_PROVIDER ||
      manifest.status !== "verified" ||
      manifest.blob_checksum_status !== "matched" ||
      manifest.manifest_checksum_status !== "matched"
    ) {
      refuse(`Cass did not corroborate manifest ${manifest.manifest_id}`);
    }
  }

  const summary = rawMirror.summary ?? {};
  const expectedDuplicateReferences = journal.manifests.length - journal.blobs.length;
  const expectedBytes = journal.blobs.reduce(
    (total, entry) => total + Number(entry.identity.size),
    0,
  );
  const exactSummary = {
    manifest_count: journal.manifests.length,
    verified_blob_count: journal.blobs.length,
    missing_blob_count: 0,
    checksum_mismatch_count: 0,
    manifest_checksum_mismatch_count: 0,
    manifest_checksum_not_recorded_count: 0,
    invalid_manifest_count: 0,
    interrupted_capture_count: 0,
    duplicate_blob_reference_count: expectedDuplicateReferences,
    total_blob_bytes: expectedBytes,
  };
  for (const [key, expected] of Object.entries(exactSummary)) {
    if (summary[key] !== expected) {
      refuse(`Cass verification summary ${key} was ${summary[key]}, expected ${expected}`);
    }
  }
  removeVerificationArtifacts(opPath, journal, hooks);
}

function deleteTransaction({ root, opPath, journal, home, hooks = {} }) {
  requireTransactionPhase(opPath, journal, "deleting");
  removeVerificationArtifacts(opPath, journal, hooks);
  auditOperationTree(opPath, journal);
  const graph = scanManifestGraph({ home, root });
  if (graph.targets.length > 0) {
    refuse("a retired-provider manifest reappeared during deletion");
  }
  const preservedLiveBlobs = new Set();
  for (const entry of journal.blobs) {
    const live = originalPath(root, entry);
    const references = graph.references.get(entry.relative_path) ?? [];
    if (!lstatMaybe(live)) {
      if (references.length > 0) {
        refuse(`a live provider references a missing retirement blob: ${entry.relative_path}`);
      }
      continue;
    }
    if (references.length === 0 || references.some((reference) => reference.target)) {
      refuse(`a recreated retirement blob has no active-provider provenance: ${entry.relative_path}`);
    }
    reproveEquivalentContent(live, entry, "recreated active-provider blob");
    preservedLiveBlobs.add(entry.relative_path);
  }
  const ordered = [
    ...journal.manifests.map((entry) => ({ ...entry, kind: "manifest" })),
    ...journal.blobs.map((entry) => ({ ...entry, kind: "blob" })),
  ];
  let index = 0;
  for (const entry of ordered) {
    const live = originalPath(root, entry);
    const preserveLive = entry.kind === "blob" && preservedLiveBlobs.has(entry.relative_path);
    if (lstatMaybe(live) && !preserveLive) {
      refuse(`a live retirement target exists during deletion: ${live}`);
    }
    if (preserveLive) {
      reproveEquivalentContent(live, entry, "recreated active-provider blob");
    }
    const quarantined = claimedPath(opPath, entry);
    if (!lstatMaybe(quarantined)) {
      if (preserveLive) {
        reproveEquivalentContent(live, entry, "preserved active-provider blob");
      }
      index += 1;
      continue;
    }
    reprovePath(quarantined, entry, "quarantined deletion target");
    hooks.beforeDelete?.({ entry, path: quarantined, index });
    reprovePath(quarantined, entry, "quarantined deletion target");
    if (preserveLive) {
      reproveEquivalentContent(live, entry, "recreated active-provider blob");
    }
    unlinkSync(quarantined);
    fsyncDirectory(dirname(quarantined));
    if (preserveLive) {
      reproveEquivalentContent(live, entry, "preserved active-provider blob");
    }
    hooks.afterDelete?.({ entry, path: quarantined, index });
    index += 1;
  }
  for (const entry of ordered) {
    if (lstatMaybe(claimedPath(opPath, entry))) {
      refuse(`quarantined target remains after deletion: ${entry.relative_path}`);
    }
  }
  removeOperationTree(opPath, journal, hooks, { expectedPhase: "deleting" });
}

function removeIncompleteOperation(opPath) {
  const entries = walkPrivateTree(opPath);
  if (entries.length > 0) {
    refuse(`journal-less retirement operation is not empty: ${opPath}`);
  }
  rmdirSync(opPath);
  fsyncDirectory(dirname(opPath));
}

function recoverExistingTransaction({ root, home, hooks = {} }) {
  const existing = discoverTransactions(root);
  if (existing.length === 0) return;
  const opPath = existing[0];
  const initialJournalFactory = () =>
    preparedJournal(basename(opPath), buildPlan({ home, root }));
  const durable = inspectJournalPublication(opPath, {
    recover: true,
    initialJournalFactory,
  });
  const { journal, phase } = durable;
  if (!journal) {
    removeIncompleteOperation(opPath);
    return;
  }
  if (durable.terminalRestoration) {
    removeRestorationOperationTree(opPath, journal, phase, hooks);
  } else if (phase === "deleting") {
    deleteTransaction({ root, opPath, journal, home, hooks });
  } else {
    restoreTransaction({ root, opPath, journal, phase, hooks });
  }
}

function isSimulatedCrash(error) {
  return error && error.simulatedCrash === true;
}

export function retirePiRawMirror({
  home = homedir(),
  apply = false,
  cassBin,
  hooks = {},
  lockAssertion = assertCassWriterLock,
  exclusionAssertion = assertTargetExcluded,
  claimedVerifier = verifyClaimedWithCass,
} = {}) {
  const resolvedHome = resolve(home);
  const root = expectedRawMirrorRoot(resolvedHome);
  const result = {
    mode: apply ? "apply" : "dry-run",
    root,
    manifest_count: 0,
    blob_count: 0,
    bytes: 0,
    peak_extra_payload_bytes: 0,
    peak_extra_receipt_bytes_upper_bound: 0,
    verification_link_count: 0,
    pending_transaction: false,
    pending_phase: null,
    changed: false,
  };
  if (!validateRoot(resolvedHome, root)) return result;

  const pending = discoverTransactions(root);
  if (!apply && pending.length > 0) {
    const opPath = pending[0];
    result.pending_transaction = true;
    const { journal, pendingPhase, phase } = inspectJournalPublication(opPath, {
      initialJournalFactory: () =>
        preparedJournal(basename(opPath), buildPlan({ home: resolvedHome, root })),
    });
    if (journal) {
      result.pending_phase = phase ?? pendingPhase;
      result.manifest_count = journal.manifests.length;
      result.blob_count = journal.blobs.length;
      result.bytes = journal.blobs.reduce(
        (total, entry) => total + Number(entry.identity.size),
        0,
      );
      setRetirementOverhead(result, journal);
    } else {
      result.pending_phase = pendingPhase;
    }
    return result;
  }

  const resolvedCassBin = cassBin ?? defaultCassBin(resolvedHome);
  if (apply) {
    lockAssertion({ root });
    exclusionAssertion({ cassBin: resolvedCassBin });
    recoverExistingTransaction({ root, home: resolvedHome, hooks });
  }

  const initial = buildPlan({ home: resolvedHome, root });
  result.manifest_count = initial.manifests.length;
  result.blob_count = initial.blobs.length;
  result.bytes = initial.bytes;
  if (initial.manifests.length > 0) {
    setRetirementOverhead(
      result,
      preparedJournal(`${OPERATION_PREFIX}${"0".repeat(32)}`, initial),
    );
  }
  if (!apply || initial.manifests.length === 0) return result;

  const verified = buildPlan({ home: resolvedHome, root });
  if (planKey(initial) !== planKey(verified)) {
    refuse("raw-mirror retirement state changed during verification");
  }

  const transaction = createTransaction(root, verified, hooks);
  const journal = transaction.journal;
  try {
    updateJournalPhase(transaction.opPath, journal, "claiming", hooks);
    claimTransaction({ root, opPath: transaction.opPath, journal, hooks });
    const targetBlobPaths = new Set(journal.blobs.map((entry) => entry.relative_path));
    hooks.afterClaims?.({ root, opPath: transaction.opPath, journal });
    scanLiveReferences({ home: resolvedHome, root, targetBlobPaths });
    updateJournalPhase(transaction.opPath, journal, "claimed", hooks);

    requireTransactionPhase(transaction.opPath, journal, "claimed");
    claimedVerifier({
      root,
      opPath: transaction.opPath,
      journal,
      cassBin: resolvedCassBin,
      hooks,
    });
    hooks.afterDoctor?.({ root, opPath: transaction.opPath, journal });
    reproveClaimed(transaction.opPath, journal);
    scanLiveReferences({ home: resolvedHome, root, targetBlobPaths });
    updateJournalPhase(transaction.opPath, journal, "verified", hooks);
    reproveClaimed(transaction.opPath, journal);
    scanLiveReferences({ home: resolvedHome, root, targetBlobPaths });
    updateJournalPhase(transaction.opPath, journal, "deleting", hooks);
    deleteTransaction({
      root,
      opPath: transaction.opPath,
      journal,
      home: resolvedHome,
      hooks,
    });
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    try {
      if (lstatMaybe(transaction.opPath)) {
        const { journal: durable, phase } = inspectJournalPublication(transaction.opPath, {
          recover: true,
        });
        if (durable && phase !== "deleting") {
          restoreTransaction({
            root,
            opPath: transaction.opPath,
            journal: durable,
            phase,
            hooks,
          });
        }
      }
    } catch (recoveryError) {
      error.message = `${error.message}; automatic restoration also refused: ${recoveryError.message}`;
    }
    throw error;
  }

  const remaining = buildPlan({ home: resolvedHome, root });
  if (remaining.manifests.length !== 0 || remaining.blobs.length !== 0) {
    refuse("retired raw-mirror captures remain after cleanup");
  }
  return { ...result, changed: true };
}

function usage() {
  process.stdout.write(
    "Usage: scripts/retire-pi-raw-mirror.mjs --dry-run | --apply [--cass-bin <path>] | --assert-lock | --pending-status | --mark-pending | --clear-pending\n",
  );
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  let mode;
  let cassBin;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--dry-run" ||
      argument === "--apply" ||
      argument === "--assert-lock" ||
      argument === "--pending-status" ||
      argument === "--mark-pending" ||
      argument === "--clear-pending"
    ) {
      if (mode) return null;
      mode = argument;
    } else if (argument === "--cass-bin") {
      if (cassBin || index + 1 >= argv.length) return null;
      cassBin = argv[index + 1];
      index += 1;
    } else {
      return null;
    }
  }
  if (!mode) return null;
  if (mode !== "--dry-run" && mode !== "--apply" && cassBin) return null;
  return { mode, cassBin };
}

function main(argv) {
  const parsed = parseArguments(argv);
  if (!parsed) {
    usage();
    return 64;
  }
  if (parsed.help) {
    usage();
    return 0;
  }
  try {
    if (parsed.mode === "--assert-lock") {
      const root = expectedRawMirrorRoot(homedir());
      assertCassWriterLock({ root });
      process.stdout.write(`${JSON.stringify({ mode: "assert-lock", lock: "held" })}\n`);
      return 0;
    }
    if (parsed.mode === "--pending-status") {
      process.stdout.write(`${JSON.stringify({ pending: retirementPendingStatus() })}\n`);
      return 0;
    }
    if (parsed.mode === "--mark-pending") {
      assertCassWriterLock({ root: expectedRawMirrorRoot(homedir()) });
      process.stdout.write(`${JSON.stringify({ pending: true, changed: markRetirementPending() })}\n`);
      return 0;
    }
    if (parsed.mode === "--clear-pending") {
      assertCassWriterLock({ root: expectedRawMirrorRoot(homedir()) });
      process.stdout.write(`${JSON.stringify({ pending: false, changed: clearRetirementPending() })}\n`);
      return 0;
    }
    const result = retirePiRawMirror({
      apply: parsed.mode === "--apply",
      cassBin: parsed.cassBin,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Agentchats raw-mirror retirement: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
