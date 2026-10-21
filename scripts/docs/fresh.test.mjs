import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFreshness, FreshnessError } from "./fresh.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";

const temporary = [];
after(() =>
  Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))),
);

const run = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const write = async (directory, file, text) => {
  await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await writeFile(path.join(directory, file), text);
};
const page = (sources, reviewed = "2026-01-01") =>
  `---\nsources:\n${sources.map((source) => `  - ${source}`).join("\n")}\nreviewed: ${reviewed}\n---\n# Page\n`;
const sidecar = (reviewed = "2026-01-01") =>
  `${JSON.stringify({ "README.md": { sources: ["src/**"], reviewed }, "site/index.html": { sources: ["src/b.txt"], reviewed } })}\n`;

// A repository with an origin whose default branch is main, and a feature
// branch checked out in a clone of it.
async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "verifika-fresh-")));
  temporary.push(parent);
  const origin = path.join(parent, "origin.git");
  const seed = path.join(parent, "seed");
  run(parent, "init", "-q", "--bare", "-b", "main", origin);
  run(parent, "init", "-q", "-b", "main", seed);
  await write(seed, "src/a.txt", "a\n");
  await write(seed, "src/b.txt", "b\n");
  await write(seed, "docs/page.md", page(["src/a.txt"]));
  await write(seed, "docs/freshness.json", sidecar());
  await write(seed, "README.md", "# R\n");
  await write(seed, "site/index.html", "<html></html>\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "seed");
  run(seed, "remote", "add", "origin", origin);
  run(seed, "push", "-q", "origin", "main");
  const clone = path.join(parent, "clone");
  run(parent, "clone", "-q", origin, clone);
  run(clone, "checkout", "-q", "-b", "feature");
  return clone;
}
const commit = (clone, message) => {
  run(clone, "add", "-A");
  run(clone, "commit", "-qm", message);
};

test("a changed source without its page names the page", async () => {
  const clone = await fixture();
  await write(clone, "src/a.txt", "changed\n");
  commit(clone, "change a source");
  const problems = await checkFreshness({ root: clone, env: {} });
  assert.equal(problems.length, 2, problems.join("\n")); // docs/page.md and README.md
  assert.match(problems[0], /^docs\/page\.md: review it, because src\/a\.txt changed/);
});

test("editing the page, or bumping its reviewed date, satisfies the rule", async () => {
  const clone = await fixture();
  await write(clone, "src/a.txt", "changed\n");
  await write(clone, "docs/page.md", page(["src/a.txt"], "2026-02-02"));
  await write(clone, "docs/freshness.json", sidecar("2026-02-02"));
  commit(clone, "change a source and review the pages");
  assert.deepEqual(await checkFreshness({ root: clone, env: {} }), []);
});

test("README and the landing page are checked through docs/freshness.json", async () => {
  const clone = await fixture();
  await write(clone, "src/b.txt", "changed\n");
  commit(clone, "change b");
  const problems = await checkFreshness({ root: clone, env: {} });
  assert.deepEqual(problems.map((problem) => problem.split(":")[0]).sort(), [
    "README.md",
    "site/index.html",
  ]);
  await write(clone, "README.md", "# Reviewed\n");
  assert.deepEqual(
    (await checkFreshness({ root: clone, env: {} })).map((problem) => problem.split(":")[0]),
    ["site/index.html"],
  );
});

test("uncommitted and untracked changes count", async () => {
  const clone = await fixture();
  await write(clone, "src/a.txt", "dirty\n");
  assert.match((await checkFreshness({ root: clone, env: {} }))[0], /docs\/page\.md/);
});

test("a branch that changes no source passes", async () => {
  const clone = await fixture();
  await write(clone, "unrelated.txt", "x\n");
  commit(clone, "unrelated");
  assert.deepEqual(await checkFreshness({ root: clone, env: {} }), []);
});

test("a missing declaration, a bad date and a stale glob are reported", async () => {
  const clone = await fixture();
  await write(clone, "docs/page.md", "# No frontmatter\n");
  await write(clone, "docs/other.md", page(["gone/**"], "soon"));
  await write(clone, "docs/third.md", page(["gone/**"]));
  commit(clone, "bad pages");
  const text = (await checkFreshness({ root: clone, env: {} })).join("\n");
  assert.match(text, /docs\/page\.md: declare what it describes/);
  assert.match(text, /docs\/other\.md: `reviewed` must be a YYYY-MM-DD date/);
  assert.match(text, /docs\/third\.md: source `gone\/\*\*` matches no tracked file/);
});

test("with no origin ref it fails loudly instead of skipping, and VERIFIKA_DOCS_BASE supplies one", async () => {
  const clone = await fixture();
  run(clone, "remote", "remove", "origin");
  await assert.rejects(
    checkFreshness({ root: clone, env: {} }),
    (error) =>
      error instanceof FreshnessError &&
      /no base to compare with.*VERIFIKA_DOCS_BASE/.test(error.message),
  );
  await write(clone, "src/a.txt", "changed\n");
  commit(clone, "change a source");
  const first = run(clone, "rev-list", "--max-parents=0", "HEAD").trim();
  assert.match(
    (await checkFreshness({ root: clone, env: { VERIFIKA_DOCS_BASE: first } }))[0],
    /docs\/page\.md/,
  );
});

// The rule on this repository's own declarations: a CLI source changes, the
// CLI guide does not, and the check says so.
test("changing a source of docs/cli.md without touching docs/cli.md fails the real check", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "verifika-fresh-real-")));
  temporary.push(directory);
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    try {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await cp(path.join(root, file), path.join(directory, file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  run(directory, "init", "-q", "-b", "main");
  run(directory, "add", "-A");
  run(directory, "commit", "-qm", "base");
  run(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
  run(directory, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  run(directory, "checkout", "-q", "-b", "feature");
  assert.deepEqual(await checkFreshness({ root: directory, env: {} }), []);

  const main = path.join(directory, "src/main.ts");
  await writeFile(main, `${await readFile(main, "utf8")}\n// a CLI change\n`);
  commit(directory, "change the CLI");
  const problems = await checkFreshness({ root: directory, env: {} });
  assert.ok(
    problems.some((problem) =>
      /^docs\/cli\.md: review it, because src\/main\.ts changed/.test(problem),
    ),
    problems.join("\n"),
  );

  // Reviewing the guide satisfies the rule again.
  const guide = path.join(directory, "docs/cli.md");
  await writeFile(
    guide,
    (await readFile(guide, "utf8")).replace(/reviewed: \S+/, "reviewed: 2026-12-31"),
  );
  const remaining = await checkFreshness({ root: directory, env: {} });
  assert.ok(!remaining.some((problem) => problem.startsWith("docs/cli.md")), remaining.join("\n"));
});

test("frontmatter with CRLF line endings declares its sources", () => {
  const { data } = parseFrontmatter(
    "---\r\nsources:\r\n  - src/a.txt\r\nreviewed: 2026-10-21\r\n---\r\n# Page\r\n",
  );
  assert.deepEqual(data.sources, ["src/a.txt"]);
  assert.equal(data.reviewed, "2026-10-21");
});
