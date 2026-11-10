// Integration tests of the CLI: Dependency order, blocking and concurrency limits.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { project, timeline } from "../helpers/project.ts";
import { config, runCli } from "../helpers/repo.ts";

describe("verifika run", () => {
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

  it("runs checks one at a time unless concurrency is configured", async () => {
    const checks = Object.fromEntries(
      ["a", "b"].map((name) => [
        name,
        { command: `node check.mjs timeline timeline.txt ${name} 300` },
      ]),
    );
    const root = project(checks);
    expect((await runCli(root, ["--all"])).code).toBe(0);
    expect(timeline(root).map((entry) => entry.event)).toEqual(["start", "end", "start", "end"]);

    writeFileSync(path.join(root, "timeline.txt"), "");
    writeFileSync(
      path.join(root, "verifika.config.json"),
      config(checks, { defaults: { concurrency: 2 } }),
    );
    expect((await runCli(root, ["--all"])).code).toBe(0);
    const events = timeline(root);
    const lastStart = Math.max(...events.filter((e) => e.event === "start").map((e) => e.at));
    const firstEnd = Math.min(...events.filter((e) => e.event === "end").map((e) => e.at));
    expect(lastStart).toBeLessThan(firstEnd);
  });
});
