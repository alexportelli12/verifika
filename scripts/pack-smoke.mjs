// Packs the package exactly as npm would publish it, installs the tarball into
// an isolated project and exercises the installed CLI. Requires a fresh `dist/`
// (the `pack` check depends on `build`).
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
const isWindows = process.platform === "win32";
const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "verifika-pack-")));

function npm(args, cwd) {
  const result = spawnSync(isWindows ? "npm.cmd" : "npm", args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.status !== 0)
    throw new Error(`npm ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  assert(
    existsSync(path.join(repo, "dist", "cli.js")),
    "dist/cli.js is missing; run npm run build first",
  );

  // 1. Pack and inspect the file list.
  const [pack] = JSON.parse(
    npm(["pack", "--json", "--ignore-scripts", "--pack-destination", work], repo),
  );
  const files = pack.files.map((file) => file.path.replace(/\\/g, "/"));
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "dist/cli.js",
    "dist/main.js",
    "schemas/verifika.schema.json",
    "skills/verifika/SKILL.md",
  ]) {
    assert(files.includes(required), `package is missing ${required}`);
  }
  const forbidden = files.filter((file) =>
    /^(src|test|scripts|\.github|node_modules|\.verifika)\/|tsconfig|\.ts$/.test(file),
  );
  assert(forbidden.length === 0, `package contains development files: ${forbidden.join(", ")}`);
  assert(pack.unpackedSize < 512 * 1024, `package unexpectedly large: ${pack.unpackedSize} bytes`);

  // 2. Install into an isolated project.
  const project = path.join(work, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "smoke", private: true }),
  );
  npm(
    ["install", "--no-audit", "--no-fund", "--prefer-offline", path.join(work, pack.filename)],
    project,
  );
  const installed = path.join(project, "node_modules", "verifika");
  assert(
    existsSync(path.join(installed, "schemas", "verifika.schema.json")),
    "schema not installed",
  );
  assert(existsSync(path.join(installed, "skills", "verifika", "SKILL.md")), "skill not installed");
  assert(
    existsSync(path.join(project, "node_modules", ".bin", isWindows ? "verifika.cmd" : "verifika")),
    "bin link not created",
  );

  // 3. Exercise the installed CLI through the bin link, from inside the project.
  const run = (args) =>
    spawnSync(isWindows ? "npx.cmd" : "npx", ["--no-install", "verifika", ...args], {
      cwd: project,
      encoding: "utf8",
      shell: isWindows,
      env: { ...process.env, VERIFIKA_MODE: "" },
    });
  const version = run(["--version"]);
  assert(
    version.stdout.trim() === manifest.version,
    `--version printed "${version.stdout.trim()}"`,
  );

  const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
  writeFileSync(
    path.join(project, "verifika.config.json"),
    JSON.stringify({
      $schema: "./node_modules/verifika/schemas/verifika.schema.json",
      version: 1,
      checks: {
        ok: { command: "node --version" },
        broken: { command: 'node -e "process.exit(3)"', paths: ["src/**"] },
      },
    }),
  );
  writeFileSync(path.join(project, ".gitignore"), "node_modules/\n");
  git("init", "--quiet");
  git("add", "-A");
  git(
    "-c",
    "user.email=a@b.c",
    "-c",
    "user.name=smoke",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "init",
  );

  const pass = run(["--check", "ok"]);
  assert(
    pass.status === 0 && /^PASS 1\/1/.test(pass.stdout),
    `expected PASS, got ${pass.status}: ${pass.stdout}${pass.stderr}`,
  );

  const failed = run(["--all", "--mode", "json"]);
  const json = JSON.parse(failed.stdout);
  assert(
    failed.status === 1 && json.status === "failed",
    `expected a failed run, got ${failed.status}`,
  );
  assert(
    json.checks.find((check) => check.name === "broken")?.exitCode === 3,
    "exit code not propagated",
  );

  const logs = run(["logs"]);
  assert(
    logs.status === 0 && logs.stdout.includes("broken"),
    `logs failed: ${logs.stdout}${logs.stderr}`,
  );

  const plan = run(["plan", "--mode", "json"]);
  assert(plan.status === 0 && JSON.parse(plan.stdout).kind === "plan", "plan failed");

  process.stdout.write(
    `pack OK: ${pack.filename} (${files.length} files, ${pack.unpackedSize} bytes unpacked)\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
