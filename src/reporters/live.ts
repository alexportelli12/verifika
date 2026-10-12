import { formatSeconds } from "../format.ts";
import { renderCheckEnd, renderStart, renderSummary, type Style } from "./human.ts";
import type { Reporter, StartInfo } from "./reporter.ts";

/** What the live block needs from a terminal. Injected so tests can use a fake one. */
export interface LiveTerminal {
  /** Writes to the terminal (stdout). */
  write(text: string): void;
  /** Current size; read on every redraw, so a resized terminal is picked up. */
  columns(): number;
  rows(): number;
  /** Monotonic clock in milliseconds. */
  now(): number;
  /** Calls `frame` roughly every `ms` until the returned function is called. */
  every(ms: number, frame: () => void): () => void;
  /** Calls `restore` if the process exits while the block is live. Returns an unregister function. */
  onExit(restore: () => void): () => void;
}

/** Redraw interval: about 10 frames a second, which also throttles output-driven updates. */
const FRAME_MS = 100;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CSI = "\u001b[";
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
// Autowrap stays off while the block is drawn, so an overlong line (wide characters
// the width estimate missed) is clipped by the terminal instead of wrapping and
// breaking the cursor-up count of the next redraw.
const NO_WRAP = `${CSI}?7l`;
const WRAP = `${CSI}?7h`;

export interface BlockState {
  /** Selected checks in config order. */
  selected: string[];
  dependsOn: Record<string, string[]>;
  running: Map<string, { since: number; line: string }>;
  /** Finished checks: whether each passed. */
  finished: Map<string, boolean>;
  startedAt: number;
  stopping: boolean;
}

export interface Viewport {
  width: number;
  height: number;
  now: number;
}

/**
 * The redrawn part of the live display: a progress header, one line per running
 * check (spinner, elapsed time, latest output) and the checks still waiting.
 * Lines fit the width; the block never exceeds the height minus one row, so the
 * cursor can always move back to its top.
 */
export function renderBlock(state: BlockState, view: Viewport, style: Style): string[] {
  const max = Math.max(1, view.width - 1);
  const elapsed = formatSeconds(view.now - state.startedAt);
  const header = `[${state.finished.size}/${state.selected.length}] ${elapsed}${state.stopping ? " · stopping…" : ""}`;
  const nameWidth = Math.max(...state.selected.map((name) => name.length));
  const frame = SPINNER[Math.floor(view.now / FRAME_MS) % SPINNER.length] as string;

  const running = state.selected
    .filter((name) => state.running.has(name))
    .map((name) => {
      const { since, line } = state.running.get(name) as { since: number; line: string };
      const time = formatSeconds(view.now - since).padStart(5);
      const prefix = `${frame} ${name.padEnd(nameWidth)}  ${time}`;
      if (prefix.length + 2 >= max) return fit(prefix, max);
      const shown = fit(line, max - prefix.length - 2);
      return `${frame} ${name.padEnd(nameWidth)}  ${style.dim(time)}${shown ? `  ${style.dim(shown)}` : ""}`;
    });
  const groups = waitingGroups(state);
  const waiting = groups.map(({ names, why }) =>
    style.dim(fit(`  ${names.join(", ")}  ${why}`, max)),
  );

  // Keep the header, then as many running checks as fit, then waiting groups;
  // collapse whatever does not fit into a count.
  const room = Math.max(1, view.height - 1) - 1;
  let shownRunning = running.length;
  let shownWaiting = waiting.length;
  const total = () =>
    shownRunning +
    (shownRunning < running.length ? 1 : 0) +
    shownWaiting +
    (shownWaiting < waiting.length ? 1 : 0);
  while (total() > room && (shownWaiting > 0 || shownRunning > 0)) {
    if (shownWaiting > 0) shownWaiting--;
    else shownRunning--;
  }
  const lines = [style.bold(fit(header, max)), ...running.slice(0, shownRunning)];
  if (shownRunning < running.length)
    lines.push(style.dim(fit(`  +${running.length - shownRunning} more running`, max)));
  lines.push(...waiting.slice(0, shownWaiting));
  if (shownWaiting < waiting.length) {
    const hidden = groups
      .slice(shownWaiting)
      .reduce((count, group) => count + group.names.length, 0);
    lines.push(style.dim(fit(`  +${hidden} more waiting`, max)));
  }
  return lines.slice(0, Math.max(1, view.height - 1));
}

/** Checks not yet started, grouped by what they wait for, e.g. `test, pack  waiting on build`. */
function waitingGroups(state: BlockState): { names: string[]; why: string }[] {
  const selected = new Set(state.selected);
  // A check whose dependency failed (directly or down a chain) will never start.
  const blocked = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const name of state.selected) {
      if (blocked.has(name) || state.finished.has(name) || state.running.has(name)) continue;
      const deps = state.dependsOn[name] ?? [];
      if (deps.some((dep) => state.finished.get(dep) === false || blocked.has(dep))) {
        blocked.add(name);
        changed = true;
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const name of state.selected) {
    if (state.running.has(name) || state.finished.has(name) || blocked.has(name)) continue;
    const unmet = (state.dependsOn[name] ?? []).filter(
      (dep) => selected.has(dep) && state.finished.get(dep) !== true,
    );
    const why = state.stopping
      ? "will not start"
      : unmet.length > 0
        ? `waiting on ${unmet.join(", ")}`
        : "queued";
    groups.set(why, [...(groups.get(why) ?? []), name]);
  }
  return [...groups].map(([why, names]) => ({ names, why }));
}

/** Truncates to `width` characters (code points), marking the cut with an ellipsis. */
export function fit(text: string, width: number): string {
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  return width <= 0 ? "" : `${chars.slice(0, width - 1).join("")}…`;
}

/**
 * Human output with a live status block. Finished checks print permanently above
 * the block exactly as the line reporter prints them, so scrollback reads like
 * line mode; the block below is redrawn in place (cursor up, erase down) and
 * removed when the run ends. The cursor is hidden while live and restored on
 * finish, on dispose (errors) and on process exit.
 */
export function liveReporter(terminal: LiveTerminal, style: Style): Reporter {
  let state: BlockState | null = null;
  let drawn = 0;
  let stopTicker: (() => void) | undefined;
  let unregisterExit: (() => void) | undefined;

  const clear = () => (drawn > 0 ? `\r${CSI}${drawn}A${CSI}J` : "");
  const draw = (above = "") => {
    if (!state) return;
    const lines = renderBlock(
      state,
      { width: terminal.columns(), height: terminal.rows(), now: terminal.now() },
      style,
    );
    terminal.write(
      `${clear()}${above}${NO_WRAP}${lines.map((line) => `${line}\n`).join("")}${WRAP}`,
    );
    drawn = lines.length;
  };
  const release = (after = "") => {
    if (!state) {
      if (after) terminal.write(after);
      return;
    }
    stopTicker?.();
    unregisterExit?.();
    terminal.write(`${clear()}${SHOW_CURSOR}${after}`);
    state = null;
    drawn = 0;
  };

  return {
    onStart(info: StartInfo) {
      terminal.write(renderStart(info, style));
      if (info.selected.length === 0) return;
      state = {
        selected: info.selected,
        dependsOn: info.dependsOn,
        running: new Map(),
        finished: new Map(),
        startedAt: terminal.now(),
        stopping: false,
      };
      terminal.write(HIDE_CURSOR);
      unregisterExit = terminal.onExit(() => terminal.write(`${SHOW_CURSOR}${WRAP}`));
      stopTicker = terminal.every(FRAME_MS, () => draw());
      draw();
    },
    onCheckStart(name) {
      state?.running.set(name, { since: terminal.now(), line: "" });
      draw();
    },
    onCheckOutput(name, line) {
      // Picked up by the next frame; output alone never triggers a redraw.
      const entry = state?.running.get(name);
      if (entry) entry.line = line;
    },
    onCheckEnd(check) {
      state?.running.delete(check.name);
      state?.finished.set(check.name, check.status === "passed");
      draw(renderCheckEnd(check, style));
    },
    onFinish(result) {
      release(renderSummary(result, style));
    },
    dispose() {
      release();
    },
  };
}

/** The real terminal behind stdout. */
export function systemTerminal(
  write: (text: string) => void,
  stream: NodeJS.WriteStream,
): LiveTerminal {
  return {
    write,
    columns: () => stream.columns || 80,
    rows: () => stream.rows || 24,
    now: () => performance.now(),
    every(ms, frame) {
      const timer = setInterval(frame, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
    onExit(restore) {
      process.once("exit", restore);
      return () => process.off("exit", restore);
    },
  };
}
