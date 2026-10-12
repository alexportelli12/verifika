import { spawn } from "node:child_process";
import path from "node:path";
import type { ChangeSet, ChangeStatus, ChangedFile } from "./types.ts";

export type ChangeDetection =
  { ok: true; changes: ChangeSet } | { ok: false; reason: string; hint?: string };

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

class GitUnavailableError extends Error {}

/**
 * Lists files that differ between `base` and the working tree.
 *
 * The comparison point is `git merge-base <base> HEAD`, so `--changed-since
 * origin/main` means "everything this branch changed" and ignores commits that
 * landed on main after the branch point. Staged, unstaged and untracked files
 * are always included. Renames are reported as a deletion plus an addition so
 * both paths take part in check selection.
 *
 * Never throws for repository state problems; callers decide whether an
 * unknown change scope means "run everything" or "fail".
 */
export async function detectChanges(root: string, base: string): Promise<ChangeDetection> {
  if (base.startsWith("-")) {
    return { ok: false, reason: `invalid base ref "${base}"` };
  }
  try {
    const top = await git(root, ["rev-parse", "--show-toplevel", "--show-prefix"]);
    if (top.code !== 0) return { ok: false, reason: "not inside a git repository" };
    const [topLevel = "", prefix = ""] = top.stdout.split(/\r?\n/);

    const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code !== 0) return { ok: false, reason: "the repository has no commits yet" };
    const headSha = head.stdout.trim();

    const shallow =
      (await git(root, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
    const shallowHint = shallow
      ? "This is a shallow clone; fetch more history (for example `git fetch --unshallow`)."
      : undefined;

    const resolved = await git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (resolved.code !== 0) {
      return {
        ok: false,
        reason: `base ref "${base}" does not exist`,
        hint:
          shallowHint ?? "Check the ref name, or fetch it first (for example `git fetch origin`).",
      };
    }
    const baseSha = resolved.stdout.trim();

    let baseCommit = baseSha;
    if (baseSha !== headSha) {
      const mergeBase = await git(root, ["merge-base", baseSha, headSha]);
      if (mergeBase.code !== 0) {
        return {
          ok: false,
          reason: `"${base}" and HEAD have no common ancestor`,
          ...(shallowHint ? { hint: shallowHint } : {}),
        };
      }
      baseCommit = mergeBase.stdout.trim();
    }

    const diff = await git(topLevel, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      baseCommit,
      "--",
    ]);
    if (diff.code !== 0) return { ok: false, reason: `git diff failed: ${firstLine(diff.stderr)}` };

    const untracked = await git(topLevel, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.code !== 0) {
      return { ok: false, reason: `git ls-files failed: ${firstLine(untracked.stderr)}` };
    }

    const files = new Map<string, ChangeStatus>();
    for (const entry of parseNameStatus(diff.stdout)) files.set(entry.path, entry.status);
    for (const file of untracked.stdout.split("\0")) {
      if (file) files.set(file, "untracked");
    }

    const relativePrefix = prefix.replace(/\/$/, "");
    const changed: ChangedFile[] = [...files]
      .map(([file, status]) => ({ path: toRootRelative(file, relativePrefix), status }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return { ok: true, changes: { base, baseCommit, files: changed } };
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return { ok: false, reason: "git is not installed or not on PATH" };
    }
    throw error;
  }
}

/** Parses `git diff --name-status -z --no-renames` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const tokens = output.split("\0");
  const result: ChangedFile[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const code = tokens[index];
    const file = tokens[index + 1];
    if (!code || !file) continue;
    result.push({ path: file, status: statusFor(code) });
  }
  return result;
}

function statusFor(code: string): ChangeStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    default:
      return "changed";
  }
}

/** Git reports paths from the repository top level; checks match relative to the config root. */
export function toRootRelative(file: string, prefix: string): string {
  if (!prefix) return file;
  return path.posix.relative(prefix, file);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // Arguments are passed as an array (no shell), so refs and file names are never interpreted.
    const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new GitUnavailableError(error.message) : error);
    });
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
