import { describe, expect, it } from "vitest";
import { detectCi } from "../../src/ci.ts";
import { formatSeconds } from "../../src/format.ts";
import { OutputCapture, stripAnsi } from "../../src/preview.ts";
import { renderAgent } from "../../src/reporters/agent.ts";
import { humanReporter, plain, renderSummary } from "../../src/reporters/human.ts";
import { jsonReporter } from "../../src/reporters/json.ts";
import { renderPlan } from "../../src/reporters/plan.ts";
import { quietReporter } from "../../src/reporters/quiet.ts";
import { summarize, signalExitCode } from "../../src/runner.ts";
import type { CheckResult, RunResult, Selection } from "../../src/types.ts";

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

function run(checks: CheckResult[], overrides: Partial<RunResult> = {}): RunResult {
  const summary = summarize(checks);
  const status = checks.every((item) => !item.selected || item.status === "passed")
    ? "passed"
    : "failed";
  return {
    schemaVersion: 1,
    tool: { name: "verifika", version: "1.0.0" },
    runId: "20261012-000000-000-abcdef",
    status,
    exitCode: status === "passed" ? 0 : 1,
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
    summary,
    latest: true,
    checks,
    ...overrides,
  };
}

const failure = check("typecheck", {
  status: "failed",
  reason: "exit 2",
  exitCode: 2,
  preview: ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."],
});

describe("agent output", () => {
  it("is a single line on success", () => {
    const output = renderAgent(
      run([check("lint"), check("format"), check("typecheck"), check("unit")]),
    );
    expect(output).toBe("PASS 4/4 (4.3s) full run (--all)\n");
  });

  it("names the failure, shows a bounded preview and the next command", () => {
    const output = renderAgent(
      run([check("lint"), failure, check("unit"), check("format")], { durationMs: 3200 }),
    );
    expect(output).toBe(
      [
        "FAIL 3/4 (3.2s) full run (--all)",
        "typecheck: exit 2",
        "  src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "Run: verifika logs typecheck",
        "",
      ].join("\n"),
    );
  });

  it("lists blocked and timed-out checks and points to all failed logs", () => {
    const output = renderAgent(
      run([
        check("build", { status: "timed_out", reason: "timed out after 2.0s", exitCode: null }),
        check("e2e", {
          status: "blocked",
          reason: "dependency build did not pass",
          log: null,
          durationMs: null,
        }),
        check("lint", { status: "failed", reason: "exit 1", exitCode: 1 }),
      ]),
    );
    expect(output).toContain("FAIL 0/3");
    expect(output).toContain("build: timed out after 2.0s\n");
    expect(output).toContain("e2e: dependency build did not pass\n");
    expect(output).toContain("Run: verifika logs --failed\n");
  });

  it("previews at most three failed checks", () => {
    const failures = ["a", "b", "c", "d"].map((name) =>
      check(name, { status: "failed", reason: "exit 1", preview: [`error in ${name}`] }),
    );
    const output = renderAgent(run(failures));
    expect(output).toContain("error in c");
    expect(output).not.toContain("error in d");
  });

  it("describes selective runs and empty selections", () => {
    const selection = {
      mode: "changed" as const,
      reason: "no files changed since HEAD (abc1234)",
      base: "HEAD",
      baseCommit: "abc1234",
      changedFiles: [],
      invalidatedBy: null,
    };
    const output = renderAgent(
      run([check("lint", { selected: false, status: "skipped" })], { selection, durationMs: 10 }),
    );
    expect(output).toBe(
      "PASS 0/0 (0.0s) selective: no files changed since HEAD (abc1234); 1 skipped\n" +
        "Nothing to verify for these changes. Full run: verifika --all\n",
    );
  });

  it("reports spawn errors with their message", () => {
    const output = renderAgent(
      run([check("x", { status: "error", reason: "could not start", error: "spawn ENOENT" })]),
    );
    expect(output).toContain("x: could not start: spawn ENOENT");
  });

  it("names the run in the logs hint when a later run became the latest", () => {
    const output = renderAgent(run([failure], { latest: false }));
    expect(output).toContain("Run: verifika logs typecheck --run 20261012-000000-000-abcdef\n");
  });

  it("reports a check whose processes could not be cleaned up as an error", () => {
    const output = renderAgent(
      run([
        check("serve", {
          status: "error",
          reason: "process tree not cleaned up",
          error: "a process kept the check's output open and could not be stopped",
        }),
      ]),
    );
    expect(output).toMatch(/^FAIL 0\/1/);
    expect(output).toContain(
      "serve: process tree not cleaned up: a process kept the check's output open and could not be stopped\n",
    );
  });

  it("labels interrupted runs", () => {
    const result = run([check("a", { status: "interrupted", reason: "interrupted" })], {
      status: "interrupted",
      exitCode: 130,
    });
    expect(renderAgent(result)).toMatch(/^INTERRUPTED 0\/1/);
  });
});

describe("quiet output", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      output: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    };
  };

  it("prints nothing on success", () => {
    const { out, err, output } = capture();
    quietReporter(output).onFinish(run([check("lint")]));
    expect(out.concat(err)).toEqual([]);
  });

  it("prints one actionable line on failure", () => {
    const { out, err, output } = capture();
    quietReporter(output).onFinish(run([check("lint"), failure]));
    expect(out).toEqual([]);
    expect(err).toEqual(["verifika: FAIL typecheck (exit 2). Run: verifika logs typecheck\n"]);
  });
});

describe("json output", () => {
  it("prints exactly the run result", () => {
    const out: string[] = [];
    const result = run([check("lint"), failure]);
    jsonReporter({ out: (text) => out.push(text), err: () => undefined }).onFinish(result);
    expect(JSON.parse(out.join(""))).toEqual(result);
  });
});

describe("human output", () => {
  it("streams start and end lines and summarises", () => {
    const out: string[] = [];
    const reporter = humanReporter({ out: (text) => out.push(text), err: () => undefined }, plain);
    const selection: Selection = {
      mode: "changed",
      reason: "2 files changed since HEAD (abc1234)",
      changes: null,
      invalidatedBy: null,
      checks: [
        { name: "lint", selected: true, reason: "matched a.ts", matchedFiles: [] },
        { name: "docs", selected: false, reason: "no matching changes", matchedFiles: [] },
      ],
    };
    reporter.onStart?.({ runId: "r", selection, selected: ["lint"], concurrency: 2 });
    reporter.onCheckStart?.("lint");
    reporter.onCheckEnd?.(check("lint"));
    reporter.onFinish(run([check("lint"), check("docs", { selected: false, status: "skipped" })]));
    expect(out.join("")).toBe(
      [
        "verifika selective: 2 files changed since HEAD (abc1234); 1 skipped",
        "skipped: docs",
        "▸ lint",
        "✓ lint 1.2s",
        "✓ 1 of 1 checks passed (4.3s)",
        "",
      ].join("\n"),
    );
  });

  it("summarises failures with previews and the logs command", () => {
    const summary = renderSummary(run([check("lint"), failure]), plain);
    expect(summary).toContain("✗ typecheck: exit 2");
    expect(summary).toContain("    src/a.ts(3,7): error TS2322");
    expect(summary).toContain("✗ verification failed: 1 of 2 checks passed (4.3s)");
    expect(summary).toContain("Logs: verifika logs typecheck");
  });
});

describe("plan output", () => {
  it("lists changed files and decisions, bounding the file list", () => {
    const selection: Selection = {
      mode: "changed",
      reason: "3 files changed since HEAD (abc1234)",
      changes: {
        base: "HEAD",
        baseCommit: "abc1234",
        files: [
          { path: "a.ts", status: "added" },
          { path: "b.ts", status: "deleted" },
          { path: "c.ts", status: "untracked" },
        ],
      },
      invalidatedBy: null,
      checks: [
        { name: "lint", selected: true, reason: "matched a.ts (+1 more)", matchedFiles: [] },
        { name: "unit-tests", selected: false, reason: "no matching changes", matchedFiles: [] },
      ],
    };
    expect(renderPlan(selection, 2)).toBe(
      [
        "Plan: selective: 3 files changed since HEAD (abc1234); 1 skipped",
        "Changed files (3):",
        "  A a.ts",
        "  D b.ts",
        "  … 1 more (verifika plan --mode json lists all)",
        "Checks:",
        "  run   lint        matched a.ts (+1 more)",
        "  skip  unit-tests  no matching changes",
        "",
      ].join("\n"),
    );
  });
});

describe("OutputCapture", () => {
  it("prefers failure-looking lines and ignores package-manager noise", () => {
    const capture = new OutputCapture(3);
    capture.write(
      "out",
      "> app@1.0.0 lint\n> eslint .\n\n/src/a.ts\n  3:7  error  'x' is unused\n",
    );
    capture.write(
      "err",
      "npm error Lifecycle script `lint` failed with error:\nnpm error code 1\n",
    );
    expect(capture.preview()).toEqual(["/src/a.ts", "  3:7  error  'x' is unused"]);
  });

  it("keeps the heading of grouped failures only once per group", () => {
    const capture = new OutputCapture(10);
    capture.write(
      "out",
      "/src/a.ts\n  1:1  error  one\n  2:1  error  two\n\n/src/b.ts\n  4:1  error  three\n",
    );
    expect(capture.preview()).toEqual([
      "/src/a.ts",
      "  1:1  error  one",
      "  2:1  error  two",
      "/src/b.ts",
      "  4:1  error  three",
    ]);
  });

  it("does not add headings to unindented failure lines", () => {
    const capture = new OutputCapture(10);
    capture.write("out", "Compiling\nsrc/a.ts(1,1): error TS1: x\n");
    expect(capture.preview()).toEqual(["src/a.ts(1,1): error TS1: x"]);
  });

  it("collapses Karma-style progress redraws and keeps the assertion message", () => {
    const capture = new OutputCapture(10);
    const progress = (n: number) =>
      `\u001b[1A\u001b[2KChrome Headless: Executed ${n} of 756 (1 FAILED)\n`;
    capture.write("out", "Chrome Headless: Executed 0 of 756\n");
    capture.write(
      "out",
      "Chrome Headless AppTitleStrategy falls back to the application name FAILED\n",
    );
    capture.write("out", "\tExpected 'Acme Admin' to be 'Wrong Title'.\n");
    capture.write("out", "\t    at <Jasmine>\n");
    for (let n = 397; n < 420; n++) capture.write("out", progress(n));
    capture.write("out", "Chrome Headless: Executed 756 of 756 (1 FAILED) (16.5 secs)\n");
    expect(capture.preview()).toEqual([
      "Chrome Headless AppTitleStrategy falls back to the application name FAILED",
      "\tExpected 'Acme Admin' to be 'Wrong Title'.",
      "Chrome Headless: Executed 756 of 756 (1 FAILED) (16.5 secs)",
    ]);
  });

  it("prefers failed-test markers over exceptions logged by passing tests", () => {
    const capture = new OutputCapture(10);
    for (let i = 0; i < 12; i++) {
      capture.write("out", "ERROR: 'Optimisation task failed', Error: fails\n");
      capture.write("out", "Error: Provider unavailable\n");
    }
    capture.write(
      "out",
      "Chrome Headless AppTitleStrategy falls back to the application name FAILED\n",
    );
    capture.write("out", "\tExpected 'Acme Admin' to be 'Wrong Title'.\n");
    expect(capture.preview()).toEqual([
      "Chrome Headless AppTitleStrategy falls back to the application name FAILED",
      "\tExpected 'Acme Admin' to be 'Wrong Title'.",
    ]);
  });

  it("keeps only the latest state of a progress line interleaved with other output", () => {
    const capture = new OutputCapture(10);
    capture.write("out", "Chrome: Executed 387 of 756 (1 FAILED) (9.02 secs)\n");
    capture.write("out", "LOG: 'something'\n");
    capture.write("out", "Chrome: Executed 438 of 756 (1 FAILED) (13.7 secs)\n");
    capture.write("out", "TOTAL: 1 FAILED, 755 SUCCESS\n");
    expect(capture.preview()).toEqual([
      "Chrome: Executed 438 of 756 (1 FAILED) (13.7 secs)",
      "TOTAL: 1 FAILED, 755 SUCCESS",
    ]);
  });

  it("keeps distinct compiler errors that differ only in line numbers", () => {
    const capture = new OutputCapture(10);
    capture.write("out", "src/a.ts(3,7): error TS2322: Type 'string' is not assignable.\n");
    capture.write("out", "src/a.ts(9,7): error TS2322: Type 'string' is not assignable.\n");
    expect(capture.preview()).toHaveLength(2);
  });

  it("ranks real assertion failures above structured logs that mention errors", () => {
    const capture = new OutputCapture(5);
    for (let i = 0; i < 20; i++) {
      capture.write(
        "out",
        `{"status":"error","isFallback":true,"message":"Build bundle session ${i}"}\n`,
      );
    }
    capture.write("out", " FAIL  src/matcher-batch.spec.ts > matches items\n");
    capture.write("out", "AssertionError: expected 'item-6' to be 'item-WRONG'\n");
    expect(capture.preview()).toEqual([
      " FAIL  src/matcher-batch.spec.ts > matches items",
      "AssertionError: expected 'item-6' to be 'item-WRONG'",
    ]);
  });

  it("falls back to the last lines when nothing looks like a failure", () => {
    const capture = new OutputCapture(2);
    capture.write("out", "one\ntwo\nthree\n[warn] src/a.ts\n");
    expect(capture.preview()).toEqual(["three", "[warn] src/a.ts"]);
  });

  it("handles partial lines, CRLF, carriage-return redraws and ANSI codes", () => {
    const capture = new OutputCapture(5);
    capture.write("out", "\u001b[31mError:\u001b[39m bro");
    capture.write("out", "ken\r\nprogress 10%\rprogress 100%\nlast without newline");
    expect(capture.preview()).toEqual(["Error: broken"]);
    const tail = new OutputCapture(5);
    tail.write("out", "progress 10%\rprogress 100%\r\nlast without newline");
    expect(tail.preview()).toEqual(["progress 100%", "last without newline"]);
  });

  it("bounds line length and memory for huge single lines", () => {
    const capture = new OutputCapture(2);
    capture.write("out", "error ".repeat(10_000));
    capture.write("out", "\n");
    const [line] = capture.preview();
    expect(line?.length).toBe(200);
    expect(line?.endsWith("…")).toBe(true);
  });

  it("captures nothing when previews are disabled", () => {
    const capture = new OutputCapture(0);
    capture.write("out", "error: x\n");
    expect(capture.preview()).toEqual([]);
  });

  it("strips ANSI sequences", () => {
    expect(stripAnsi("\u001b[1m\u001b[31mbold red\u001b[0m")).toBe("bold red");
  });
});

describe("detectCi", () => {
  it.each([
    [{}, false, "none"],
    [{ CI: "true" }, true, "CI"],
    [{ CI: "1" }, true, "CI"],
    [{ CI: "false" }, false, "none"],
    [{ CI: "0", GITHUB_ACTIONS: "true" }, true, "GITHUB_ACTIONS"],
    [{ CI: "false", GITLAB_CI: "true" }, true, "GITLAB_CI"],
    [{ GITHUB_ACTIONS: "false" }, false, "none"],
    [{ GITLAB_CI: "true" }, true, "GITLAB_CI"],
    [{ JENKINS_URL: "http://ci" }, true, "JENKINS_URL"],
    [{ CI: "true", VERIFIKA_CI: "0" }, true, "CI"],
    [{ VERIFIKA_CI: "1" }, false, "none"],
    [{ CI: "" }, false, "none"],
  ])("%j -> ci=%s via %s", (env, ci, source) => {
    expect(detectCi(env)).toEqual({ ci, source });
  });
});

describe("formatting and exit codes", () => {
  it.each([
    [0, "0.0s"],
    [4321, "4.3s"],
    [12_400, "12s"],
    [185_000, "3m05s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatSeconds(ms)).toBe(text);
  });

  it("maps signals to 128 + signal number", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode(undefined)).toBe(130);
  });

  it("summarises statuses into stable counters", () => {
    expect(
      summarize([
        check("a"),
        check("b", { status: "failed" }),
        check("c", { status: "timed_out" }),
        check("d", { status: "blocked" }),
        check("e", { status: "cancelled" }),
        check("f", { selected: false, status: "skipped" }),
      ]),
    ).toEqual({ total: 6, selected: 5, passed: 1, failed: 2, notRun: 2, skipped: 1 });
  });
});
