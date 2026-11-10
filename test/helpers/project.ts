// Shared set-up for the CLI integration tests in test/integration/cli-*.test.ts.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { commitAll, config, gitRepo, installFixture, writeFiles } from "./repo.ts";

/** A committed repository with the fixture script and the given checks. */
export function project(
  checks: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  const root = gitRepo({ "README.md": "x\n", "verifika.config.json": config(checks, extra) });
  installFixture(root);
  writeFiles(root, { ".gitignore": "check.mjs\n*.txt\n" });
  commitAll(root, "setup");
  return root;
}

/** The start and end events the fixture's `timeline` command wrote, in order. */
export function timeline(root: string): { event: string; name: string; at: number }[] {
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

export const pass = (name: string) => ({ command: `node check.mjs pass ${name}` });
