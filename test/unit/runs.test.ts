import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTail } from "../../src/logs.ts";
import { execCheck } from "../../src/process.ts";
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
