// Integration tests of the CLI: running independent checks concurrently up to the limit.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { project, timeline } from "../helpers/project.ts";
import { runCli } from "../helpers/repo.ts";

describe("verifika run", () => {
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
});
