import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { buildDocs } from "./build.mjs";
import { checkConsistency } from "./consistency.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { globToRegExp } from "./lib/glob.mjs";
import { readAllowed } from "./lib/source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const temporary = [];
after(() =>
  Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))),
);

// A throwaway Git repository holding this working tree's files (tracked, plus
// untracked ones Git would not ignore), with node_modules linked so VitePress
// resolves. `edit` changes files before the commit; `extra` adds files;
// `untracked` writes files after the commit, which must never be read.
async function copyRepo({ extra = {}, untracked = {}, edit = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verifika-docs-"));
  temporary.push(directory);
  const files = git(root, "ls-files", "-co", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    try {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await cp(path.join(root, file), path.join(directory, file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error; // listed but deleted in the working tree
    }
  }
  await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"));
  for (const [file, change] of Object.entries(edit)) {
    await writeFile(
      path.join(directory, file),
      change(await readFile(path.join(directory, file), "utf8")),
    );
  }
  for (const [file, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  }
  git(directory, "init", "-q", "-b", "main");
  git(directory, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
  git(directory, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fixture");
  for (const [file, text] of Object.entries(untracked)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  }
  return directory;
}

const outputs = (directory) => ({
  out: path.join(directory, "docs-site"),
  site: path.join(directory, "site/docs"),
});

async function listFiles(directory) {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("the frontmatter reader handles folded blocks, lists and quotes", () => {
  const { data, body } = parseFrontmatter(
    "---\nname: x\ndescription: >-\n  one\n  two\nsources:\n  - a/**\n  - b.md\nlist: [c, 'd']\nreviewed: 2026-10-21\n---\nbody\n",
  );
  assert.deepEqual(data, {
    name: "x",
    description: "one two",
    sources: ["a/**", "b.md"],
    list: ["c", "d"],
    reviewed: "2026-10-21",
  });
  assert.equal(body, "body\n");
});

test("globs keep * inside a segment and let ** cross segments", () => {
  assert.ok(globToRegExp("docs/*.md").test("docs/a.md"));
  assert.ok(!globToRegExp("docs/*.md").test("docs/a/b.md"));
  assert.ok(globToRegExp("src/**").test("src/reporters/human.ts"));
  assert.ok(globToRegExp("**/SKILL.md").test("SKILL.md"));
});

test("the landing page carries the README's setup prompt, and drift is caught", async () => {
  assert.deepEqual(checkConsistency(await readAllowed(root)), []);
  const files = await readAllowed(root);
  files.set(
    "README.md",
    files.get("README.md").replace("Set up Verifika (", "Set up Verifika now ("),
  );
  assert.match(checkConsistency(files).join("\n"), /copy button must carry the README's prompt/);
});

test("a schema option nobody wrote about appears on the generated configuration page", async () => {
  const directory = await copyRepo({
    edit: {
      "schemas/verifika.schema.json": (text) => {
        const schema = JSON.parse(text);
        schema.properties.defaults.properties.quarantineWindow = {
          type: "integer",
          minimum: 1,
          description: "Zebrafish marker: how many runs a flaky check sits out.",
        };
        return JSON.stringify(schema, null, 2);
      },
    },
  });
  const { out, site } = outputs(directory);
  await buildDocs({ root: directory, out, site, render: false });
  const page = await readFile(path.join(out, "reference/configuration.md"), "utf8");
  assert.match(
    page,
    /\| `defaults\.quarantineWindow` \| integer \| Limits: at least 1\. Zebrafish marker: how many runs a flaky check sits out\. \|/,
  );
  // And the real page lists every current option.
  const real = JSON.parse(await readFile(path.join(root, "schemas/verifika.schema.json"), "utf8"));
  const current = await readFile(
    path.join(directory, "docs-site/reference/configuration.md"),
    "utf8",
  );
  for (const key of Object.keys(real.properties.defaults.properties)) {
    assert.ok(current.includes(`\`defaults.${key}\``), `defaults.${key} is documented`);
  }
});

test("a flag added to the CLI's help appears on the generated CLI page", async () => {
  const directory = await copyRepo({
    edit: {
      "src/main.ts": (text) =>
        text.replace(
          "      --config <path>             Use this config file instead of searching upward\n",
          "      --config <path>             Use this config file instead of searching upward\n      --quokka <n>                Quokka marker flag\n",
        ),
    },
  });
  const { out, site } = outputs(directory);
  await buildDocs({ root: directory, out, site, render: false });
  const page = await readFile(path.join(out, "reference/cli.md"), "utf8");
  assert.match(page, /\| `--quokka` \| `<n>` \| Quokka marker flag\. \|/);
  assert.match(page, /\| `128\+signal` \| Interrupted/);
});

test("the build publishes only allowlisted tracked files, and search finds every page by its rarest word", async () => {
  const directory = await copyRepo({
    extra: { "scripts/not-allowlisted.md": "TRACKED-BUT-NOT-ALLOWLISTED" },
    untracked: {
      ".verifika/runs/log.md": "RUNLOG-SECRET",
      "docs/untracked.md": "UNTRACKED-SECRET",
      "examples/untracked.json": '{"UNTRACKED-EXAMPLE": true}',
    },
  });
  const { out, site } = outputs(directory);
  const { pages } = await buildDocs({ root: directory, out, site });
  const published = [...(await listFiles(out)), ...(await listFiles(site))].filter(
    (file) => !file.includes(`${path.sep}.vitepress${path.sep}cache${path.sep}`),
  );
  for (const file of published) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const secret of [
      "RUNLOG-SECRET",
      "UNTRACKED-SECRET",
      "UNTRACKED-EXAMPLE",
      "TRACKED-BUT-NOT-ALLOWLISTED",
    ]) {
      assert.ok(!text.includes(secret), `${file} leaked ${secret}`);
    }
  }
  assert.ok(published.every((file) => !file.includes("node_modules")));
  assert.ok(
    !published.some((file) =>
      file.includes(`${path.sep}site${path.sep}docs${path.sep}public${path.sep}`),
    ),
    "plain .md copies must not also be built as pages",
  );
  // Guides lose their `sources:` frontmatter in the published page.
  assert.ok(!(await readFile(path.join(out, "cli.md"), "utf8")).includes("sources:"));
  // llms.txt and a plain .md copy of each page ship with the site.
  assert.match(
    await readFile(path.join(site, "llms.txt"), "utf8"),
    /\(https:\/\/alexportelli12\.github\.io\/verifika\/docs\/reference\/cli\.md\)/,
  );
  assert.match(
    await readFile(path.join(site, "reference/cli.md"), "utf8"),
    /^# Command-line options/,
  );

  // Search: for every page, a word that occurs on that page alone finds it.
  const chunks = path.join(site, "assets/chunks");
  const indexFile = (await readdir(chunks)).find((name) =>
    name.startsWith("@localSearchIndexroot"),
  );
  assert.ok(indexFile, "VitePress wrote its local search index");
  const indexModule = await readFile(path.join(chunks, indexFile), "utf8");
  const serialised = (
    await import(`data:text/javascript;base64,${Buffer.from(indexModule).toString("base64")}`)
  ).default;
  const search = MiniSearch.loadJSON(serialised, {
    fields: ["title", "titles", "text"],
    storeFields: ["title", "titles"],
  });
  const wordsOf = (markdown) =>
    new Set(
      markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/\]\([^)]*\)/g, " ")
        .toLowerCase()
        .match(/\b[a-z]{4,}\b/g),
    );
  assert.ok(pages.length >= 12);
  // The rarest word on each page (longest on a tie): a page whose words are all
  // shared with others, such as a short example, is still found by its rarest.
  const pageWords = new Map(pages.map((page) => [page, wordsOf(page.markdown)]));
  for (const page of pages) {
    const sharedBy = (word) => [...pageWords.values()].filter((words) => words.has(word)).length;
    const word = [...pageWords.get(page)].sort(
      (a, b) => sharedBy(a) - sharedBy(b) || b.length - a.length,
    )[0];
    assert.ok(word, `${page.route} has a word to search for`);
    // VitePress serves an index page at its directory's URL.
    const url = `/verifika/docs/${/(^|\/)index$/.test(page.route) ? page.route.replace(/index$/, "") : `${page.route}.html`}`;
    const hits = search.search(word, { prefix: true }).map((hit) => hit.id);
    assert.ok(
      hits.some((id) => id.startsWith(url)),
      `searching "${word}" should find ${url}; found ${hits.slice(0, 5).join(", ")}`,
    );
  }
});

test("the build fails on a planted broken internal link", async () => {
  const directory = await copyRepo({
    edit: {
      "docs/architecture.md": (text) =>
        `${text}\nSee [a page that is not there](no-such-page.md).\n`,
    },
  });
  const { out, site } = outputs(directory);
  await assert.rejects(buildDocs({ root: directory, out, site }), /dead link/i);
});

test("the build fails on a link to a repository path Git does not track", async () => {
  const directory = await copyRepo({
    edit: {
      "docs/architecture.md": (text) =>
        `${text}\nSee [a missing source](../src/no-such-file.ts).\n`,
    },
  });
  const { out, site } = outputs(directory);
  await assert.rejects(
    buildDocs({ root: directory, out, site, render: false }),
    /docs\/architecture\.md.*\.\.\/src\/no-such-file\.ts/,
  );
});
