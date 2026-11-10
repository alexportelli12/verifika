// Integration tests of the CLI: agent, JSON, quiet and human output, and usage errors.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { pass, project } from "../helpers/project.ts";
import { config, runCli } from "../helpers/repo.ts";

describe("verifika run", () => {
  it("passes with one line of agent output and hides successful command output", async () => {
    const root = project({ lint: pass("lint"), test: pass("test") });
    const result = await runCli(root, ["--all"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PASS 2\/2 \(\d+\.\ds\) full run \(--all\)\n$/);
    expect(result.stderr).toBe("");
  });

  it("fails with exit 1, a preview and the logs command", async () => {
    const root = project({
      lint: pass("lint"),
      typecheck: { command: "node check.mjs fail 2 bad-type" },
    });
    const result = await runCli(root, ["--all"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL 1/2");
    expect(result.stdout).toContain(
      "typecheck: exit 2\n  src/app.ts(3,7): error TS2322: bad-type\n",
    );
    expect(result.stdout).toContain("Run: vfk logs typecheck");
    expect(result.stdout).not.toContain("noise line");
  });

  it("writes only valid JSON to stdout in json mode", async () => {
    const root = project({ lint: pass("lint"), broken: { command: "node check.mjs fail 3" } });
    const result = await runCli(root, ["--all", "--mode", "json"]);
    expect(result.code).toBe(1);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(json).toMatchObject({
      schemaVersion: 1,
      tool: { name: "verifika" },
      status: "failed",
      exitCode: 1,
      selection: { mode: "all" },
      summary: { total: 2, selected: 2, passed: 1, failed: 1, notRun: 0, skipped: 0 },
    });
    expect(json.runId).toMatch(/^\d{8}-\d{6}-\d{3}-[0-9a-f]{6}$/);
    const broken = json.checks.find((check) => check.name === "broken");
    expect(broken).toMatchObject({
      status: "failed",
      exitCode: 3,
      log: `.verifika/runs/${json.runId}/broken.log`,
    });
    expect(existsSync(path.join(root, broken?.log ?? ""))).toBe(true);
  });

  it("prints nothing on success in quiet mode and one line on failure", async () => {
    const root = project({ lint: pass("lint") });
    expect(await runCli(root, ["--all", "--mode", "quiet"])).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "",
    });
    writeFileSync(
      path.join(root, "verifika.config.json"),
      config({ lint: { command: "node check.mjs fail 1" } }),
    );
    const failed = await runCli(root, ["--all", "--mode", "quiet"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe("verifika: FAIL lint (exit 1). Run: vfk logs lint\n");
  });

  it("shows progress in human mode", async () => {
    const root = project({ lint: pass("lint") });
    const result = await runCli(root, ["--all", "--mode", "human"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("▸ lint\n✓ lint");
    expect(result.stdout).toContain("✓ 1 of 1 checks passed");
  });

  it("exits 2 for an invalid --changed-since ref, in every mode", async () => {
    const root = project({ lint: pass("lint") });
    const agent = await runCli(root, ["--changed-since", "origin/missing"]);
    expect(agent.code).toBe(2);
    expect(agent.stderr).toContain(
      'cannot determine changes: base ref "origin/missing" does not exist',
    );
    const json = await runCli(root, ["--changed-since", "origin/missing", "--mode", "json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "error",
      exitCode: 2,
    });
  });

  it("exits 2 for invalid configuration and unknown checks", async () => {
    const root = project({ lint: pass("lint") });
    const unknown = await runCli(root, ["--check", "lnt"]);
    expect(unknown).toMatchObject({ code: 2, stdout: "" });
    expect(unknown.stderr).toContain("unknown check: lnt\nAvailable checks: lint");

    writeFileSync(
      path.join(root, "verifika.config.json"),
      JSON.stringify({ version: 1, checks: { a: {} } }),
    );
    const invalid = await runCli(root, ["--all"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("checks.a.command: required");

    const usage = await runCli(root, ["--bogus"]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("Unknown option '--bogus'");
  });

  it("rejects empty --check and --changed-since values", async () => {
    const root = project({ lint: pass("lint") });
    const empty = await runCli(root, ["--check", ""]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("--check needs at least one check name");
    expect((await runCli(root, ["--changed-since="])).code).toBe(2);
  });
});
