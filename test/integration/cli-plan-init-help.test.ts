// Integration tests of the CLI: vfk plan, vfk init, help and version.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pass, project, timeline } from "../helpers/project.ts";
import { CLI, SRC_CLI, runCli, tempDir, writeFiles } from "../helpers/repo.ts";

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
    expect(result.stdout).toContain(
      'Added package.json scripts: "verify": "vfk", "verify:ci": "vfk --all"\n',
    );
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject({ verify: "vfk", "verify:ci": "vfk --all" });
    expect((await runCli(root, ["plan"])).code).toBe(0);
    expect((await runCli(root, ["init"])).code).toBe(2);
    const again = await runCli(root, ["init", "--force"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('package.json already has "verify": "vfk"\n');
  });

  it("leaves existing verify scripts alone and says so", async () => {
    const root = tempDir();
    writeFiles(root, {
      "package.json": `${JSON.stringify({ scripts: { lint: "eslint .", verify: "npm run lint" } }, null, 2)}\n`,
    });
    const result = await runCli(root, ["init"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Added package.json scripts: "verify:ci": "vfk --all"\n');
    expect(result.stdout).toContain(
      'Kept the existing "verify" script (npm run lint); to use Verifika, change it to "vfk" once the checks cover everything it runs\n',
    );
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.scripts.verify).toBe("npm run lint");
  });

  it("prints help and version", async () => {
    const root = tempDir();
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    // The compiled CLI the other tests use, and the TypeScript entry point used in development.
    for (const entry of [CLI, SRC_CLI]) {
      const help = await runCli(root, ["--help"], { entry });
      expect(help.code, entry).toBe(0);
      expect(help.stdout, entry).toContain("vfk plan [options]");
      const version = await runCli(root, ["--version"], { entry });
      expect(version.stdout, entry).toBe(`${manifest.version}\n`);
    }
  });

  it("rejects stray positional arguments", async () => {
    const root = project({ lint: pass("lint") });
    const result = await runCli(root, ["lint"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unexpected argument "lint"');
  });
});
