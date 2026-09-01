/**
 * Argument parsing for the agentchats CLI. Small and strict on purpose: an
 * unknown flag is a usage error rather than a silently ignored word, because
 * an agent that misspells a filter and gets unfiltered results back will
 * believe the wrong answer.
 */

export interface Parsed {
  positional: string[];
  values: Record<string, string>;
  flags: Set<string>;
}

export class UsageError extends Error {}

/**
 * `value` names the options that take an argument; everything else in
 * `boolean` is a bare flag. Both lists are per-command, so `--limit` is a
 * usage error where it means nothing.
 */
export function parseArgs(
  argv: readonly string[],
  spec: { value: readonly string[]; boolean: readonly string[] },
): Parsed {
  const parsed: Parsed = { positional: [], values: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (!argument.startsWith("--")) {
      parsed.positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = (equals === -1 ? argument : argument.slice(0, equals)).slice(2);
    if (spec.value.includes(name)) {
      const value = equals === -1 ? argv[++i] : argument.slice(equals + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      parsed.values[name] = value;
      continue;
    }
    if (spec.boolean.includes(name)) {
      parsed.flags.add(name);
      continue;
    }
    throw new UsageError(`unknown option "--${name}"`);
  }
  return parsed;
}

export function integer(parsed: Parsed, name: string, fallback: number): number {
  const raw = parsed.values[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number`);
  return Number(raw);
}

const RELATIVE = /^-?(\d+)([dhwm])$/;

/**
 * A point in time, as the ISO string the index stores. Accepts what an agent
 * will actually type: `7` days via --days, a relative `-7d`/`24h`, or a date.
 * Anything else is a usage error rather than a silent epoch.
 */
export function resolveWhen(raw: string, now: Date = new Date()): string {
  const relative = raw.match(RELATIVE);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000 }[unit]!;
    return new Date(now.getTime() - amount * ms).toISOString();
  }
  const parsedDate = new Date(raw);
  if (Number.isNaN(parsedDate.getTime())) throw new UsageError(`cannot read a date from "${raw}"`);
  return parsedDate.toISOString();
}

export function daysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
