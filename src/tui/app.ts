import { existsSync, statSync } from "node:fs";
import {
  cassBinary,
  parseHits,
  parseSessions,
  searchArgs,
  sessionsArgs,
  spawnRunner,
} from "./cass.ts";
import { applyDescriptions, fetchDescriptions } from "./describe.ts";
import { assertHostedStdout, buildResumeDirective, directiveLine } from "./directive.ts";
import {
  applyError,
  applyRows,
  buildResultRows,
  createState,
  cycleWindow,
  moveSelection,
  scopeLabel,
  scopeWorkspace,
  toggleScope,
} from "./model.ts";
import { createListOverlay } from "./overlay.ts";
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
 * enter submitting the pick instead of inserting, and two chords released
 * to the app — ctrl+k for the command palette (the fleet chord outranks
 * kill-to-line-end in a field this short), ctrl+g for the scope toggle,
 * and ctrl+t for the time window: the toggles must work while typing
 * because printable keys are the field's. */
export function queryKeyBindings(defaults: readonly QueryBinding[]): QueryBinding[] {
  return [
    ...defaults.filter(
      (binding) =>
        !(
          ((binding.name === "return" || binding.name === "kpenter") &&
            binding.shift !== true &&
            binding.action === "newline") ||
          ((binding.name === "k" || binding.name === "g" || binding.name === "t") &&
            binding.ctrl === true)
        ),
    ),
    { name: "return", action: "submit" },
    { name: "kpenter", action: "submit" },
  ];
}

export interface SearchInvocation {
  query: string;
  workspace: string | null;
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

  const workspace = invocation.workspace ?? projectDirectory();
  const state = createState(workspace, invocation.query);
  const runner = spawnRunner(binary);

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
      if (commands.isOpen()) {
        dismissPalette();
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
  // The query block: the accent input rail beside OpenTUI's own textarea —
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
      if (commands.isOpen()) {
        dismissPalette();
        paint();
      }
    },
  });
  const rail = new core.TextRenderable(renderer, {
    id: "search-query-rail",
    content: GLYPHS.inputRail,
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
  // The scope readout, right of the query: the project's name when scoped,
  // "everywhere" when global — the indicator for what a search covers.
  const scopeTag = new core.TextRenderable(renderer, {
    id: "search-scope",
    content: "",
    height: 1,
    flexShrink: 0,
    fg: SIGNAL_ROOM.muted,
  });
  queryRow.add(rail);
  queryRow.add(query);
  queryRow.add(scopeTag);
  frame.add(queryRow);
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

  const commands = createListOverlay(
    core,
    renderer,
    "search-commands",
    {
      panel: SIGNAL_ROOM.panel,
      line: SIGNAL_ROOM.line,
      accent: SIGNAL_ROOM.accent,
      muted: SIGNAL_ROOM.muted,
      text: SIGNAL_ROOM.text,
    },
    { title: " COMMANDS ", empty: "no matching command" },
  );
  renderer.root.add(commands.root);

  // The palette is modal to the keyboard, and the renderer routes keys to
  // the focused textarea regardless — so opening the palette blurs the
  // query (else enter reaches the field's submit and commits a pick through
  // a closed palette), and every close path hands focus back.
  const openPalette = (): void => {
    query.blur();
    commands.open();
  };
  const dismissPalette = (): void => {
    commands.close();
    if (!closed) query.focus();
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
    const args =
      trimmed === ""
        ? sessionsArgs(scope, RECENT_LIMIT, state.window)
        : searchArgs(trimmed, scope, SEARCH_LIMIT, state.window);
    void runner(args).then((result) => {
      if (closed || current !== generation) return;
      if (!result.ok) {
        applyError(state, result.error);
      } else {
        applyRows(
          state,
          source,
          source === "recent"
            ? parseSessions(result.stdout, scope)
            : parseHits(result.stdout, scope),
        );
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
    if (commands.isOpen()) return;
    moveSelection(state, direction === "down" ? 1 : -1);
    paint();
  };

  const toggleScopeAndSearch = (): void => {
    toggleScope(state);
    // A palette pick lands here after the overlay closed itself; typing
    // must keep working, so the query takes focus back.
    if (!closed) query.focus();
    refresh();
  };

  const cycleWindowAndSearch = (): void => {
    cycleWindow(state);
    if (!closed) query.focus();
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
      id: "window",
      key: "⌃T",
      label: "cycle the time window",
      meta: state.window,
      onRun: () => cycleWindowAndSearch(),
    },
    { id: "quit", key: "ESC", label: "quit without resuming", onRun: () => shutdown(0) },
  ];

  // Rebuilt only when the rows actually change, so the repaint tick never
  // churns renderables.
  let bodySignature = "";
  const paint = (): void => {
    const columns = process.stderr.columns || renderer.width || 80;
    const rows = renderer.height || process.stderr.rows || 24;
    rail.fg = state.searching ? SIGNAL_ROOM.local : SIGNAL_ROOM.accent;
    rail.content = state.searching ? GLYPHS.busy : GLYPHS.inputRail;
    const scope = scopeLabel(state);
    scopeTag.content = `  ${scope}`;
    // Frame padding is 2+2; the rail is 2 more; the scope tag takes its own.
    query.width = Math.max(8, columns - 6 - (scope.length + 2));
    const visible = Math.max(3, rows - 6);
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
            if (commands.isOpen()) {
              dismissPalette();
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
    renderer.requestRender();
  };

  // Enter submits inside the textarea; the flag tells the keypress listener
  // below that this very event was consumed, not a second enter to act on.
  let querySubmitted = false;
  query.onSubmit = () => {
    querySubmitted = true;
    commit();
  };
  query.focus();
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
    if (commands.isOpen()) {
      if (key.ctrl && key.name === "k") {
        dismissPalette();
        return;
      }
      commands.handleKey(key);
      // The overlay may have closed itself (escape, or enter running an
      // item); focus follows it back to the query either way.
      if (!commands.isOpen() && !closed) query.focus();
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
    if (key.name === "escape") {
      shutdown(0);
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
