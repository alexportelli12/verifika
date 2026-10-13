import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.ts";
import { VerifikaError } from "../../src/errors.ts";
import { compileGlobs } from "../../src/glob.ts";
import { plan, type DetectChanges } from "../../src/planner.ts";
import type { ChangedFile } from "../../src/types.ts";

const config = parseConfig(
  {
    version: 1,
    changes: { invalidateAll: ["package.json", "tsconfig*.json", "../pnpm-lock.yaml"] },
    checks: {
      lint: { command: "lint", paths: ["src/**/*.{ts,html}"], exclude: ["src/generated/**"] },
      format: { command: "format" },
      docs: { command: "docs", paths: ["docs/**", "*.md"] },
      build: { command: "build", paths: ["src/**"] },
      e2e: { command: "e2e", paths: ["e2e/**"], dependsOn: ["build"] },
      audit: { command: "audit", always: true },
    },
  },
  "/repo/verifika.config.json",
);

const LOCAL = {};

function changes(...paths: string[]): DetectChanges {
  const files: ChangedFile[] = paths.map((path) => ({ path, status: "modified" }));
  return async (_root, base) => ({ ok: true, changes: { base, baseCommit: "abcdef1234", files } });
}

function selected(selection: Awaited<ReturnType<typeof plan>>): string[] {
  return selection.checks.filter((check) => check.selected).map((check) => check.name);
}

describe("plan", () => {
  it("selects checks whose paths match changed files, plus always-run and unfiltered checks", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("src/app/main.ts"));
    expect(selection.mode).toBe("changed");
    expect(selected(selection)).toEqual(["lint", "format", "build", "audit"]);
    const byName = Object.fromEntries(selection.checks.map((check) => [check.name, check]));
    expect(byName.lint?.reason).toBe("matched src/app/main.ts");
    expect(byName.format?.reason).toBe("no path filter; 1 changed file");
    expect(byName.audit?.reason).toBe("always runs");
    expect(byName.docs).toMatchObject({ selected: false, reason: "no matching changes" });
  });

  it("honours exclude rules", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("src/generated/api.ts"));
    expect(selected(selection)).toEqual(["format", "build", "audit"]);
  });

  it("pulls in dependencies and explains why", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("e2e/login.spec.ts"));
    expect(selected(selection)).toEqual(["format", "build", "e2e", "audit"]);
    expect(selection.checks.find((check) => check.name === "build")).toMatchObject({
      reason: "required by e2e",
      requiredBy: ["e2e"],
    });
    expect(selection.checks.find((check) => check.name === "e2e")).not.toHaveProperty("requiredBy");
  });

  it("names every check that requires a dependency, through chains", async () => {
    const chained = parseConfig(
      {
        version: 1,
        checks: {
          gen: { command: "gen", paths: ["schema/**"] },
          build: { command: "build", paths: ["src/**"], dependsOn: ["gen"] },
          test: { command: "test", paths: ["test/**"], dependsOn: ["build"] },
          pack: { command: "pack", paths: ["pack/**"], dependsOn: ["build"] },
        },
      },
      "/repo/verifika.config.json",
    );
    const selection = await plan(chained, { env: LOCAL }, changes("pack/x", "test/y"));
    const byName = Object.fromEntries(selection.checks.map((check) => [check.name, check]));
    expect(byName.build).toMatchObject({
      reason: "required by test, pack",
      requiredBy: ["test", "pack"],
    });
    expect(byName.gen).toMatchObject({ reason: "required by build", requiredBy: ["build"] });
    // Selected on its own: no requiredBy, even though test also needs it.
    const direct = await plan(chained, { env: LOCAL }, changes("src/a", "test/y"));
    expect(direct.checks.find((check) => check.name === "build")).toMatchObject({
      reason: "matched src/a",
    });
    expect(direct.checks.find((check) => check.name === "build")).not.toHaveProperty("requiredBy");
  });

  it("selects only always-run checks when nothing changed", async () => {
    const selection = await plan(config, { env: LOCAL }, changes());
    expect(selected(selection)).toEqual(["audit"]);
    expect(selection.reason).toBe("no files changed since HEAD (abcdef1)");
    expect(selection.checks.find((check) => check.name === "lint")?.reason).toBe(
      "no changed files",
    );
  });

  it("runs everything when a global invalidation file changes", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("README.md", "tsconfig.app.json"));
    expect(selection.invalidatedBy).toBe("tsconfig.app.json");
    expect(selected(selection)).toHaveLength(config.checks.length);
  });

  it("always treats the config file itself as a global invalidation", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("verifika.config.json"));
    expect(selection.invalidatedBy).toBe("verifika.config.json");
  });

  it("matches invalidation files outside the config directory", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("../pnpm-lock.yaml"));
    expect(selection.invalidatedBy).toBe("../pnpm-lock.yaml");
  });

  it("does not let ** patterns match files outside the config directory", async () => {
    const selection = await plan(config, { env: LOCAL }, changes("../other/src/a.ts"));
    expect(selected(selection)).toEqual(["format", "audit"]);
  });

  it("runs everything with --all, without consulting git", async () => {
    const detect: DetectChanges = async () => {
      throw new Error("must not be called");
    };
    const selection = await plan(config, { all: true, env: LOCAL }, detect);
    expect(selection).toMatchObject({ mode: "all", reason: "--all" });
    expect(selected(selection)).toHaveLength(config.checks.length);
  });

  it("runs explicit checks with their dependencies", async () => {
    const selection = await plan(config, { checks: ["e2e", "e2e"], env: LOCAL });
    expect(selection.mode).toBe("explicit");
    expect(selected(selection)).toEqual(["build", "e2e"]);
    expect(selection.checks.find((check) => check.name === "lint")?.reason).toBe("not requested");
  });

  it("rejects unknown explicit checks and lists the available ones", async () => {
    await expect(plan(config, { checks: ["lnt"] })).rejects.toMatchObject({
      message: "unknown check: lnt",
      hint: expect.stringContaining("lint, format"),
    });
  });

  it("rejects empty explicit selections instead of widening them", async () => {
    await expect(plan(config, { checks: [], env: LOCAL }, changes())).rejects.toThrow(
      "--check needs at least one check name",
    );
    await expect(plan(config, { changedSince: " ", env: LOCAL }, changes())).rejects.toThrow(
      "--changed-since needs a git ref",
    );
  });

  it("rejects conflicting selection flags", async () => {
    await expect(plan(config, { all: true, changed: true })).rejects.toThrow(VerifikaError);
    await expect(plan(config, { checks: ["lint"], changedSince: "main" })).rejects.toThrow(
      "use only one of",
    );
  });

  it("runs everything in CI by default", async () => {
    const selection = await plan(config, { env: { GITHUB_ACTIONS: "true" } }, changes("docs/a.md"));
    expect(selection).toMatchObject({ mode: "all", reason: "CI detected via GITHUB_ACTIONS" });
  });

  it("cannot be talked out of CI mode by environment variables", async () => {
    for (const env of [
      { GITHUB_ACTIONS: "true", CI: "false" },
      { CI: "true", VERIFIKA_CI: "0" },
      { BUILDKITE: "true", CI: "" },
    ]) {
      const selection = await plan(config, { env }, changes("docs/a.md"));
      expect(selection.mode, JSON.stringify(env)).toBe("all");
    }
  });

  it("lets CI opt into selective runs explicitly", async () => {
    const changed = await plan(
      config,
      { changed: true, env: { CI: "true" } },
      changes("docs/a.md"),
    );
    expect(changed.mode).toBe("changed");
    expect(changed.reason).toContain("selective in CI by request");
    const since = await plan(
      config,
      { changedSince: "origin/main", env: { CI: "1" } },
      changes("docs/a.md"),
    );
    expect(since.changes?.base).toBe("origin/main");
    expect(selected(since)).toEqual(["format", "docs", "audit"]);
  });

  it("uses the configured base for default selective runs", async () => {
    const custom = { ...config, base: "origin/develop" };
    const selection = await plan(custom, { env: LOCAL }, changes("docs/a.md"));
    expect(selection.changes?.base).toBe("origin/develop");
    expect(selection.reason).toBe("1 file changed since origin/develop (merge-base abcdef1)");
  });

  it("falls back to a full run when changes cannot be determined implicitly", async () => {
    const detect: DetectChanges = async () => ({
      ok: false,
      reason: "not inside a git repository",
    });
    const selection = await plan(config, { env: LOCAL }, detect);
    expect(selection).toMatchObject({
      mode: "all",
      reason: "change detection unavailable: not inside a git repository",
    });
    expect(selected(selection)).toHaveLength(config.checks.length);
  });

  it("fails clearly when an explicitly requested comparison is impossible", async () => {
    const detect: DetectChanges = async () => ({
      ok: false,
      reason: 'base ref "origin/nope" does not exist',
      hint: "fetch it",
    });
    await expect(
      plan(config, { changedSince: "origin/nope", env: LOCAL }, detect),
    ).rejects.toMatchObject({
      message: 'cannot determine changes: base ref "origin/nope" does not exist',
      hint: "fetch it",
    });
    await expect(plan(config, { changed: true, env: LOCAL }, detect)).rejects.toThrow(
      VerifikaError,
    );
  });

  it("bounds the matched file list", async () => {
    const files = Array.from({ length: 25 }, (_, index) => `src/file${index}.ts`);
    const selection = await plan(config, { env: LOCAL }, changes(...files));
    const lint = selection.checks.find((check) => check.name === "lint");
    expect(lint?.matchedFiles).toHaveLength(10);
    expect(lint?.reason).toBe("matched src/file0.ts (+24 more)");
  });
});

describe("compileGlobs", () => {
  it.each([
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/c.ts", true],
    ["src/**/*.ts", "lib/c.ts", false],
    ["src/**/*.{ts,html}", "src/a.html", true],
    ["**/*.md", ".github/README.md", true],
    ["*.md", "docs/a.md", false],
    ["tsconfig*.json", "tsconfig.app.json", true],
    ["src/**", "src/deep/file", true],
    ["src/*.ts", "SRC/a.ts", false],
    ["src/[ab].ts", "src/b.ts", true],
    ["src/a.ts", "src\\a.ts", false],
    ["**", "../outside.ts", false],
  ])("%s matches %s: %s", (pattern, file, expected) => {
    expect(compileGlobs([pattern])(file)).toBe(expected);
  });

  it("matches nothing for an empty list", () => {
    expect(compileGlobs([])("anything")).toBe(false);
  });
});
