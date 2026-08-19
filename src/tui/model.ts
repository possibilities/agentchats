import type { SessionRow } from "./cass.ts";
import { GLYPHS, type Line, type Span } from "./theme.ts";

/**
 * Everything the picker decides without a terminal: the state, the list
 * discipline, and the exact rows the shell paints. The shell owns only the
 * renderer, the debounce clock, and the cass subprocess.
 */

export type Scope = "project" | "global";

export interface SearchState {
  query: string;
  scope: Scope;
  /** The context project directory: the "project" scope. */
  workspace: string;
  /** What the rows currently answer: recent sessions or a search. */
  source: "recent" | "search";
  rows: SessionRow[];
  selected: number;
  searching: boolean;
  /** A failed cass run; cleared by the next completed one. */
  error: string | null;
}

export function createState(workspace: string, query: string): SearchState {
  return {
    query,
    scope: "project",
    workspace,
    source: "recent",
    rows: [],
    selected: 0,
    searching: false,
    error: null,
  };
}

export function moveSelection(state: SearchState, delta: number): void {
  if (state.rows.length === 0) return;
  state.selected = Math.min(state.rows.length - 1, Math.max(0, state.selected + delta));
}

export function applyRows(state: SearchState, source: "recent" | "search", rows: SessionRow[]): void {
  state.source = source;
  state.rows = rows;
  state.selected = Math.min(state.selected, Math.max(0, rows.length - 1));
  state.searching = false;
  state.error = null;
}

export function applyError(state: SearchState, error: string): void {
  state.searching = false;
  state.error = error;
}

export function toggleScope(state: SearchState): void {
  state.scope = state.scope === "project" ? "global" : "project";
}

/** The workspace argument for cass under the current scope. */
export function scopeWorkspace(state: SearchState): string | null {
  return state.scope === "project" ? state.workspace : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return GLYPHS.ellipsis;
  return `${text.slice(0, max - 1)}${GLYPHS.ellipsis}`;
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** cass connector names, in the operator's vocabulary. */
export function agentLabel(agent: string): string {
  if (agent === "claude_code") return "claude";
  if (agent === "pi_agent") return "pi";
  return agent;
}

export interface ResultRow {
  /** Index into state.rows; null for non-interactive lines. */
  index: number | null;
  spans: Line;
}

/**
 * The instrument's rows for one paint: session rows first (the selected one
 * carries the accent rail and bright text — never color alone), then the
 * selected row's snippet as quiet evidence, then whatever status earns a
 * line. `visibleRows` is how many session rows fit; the window follows the
 * selection.
 */
export function buildResultRows(
  state: SearchState,
  width: number,
  visibleRows: number,
): ResultRow[] {
  const rows: ResultRow[] = [];
  if (state.error !== null) {
    // The failure and its recovery sit first, where scrolling cannot hide
    // them; retyping reruns the search.
    rows.push({
      index: null,
      spans: [{ text: truncate(`FAILED ${GLYPHS.sep} ${state.error}`, width), token: "danger" }],
    });
    return rows;
  }
  if (state.rows.length === 0) {
    const invitation =
      state.query.trim() === ""
        ? state.scope === "project"
          ? `no sessions in ${basename(state.workspace)} yet`
          : "no sessions indexed yet"
        : state.scope === "project"
          ? `no matches in ${basename(state.workspace)}`
          : "no matches anywhere";
    rows.push({
      index: null,
      spans: [{ text: truncate(state.searching ? `${GLYPHS.busy} searching` : invitation, width), token: "muted" }],
    });
    return rows;
  }

  const count = Math.max(1, visibleRows);
  let start = Math.max(0, Math.min(state.selected - Math.floor(count / 2), state.rows.length - count));
  const window = state.rows.slice(start, start + count);

  const whenWidth = 16;
  const agentWidth = Math.max(...state.rows.map((row) => agentLabel(row.agent).length), 5);
  window.forEach((row, offset) => {
    const index = start + offset;
    const isSelected = index === state.selected;
    const spans: Span[] = [];
    spans.push(
      isSelected
        ? { text: `${GLYPHS.rail} `, token: "accent", bold: true }
        : { text: "  ", token: "canvas" },
    );
    const when = (row.when === "" ? "" : row.when).padEnd(whenWidth);
    spans.push({ text: `${when}  `, token: isSelected ? "text" : "muted" });
    spans.push({
      text: `${agentLabel(row.agent).padEnd(agentWidth)}  `,
      token: row.agent === "claude_code" || row.agent === "codex" || row.agent === "pi_agent"
        ? "remote"
        : "faint",
    });
    const used = 2 + whenWidth + 2 + agentWidth + 2;
    const remaining = Math.max(8, width - used);
    const project = truncate(basename(row.workspace), Math.min(18, Math.floor(remaining / 3)));
    spans.push({ text: `${project}  `, token: isSelected ? "text" : "muted" });
    spans.push({
      text: truncate(row.title, Math.max(4, remaining - project.length - 2)),
      token: isSelected ? "text" : "muted",
      ...(isSelected ? { bold: true } : {}),
    });
    rows.push({ index, spans });
  });

  const selected = state.rows[state.selected];
  if (selected !== undefined && selected.snippet !== null) {
    rows.push({ index: null, spans: [{ text: " ", token: "canvas" }] });
    rows.push({
      index: null,
      spans: [
        { text: `  ${GLYPHS.inputRail} `, token: "faint" },
        { text: truncate(selected.snippet, Math.max(8, width - 4)), token: "muted" },
      ],
    });
  }
  return rows;
}
