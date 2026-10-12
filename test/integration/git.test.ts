import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectChanges, parseNameStatus } from "../../src/git.ts";
import type { ChangeDetection } from "../../src/git.ts";
import { commitAll, git, gitRepo, tempDir, writeFiles } from "../helpers/repo.ts";

function files(detection: ChangeDetection): Record<string, string> {
  if (!detection.ok) throw new Error(`detection failed: ${detection.reason}`);
  return Object.fromEntries(detection.changes.files.map((file) => [file.path, file.status]));
}

describe("detectChanges", () => {
  it("reports nothing for a clean working tree", async () => {
    const root = gitRepo();
    const detection = await detectChanges(root, "HEAD");
    expect(files(detection)).toEqual({});
    expect(detection.ok && detection.changes.baseCommit).toBe(git(root, "rev-parse", "HEAD"));
  });

  it("includes staged, unstaged, untracked and deleted files", async () => {
    const root = gitRepo({ "a.ts": "a", "b.ts": "b", "c.ts": "c", "d.ts": "d" });
    writeFileSync(path.join(root, "a.ts"), "unstaged");
    writeFileSync(path.join(root, "b.ts"), "staged");
    git(root, "add", "b.ts");
    rmSync(path.join(root, "c.ts"));
    git(root, "rm", "--quiet", "--cached", "d.ts");
    writeFiles(root, { "new/e.ts": "untracked", "staged-new.ts": "x" });
    git(root, "add", "staged-new.ts");
    expect(files(await detectChanges(root, "HEAD"))).toEqual({
      "a.ts": "modified",
      "b.ts": "modified",
      "c.ts": "deleted",
      "d.ts": "untracked",
      "new/e.ts": "untracked",
      "staged-new.ts": "added",
    });
  });

  it("reports both sides of a rename", async () => {
    const root = gitRepo({ "src/old-name.ts": "export const value = 1;\n".repeat(20) });
    mkdirSync(path.join(root, "lib"));
    git(root, "mv", "src/old-name.ts", "lib/new-name.ts");
    expect(files(await detectChanges(root, "HEAD"))).toEqual({
      "lib/new-name.ts": "added",
      "src/old-name.ts": "deleted",
    });
  });

  it("respects .gitignore for untracked files", async () => {
    const root = gitRepo({ ".gitignore": "dist/\n" });
    writeFiles(root, { "dist/out.js": "x", "src/in.ts": "y" });
    expect(files(await detectChanges(root, "HEAD"))).toEqual({ "src/in.ts": "untracked" });
  });

  it("handles unusual file names without quoting or interpretation", async () => {
    const root = gitRepo();
    const names = ["with space.ts", "ünïcödé.ts", 'quote"s.ts', "$(touch pwned).ts", "-dash.ts"];
    if (process.platform === "win32") names.splice(2, 2);
    writeFiles(root, Object.fromEntries(names.map((name) => [name, "x"])));
    expect(Object.keys(files(await detectChanges(root, "HEAD"))).sort()).toEqual([...names].sort());
  });

  it("compares a branch against the merge-base, ignoring later commits on the base", async () => {
    const root = gitRepo({ "shared.ts": "1" });
    git(root, "checkout", "--quiet", "-b", "feature");
    writeFiles(root, { "feature.ts": "f" });
    commitAll(root, "feature work");
    git(root, "checkout", "--quiet", "main");
    writeFiles(root, { "main-only.ts": "m" });
    commitAll(root, "main moves on");
    const mergeBase = git(root, "merge-base", "main", "feature");
    git(root, "checkout", "--quiet", "feature");
    writeFiles(root, { "wip.ts": "uncommitted" });

    const detection = await detectChanges(root, "main");
    expect(files(detection)).toEqual({ "feature.ts": "added", "wip.ts": "untracked" });
    expect(detection.ok && detection.changes).toMatchObject({
      base: "main",
      baseCommit: mergeBase,
    });
  });

  it("works on a detached HEAD", async () => {
    const root = gitRepo({ "a.ts": "1" });
    writeFiles(root, { "b.ts": "2" });
    commitAll(root);
    git(root, "checkout", "--quiet", "--detach", "HEAD~1");
    writeFiles(root, { "c.ts": "3" });
    expect(files(await detectChanges(root, "HEAD"))).toEqual({ "c.ts": "untracked" });
    expect(files(await detectChanges(root, "main"))).toEqual({ "c.ts": "untracked" });
  });

  it("expresses paths relative to a config in a subdirectory", async () => {
    const root = gitRepo({ "packages/app/src/a.ts": "1", "package-lock.json": "{}" });
    writeFiles(root, {
      "packages/app/src/a.ts": "2",
      "package-lock.json": "{ }",
      "packages/other/b.ts": "x",
    });
    expect(files(await detectChanges(path.join(root, "packages/app"), "HEAD"))).toEqual({
      "src/a.ts": "modified",
      "../../package-lock.json": "modified",
      "../other/b.ts": "untracked",
    });
  });

  it("explains a missing base ref", async () => {
    const root = gitRepo();
    expect(await detectChanges(root, "origin/main")).toMatchObject({
      ok: false,
      reason: 'base ref "origin/main" does not exist',
      hint: expect.stringContaining("git fetch"),
    });
  });

  it("refuses refs that look like options", async () => {
    const root = gitRepo();
    expect(await detectChanges(root, "--output=/tmp/x")).toEqual({
      ok: false,
      reason: 'invalid base ref "--output=/tmp/x"',
    });
  });

  it("reports repositories without commits", async () => {
    const root = tempDir();
    git(root, "init", "--quiet");
    writeFiles(root, { "a.ts": "x" });
    expect(await detectChanges(root, "HEAD")).toEqual({
      ok: false,
      reason: "the repository has no commits yet",
    });
  });

  it("reports directories outside git", async () => {
    const root = tempDir();
    expect(await detectChanges(root, "HEAD")).toEqual({
      ok: false,
      reason: "not inside a git repository",
    });
  });

  it("reports unrelated histories", async () => {
    const root = gitRepo();
    git(root, "checkout", "--quiet", "--orphan", "other");
    writeFiles(root, { "x.ts": "x" });
    commitAll(root);
    expect(await detectChanges(root, "main")).toMatchObject({
      ok: false,
      reason: '"main" and HEAD have no common ancestor',
    });
  });

  it("suggests unshallowing when a shallow clone lacks the merge-base", async () => {
    const origin = gitRepo({ "a.ts": "1" });
    git(origin, "checkout", "--quiet", "-b", "feature");
    for (let index = 0; index < 3; index++) {
      writeFiles(origin, { [`f${index}.ts`]: "x" });
      commitAll(origin);
    }
    git(origin, "checkout", "--quiet", "main");
    writeFiles(origin, { "main.ts": "m" });
    commitAll(origin);

    const parent = tempDir();
    const url = `file://${origin.replace(/\\/g, "/")}`;
    git(parent, "clone", "--quiet", "--depth", "1", "--no-single-branch", url, "clone");
    const clone = path.join(parent, "clone");
    git(clone, "checkout", "--quiet", "feature");

    const detection = await detectChanges(clone, "origin/main");
    expect(detection).toMatchObject({ ok: false, hint: expect.stringContaining("shallow clone") });
  });
});

describe("parseNameStatus", () => {
  it("parses NUL-separated name-status output", () => {
    expect(parseNameStatus("M\0a.ts\0A\0b c.ts\0D\0d.ts\0T\0e\0")).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b c.ts", status: "added" },
      { path: "d.ts", status: "deleted" },
      { path: "e", status: "changed" },
    ]);
  });
});
