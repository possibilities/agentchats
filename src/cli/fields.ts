import { UsageError } from "./args.ts";

/**
 * Shaping a hit for output: which fields a caller asked for, and how long a
 * content field may be. Pure, and separate from the command surface so the
 * rules can be tested — both of them used to fail silently, which is the one
 * failure mode a tool agents depend on must not have.
 */

export const HIT_FIELDS = [
  "source_path", "line", "agent", "workspace", "title", "snippet",
  "score", "created_at", "session_id", "ordinal", "role", "matched_on",
  "truncated",
] as const;

export const FIELD_SETS: Record<string, readonly string[]> = {
  minimal: ["source_path", "line", "agent"],
  // `snippet` belongs here: it is what makes a hit readable without a second
  // call, and 93% of the custom field lists agents actually wrote existed
  // only to add it back.
  summary: ["source_path", "line", "agent", "workspace", "title", "snippet", "score", "created_at"],
};

/** The retired tool called it `line_number`, and a large share of real
 * invocations still do. Accept the old spelling rather than silently
 * answering with a hit that has no line in it. */
const FIELD_ALIASES: Record<string, string> = { line_number: "line" };

/** Field selection is the agent's token budget in flag form. An unknown named
 * set is a usage error; a comma list is taken literally. */
export function project(rows: readonly Record<string, unknown>[], fields: string | undefined) {
  if (fields === undefined) return rows;
  const named = FIELD_SETS[fields];
  const names = (named ?? fields.split(",").map((name) => name.trim()))
    .filter((name) => name !== "")
    .map((name) => FIELD_ALIASES[name] ?? name);
  if (names.length === 0) throw new UsageError("--fields needs at least one field");
  // Silence is the wrong answer here: an unrecognized name used to yield
  // `{}` with exit 0, so a typo looked like "no such data" instead of "no
  // such field", and the caller believed it.
  const unknown = names.filter((name) => !(HIT_FIELDS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new UsageError(
      `--fields has no field "${unknown[0]}"; choose from ${HIT_FIELDS.join(", ")}, ` +
        `or the sets ${Object.keys(FIELD_SETS).join(", ")}`,
    );
  }
  return rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name]])));
}

/** Only prose is content. Truncating every string field also truncated
 * `source_path` — the one value the skill tells agents to feed straight back
 * into `view`, `expand`, and `resume` — turning a budget into a corrupted
 * citation that still looked well-formed. */
const CONTENT_FIELDS = new Set(["snippet", "title"]);

export function truncate(rows: Record<string, unknown>[], max: number | undefined) {
  if (max === undefined) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const [key, value] of Object.entries(copy)) {
      if (!CONTENT_FIELDS.has(key)) continue;
      if (typeof value === "string" && value.length > max) copy[key] = `${value.slice(0, max)}…`;
    }
    return copy;
  });
}
