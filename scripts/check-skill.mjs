// Validates skills/verifika/SKILL.md: Agent Skills frontmatter rules, and that
// every `verifika ...` command the skill teaches is accepted by the real CLI.
// Each command is executed against a disposable fixture repository; a usage
// error (exit 2) or an internal error means the skill documents something the
// CLI does not support.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const skillDir = path.join(repo, "skills", "verifika");
const skillFile = path.join(skillDir, "SKILL.md");
const cli = path.join(repo, "src", "cli.ts");
const problems = [];

const text = readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n");
const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
if (!match) {
  fail("SKILL.md must start with YAML frontmatter delimited by ---");
}
const [, frontmatter, body] = match;
const fields = Object.fromEntries(
  frontmatter
    .split("\n")
    .filter((line) => /^[a-z-]+:/.test(line))
    .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
);
const allowed = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
for (const key of Object.keys(fields)) {
  if (!allowed.includes(key)) problems.push(`frontmatter: unexpected field "${key}"`);
}
const name = fields.name ?? "";
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
  problems.push(
    `frontmatter: name "${name}" must be lowercase words joined by hyphens, at most 64 characters`,
  );
}
if (name !== path.basename(skillDir))
  problems.push(`frontmatter: name "${name}" must match the directory name`);
const description = (fields.description ?? "").replace(/^["']|["']$/g, "");
if (description.length < 20 || description.length > 1024) {
  problems.push(`frontmatter: description must be 20-1024 characters (got ${description.length})`);
}
const lines = body.split("\n").length;
if (lines > 500) problems.push(`body has ${lines} lines; keep skills under 500 lines`);

// Commands appear in fenced code blocks and inline code spans.
const commands = new Set();
for (const block of body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
  for (const line of block[1].split("\n")) {
    const command = /^\s*(?:\$\s*)?(verifika(?:\s.*)?)$/.exec(line.replace(/\s+#.*$/, ""));
    if (command) commands.add(command[1].trim());
  }
}
for (const inline of body.matchAll(/`(verifika(?: [^`]*)?)`/g)) commands.add(inline[1].trim());
if (commands.size < 8)
  problems.push(`expected the skill to demonstrate the CLI; found only ${commands.size} commands`);

const fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), "verifika-skill-")));
try {
  setUpFixture(fixture);
  for (const command of [...commands].sort()) {
    const args = command
      .replace(/^verifika\s*/, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((arg) => arg.replace(/^<[^>]+>$/, "lint"));
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, VERIFIKA_MODE: "", CI: "" },
      timeout: 60_000,
    });
    if (
      result.status === 2 ||
      result.status === null ||
      (result.status > 2 && result.status < 128)
    ) {
      problems.push(
        `command "${command}" exited ${result.status}: ${(result.stderr || result.stdout).trim().split("\n")[0]}`,
      );
    }
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

if (problems.length > 0) fail(problems.map((problem) => `- ${problem}`).join("\n"));
process.stdout.write(`skill OK: ${commands.size} commands verified against the CLI\n`);

function setUpFixture(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const checks = Object.fromEntries(
    ["format", "lint", "typecheck", "test", "build"].map((check) => [
      check,
      { command: "node --version" },
    ]),
  );
  writeFileSync(
    path.join(root, "verifika.config.json"),
    JSON.stringify({ version: 1, checks }, null, 2),
  );
  git("init", "--quiet");
  git(
    "-c",
    "user.email=skill@example.com",
    "-c",
    "user.name=skill",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "init",
  );
  git("add", "-A");
  git(
    "-c",
    "user.email=skill@example.com",
    "-c",
    "user.name=skill",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "config",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  // A recorded run, so `verifika logs ...` commands have something to read.
  const run = spawnSync(process.execPath, [cli, "--all"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (run.status !== 0) fail(`fixture run failed: ${run.stdout}${run.stderr}`);
}

function fail(message) {
  process.stderr.write(`skills/verifika/SKILL.md is invalid:\n${message}\n`);
  process.exit(1);
}
