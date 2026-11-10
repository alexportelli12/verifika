// Compiles the CLI once per test run, so integration tests spawn JavaScript that
// starts faster than src/cli.ts and can never be stale. It builds into its own
// gitignored folder rather than dist/, which the `pack` check reads while tests run.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Directly under the root, so the CLI still finds ../package.json. */
export const TEST_DIST = path.join(root, ".test-dist");

export default function setup(): void {
  rmSync(TEST_DIST, { recursive: true, force: true });
  const typescript = path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(typescript, "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", TEST_DIST],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`building the CLI for tests failed:\n${result.stdout}${result.stderr}`);
  }
}
