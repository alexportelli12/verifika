import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import {
  commitAll,
  config,
  gitRepo,
  installFixture,
  isAlive,
  runCli,
  tempDir,
  waitFor,
  writeFiles,
} from "../helpers/repo.ts";

const isWindows = process.platform === "win32";

/** A committed repository with the fixture script and the given checks. */
function project(checks: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const root = gitRepo({ "README.md": "x\n", "verifika.config.json": config(checks, extra) });
  installFixture(root);
  writeFiles(root, { ".gitignore": "check.mjs\n*.txt\n" });
  commitAll(root, "setup");
  return root;
}

function timeline(root: string): { event: string; name: string; at: number }[] {
  const file = path.join(root, "timeline.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [event = "", name = "", at = "0"] = line.split(" ");
      return { event, name, at: Number(at) };
    });
}

const pass = (name: string) => ({ command: `node check.mjs pass ${name}` });

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
    expect(result.stdout).toContain("Run: verifika logs typecheck");
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
    expect(failed.stderr).toBe("verifika: FAIL lint (exit 1). Run: verifika logs lint\n");
  });

  it("shows progress in human mode", async () => {
    const root = project({ lint: pass("lint") });
    const result = await runCli(root, ["--all", "--mode", "human"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("▸ lint\n✓ lint");
    expect(result.stdout).toContain("✓ 1 of 1 checks passed");
  });

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
    const ci = await runCli(root, [], { env: { VERIFIKA_CI: "", CI: "true" } });
    expect(ci.stdout).toContain("PASS 1/1");
    expect(ci.stdout).toContain("full run (CI detected via CI)");
    const selective = await runCli(root, ["--changed"], { env: { VERIFIKA_CI: "", CI: "true" } });
    expect(selective.stdout).toContain("PASS 0/0");
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

  it("runs explicit checks with their dependencies first", async () => {
    const root = project({
      build: { command: "node check.mjs timeline timeline.txt build 200" },
      test: { command: "node check.mjs timeline timeline.txt test 10", dependsOn: ["build"] },
      lint: { command: "node check.mjs timeline timeline.txt lint 10" },
    });
    const result = await runCli(root, ["--check", "test", "--concurrency", "4"]);
    expect(result.code).toBe(0);
    expect(timeline(root).map((entry) => `${entry.event} ${entry.name}`)).toEqual([
      "start build",
      "end build",
      "start test",
      "end test",
    ]);
  });

  it("blocks dependents when a dependency fails", async () => {
    const root = project({
      build: { command: "node check.mjs fail 1" },
      test: { command: "node check.mjs pass", dependsOn: ["build"] },
    });
    const result = await runCli(root, ["--all", "--mode", "json"]);
    const json = JSON.parse(result.stdout) as RunResult;
    expect(result.code).toBe(1);
    expect(json.checks.find((check) => check.name === "test")).toMatchObject({
      status: "blocked",
      reason: "dependency build did not pass",
      log: null,
    });
    expect(json.summary).toMatchObject({ failed: 1, notRun: 1 });
  });

  it("runs independent checks concurrently up to the limit", async () => {
    const checks = Object.fromEntries(
      ["a", "b", "c"].map((name) => [
        name,
        { command: `node check.mjs timeline timeline.txt ${name} 600` },
      ]),
    );
    const root = project(checks);
    expect((await runCli(root, ["--all", "-j", "3"])).code).toBe(0);
    const parallel = timeline(root);
    const lastStart = Math.max(
      ...parallel.filter((entry) => entry.event === "start").map((entry) => entry.at),
    );
    const firstEnd = Math.min(
      ...parallel.filter((entry) => entry.event === "end").map((entry) => entry.at),
    );
    expect(lastStart).toBeLessThan(firstEnd);

    writeFileSync(path.join(root, "timeline.txt"), "");
    expect((await runCli(root, ["--all", "--concurrency", "1"])).code).toBe(0);
    const serial = timeline(root).map((entry) => entry.event);
    expect(serial).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

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

  it("does not leave background processes behind after a check exits", async () => {
    const root = project({ orphan: { command: "node check.mjs orphan orphan.txt" } });
    const result = await runCli(root, ["--all"]);
    expect(result.code).toBe(0);
    const pid = Number(readFileSync(path.join(root, "orphan.txt"), "utf8"));
    if (!isWindows) await waitFor(() => !isAlive(pid), 5_000);
    else if (isAlive(pid)) process.kill(pid);
  });

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

describe("verifika plan", () => {
  it("shows decisions without running anything", async () => {
    const root = project({
      app: { command: "node check.mjs timeline timeline.txt app 1", paths: ["src/**"] },
      docs: { command: "node check.mjs timeline timeline.txt docs 1", paths: ["docs/**"] },
    });
    writeFiles(root, { "src/a.ts": "x" });
    const result = await runCli(root, ["plan"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Changed files (1):\n  ? src/a.ts");
    expect(result.stdout).toMatch(/run {3}app {3}matched src\/a\.ts/);
    expect(result.stdout).toMatch(/skip {2}docs {2}no matching changes/);
    expect(timeline(root)).toEqual([]);
    expect(existsSync(path.join(root, ".verifika"))).toBe(false);

    const json = JSON.parse((await runCli(root, ["plan", "--mode", "json"])).stdout);
    expect(json).toMatchObject({ schemaVersion: 1, kind: "plan", selection: { mode: "changed" } });
    expect(json.checks[0]).toMatchObject({
      name: "app",
      selected: true,
      matchedFiles: ["src/a.ts"],
      command: expect.any(String),
    });
  });
});

describe("verifika logs", () => {
  it("summarises the latest run and prints logs on demand", async () => {
    const root = project({
      lint: pass("lint"),
      typecheck: { command: "node check.mjs fail 2 bad" },
      unit: { command: "node check.mjs fail 1 worse" },
      docs: { command: "node check.mjs pass", paths: ["docs/**"] },
    });
    writeFiles(root, { "src/a.ts": "x" });
    await runCli(root, []);

    const summary = await runCli(root, ["logs"]);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toMatch(/^Run \d{8}-\d{6}-\d{3}-[0-9a-f]{6} · failed/);
    expect(summary.stdout).toMatch(/✗ typecheck .*exit 2 {2}\.verifika\/runs\/.*\/typecheck\.log/);
    expect(summary.stdout).toContain("– skipped (1): docs (no matching changes)");

    const one = await runCli(root, ["logs", "typecheck"]);
    expect(one.stdout).toBe("starting up\nnoise line\nsrc/app.ts(3,7): error TS2322: bad\n");

    const tail = await runCli(root, ["logs", "typecheck", "--tail", "1"]);
    expect(tail.stdout).toBe("src/app.ts(3,7): error TS2322: bad\n");

    const failed = await runCli(root, ["logs", "--failed"]);
    expect(failed.stdout).toContain("── typecheck: failed (exit 2) ──\nstarting up");
    expect(failed.stdout).toContain("── unit: failed (exit 1) ──");
    expect(failed.stdout).not.toContain("ok lint");

    const passed = await runCli(root, ["logs", "lint"]);
    expect(passed.stdout).toBe("ok lint\n");

    const skipped = await runCli(root, ["logs", "docs"]);
    expect(skipped.stdout).toBe("docs has no log: skipped (no matching changes)\n");

    const unknown = await runCli(root, ["logs", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("no check named nope");
  });

  it("strips forced colour codes from logs printed to a pipe", async () => {
    const root = project({ build: { command: "node check.mjs color" } });
    const run = await runCli(root, ["--all"]);
    expect(run.stdout).toContain("build: exit 1\n  error: broken\n");
    expect((await runCli(root, ["logs", "build"])).stdout).toBe("error: broken\n");
    expect((await runCli(root, ["logs", "build", "--tail", "5"])).stdout).toBe("error: broken\n");
  });

  it("reads a specific run and keeps only the configured number of runs", async () => {
    const root = project({ lint: pass("lint") }, { defaults: { keepRuns: 2 } });
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push(
        (JSON.parse((await runCli(root, ["--all", "--mode", "json"])).stdout) as RunResult).runId,
      );
    }
    const runs = readdirSync(path.join(root, ".verifika", "runs")).sort();
    expect(runs).toEqual(ids.slice(1).sort());
    expect((await runCli(root, ["logs", "--run", ids[2] as string])).stdout).toContain(ids[2]);
    expect((await runCli(root, ["logs", "--run", ids[0] as string])).code).toBe(2);
  });

  it("explains when there are no runs or no failures", async () => {
    const root = project({ lint: pass("lint") });
    const none = await runCli(root, ["logs"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("no verification runs recorded yet");
    await runCli(root, ["--all"]);
    expect((await runCli(root, ["logs", "--failed"])).stdout).toMatch(
      /^No failed checks in run .* \(passed\)\.\n$/,
    );
  });

  it("keeps the state directory out of git", async () => {
    const root = project({ lint: pass("lint") });
    await runCli(root, ["--all"]);
    expect(readFileSync(path.join(root, ".verifika", ".gitignore"), "utf8")).toContain("*");
    const plan = JSON.parse((await runCli(root, ["plan", "--mode", "json"])).stdout);
    expect(plan.selection.changedFiles).toEqual([]);
  });
});

describe("verifika init, help and version", () => {
  it("creates a starter config from package.json scripts", async () => {
    const root = tempDir();
    writeFiles(root, {
      "package.json": JSON.stringify({
        scripts: {
          lint: "eslint .",
          "format:check": "prettier -c .",
          test: "vitest run",
          build: "tsc",
        },
      }),
      "pnpm-lock.yaml": "",
    });
    const result = await runCli(root, ["init"]);
    expect(result.code).toBe(0);
    const created = JSON.parse(readFileSync(path.join(root, "verifika.config.json"), "utf8"));
    expect(created.checks).toEqual({
      format: { command: "pnpm run format:check" },
      lint: { command: "pnpm run lint" },
      test: { command: "pnpm run test" },
      build: { command: "pnpm run build" },
    });
    expect((await runCli(root, ["plan"])).code).toBe(0);
    expect((await runCli(root, ["init"])).code).toBe(2);
    expect((await runCli(root, ["init", "--force"])).code).toBe(0);
  });

  it("prints help and version", async () => {
    const root = tempDir();
    const help = await runCli(root, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("verifika plan [options]");
    const version = await runCli(root, ["--version"]);
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(version.stdout).toBe(`${manifest.version}\n`);
  });

  it("rejects stray positional arguments", async () => {
    const root = project({ lint: pass("lint") });
    const result = await runCli(root, ["lint"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unexpected argument "lint"');
  });
});
