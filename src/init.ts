import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE } from "./config.ts";
import { VerifikaError } from "./errors.ts";

export const SCHEMA_URL =
  "https://raw.githubusercontent.com/alexportelli12/verifika/main/schemas/verifika.schema.json";
const LOCAL_SCHEMA = "./node_modules/verifika/schemas/verifika.schema.json";

/** Conventional script names, in order of preference, for each starter check. */
const CANDIDATES: [check: string, scripts: string[]][] = [
  ["format", ["format:check", "format-check", "prettier:check", "fmt:check"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck", "type-check", "check-types", "types", "tsc"]],
  ["test", ["test"]],
  ["build", ["build"]],
];
const NPM_PLACEHOLDER_TEST = /no test specified/;

interface StarterConfig {
  $schema: string;
  version: 1;
  changes: { invalidateAll: string[] };
  checks: Record<string, { command: string }>;
}

/** npm scripts `vfk init` adds: selective verification while working, the full gate for CI. */
export const VERIFY_SCRIPTS: Readonly<Record<string, string>> = {
  verify: "vfk",
  "verify:ci": "vfk --all",
};

export interface ScriptsResult {
  added: string[];
  /** Scripts that already existed under those names and were left alone. */
  kept: { name: string; command: string }[];
}

/**
 * Adds the `verify` and `verify:ci` scripts to package.json where they are
 * absent; existing scripts are never overwritten. Keeps the file's indentation,
 * line endings, key order and trailing newline.
 */
export async function addVerifyScripts(root: string): Promise<ScriptsResult> {
  const file = path.join(root, "package.json");
  const raw = await readFile(file, "utf8");
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  const manifest = JSON.parse(text) as { scripts?: Record<string, string> };
  const scripts = (manifest.scripts ??= {});
  const result: ScriptsResult = { added: [], kept: [] };
  for (const [name, command] of Object.entries(VERIFY_SCRIPTS)) {
    const existing = scripts[name];
    if (existing === undefined) {
      scripts[name] = command;
      result.added.push(name);
    } else {
      result.kept.push({ name, command: existing });
    }
  }
  if (result.added.length === 0) return result;

  // A one-line manifest stays on one line.
  const indent = text.trim().includes("\n") ? (/^[ \t]+(?=")/m.exec(text)?.[0] ?? "  ") : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\r?\n$/.test(text) ? newline : "";
  const json = JSON.stringify(manifest, null, indent).replace(/\n/g, newline);
  await writeFile(file, `${bom}${json}${trailing}`);
  return result;
}

/**
 * Writes a starter verifika.config.json from the package.json scripts in `root`.
 * Checks are created without path filters (they run on any change); narrowing
 * them is a deliberate, reviewable edit.
 */
export async function initConfig(
  root: string,
  force: boolean,
): Promise<{ file: string; checks: string[] }> {
  const file = path.join(root, CONFIG_FILE);
  if (existsSync(file) && !force) {
    throw new VerifikaError(`${CONFIG_FILE} already exists`, "Use --force to overwrite it.");
  }
  const config = starterConfig(root);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, checks: Object.keys(config.checks) };
}

export function starterConfig(root: string): StarterConfig {
  let scripts: Record<string, string> = {};
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = manifest.scripts ?? {};
  } catch {
    throw new VerifikaError(
      `no readable package.json in ${root}`,
      `Write ${CONFIG_FILE} by hand; see https://github.com/alexportelli12/verifika#configuration`,
    );
  }
  const runner = packageRunner(root);
  const checks: StarterConfig["checks"] = {};
  for (const [check, names] of CANDIDATES) {
    const script = names.find((name) => scripts[name] && !NPM_PLACEHOLDER_TEST.test(scripts[name]));
    if (script) checks[check] = { command: `${runner} ${script}` };
  }
  if (Object.keys(checks).length === 0) {
    throw new VerifikaError(
      "package.json has no lint, format, typecheck, test or build scripts to start from",
      `Write ${CONFIG_FILE} by hand; see https://github.com/alexportelli12/verifika#configuration`,
    );
  }
  return {
    $schema: existsSync(path.join(root, "node_modules", "verifika")) ? LOCAL_SCHEMA : SCHEMA_URL,
    version: 1,
    changes: {
      invalidateAll: [
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "tsconfig*.json",
      ],
    },
    checks,
  };
}

function packageRunner(root: string): string {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn run";
  if (existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb")))
    return "bun run";
  return "npm run";
}
