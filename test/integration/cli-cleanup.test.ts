// Integration tests of the CLI: Leftover processes a check starts are stopped, or the check does not pass.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { project } from "../helpers/project.ts";
import { isAlive, runCli, waitFor } from "../helpers/repo.ts";

const isWindows = process.platform === "win32";

describe("verifika run", () => {
  it("kills background processes a check leaves behind, including ones holding its output", async () => {
    const root = project({ orphan: { command: "node check.mjs orphan orphan.txt" } });
    const result = await runCli(root, ["--all"]);
    expect(result.code).toBe(0);
    const pid = Number(readFileSync(path.join(root, "orphan.txt"), "utf8"));
    expect(isAlive(pid)).toBe(false);
  });

  it("kills leftovers that ignore SIGTERM and do not hold the output", async () => {
    const root = project({ stubborn: { command: "node check.mjs stubborn stubborn.txt" } });
    // The real SIGTERM grace period before SIGKILL, unscaled.
    const result = await runCli(root, ["--all"], { env: { VERIFIKA_TIMING_SCALE: "1" } });
    const pid = Number(readFileSync(path.join(root, "stubborn.txt"), "utf8"));
    const survived = isAlive(pid);
    if (survived) {
      process.kill(pid, "SIGKILL");
      // Windows finishes the kill asynchronously; until then the process keeps the test's
      // directory open and its removal fails with EBUSY.
      await waitFor(() => !isAlive(pid));
    }
    expect(result.code).toBe(0);
    expect(survived).toBe(false);
  });

  it("kills processes the shell itself left running in the background", async () => {
    // Started by the shell rather than by Node, so no job object or parent cleanup applies:
    // only Verifika's own reaping (process group on POSIX, parent-pid trace on Windows) stops it.
    const command = isWindows
      ? "start /b node check.mjs daemon daemon.txt"
      : "node check.mjs daemon daemon.txt &";
    const root = project({ daemon: { command } });
    const result = await runCli(root, ["--all"]);
    const file = path.join(root, "daemon.txt");
    const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
    const survived = pid !== null && isAlive(pid);
    if (survived) {
      process.kill(pid, "SIGKILL");
      // Windows finishes the kill asynchronously; until then the process keeps the test's
      // directory open and its removal fails with EBUSY.
      await waitFor(() => !isAlive(pid));
    }
    expect(result.code).toBe(0);
    expect(survived).toBe(false);
  });

  it("never passes a check whose leftover processes escape cleanup", async () => {
    const root = project({ escape: { command: "node check.mjs escape escape.txt" } });
    const result = await runCli(root, ["--all", "--mode", "json"]);
    const pid = Number(readFileSync(path.join(root, "escape.txt"), "utf8"));
    const survived = isAlive(pid);
    if (survived) {
      process.kill(pid, "SIGKILL");
      // Windows finishes the kill asynchronously; until then the process keeps the test's
      // directory open and its removal fails with EBUSY.
      await waitFor(() => !isAlive(pid));
    }
    const json = JSON.parse(result.stdout) as RunResult;
    // The invariant on every platform: a check never passes while its leftover survives.
    if (result.code === 0) {
      expect(survived).toBe(false);
    } else {
      expect(result.code).toBe(1);
      expect(json.checks[0]).toMatchObject({
        status: "error",
        reason: "process tree not cleaned up",
        exitCode: 0,
        error: expect.stringContaining("kept"),
      });
    }
    // POSIX cannot reach a process in a new session, so there it must be an error.
    if (!isWindows) expect(result.code).toBe(1);
  });
});
