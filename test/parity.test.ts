import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseClaude } from "../src/parse/claude.ts";
import { parseCodex } from "../src/parse/codex.ts";
import type { ParsedSession } from "../src/parse/types.ts";
import { openIndex } from "../src/store/schema.ts";
import { ingest } from "../src/store/ingest.ts";
import { search } from "../src/store/query.ts";

/**
 * Search parity, measured against ground truth rather than against the tool
 * this index replaced. The retired search engine is gone and was already
 * unhealthy before it went, so agreeing with it would prove nothing; what
 * matters is whether a term that genuinely appears in a session finds that
 * session.
 *
 * Ground truth comes from tokenizing the very messages the index stored, the
 * way FTS5's unicode61 tokenizer does. Recall and precision must both be
 * perfect: a lexical index that misses a term it holds is broken, and one
 * that returns a session without the term is worse.
 *
 * Skipped where the transcript stores do not exist — CI has no session
 * history, and this fixture is about this machine's real corpus.
 */

const CLAUDE_ROOT = join(process.env["HOME"] ?? "", ".claude", "projects");
const CODEX_ROOT = join(process.env["HOME"] ?? "", ".codex", "sessions");
const HAVE_STORES = existsSync(CLAUDE_ROOT) && existsSync(CODEX_ROOT);

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

/**
 * A deterministic spread across the corpus, skipping transcripts too small to
 * carry a recurring vocabulary. Sampling the smallest files instead would be
 * faster and would test nothing: they are mostly aborted sessions with a
 * handful of tokens between them.
 */
function sample(root: string, count: number): string[] {
  const usable = walk(root)
    .map((path) => ({ path, size: statSync(path).size }))
    .filter((entry) => entry.size > 32_000)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (usable.length <= count) return usable.map((entry) => entry.path);
  const stride = Math.floor(usable.length / count);
  return usable.filter((_entry, index) => index % stride === 0).slice(0, count).map((e) => e.path);
}

/** unicode61's split, near enough: letters and numbers are tokens, and
 * everything else is a separator. Only ASCII tokens are used for queries so
 * diacritic folding cannot make the two disagree. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => /^[a-z][a-z0-9]{4,}$/.test(token)),
  );
}

const maybe = HAVE_STORES ? describe : describe.skip;

maybe("lexical parity against ground truth", () => {
  test("every term the index holds finds exactly the sessions containing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentchats-parity-"));
    try {
      const claudeFiles = sample(CLAUDE_ROOT, 25);
      const codexFiles = sample(CODEX_ROOT, 25);
      expect(claudeFiles.length + codexFiles.length).toBeGreaterThan(10);

      // Mirror the store layouts into a scratch corpus so ingest walks a
      // bounded tree instead of the whole machine.
      const claudeRoot = join(root, "claude");
      const codexRoot = join(root, "codex");
      for (const [files, base, source] of [
        [claudeFiles, claudeRoot, CLAUDE_ROOT],
        [codexFiles, codexRoot, CODEX_ROOT],
      ] as const) {
        for (const file of files) {
          const target = join(base, file.slice(source.length + 1));
          mkdirSync(dirname(target), { recursive: true });
          cpSync(file, target);
        }
      }

      const db = openIndex(join(root, "index.db"));
      const read = (path: string): Promise<string> => Bun.file(path).text();
      const report = await ingest(db, {
        roots: [claudeRoot, codexRoot],
        parsers: {
          claude_code: { root: claudeRoot, parse: parseClaude, read },
          codex: { root: codexRoot, parse: parseCodex, read },
        },
      });
      expect(report.indexed).toBeGreaterThan(10);

      // Ground truth: parse the same copies, and record which sessions hold
      // which tokens.
      const sessionsByToken = new Map<string, Set<string>>();
      for (const [files, parse] of [
        [walk(claudeRoot), parseClaude],
        [walk(codexRoot), parseCodex],
      ] as const) {
        for (const file of files) {
          const parsed: ParsedSession | null = parse(await Bun.file(file).text(), file);
          if (parsed === null) continue;
          const tokens = tokenize(parsed.messages.map((message) => message.body).join("\n"));
          for (const token of tokens) {
            let holders = sessionsByToken.get(token);
            if (holders === undefined) sessionsByToken.set(token, (holders = new Set()));
            holders.add(file);
          }
        }
      }

      // Discriminating terms: rare enough that a wrong answer shows, common
      // enough that the query is not a single-session curiosity.
      const eligible = [...sessionsByToken.entries()]
        .filter(([, holders]) => holders.size >= 2 && holders.size <= 8)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const stride = Math.max(1, Math.floor(eligible.length / 20));
      const probes = eligible.filter((_entry, index) => index % stride === 0).slice(0, 20);
      expect(probes.length).toBeGreaterThanOrEqual(10);

      const misses: string[] = [];
      for (const [token, expected] of probes) {
        const found = new Set(
          search(db, { query: token, limit: 50_000, offset: 0 }).hits.map((hit) => hit.sourcePath),
        );
        for (const path of expected) {
          if (!found.has(path)) misses.push(`recall: "${token}" missed ${path}`);
        }
        for (const path of found) {
          if (!expected.has(path)) misses.push(`precision: "${token}" wrongly returned ${path}`);
        }
      }
      expect(misses).toEqual([]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
