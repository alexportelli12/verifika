import { describe, expect, it } from "vitest";
import { LastLine } from "../../src/preview.ts";
import { humanReporter, plain } from "../../src/reporters/human.ts";
import {
  fit,
  liveReporter,
  renderBlock,
  type BlockState,
  type LiveTerminal,
} from "../../src/reporters/live.ts";
import type { Reporter, StartInfo } from "../../src/reporters/reporter.ts";
import { summarize } from "../../src/runner.ts";
import type { CheckResult, RunResult, Selection } from "../../src/types.ts";

/** Interprets the escape sequences the live reporter writes, like a terminal would. */
class Screen {
  lines: string[] = [""];
  row = 0;
  col = 0;
  cursorHidden = false;
  autowrap = true;

  write(text: string): void {
    let index = 0;
    while (index < text.length) {
      // eslint-disable-next-line no-control-regex
      const sequence = /^\u001b\[([?\d;]*)([A-Za-z])/.exec(text.slice(index));
      if (sequence) {
        this.control(sequence[1] ?? "", sequence[2] ?? "");
        index += sequence[0].length;
        continue;
      }
      const char = text[index++] as string;
      if (char === "\r") this.col = 0;
      else if (char === "\n") {
        this.row++;
        this.col = 0;
        while (this.lines.length <= this.row) this.lines.push("");
      } else {
        const line = (this.lines[this.row] ?? "").padEnd(this.col);
        this.lines[this.row] = line.slice(0, this.col) + char + line.slice(this.col + 1);
        this.col++;
      }
    }
  }

  private control(params: string, command: string): void {
    if (command === "A") this.row = Math.max(0, this.row - Number(params || 1));
    else if (command === "J") {
      this.lines[this.row] = (this.lines[this.row] ?? "").slice(0, this.col);
      this.lines.length = this.row + 1;
    } else if (params === "?25") this.cursorHidden = command === "l";
    else if (params === "?7") this.autowrap = command === "h";
  }

  /** Visible text, without the empty line the cursor rests on. */
  text(): string {
    return this.lines.join("\n").replace(/\n$/, "");
  }
}

function fakeTerminal(size = { columns: 60, rows: 20 }) {
  const screen = new Screen();
  let clock = 0;
  let frame: (() => void) | undefined;
  let exitHook: (() => void) | undefined;
  const terminal: LiveTerminal = {
    write: (text) => screen.write(text),
    columns: () => size.columns,
    rows: () => size.rows,
    now: () => clock,
    every(_ms, callback) {
      frame = callback;
      return () => {
        frame = undefined;
      };
    },
    onExit(restore) {
      exitHook = restore;
      return () => {
        exitHook = undefined;
      };
    },
  };
  return {
    screen,
    terminal,
    size,
    advance(ms: number) {
      clock += ms;
      frame?.();
    },
    get ticking() {
      return frame !== undefined;
    },
    exit: () => exitHook?.(),
  };
}

function check(name: string, overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name,
    command: `npm run ${name}`,
    selected: true,
    status: "passed",
    reason: "exit 0",
    exitCode: 0,
    signal: null,
    durationMs: 1200,
    log: `.verifika/runs/r/${name}.log`,
    preview: [],
    error: null,
    ...overrides,
  };
}

function runResult(checks: CheckResult[]): RunResult {
  const failed = checks.some((item) => item.selected && item.status !== "passed");
  return {
    schemaVersion: 1,
    tool: { name: "verifika", version: "1.0.0" },
    runId: "20261012-000000-000-abcdef",
    status: failed ? "failed" : "passed",
    exitCode: failed ? 1 : 0,
    startedAt: "2026-10-12T00:00:00.000Z",
    durationMs: 4300,
    root: "/repo",
    logsDir: ".verifika/runs/20261012-000000-000-abcdef",
    selection: {
      mode: "all",
      reason: "--all",
      base: null,
      baseCommit: null,
      changedFiles: [],
      invalidatedBy: null,
    },
    summary: summarize(checks),
    latest: true,
    checks,
  };
}

const names = ["build", "lint", "test", "pack"];
const selection: Selection = {
  mode: "all",
  reason: "--all",
  changes: null,
  invalidatedBy: null,
  checks: names.map((name) => ({ name, selected: true, reason: "full", matchedFiles: [] })),
};
const start: StartInfo = {
  runId: "r",
  selection,
  selected: names,
  concurrency: 2,
  dependsOn: { build: [], lint: [], test: ["build"], pack: ["build"] },
};

/** Drives a reporter through a typical run: build and lint in parallel, then test and pack. */
function drive(reporter: Reporter, advance: (ms: number) => void = () => undefined) {
  reporter.onStart?.(start);
  reporter.onCheckStart?.("build");
  reporter.onCheckStart?.("lint");
  reporter.onCheckOutput?.("build", "compiling src/index.ts");
  advance(100);
  reporter.onCheckEnd?.(check("lint", { status: "failed", reason: "exit 1", exitCode: 1 }));
  advance(100);
  reporter.onCheckEnd?.(check("build"));
  reporter.onCheckStart?.("test");
  reporter.onCheckStart?.("pack");
  advance(100);
  reporter.onCheckEnd?.(check("test"));
  reporter.onCheckEnd?.(check("pack"));
  reporter.onFinish(
    runResult([
      check("build"),
      check("lint", { status: "failed", reason: "exit 1", exitCode: 1 }),
      check("test"),
      check("pack"),
    ]),
  );
}

describe("live block rendering", () => {
  const state = (overrides: Partial<BlockState> = {}): BlockState => ({
    selected: names,
    dependsOn: start.dependsOn,
    running: new Map([
      ["build", { since: 0, line: "compiling src/index.ts" }],
      ["lint", { since: 1000, line: "" }],
    ]),
    finished: new Map(),
    startedAt: 0,
    stopping: false,
    ...overrides,
  });

  it("shows progress, running checks with their latest output, and what waits on what", () => {
    expect(renderBlock(state(), { width: 60, height: 20, now: 4200 }, plain)).toEqual([
      "[0/4] 4.2s",
      "⠹ build   4.2s  compiling src/index.ts",
      "⠹ lint    3.2s",
      "  test, pack  waiting on build",
    ]);
  });

  it("separates queued checks from those waiting on a dependency, and drops blocked ones", () => {
    const blocked = state({
      running: new Map(),
      finished: new Map([
        ["build", false],
        ["lint", true],
      ]),
    });
    expect(renderBlock(blocked, { width: 60, height: 20, now: 0 }, plain)).toEqual(["[2/4] 0.0s"]);
    const queued = state({ running: new Map([["build", { since: 0, line: "" }]]) });
    expect(renderBlock(queued, { width: 60, height: 20, now: 0 }, plain)).toEqual([
      "[0/4] 0.0s",
      "⠋ build   0.0s",
      "  lint  queued",
      "  test, pack  waiting on build",
    ]);
  });

  it("truncates output to the terminal width", () => {
    const long = state({
      running: new Map([["build", { since: 0, line: "x".repeat(200) }]]),
    });
    const lines = renderBlock(long, { width: 30, height: 20, now: 0 }, plain);
    expect(lines[1]).toBe(`⠋ build   0.0s  ${"x".repeat(12)}…`);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(30);
  });

  it("clamps the block to the terminal height and collapses the rest", () => {
    const many = Array.from({ length: 8 }, (_, index) => `check${index}`);
    const crowded: BlockState = {
      selected: many,
      dependsOn: {},
      running: new Map(many.map((name) => [name, { since: 0, line: "" }])),
      finished: new Map(),
      startedAt: 0,
      stopping: false,
    };
    const lines = renderBlock(crowded, { width: 60, height: 6, now: 0 }, plain);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe("  +5 more running");
  });

  it("says which checks will not start once the run is stopping", () => {
    expect(
      renderBlock(state({ stopping: true }), { width: 60, height: 20, now: 0 }, plain),
    ).toContain("  test, pack  will not start");
  });

  it("fits by code points", () => {
    expect(fit("abcdef", 4)).toBe("abc…");
    expect(fit("abc", 3)).toBe("abc");
    expect(fit("abc", 0)).toBe("");
  });
});

describe("live reporter", () => {
  it("leaves scrollback identical to line mode, minus the start lines", () => {
    const fake = fakeTerminal();
    drive(liveReporter(fake.terminal, plain), fake.advance);

    const lines: string[] = [];
    drive(humanReporter({ out: (text) => lines.push(text), err: () => undefined }, plain));
    const lineMode = lines
      .join("")
      .split("\n")
      .filter((line) => !line.startsWith("▸ "))
      .join("\n")
      .replace(/\n$/, "");

    expect(fake.screen.text()).toBe(lineMode);
  });

  it("redraws the block in place while checks run", () => {
    const fake = fakeTerminal();
    const reporter = liveReporter(fake.terminal, plain);
    reporter.onStart?.(start);
    reporter.onCheckStart?.("build");
    reporter.onCheckOutput?.("build", "step 1");
    fake.advance(100);
    reporter.onCheckOutput?.("build", "step 2");
    fake.advance(100);
    expect(fake.screen.text()).toBe(
      [
        "verifika · full run (--all) · 4 checks · 2 parallel",
        "[0/4] 0.2s",
        "⠹ build   0.2s  step 2",
        "  lint  queued",
        "  test, pack  waiting on build",
      ].join("\n"),
    );
    expect(fake.screen.cursorHidden).toBe(true);
    expect(fake.screen.autowrap).toBe(true);
  });

  it("throttles output: lines are drawn on the next frame, not as they arrive", () => {
    const fake = fakeTerminal();
    const writes: string[] = [];
    const terminal = { ...fake.terminal, write: (text: string) => writes.push(text) };
    const reporter = liveReporter(terminal, plain);
    reporter.onStart?.(start);
    reporter.onCheckStart?.("build");
    const before = writes.length;
    for (let index = 0; index < 1000; index++) reporter.onCheckOutput?.("build", `line ${index}`);
    expect(writes).toHaveLength(before);
    fake.advance(100);
    expect(writes).toHaveLength(before + 1);
  });

  it("re-reads the terminal size on every frame", () => {
    const fake = fakeTerminal({ columns: 60, rows: 20 });
    const reporter = liveReporter(fake.terminal, plain);
    reporter.onStart?.(start);
    reporter.onCheckStart?.("build");
    reporter.onCheckOutput?.("build", "y".repeat(100));
    fake.size.columns = 24;
    fake.advance(100);
    expect(fake.screen.lines.every((line) => line.length < 24 || line.startsWith("verifika"))).toBe(
      true,
    );
  });

  it("restores the cursor and stops redrawing on finish and on dispose", () => {
    const finished = fakeTerminal();
    drive(liveReporter(finished.terminal, plain), finished.advance);
    expect(finished.screen.cursorHidden).toBe(false);
    expect(finished.ticking).toBe(false);

    const disposed = fakeTerminal();
    const reporter = liveReporter(disposed.terminal, plain);
    reporter.onStart?.(start);
    reporter.onCheckStart?.("build");
    reporter.dispose?.();
    expect(disposed.screen.cursorHidden).toBe(false);
    expect(disposed.ticking).toBe(false);
    expect(disposed.screen.text()).toBe("verifika · full run (--all) · 4 checks · 2 parallel");
  });

  it("restores the cursor if the process exits mid-run", () => {
    const fake = fakeTerminal();
    liveReporter(fake.terminal, plain).onStart?.(start);
    expect(fake.screen.cursorHidden).toBe(true);
    fake.exit();
    expect(fake.screen.cursorHidden).toBe(false);
  });

  it("does not go live when nothing is selected", () => {
    const fake = fakeTerminal();
    liveReporter(fake.terminal, plain).onStart?.({ ...start, selected: [] });
    expect(fake.screen.cursorHidden).toBe(false);
    expect(fake.ticking).toBe(false);
  });
});

describe("LastLine", () => {
  it("reports the latest non-empty line, including partial and redrawn lines", () => {
    const seen: string[] = [];
    const follower = new LastLine((line) => seen.push(line));
    follower.write("\u001b[32mfirst\u001b[39m\n\n");
    follower.write("progress 10%\rprogress 50%");
    follower.write("\rprogress 100%\n");
    follower.write("   \n");
    follower.write("done\n");
    expect(seen).toEqual(["first", "progress 50%", "progress 100%", "done"]);
    follower.write("\u0007ding\u000e\tbell\b\n");
    expect(seen.at(-1)).toBe("ding bell");
  });
});
