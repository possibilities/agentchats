import { existsSync, statSync } from "node:fs";
import {
  cachedSessionClassifier,
  cassBinary,
  classifySession,
  loadVisibleRows,
  spawnRunner,
} from "./cass.ts";
import { loadAgentchatsConfig } from "./config.ts";
import { applyDescriptions, fetchDescriptions } from "./describe.ts";
import { assertHostedStdout, buildResumeDirective, directiveLine } from "./directive.ts";
import {
  applyError,
  applyRows,
  buildResultRows,
  createState,
  cycleWindow,
  moveSelection,
  scopeWorkspace,
  selectAllProjects,
  selectProject,
  toggleAuxiliary,
  toggleScope,
} from "./model.ts";
import { createListOverlay, type OverlayItem } from "./overlay.ts";
import {
  discoverProjectChoices,
  type ProjectChoice,
  projectDisplayPath,
} from "./projects.ts";
import { resumeTarget } from "./resume.ts";
import { GLYPHS, type Line, SIGNAL_ROOM } from "./theme.ts";

/**
 * The picker shell: a query box over live cass results, rendering on stderr
 * with stdout held by the surface host as the directive pipe. A committed
 * pick writes one resume directive and exits 0; a pick that cannot resume
 * faithfully exits 1 with the reason on stderr, where the host holds the
 * popup open. Everything decidable without a terminal lives in model.ts,
 * resume.ts, and cass.ts.
 */

// Hits collapse to one row per session, so fetch deep enough that a chatty
// session cannot starve the list.
const SEARCH_LIMIT = 120;
const RECENT_LIMIT = 20;
const DEBOUNCE_MS = 150;

interface QueryBinding {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  action: import("@opentui/core").TextareaAction;
}

/** The query field's keymap: the widget's default line-editing set with
 * enter submitting the pick instead of inserting. Ctrl+k/g/t and Tab are
 * released to the app for palette, scope, time, and field focus. */
export function queryKeyBindings(defaults: readonly QueryBinding[]): QueryBinding[] {
  return [
    ...defaults.filter(
      (binding) =>
        !(
          ((binding.name === "return" || binding.name === "kpenter") &&
            binding.shift !== true &&
            binding.action === "newline") ||
          ((binding.name === "k" || binding.name === "g" || binding.name === "t") &&
            binding.ctrl === true) ||
          binding.name === "tab" ||
          binding.name === "backtab"
        ),
    ),
    { name: "return", action: "submit" },
    { name: "kpenter", action: "submit" },
  ];
}

/** The search field shares the same left-weighted focus rail as selectable rows. */
export function queryRailGlyph(searching: boolean): string {
  return searching ? GLYPHS.busy : GLYPHS.rail;
}

export interface SearchInvocation {
  query: string;
  workspace: string | null;
  includeAuxiliary: boolean;
}

export async function runSearch(
  env: Record<string, string | undefined>,
  invocation: SearchInvocation,
): Promise<number> {
  // Everything fallible happens before the alternate screen, so a failure
  // prints plainly where the host can hold it on screen.
  const refusal = assertHostedStdout(process.stdout);
  if (refusal !== null) {
    process.stderr.write(`agentchats search: ${refusal}\n`);
    return 1;
  }
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    process.stderr.write(
      "agentchats search: the picker needs a terminal on stdin and stderr\n",
    );
    return 1;
  }
  const binary = cassBinary(env);
  if (binary === null) {
    process.stderr.write(
      "agentchats search: cass is not installed; run ~/code/agentchats/scripts/install.sh --install\n",
    );
    return 1;
  }
  let config: Awaited<ReturnType<typeof loadAgentchatsConfig>>;
  try {
    config = await loadAgentchatsConfig(env);
  } catch (error) {
    process.stderr.write(
      `agentchats search: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const workspace = invocation.workspace ?? projectDirectory();
  const home = env["HOME"] ?? "";
  const projectChoices = discoverProjectChoices(workspace, home);
  const state = createState(workspace, invocation.query, invocation.includeAuxiliary);
  const runner = spawnRunner(binary);
  const classifyForSearch = cachedSessionClassifier((row) =>
    classifySession(row, config.auxiliaryCodexOriginators),
  );

  // @opentui/core is imported dynamically only — its platform-native package
  // top-level-awaits and races under parallel test isolation.
  const core = await import("@opentui/core");
  // The renderer draws on stderr: stdout is the host's directive channel.
  // Console capture stays off so nothing else can reach stdout either.
  const renderer = await core.createCliRenderer({
    stdout: process.stderr as unknown as NodeJS.WriteStream,
    consoleMode: "disabled",
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  // Off process.stdout the renderer sees no SIGWINCH itself; resize() is
  // documented for exactly this externally-driven case.
  const onResize = (): void => {
    // `||`, not `??`: a headless pty reports 0×0, which is no size at all.
    renderer.resize(process.stderr.columns || 80, process.stderr.rows || 24);
    paint();
  };

  const root = new core.BoxRenderable(renderer, {
    id: "search-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  renderer.root.add(root);
  const frame = new core.BoxRenderable(renderer, {
    id: "search-frame",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
    // A press on padding or empty canvas dismisses an open overlay and
    // nothing else.
    onMouseUp: (event) => {
      event.stopPropagation();
      if (commands.isOpen() || projects.isOpen()) {
        dismissOverlays();
        paint();
      }
    },
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      event.stopPropagation();
      event.preventDefault();
      listScroll(direction);
    },
  });
  // The query block: the accent focus rail beside OpenTUI's own textarea —
  // a real line editor. The rail doubles as the live-search signal: the
  // busy glyph while a cass run is in flight.
  const queryRow = new core.BoxRenderable(renderer, {
    id: "search-query-row",
    width: "100%",
    flexDirection: "row",
    flexShrink: 0,
    backgroundColor: SIGNAL_ROOM.canvas,
    onMouseUp: (event) => {
      event.stopPropagation();
      if (commands.isOpen() || projects.isOpen()) {
        dismissOverlays();
        paint();
        return;
      }
      focusQuery();
      paint();
    },
  });
  const rail = new core.TextRenderable(renderer, {
    id: "search-query-rail",
    content: queryRailGlyph(false),
    fg: SIGNAL_ROOM.accent,
    width: 2,
  });
  const query = new core.TextareaRenderable(renderer, {
    id: "search-query",
    flexGrow: 1,
    minHeight: 1,
    height: 1,
    wrapMode: "none",
    backgroundColor: SIGNAL_ROOM.canvas,
    focusedBackgroundColor: SIGNAL_ROOM.canvas,
    textColor: SIGNAL_ROOM.text,
    focusedTextColor: SIGNAL_ROOM.text,
    cursorColor: SIGNAL_ROOM.accent,
    placeholder: `Search sessions${GLYPHS.ellipsis}`,
    placeholderColor: SIGNAL_ROOM.muted,
    keyBindings: queryKeyBindings(core.defaultTextareaKeyBindings),
  });
  queryRow.add(rail);
  queryRow.add(query);
  frame.add(queryRow);
  // Project is a first-class field beneath search, following AgentLaunch's
  // form grammar: Tab focuses it; Space/Enter opens its fuzzy chooser.
  const projectRow = new core.BoxRenderable(renderer, {
    id: "search-project-row",
    width: "100%",
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: SIGNAL_ROOM.canvas,
    onMouseUp: (event) => {
      event.stopPropagation();
      if (commands.isOpen() || projects.isOpen()) {
        dismissOverlays();
        paint();
        return;
      }
      focusProject();
      openProjects();
    },
  });
  const projectText = new core.TextRenderable(renderer, {
    id: "search-project",
    content: "",
    height: 1,
  });
  projectRow.add(projectText);
  frame.add(projectRow);
  // The result list is a column of per-row renderables rather than one text
  // blob, so every row is a pointer target the renderer can hit-test.
  const body = new core.BoxRenderable(renderer, {
    id: "search-body",
    marginTop: 1,
    width: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
  });
  frame.add(body);
  root.add(frame);

  const overlayTokens = {
    panel: SIGNAL_ROOM.panel,
    line: SIGNAL_ROOM.line,
    accent: SIGNAL_ROOM.accent,
    muted: SIGNAL_ROOM.muted,
    text: SIGNAL_ROOM.text,
  };
  const commands = createListOverlay(
    core,
    renderer,
    "search-commands",
    overlayTokens,
    { title: " COMMANDS ", empty: "no matching command" },
  );
  const projects = createListOverlay(core, renderer, "search-projects", overlayTokens, {
    title: " PROJECTS ",
    empty: "no matching project",
  });
  renderer.root.add(commands.root);
  renderer.root.add(projects.root);

  type SearchFocus = "query" | "project";
  let searchFocus: SearchFocus = "query";
  const focusQuery = (): void => {
    searchFocus = "query";
    query.focus();
  };
  const focusProject = (): void => {
    searchFocus = "project";
    query.blur();
  };
  const restoreFocus = (): void => {
    if (searchFocus === "query") query.focus();
    else query.blur();
  };

  // Overlays are modal to the keyboard. The focused field is remembered
  // underneath them and restored on every close path.
  const openPalette = (): void => {
    query.blur();
    commands.open();
  };
  const dismissOverlays = (): void => {
    commands.close();
    projects.close();
    if (!closed) restoreFocus();
  };

  const lineToStyled = (line: Line): InstanceType<typeof core.StyledText> => {
    const chunks: ReturnType<typeof core.bold>[] = [];
    for (const part of line) {
      if (part.text.length === 0) continue;
      let chunk = core.fg(SIGNAL_ROOM[part.token])(part.text);
      if (part.bold === true) chunk = core.bold(chunk);
      chunks.push(chunk);
    }
    if (chunks.length === 0) chunks.push(core.fg(SIGNAL_ROOM.canvas)(" "));
    return new core.StyledText(chunks);
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let done!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    done = resolve;
  });
  let closed = false;
  let epitaph: string | null = null;
  const shutdown = (code: number): void => {
    if (closed) return;
    closed = true;
    if (interval !== null) clearInterval(interval);
    if (debounce !== null) clearTimeout(debounce);
    process.removeListener("SIGWINCH", onResize);
    renderer.destroy();
    if (epitaph !== null) process.stderr.write(`agentchats search: ${epitaph}\n`);
    done(code);
  };
  process.once("SIGTERM", () => shutdown(1));
  process.once("SIGHUP", () => shutdown(1));

  /** The fatal-error contract: a pick that cannot resume ends the picker
   * with the reason on stderr, held on screen by the host. */
  const die = (reason: string): void => {
    epitaph = reason;
    shutdown(1);
  };

  // Latest-wins: a slow cass answer for a stale query repaints nothing.
  let generation = 0;
  const refresh = (): void => {
    generation += 1;
    const current = generation;
    const trimmed = query.plainText.trim();
    state.query = query.plainText;
    state.searching = true;
    paint();
    const scope = scopeWorkspace(state);
    const source = trimmed === "" ? "recent" : "search";
    void loadVisibleRows(
      runner,
      {
        query: trimmed,
        scope,
        window: state.window,
        limit: trimmed === "" ? RECENT_LIMIT : SEARCH_LIMIT,
        includeAuxiliary: state.includeAuxiliary,
        shouldContinue: () => !closed && current === generation,
      },
      classifyForSearch,
    ).then((result) => {
      if (closed || current !== generation) return;
      if (!result.ok) {
        applyError(state, result.error);
      } else {
        applyRows(state, source, result.rows);
        // Enrichment arrives late and only improves rows already shown, so
        // it rides behind the paint and honors the same generation.
        void fetchDescriptions(state.rows, env).then((descriptions) => {
          if (closed || current !== generation || descriptions.size === 0) return;
          applyDescriptions(state.rows, descriptions);
          paint();
        });
      }
      paint();
    });
  };

  const scheduleRefresh = (): void => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      refresh();
    }, DEBOUNCE_MS);
  };

  /** Freeze the pick, judge it, and either hand the host one directive line
   * or die with the reason. One commit per run: the guard keeps a
   * key-repeat enter from writing the directive twice. */
  let committing = false;
  const commit = (): void => {
    if (committing || closed) return;
    const row = state.rows[state.selected];
    if (row === undefined) return;
    committing = true;
    const outcome = resumeTarget(row, {
      fileExists: (path) => existsSync(path),
      directoryExists: (path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      },
    });
    if (!outcome.ok) {
      die(outcome.reason);
      return;
    }
    // The widget, not the state: a terminal that batches its key dispatch
    // can land enter before the debounced refresh copied the text over.
    const directive = buildResumeDirective(outcome.target, {
      query: query.plainText.trim(),
      source_path: row.path,
    });
    try {
      process.stdout.write(directiveLine(directive));
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
      return;
    }
    shutdown(0);
  };

  const listScroll = (direction: "up" | "down"): void => {
    if (commands.isOpen() || projects.isOpen()) return;
    moveSelection(state, direction === "down" ? 1 : -1);
    paint();
  };

  const toggleScopeAndSearch = (): void => {
    toggleScope(state);
    refresh();
  };

  const cycleWindowAndSearch = (): void => {
    cycleWindow(state);
    refresh();
  };

  const toggleAuxiliaryAndSearch = (): void => {
    toggleAuxiliary(state);
    refresh();
  };

  const projectItems = (): OverlayItem[] => {
    return [
      {
        id: "all-projects",
        label: "all projects",
        meta: "everywhere",
        onRun: () => {
          selectAllProjects(state);
          refresh();
        },
      },
      ...projectChoices.map((project) => ({
        id: project.path,
        label: project.display,
        onRun: () => {
          selectProject(state, project.path);
          refresh();
        },
      })),
    ];
  };

  const openProjects = (): void => {
    focusProject();
    const at =
      state.scope === "global"
        ? 0
        : Math.max(
            1,
            projectChoices.findIndex((project) => project.path === state.workspace) + 1,
          );
    projects.open(at);
    paint();
  };

  const stepProject = (delta: number): void => {
    const choices: Array<ProjectChoice | null> = [null, ...projectChoices];
    const current =
      state.scope === "global"
        ? 0
        : Math.max(
            1,
            projectChoices.findIndex((project) => project.path === state.workspace) + 1,
          );
    const at = Math.max(0, Math.min(choices.length - 1, current + delta));
    const choice = choices[at];
    if (choice === undefined) return;
    if (choice === null) selectAllProjects(state);
    else selectProject(state, choice.path);
    refresh();
  };

  const commandItems = () => [
    { id: "resume", key: "⏎", label: "resume the selected session", onRun: () => commit() },
    {
      id: "scope",
      key: "⌃G",
      label: state.scope === "project" ? "search all workspaces" : "search this project only",
      meta: state.scope === "project" ? "global" : basename(state.workspace),
      onRun: () => toggleScopeAndSearch(),
    },
    {
      id: "project",
      label: "choose project",
      meta: basename(state.workspace),
      onRun: () => openProjects(),
    },
    {
      id: "window",
      key: "⌃T",
      label: "cycle the time window",
      meta: state.window,
      onRun: () => cycleWindowAndSearch(),
    },
    {
      id: "auxiliary",
      label: state.includeAuxiliary ? "hide auxiliary threads" : "include auxiliary threads",
      meta: state.includeAuxiliary ? "shown" : "hidden",
      onRun: () => toggleAuxiliaryAndSearch(),
    },
    { id: "quit", key: "ESC", label: "quit without resuming", onRun: () => shutdown(0) },
  ];

  // Rebuilt only when the rows actually change, so the repaint tick never
  // churns renderables.
  let bodySignature = "";
  const paint = (): void => {
    const columns = process.stderr.columns || renderer.width || 80;
    const rows = renderer.height || process.stderr.rows || 24;
    rail.fg =
      state.searching
        ? SIGNAL_ROOM.local
        : searchFocus === "query"
          ? SIGNAL_ROOM.accent
          : SIGNAL_ROOM.faint;
    rail.content = queryRailGlyph(state.searching);
    // Frame padding is 2+2; the query rail is 2 more.
    query.width = Math.max(8, columns - 6);
    const projectRaw =
      state.scope === "global" ? "all projects" : projectDisplayPath(state.workspace, home);
    const qualifiers = [
      state.window === "all" ? null : state.window,
      state.includeAuxiliary ? "auxiliary" : null,
    ].filter((part): part is string => part !== null);
    const qualifierWidth = qualifiers.reduce(
      (total, qualifier) => total + 4 + qualifier.length,
      0,
    );
    const project = fitText(
      projectRaw,
      Math.max(
        6,
        columns - 4 - 13 - qualifierWidth - (searchFocus === "project" ? 4 : 0),
      ),
    );
    const projectSpans: Line = [
      searchFocus === "project"
        ? { text: `${GLYPHS.rail} `, token: "accent", bold: true }
        : { text: "  ", token: "canvas" },
      { text: "project    ", token: "muted" },
      ...(searchFocus === "project"
        ? [
            { text: `${GLYPHS.prev} `, token: "faint" as const },
            { text: project, token: "text" as const, bold: true },
            { text: ` ${GLYPHS.next}`, token: "faint" as const },
          ]
        : [{ text: project, token: "text" as const }]),
      ...qualifiers.flatMap((qualifier) => [
        { text: `  ${GLYPHS.sep} `, token: "faint" as const },
        { text: qualifier, token: "muted" as const },
      ]),
    ];
    projectText.content = lineToStyled(projectSpans);
    const visible = Math.max(3, rows - 7);
    const resultRows = buildResultRows(state, Math.max(24, columns - 4), visible);
    const nextSignature = JSON.stringify(resultRows);
    if (nextSignature !== bodySignature) {
      bodySignature = nextSignature;
      for (const child of body.getChildren()) {
        body.remove(child.id);
        child.destroyRecursively();
      }
      resultRows.forEach((row, position) => {
        const rowBox = new core.BoxRenderable(renderer, {
          id: `search-row-${position}`,
          height: 1,
          width: "100%",
          flexDirection: "row",
          backgroundColor: SIGNAL_ROOM.canvas,
          onMouseUp: (event) => {
            event.stopPropagation();
            if (commands.isOpen() || projects.isOpen()) {
              dismissOverlays();
              paint();
              return;
            }
            // A tap performs the row's primary action: pick that session.
            if (row.index !== null) {
              state.selected = row.index;
              commit();
            }
          },
          onMouseScroll: (event) => {
            const direction = event.scroll?.direction;
            if (direction !== "up" && direction !== "down") return;
            event.stopPropagation();
            event.preventDefault();
            listScroll(direction);
          },
        });
        rowBox.add(
          new core.TextRenderable(renderer, { content: lineToStyled(row.spans), height: 1 }),
        );
        body.add(rowBox);
      });
    }
    commands.update({ width: columns, height: rows, items: commandItems() });
    projects.update({ width: columns, height: rows, items: projectItems() });
    renderer.requestRender();
  };

  // Enter submits inside the textarea; the flag tells the keypress listener
  // below that this very event was consumed, not a second enter to act on.
  let querySubmitted = false;
  query.onSubmit = () => {
    querySubmitted = true;
    commit();
  };
  focusQuery();
  if (invocation.query !== "") {
    query.setText(invocation.query);
    query.cursorOffset = query.plainText.length;
  }

  let queryShadow = query.plainText;
  // The microtasks run after the widget's own dispatch — and possibly after
  // a commit tore the renderer down, so they check `closed` first.
  const syncQuery = (): void => {
    if (closed) return;
    if (query.plainText !== queryShadow) {
      queryShadow = query.plainText;
      scheduleRefresh();
    }
    paint();
  };
  renderer.keyInput.on("paste", () => {
    queueMicrotask(syncQuery);
  });

  renderer.keyInput.on("keypress", (key) => {
    // Kitty-mode terminals report key releases too; only presses act.
    if ((key as { eventType?: string }).eventType === "release") return;
    if (querySubmitted) {
      querySubmitted = false;
      return;
    }
    if (key.ctrl && key.name === "c") {
      shutdown(130);
      return;
    }
    const openOverlay = projects.isOpen() ? projects : commands.isOpen() ? commands : null;
    if (openOverlay !== null) {
      if (key.ctrl && key.name === "k") {
        dismissOverlays();
        return;
      }
      openOverlay.handleKey(key);
      // The overlay may have closed itself (escape, or enter running an
      // item); focus returns to the field that opened it.
      if (!commands.isOpen() && !projects.isOpen() && !closed) restoreFocus();
      return;
    }
    if (key.ctrl && key.name === "k") {
      openPalette();
      return;
    }
    if (key.ctrl && key.name === "g") {
      toggleScopeAndSearch();
      return;
    }
    if (key.ctrl && key.name === "t") {
      cycleWindowAndSearch();
      return;
    }
    if (key.name === "tab" || key.name === "backtab") {
      if (searchFocus === "query") focusProject();
      else focusQuery();
      paint();
      return;
    }
    if (key.name === "escape") {
      shutdown(0);
      return;
    }
    if (searchFocus === "project") {
      if (
        key.name === "space" ||
        key.sequence === " " ||
        key.name === "return" ||
        key.name === "enter"
      ) {
        openProjects();
        return;
      }
      if (key.name === "left" || key.name === "up") {
        stepProject(-1);
        return;
      }
      if (key.name === "right" || key.name === "down") {
        stepProject(1);
        return;
      }
      return;
    }
    if (key.name === "up" || (key.ctrl === true && key.name === "p")) {
      listScroll("up");
      return;
    }
    if (key.name === "down" || (key.ctrl === true && key.name === "n")) {
      listScroll("down");
      return;
    }
    // Everything else belongs to the query field; the microtask runs after
    // its dispatch, so the diff sees the edit.
    queueMicrotask(syncQuery);
  });

  process.on("SIGWINCH", onResize);
  interval = setInterval(paint, 500);
  refresh();
  return await finished;
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

function fitText(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return GLYPHS.ellipsis;
  return `${text.slice(0, width - 1)}${GLYPHS.ellipsis}`;
}

/** The context project: the git toplevel of the host-provided cwd, or the
 * cwd itself outside a repository — the same rule as `agentchats state`. */
export function projectDirectory(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const top = proc.stdout.toString().trim();
    if (proc.exitCode === 0 && top !== "") return top;
  } catch {
    // No git, no repository: the cwd is the project.
  }
  return process.cwd();
}
