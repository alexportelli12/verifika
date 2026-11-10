// Integration tests of the CLI: Timeouts, fail-fast, missing commands, huge output and the check environment.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { project } from "../helpers/project.ts";
import { runCli } from "../helpers/repo.ts";

describe("verifika run", () => {
  it("times out hung checks and kills them", async () => {
    const root = project({ hang: { command: "node check.mjs hang", timeoutMs: 500 } });
    const started = Date.now();
    const result = await runCli(root, ["--all"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("hang: timed out after 0.5s");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("stops other checks on fail-fast", async () => {
    const root = project({
      fail: { command: "node check.mjs fail 1" },
      slow: { command: "node check.mjs hang" },
      later: { command: "node check.mjs pass" },
    });
    const result = await runCli(root, ["--all", "--fail-fast", "-j", "2", "--mode", "json"]);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(result.code).toBe(1);
    const status = Object.fromEntries(json.checks.map((check) => [check.name, check.status]));
    expect(status).toEqual({ fail: "failed", slow: "cancelled", later: "cancelled" });
  });

  it("reports a missing command as a failed check", async () => {
    const root = project({ missing: { command: "definitely-not-a-real-command-xyz" } });
    const result = await runCli(root, ["--all", "--mode", "json"]);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(result.code).toBe(1);
    expect(json.checks[0]).toMatchObject({ status: "failed" });
    expect(json.checks[0]?.exitCode).not.toBe(0);
  });

  it("streams huge output to disk and keeps the preview bounded", async () => {
    const root = project({ flood: { command: "node check.mjs big 10" } });
    const result = await runCli(root, ["--all", "--mode", "json"]);
    const json = JSON.parse(result.stdout) as RunResult;
    const flood = json.checks[0];
    expect(flood?.preview).toEqual(["error: flood finished"]);
    const size = readFileSync(path.join(root, flood?.log ?? "")).length;
    expect(size).toBeGreaterThan(10_000_000);
  });

  it("passes run metadata to checks through the environment", async () => {
    const root = project({ env: { command: "node check.mjs env" } });
    const result = await runCli(root, ["--all", "--mode", "json"]);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(readFileSync(path.join(root, json.checks[0]?.log ?? ""), "utf8")).toBe(
      `1 env ${json.runId}\n`,
    );
  });
});
