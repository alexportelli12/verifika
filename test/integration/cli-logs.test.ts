// Integration tests of the CLI: reading logs with vfk logs.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/main.ts";
import { pass, project } from "../helpers/project.ts";
import { cleanEnv, runCli, writeFiles } from "../helpers/repo.ts";

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

  it("pages log contents on a terminal, never with --tail or --no-pager, and falls back without a pager", async () => {
    const root = project({ build: { command: "node check.mjs fail 1 broken" } });
    await runCli(root, ["--all"]);
    const pager = path.join(root, "pager.mjs");
    const paged = path.join(root, "paged.txt");
    writeFileSync(
      pager,
      'import { createWriteStream } from "node:fs";\nprocess.stdin.pipe(createWriteStream(process.argv[2]));\n',
    );
    const terminal = async (args: string[], env: NodeJS.ProcessEnv) => {
      let out = "";
      const code = await main(args, {
        cwd: root,
        env: cleanEnv(env),
        isTTY: true,
        out: (text) => (out += text),
        err: () => undefined,
      });
      return { code, out };
    };
    const withPager = { PAGER: `"${process.execPath}" "${pager}" "${paged}"` };

    const content = "starting up\nnoise line\nsrc/app.ts(3,7): error TS2322: broken\n";
    const logs = await terminal(["logs", "build"], withPager);
    expect(logs).toEqual({ code: 0, out: "" });
    expect(readFileSync(paged, "utf8")).toBe(content);

    for (const args of [
      ["logs", "build", "--tail", "5"],
      ["logs", "build", "--no-pager"],
      ["logs", "build", "--mode", "agent"],
    ]) {
      expect((await terminal(args, withPager)).out).toBe(content);
    }
    // An agent in a pseudo-terminal must never get a pager.
    expect((await terminal(["logs", "build"], { ...withPager, VERIFIKA_MODE: "agent" })).out).toBe(
      content,
    );
    const missing = await terminal(["logs", "build"], { PAGER: "no-such-pager-anywhere -R" });
    expect(missing.out).toBe(content);

    // The summary is never paged; on a terminal it shows local, relative time.
    const summary = await terminal(["logs"], { ...withPager, VERIFIKA_HYPERLINKS: "0" });
    expect(summary.out).toMatch(/^Run \S+ · failed · \S+ · today \d\d:\d\d, (just now|\d+s ago)\n/);
    expect(summary.out).not.toContain("\u001b]8;;");
    expect((await terminal(["logs"], withPager)).out).toContain("\u001b]8;;file://");
  });

  it("strips forced colour codes from logs printed to a pipe", async () => {
    const root = project({ build: { command: "node check.mjs color" } });
    const run = await runCli(root, ["--all"]);
    expect(run.stdout).toContain("build: exit 1\n  error: broken\n");
    expect((await runCli(root, ["logs", "build"])).stdout).toBe("error: broken\n");
    expect((await runCli(root, ["logs", "build", "--tail", "5"])).stdout).toBe("error: broken\n");
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
