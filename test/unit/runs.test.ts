import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTail } from "../../src/logs.ts";
import { descendantsOf, execCheck } from "../../src/process.ts";
import { createRunId, logPath } from "../../src/runs.ts";
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
