// Integration tests of the CLI: Interrupting a run with SIGINT or SIGTERM.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { project } from "../helpers/project.ts";
import { isAlive, runCli, waitFor } from "../helpers/repo.ts";

const isWindows = process.platform === "win32";

describe("verifika run", () => {
  it.skipIf(isWindows)("terminates the whole process tree on SIGINT and exits 130", async () => {
    const root = project({
      tree: { command: "node check.mjs tree grandchild.txt" },
      waiting: { command: "node check.mjs pass", dependsOn: ["tree"] },
    });
    let pid = 0;
    const pending = runCli(root, ["--all", "--mode", "json"], {
      onSpawn: (value) => (pid = value),
    });
    const pidFile = path.join(root, "grandchild.txt");
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(isAlive(grandchild)).toBe(true);
    process.kill(pid, "SIGINT");
    const result = await pending;
    expect(result.code).toBe(130);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(json.status).toBe("interrupted");
    expect(json.checks.map((check) => check.status)).toEqual(["interrupted", "interrupted"]);
    await waitFor(() => !isAlive(grandchild), 5_000);
  });

  it.skipIf(isWindows)("exits 143 on SIGTERM", async () => {
    const root = project({ hang: { command: "node check.mjs hang" } });
    let pid = 0;
    const pending = runCli(root, ["--all"], { onSpawn: (value) => (pid = value) });
    const runs = path.join(root, ".verifika", "runs");
    await waitFor(() => existsSync(runs) && readdirSync(runs).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(pid, "SIGTERM");
    const result = await pending;
    expect(result.code).toBe(143);
    expect(result.stdout).toMatch(/^INTERRUPTED 0\/1/);
  });
});
