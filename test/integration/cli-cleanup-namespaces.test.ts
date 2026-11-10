// Integration tests of the CLI: Cleanup inside Linux PID namespaces, as in containers without an init process.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { project } from "../helpers/project.ts";
import { CLI, cleanEnv } from "../helpers/repo.ts";

describe("verifika run", () => {
  it.skipIf(process.platform !== "linux")(
    "treats killed leftovers as gone under a PID 1 that never reaps zombies",
    async (context) => {
      // Like `docker run` without --init: Verifika is PID 1 of a new namespace.
      const probe = spawnSync("unshare", ["-Urpf", "--mount-proc", "true"]);
      if (probe.status !== 0) context.skip("unprivileged user namespaces are unavailable");
      const root = project({ bg: { command: "sleep 100 & echo started" } });
      const result = spawnSync(
        "unshare",
        ["-Urpf", "--mount-proc", process.execPath, CLI, "--all"],
        { cwd: root, encoding: "utf8", env: cleanEnv() },
      );
      expect(result.stdout).toMatch(/^PASS 1\/1 \(0\.\ds\)/);
      expect(result.status).toBe(0);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "still signals leftovers when /proc does not show the current PID namespace",
    async (context) => {
      // unshare without --mount-proc: kill() sees the group, but /proc shows the host's
      // processes, so zombies cannot be told apart from live processes.
      const probe = spawnSync("unshare", ["-Urpf", "true"]);
      if (probe.status !== 0) context.skip("unprivileged user namespaces are unavailable");
      const root = project({
        bg: {
          command:
            "node check.mjs trap-term term.txt ready.txt > /dev/null 2>&1 & node check.mjs wait-for ready.txt",
        },
      });
      const result = spawnSync(
        "unshare",
        ["-Urpf", process.execPath, CLI, "--all", "--mode", "json"],
        { cwd: root, encoding: "utf8", env: cleanEnv() },
      );
      // The leftover must have been signalled, never silently ignored.
      expect(existsSync(path.join(root, "term.txt"))).toBe(true);
      // Its death cannot be confirmed here, so the check must not pass.
      const json = JSON.parse(result.stdout) as RunResult;
      expect(json.checks[0]).toMatchObject({
        status: "error",
        reason: "process tree not cleaned up",
      });
      expect(result.status).toBe(1);
    },
  );
});
