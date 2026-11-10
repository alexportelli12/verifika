// Integration tests of the CLI: run history, retention and concurrent runs.
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../src/types.ts";
import { pass, project } from "../helpers/project.ts";
import { runCli, waitFor, writeFiles } from "../helpers/repo.ts";

describe("verifika logs", () => {
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

  it("keeps concurrent runs apart: hints point at their own run and logs survive", async () => {
    const root = project(
      {
        // Holds the first run open until the test releases it, so it is still active
        // however long the other runs take on a loaded machine.
        slow: { command: "node check.mjs wait-for release.txt started.txt" },
        broken: { command: "node check.mjs fail 1 slow-run-failure", dependsOn: ["slow"] },
        quick: pass("quick"),
      },
      { defaults: { keepRuns: 1 } },
    );
    const first = runCli(root, ["--check", "broken", "--mode", "json"]);
    try {
      await waitFor(() => existsSync(path.join(root, "started.txt")));
      // Two complete runs while the first is still going, with keepRuns: 1.
      for (let index = 0; index < 2; index++) {
        expect((await runCli(root, ["--check", "quick"])).code).toBe(0);
      }
    } finally {
      // Release the first run even when an assertion above fails, so it never lingers.
      writeFileSync(path.join(root, "release.txt"), "");
    }
    const slowRun = await first;
    expect(slowRun.code).toBe(1);
    const json = JSON.parse(slowRun.stdout) as RunResult;
    expect(json).toMatchObject({ status: "failed", latest: false });

    // The first run's logs were not pruned while it was active, and its hint names it.
    const logs = await runCli(root, ["logs", "broken", "--run", json.runId]);
    expect(logs.stdout).toContain("slow-run-failure");
    const agent = await runCli(root, ["--check", "broken"]);
    const hint = /Run: (vfk logs broken.*)\n/.exec(agent.stdout)?.[1];
    expect(hint).toBe("vfk logs broken");

    // Once finished, retention applies again: only the newest run remains.
    expect(readdirSync(path.join(root, ".verifika", "runs"))).toHaveLength(1);
  });

  it("keeps latest and retention consistent across racing invocations", async () => {
    const root = project({ lint: pass("lint") }, { defaults: { keepRuns: 2 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runCli(root, ["--all", "--mode", "json"])),
    );
    const ids = results.map((result) => (JSON.parse(result.stdout) as RunResult).runId);
    expect(results.every((result) => result.code === 0)).toBe(true);
    // `latest` means "no newer run had started when this one finished": the newest run
    // always says so, and every run that says otherwise really was superseded.
    const runs = results.map((result) => JSON.parse(result.stdout) as RunResult);
    const newest = [...ids].sort().at(-1) as string;
    expect(runs.find((run) => run.runId === newest)?.latest).toBe(true);
    for (const run of runs.filter((candidate) => !candidate.latest)) {
      expect(ids.some((id) => id > run.runId)).toBe(true);
    }
    const logs = await runCli(root, ["logs"]);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain(`Run ${[...ids].sort().at(-1)}`);
    // Runs that overlapped were protected from each other's retention; the next run
    // prunes them back to keepRuns, keeping the newest.
    const next = await runCli(root, ["--all", "--mode", "json"]);
    const nextId = (JSON.parse(next.stdout) as RunResult).runId;
    const remaining = readdirSync(path.join(root, ".verifika", "runs")).sort();
    expect(remaining).toEqual([[...ids].sort().at(-1), nextId]);
  });

  it("prunes runs abandoned by crashed processes and half-created run directories", async () => {
    const root = project({ lint: pass("lint") }, { defaults: { keepRuns: 1 } });
    const runs = path.join(root, ".verifika", "runs");
    const crashed = path.join(runs, "20200101-000000-000-aaaaaa");
    const abandoned = path.join(runs, ".tmp-20200101-000000-000-bbbbbb");
    writeFiles(root, {
      ".verifika/runs/20200101-000000-000-aaaaaa/run.json": "{}",
      // A pid that cannot belong to a live process.
      ".verifika/runs/20200101-000000-000-aaaaaa/owner.json": JSON.stringify({
        pid: 2147483646,
        host: os.hostname(),
        startedAt: "2020-01-01T00:00:00.000Z",
      }),
      ".verifika/runs/.tmp-20200101-000000-000-bbbbbb/run.json": "{}",
    });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(abandoned, old, old);
    expect((await runCli(root, ["--all"])).code).toBe(0);
    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(abandoned)).toBe(false);
    const [only] = readdirSync(runs);
    expect(existsSync(path.join(runs, only as string, "owner.json"))).toBe(false);
  });
});
