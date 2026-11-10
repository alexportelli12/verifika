// Integration tests of the CLI: choosing checks from changed files, CI detection and git fallbacks.
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { project } from "../helpers/project.ts";
import { commitAll, config, installFixture, runCli, tempDir, writeFiles } from "../helpers/repo.ts";

describe("verifika run", () => {
  it("selects checks by changed files and reports an empty selection as success", async () => {
    const root = project({
      app: { command: "node check.mjs pass app", paths: ["src/**"] },
      docs: { command: "node check.mjs pass docs", paths: ["docs/**"] },
    });
    const clean = await runCli(root, []);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("PASS 0/0");
    expect(clean.stdout).toContain("Nothing to verify");

    writeFiles(root, { "src/new.ts": "x" });
    const changed = await runCli(root, ["--mode", "json"]);
    const json = JSON.parse(changed.stdout) as RunResult;
    expect(json.selection.changedFiles).toEqual([{ path: "src/new.ts", status: "untracked" }]);
    expect(json.checks.map((check) => [check.name, check.status, check.reason])).toEqual([
      ["app", "passed", "exit 0"],
      ["docs", "skipped", "no matching changes"],
    ]);
  });

  it("runs everything in CI unless selective mode is requested explicitly", async () => {
    const root = project({ docs: { command: "node check.mjs pass docs", paths: ["docs/**"] } });
    const ci = await runCli(root, [], { env: { CI: "true" } });
    expect(ci.stdout).toContain("PASS 1/1");
    expect(ci.stdout).toContain("full run (CI detected via CI)");
    const selective = await runCli(root, ["--changed"], { env: { CI: "true" } });
    expect(selective.stdout).toContain("PASS 0/0");
    expect(selective.stdout).toContain("selective in CI by request");
    for (const env of [
      { GITHUB_ACTIONS: "true", CI: "false" },
      { GITLAB_CI: "true", CI: "0" },
      { CI: "true", VERIFIKA_CI: "0" },
    ]) {
      const result = await runCli(root, [], { env });
      expect(result.stdout, JSON.stringify(env)).toContain("PASS 1/1");
      expect(result.stdout, JSON.stringify(env)).toContain("full run (CI detected via");
    }
  });

  it("supports --changed-since with merge-base semantics", async () => {
    const root = project({
      app: { command: "node check.mjs pass app", paths: ["src/**"] },
      docs: { command: "node check.mjs pass docs", paths: ["docs/**"] },
    });
    const { git } = await import("../helpers/repo.ts");
    git(root, "checkout", "--quiet", "-b", "feature");
    writeFiles(root, { "docs/guide.md": "x" });
    commitAll(root, "docs");
    const result = await runCli(root, ["--changed-since", "main", "--mode", "json"]);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(json.selection).toMatchObject({ mode: "changed", base: "main" });
    expect(json.checks.filter((check) => check.selected).map((check) => check.name)).toEqual([
      "docs",
    ]);
  });

  it("falls back to a full run outside git and says so", async () => {
    const root = tempDir();
    installFixture(root);
    writeFiles(root, {
      "verifika.config.json": config({
        app: { command: "node check.mjs pass", paths: ["src/**"] },
      }),
    });
    const result = await runCli(root, []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "full run (change detection unavailable: not inside a git repository)",
    );
  });
});
