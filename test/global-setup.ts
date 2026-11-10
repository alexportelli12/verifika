// Compiles the CLI for each test run, so integration tests spawn JavaScript that starts
// faster than src/cli.ts and is never stale: it is rebuilt when watch mode reruns tests.
// Each run builds into its own gitignored folder, so two runs in one checkout cannot
// delete each other's build, and none of them touches dist/, which the `pack` check
// reads while tests run.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The compiled CLI entry point the tests spawn. */
    cli: string;
  }
}

const root = fileURLToPath(new URL("..", import.meta.url));
const PREFIX = ".test-dist-";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes builds left behind by test runs that were killed before their teardown. */
function removeAbandonedBuilds(): void {
  for (const name of readdirSync(root)) {
    const pid = Number(name.slice(PREFIX.length));
    if (name.startsWith(PREFIX) && Number.isInteger(pid) && !isAlive(pid)) {
      rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}

function build(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  const typescript = path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(typescript, "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", outDir],
    { cwd: root, encoding: "utf8" },
  );
  // Type errors still emit JavaScript, and the typecheck check reports them, so only a
  // build that produced no CLI stops the tests.
  if (!existsSync(path.join(outDir, "cli.js"))) {
    throw new Error(`building the CLI for tests failed:\n${result.stdout}${result.stderr}`);
  }
}

export default function setup(project: TestProject): () => void {
  removeAbandonedBuilds();
  // Directly under the root, so the CLI still finds ../package.json.
  const outDir = path.join(root, `${PREFIX}${process.pid}`);
  build(outDir);
  project.onTestsRerun(() => build(outDir));
  project.provide("cli", path.join(outDir, "cli.js"));
  return () => rmSync(outDir, { recursive: true, force: true });
}
