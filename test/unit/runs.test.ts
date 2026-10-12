import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeTime, hyperlink, readTail } from "../../src/logs.ts";
import { DEFAULT_PAGER, pagerAvailable, pagerCommand } from "../../src/pager.ts";
import { descendantsOf, execCheck } from "../../src/process.ts";
import {
  createRun,
  createRunId,
  estimateSkipped,
  logPath,
  pruneRuns,
  readLatest,
  readRun,
  releaseRun,
} from "../../src/runs.ts";
import type { RunResult } from "../../src/types.ts";
import { tempDir, writeFiles } from "../helpers/repo.ts";

describe("run ids", () => {
  it("are sortable by time and unique", () => {
    const early = createRunId(new Date("2026-01-02T03:04:05Z"));
    const late = createRunId(new Date("2026-11-12T13:14:15Z"));
    expect(early).toMatch(/^20260102-030405-000-[0-9a-f]{6}$/);
    const sameSecond = [
      createRunId(new Date("2026-01-02T03:04:05.900Z")),
      createRunId(new Date("2026-01-02T03:04:05.100Z")),
    ];
    expect(sameSecond.sort()[0]).toMatch(/^20260102-030405-100-/);
    expect(early < late).toBe(true);
    expect(createRunId()).not.toBe(createRunId());
  });

  it("build portable log paths", () => {
    expect(logPath("20260102-030405-000-abcdef", "lint")).toBe(
      ".verifika/runs/20260102-030405-000-abcdef/lint.log",
    );
  });
});

describe("estimateSkipped", () => {
  const runWith = (id: string, checks: Partial<RunResult["checks"][number]>[]) => ({
    [`.verifika/runs/${id}/run.json`]: JSON.stringify({ runId: id, checks }),
  });

  it("uses each check's most recent completed duration", async () => {
    const root = tempDir();
    writeFiles(root, {
      ...runWith("20260101-000000-000-aaaaaa", [
        { name: "test", status: "passed", durationMs: 30_000 },
        { name: "e2e", status: "failed", durationMs: 50_000 },
      ]),
      ...runWith("20260102-000000-000-bbbbbb", [
        { name: "test", status: "failed", durationMs: 20_000 },
        { name: "e2e", status: "interrupted", durationMs: 1_000 },
        { name: "lint", status: "skipped", durationMs: null },
      ]),
      ".verifika/runs/20260103-000000-000-cccccc/run.json": "{ not json",
    });
    expect(await estimateSkipped(root, ["test", "e2e"])).toEqual({ knownMs: 70_000, unknown: 0 });
    expect(await estimateSkipped(root, ["test", "lint"])).toEqual({ knownMs: 20_000, unknown: 1 });
  });

  it("knows nothing without recorded runs", async () => {
    expect(await estimateSkipped(tempDir(), ["test"])).toEqual({ knownMs: 0, unknown: 1 });
  });
});

describe("logs presentation", () => {
  it("describes start times in local time, relative to now", () => {
    const now = new Date(2026, 9, 13, 1, 15, 0);
    expect(describeTime(new Date(2026, 9, 13, 1, 12, 30), now)).toBe("today 01:12, 2m ago");
    expect(describeTime(new Date(2026, 9, 13, 1, 14, 50), now)).toBe("today 01:14, 10s ago");
    expect(describeTime(new Date(2026, 9, 13, 1, 15, 0), now)).toBe("today 01:15, just now");
    expect(describeTime(new Date(2026, 9, 12, 23, 40), now)).toBe("yesterday 23:40, 1h ago");
    expect(describeTime(new Date(2026, 9, 9, 8, 5), now)).toBe("2026-10-09 08:05, 3d ago");
  });

  it("links files with OSC 8", () => {
    const link = hyperlink("a.log", path.resolve("/tmp/a b.log"));
    // eslint-disable-next-line no-control-regex
    expect(link).toMatch(/^\u001b\]8;;file:\/\/\S*a%20b\.log\u001b\\a\.log\u001b\]8;;\u001b\\$/);
  });

  it("uses $PAGER, or less, and checks that the program exists", () => {
    expect(pagerCommand({})).toBe(DEFAULT_PAGER);
    expect(pagerCommand({ PAGER: "  " })).toBe(DEFAULT_PAGER);
    expect(pagerCommand({ PAGER: "more" })).toBe("more");
    const bin = tempDir();
    const program = process.platform === "win32" ? "mypager.cmd" : "mypager";
    writeFiles(bin, { [program]: "" });
    chmodSync(path.join(bin, program), 0o755);
    expect(pagerAvailable("mypager -R", { PATH: bin, PATHEXT: ".CMD" })).toBe(true);
    expect(pagerAvailable(`"${path.join(bin, program)}" -R`, { PATH: "" })).toBe(true);
    expect(pagerAvailable("nope -R", { PATH: bin, PATHEXT: ".CMD" })).toBe(false);
    expect(pagerAvailable("", { PATH: bin })).toBe(false);
  });
});

describe("readTail", () => {
  it("returns the last lines of large files", async () => {
    const root = tempDir();
    const lines = Array.from({ length: 50_000 }, (_, index) => `line ${index}`);
    writeFiles(root, {
      "big.log": `${lines.join("\n")}\n`,
      "empty.log": "",
      "partial.log": "a\nb",
    });
    expect(await readTail(path.join(root, "big.log"), 3)).toBe(
      "line 49997\nline 49998\nline 49999\n",
    );
    expect(await readTail(path.join(root, "big.log"), 0)).toBe("");
    expect(await readTail(path.join(root, "empty.log"), 5)).toBe("");
    expect(await readTail(path.join(root, "partial.log"), 1)).toBe("b\n");
    expect(await readTail(path.join(root, "partial.log"), 10)).toBe("a\nb\n");
  });
});

describe("execCheck", () => {
  it("reports a process that cannot start as a spawn error", async () => {
    const root = tempDir();
    const outcome = await execCheck({
      command: "node --version",
      cwd: path.join(root, "missing-directory"),
      env: process.env,
      timeoutMs: 5_000,
      logFile: path.join(root, "out.log"),
      previewLines: 5,
      signal: new AbortController().signal,
    });
    expect(outcome.kind).toBe("spawn_error");
  });

  it("does not start when already aborted", async () => {
    const root = tempDir();
    const controller = new AbortController();
    controller.abort("SIGINT");
    const outcome = await execCheck({
      command: "node --version",
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      logFile: path.join(root, "out.log"),
      previewLines: 5,
      signal: controller.signal,
    });
    expect(outcome).toMatchObject({ kind: "aborted", reason: "SIGINT" });
  });
});

describe("descendantsOf", () => {
  const entry = (pid: number, parentPid: number, createdAt: number) => ({
    pid,
    parentPid,
    createdAt,
  });
  const pids = (table: ReturnType<typeof entry>[], root: number, rootCreatedAt: number) =>
    descendantsOf(table, root, rootCreatedAt)
      .map((found) => found.pid)
      .sort((a, b) => a - b);

  it("finds every generation below the exited root", () => {
    const table = [
      entry(11, 10, 1100),
      entry(12, 11, 1200),
      entry(13, 12, 1300),
      entry(20, 1, 1000), // unrelated
    ];
    expect(pids(table, 10, 1000)).toEqual([11, 12, 13]);
  });

  it("ignores orphans of an earlier holder of the root's process id", () => {
    // 11 was a child of a previous process with id 10, created before the check started.
    const table = [entry(11, 10, 500), entry(12, 10, 1500)];
    expect(pids(table, 10, 1000)).toEqual([12]);
  });

  it("ignores children of a new process that reused the root's id", () => {
    // Root 10 (started at 1000) exited; an unrelated process took id 10 at 2000.
    const table = [
      entry(10, 99, 2000), // the reuser
      entry(11, 10, 1500), // our leftover, created before the reuser existed
      entry(12, 10, 2500), // the reuser's child: must not be killed
      entry(13, 12, 2600),
    ];
    expect(pids(table, 10, 1000)).toEqual([11]);
  });

  it("requires every descendant to be younger than its parent", () => {
    // 12 claims parent 11 but predates it: 11's id was reused, 12 is unrelated.
    const table = [entry(11, 10, 1500), entry(12, 11, 1200)];
    expect(pids(table, 10, 1000)).toEqual([11]);
  });

  it("terminates on parent id cycles and never targets the root id itself", () => {
    const table = [entry(11, 10, 1500), entry(10, 11, 1600)];
    expect(pids(table, 10, 1000)).toEqual([11]);
  });
});

describe("latest run and retention under concurrency", () => {
  const stub = (runId: string) => ({ runId, status: "passed" }) as unknown as RunResult;

  /** A finished run directory with a chosen id, as another process would leave it. */
  function finishedRun(root: string, runId: string): void {
    writeFiles(root, { [`.verifika/runs/${runId}/run.json`]: JSON.stringify(stub(runId)) });
  }

  it("names the newest run even when run directories appear out of order", async () => {
    const root = tempDir();
    // A newer run lands first, then an older one created earlier by a slower process.
    finishedRun(root, "20261012-120000-500-bbbbbb");
    finishedRun(root, "20261012-120000-100-aaaaaa");
    expect(await readLatest(root)).toBe("20261012-120000-500-bbbbbb");
    expect((await readRun(root)).runId).toBe("20261012-120000-500-bbbbbb");
  });

  it("stays consistent when many runs are created concurrently", async () => {
    const root = tempDir();
    const ids = await Promise.all(Array.from({ length: 20 }, () => createRun(root, stub)));
    expect(new Set(ids).size).toBe(20);
    expect(await readLatest(root)).toBe([...ids].sort().at(-1));
    await Promise.all(ids.map((id) => releaseRun(root, id)));
    await pruneRuns(root, 3, ids[0] as string);
    expect(await readLatest(root)).toBe([...ids].sort().at(-1));
    expect((await readRun(root)).runId).toBe(await readLatest(root));
  });

  it("never prunes the latest run while an older run is still finishing", async () => {
    const root = tempDir();
    finishedRun(root, "20261012-120000-000-aaaaaa");
    finishedRun(root, "20261012-120000-100-bbbbbb");
    finishedRun(root, "20261012-120000-200-cccccc"); // newest, finished
    // An older, overlapping run applies retention with keepRuns: 1.
    await pruneRuns(root, 1, "20261012-120000-100-bbbbbb");
    expect(await readLatest(root)).toBe("20261012-120000-200-cccccc");
    expect((await readRun(root)).runId).toBe("20261012-120000-200-cccccc");
    expect(existsSync(path.join(root, ".verifika/runs/20261012-120000-000-aaaaaa"))).toBe(false);
  });

  it("has no latest run before the first one", async () => {
    expect(await readLatest(tempDir())).toBeNull();
  });
});
