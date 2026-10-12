import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

export const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixture-check.mjs", import.meta.url));

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** A fresh temporary directory, removed after the current test. */
export function tempDir(prefix = "verifika-test-"): string {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(directory);
  return directory;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// Isolate test repositories from the developer's git config. An empty file rather
// than os.devNull, which Git for Windows cannot open as a config file.
const EMPTY_GIT_CONFIG = path.join(
  mkdtempSync(path.join(os.tmpdir(), "verifika-gitconfig-")),
  "config",
);
writeFileSync(EMPTY_GIT_CONFIG, "");
process.once("exit", () =>
  rmSync(path.dirname(EMPTY_GIT_CONFIG), { recursive: true, force: true }),
);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A git repository with one commit containing `files`. */
export function gitRepo(files: Record<string, string> = { "README.md": "hello\n" }): string {
  const root = tempDir();
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  writeFiles(root, files);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

export function commitAll(root: string, message = "change"): void {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
}

/** Installs the fixture check script as `check.mjs` in `root`. */
export function installFixture(root: string): void {
  copyFileSync(FIXTURE, path.join(root, "check.mjs"));
}

export function config(
  checks: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ version: 1, ...extra, checks }, null, 2)}\n`;
}

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Environment with CI detection and output-mode overrides neutralised. */
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([key]) => key !== "CI" && key !== "GITHUB_ACTIONS" && !key.startsWith("VERIFIKA"),
  );
  return { ...Object.fromEntries(inherited), VERIFIKA_CI: "0", NO_COLOR: "1", ...extra };
}

export function runCli(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; onSpawn?: (pid: number) => void } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: cleanEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
