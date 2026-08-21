import type { SessionRow, TimeWindow } from "./cass.ts";
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
  /** How far back a search reaches; cycled with ctrl+t. */
  window: TimeWindow;
  /** Auxiliary app-server, realtime, and child Codex threads are opt-in. */
  includeAuxiliary: boolean;
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

export function createState(
  workspace: string,
  query: string,
  includeAuxiliary = false,
): SearchState {
  return {
    query,
    scope: "project",
    window: "all",
    includeAuxiliary,
    workspace,
    source: "recent",
    rows: [],
    selected: 0,
    searching: false,
    error: null,
  };
}

/** Keyboard steps wrap at the ends — only an exact edge step wraps, a larger
 * jump clamps to the end first; the wheel stays clamped (wrap = false). */
export function moveSelection(state: SearchState, delta: number, wrap = false): void {
  const count = state.rows.length;
  if (count === 0) return;
  const next = state.selected + delta;
  if (wrap && next < 0 && state.selected === 0) state.selected = count - 1;
  else if (wrap && next >= count && state.selected === count - 1) state.selected = 0;
  else state.selected = Math.min(count - 1, Math.max(0, next));
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
  state.rows = [];
  state.selected = 0;
}

/** Selecting a project also makes project scope active. */
export function selectProject(state: SearchState, workspace: string): void {
  state.workspace = workspace;
  state.scope = "project";
  // A result from the previous workspace must never be resumable under the
  // newly displayed scope while cass is answering the replacement search.
  state.rows = [];
  state.selected = 0;
}

/** All-projects is a scope choice too; clear rows until its search answers. */
export function selectAllProjects(state: SearchState): void {
  state.scope = "global";
  state.rows = [];
  state.selected = 0;
}

export function toggleAuxiliary(state: SearchState): void {
  state.includeAuxiliary = !state.includeAuxiliary;
}

/** The workspace argument for cass under the current scope. */
export function scopeWorkspace(state: SearchState): string | null {
  return state.scope === "project" ? state.workspace : null;
}

/** The scope readout beside the query: what the operator recognizes — the
 * project's own name when scoped, "everywhere" when global — plus the time
 * window when one narrows the search. */
export function scopeLabel(state: SearchState): string {
  const place = state.scope === "project" ? basename(state.workspace) : "everywhere";
  const qualifiers = [
    state.window === "all" ? null : state.window,
    state.includeAuxiliary ? "auxiliary" : null,
  ].filter((part): part is string => part !== null);
  return qualifiers.length === 0
    ? place
    : `${place} ${qualifiers.map((part) => `${GLYPHS.sep} ${part}`).join(" ")}`;
}

export function cycleWindow(state: SearchState): void {
  state.window = state.window === "all" ? "today" : state.window === "today" ? "week" : "all";
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
    // The row's subject: the fleet's slug when naming ever computed one,
    // brighter than the excerpt beside it; otherwise the first-prompt
    // excerpt, and only as a last resort cass's raw title.
    let budget = Math.max(4, remaining - project.length - 2);
    if (row.slug !== null) {
      const slug = truncate(row.slug, Math.max(4, Math.min(36, budget)));
      spans.push({ text: slug, token: "text", ...(isSelected ? { bold: true } : {}) });
      budget -= slug.length;
      if (row.excerpt !== null && budget > 8) {
        spans.push({ text: `  ${GLYPHS.sep} `, token: "faint" });
        spans.push({ text: truncate(row.excerpt, budget - 4), token: "muted" });
      }
    } else {
      spans.push({
        text: truncate(row.excerpt ?? row.title, budget),
        token: isSelected ? "text" : "muted",
        ...(isSelected ? { bold: true } : {}),
      });
    }
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
