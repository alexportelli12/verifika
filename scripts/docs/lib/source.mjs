// What the docs generator may read. The allowlist is the privacy boundary: a
// path reaches docs-site/ only if Git tracks it AND one of these globs matches,
// so run logs (.verifika/), node_modules and anything untracked cannot be
// published whatever else changes.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { matchesAny } from "./glob.mjs";

export const REPO_URL = "https://github.com/alexportelli12/verifika";
export const SITE_URL = "https://alexportelli12.github.io/verifika/docs/";

export const ALLOWLIST = [
  "README.md",
  "CHANGELOG.md",
  "docs/*.md",
  "docs/freshness.json",
  "examples/README.md",
  "examples/*.json",
  "schemas/verifika.schema.json",
  "skills/verifika/SKILL.md",
  "site/favicon.svg",
  "site/index.html", // read by the consistency check, never published as a docs page
];

export function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Every tracked path, for resolving links; only some may be read.
export function trackedPaths(root) {
  return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

export async function readAllowed(root) {
  const files = new Map();
  for (const file of trackedPaths(root)
    .filter((name) => matchesAny(ALLOWLIST, name))
    .sort()) {
    try {
      files.set(file, await readFile(path.join(root, file), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error; // tracked but deleted in the working tree
    }
  }
  return files;
}
