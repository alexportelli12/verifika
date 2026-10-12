import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { VerifikaError } from "./errors.ts";
import type { RunResult } from "./types.ts";

export const STATE_DIR = ".verifika";
const RUNS_DIR = "runs";
const LATEST_FILE = "latest";
const RESULT_FILE = "run.json";
const RUN_ID_PATTERN = /^\d{8}-\d{6}-\d{3}-[0-9a-f]{6}$/;

/**
 * Unique run identifier that sorts chronologically to the millisecond, e.g.
 * `20261012-143955-042-a1b2c3` (UTC). Retention relies on that ordering.
 */
export function createRunId(now = new Date()): string {
  const iso = now.toISOString(); // 2026-10-12T14:39:55.042Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function runDirectory(root: string, runId: string): string {
  return path.join(root, STATE_DIR, RUNS_DIR, runId);
}

/** Log path for a check, relative to the config root with forward slashes. */
export function logPath(runId: string, check: string): string {
  return `${STATE_DIR}/${RUNS_DIR}/${runId}/${check}.log`;
}

/**
 * Creates the run directory and makes the state directory self-ignoring, so
 * Verifika never needs an entry in the repository's own .gitignore and its
 * logs never show up as changed files.
 */
export async function prepareRun(root: string, runId: string): Promise<string> {
  const stateDir = path.join(root, STATE_DIR);
  const directory = runDirectory(root, runId);
  try {
    await mkdir(directory, { recursive: true });
    const ignore = path.join(stateDir, ".gitignore");
    if (!existsSync(ignore))
      await writeFile(ignore, "# Created by verifika; run logs stay local.\n*\n");
  } catch (error) {
    throw new VerifikaError(`cannot create ${STATE_DIR}/ in ${root}: ${(error as Error).message}`);
  }
  return directory;
}

export async function writeRunResult(root: string, result: RunResult): Promise<void> {
  const directory = runDirectory(root, result.runId);
  await writeAtomic(path.join(directory, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
}

export async function markLatest(root: string, runId: string): Promise<void> {
  await writeAtomic(path.join(root, STATE_DIR, LATEST_FILE), `${runId}\n`);
}

/** Runs younger than this that are still `running` belong to a concurrent process; never prune them. */
const ACTIVE_RUN_GRACE_MS = 6 * 60 * 60 * 1000;

/** Keeps the newest `keep` runs, never deleting `current` or another run still in progress. */
export async function pruneRuns(root: string, keep: number, current: string): Promise<void> {
  const directory = path.join(root, STATE_DIR, RUNS_DIR);
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((name) => RUN_ID_PATTERN.test(name)).sort();
  } catch {
    return;
  }
  const candidates = entries
    .filter((name) => name !== current)
    .slice(0, Math.max(0, entries.length - keep));
  const excess: string[] = [];
  for (const name of candidates) {
    if (!(await isActiveRun(path.join(directory, name)))) excess.push(name);
  }
  await Promise.all(
    excess.map((name) =>
      rm(path.join(directory, name), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

async function isActiveRun(directory: string): Promise<boolean> {
  try {
    const run = JSON.parse(await readFile(path.join(directory, RESULT_FILE), "utf8")) as RunResult;
    return run.status === "running" && Date.now() - Date.parse(run.startedAt) < ACTIVE_RUN_GRACE_MS;
  } catch {
    return false;
  }
}

export async function readRun(root: string, runId?: string): Promise<RunResult> {
  let id = runId;
  if (id === undefined) {
    try {
      id = (await readFile(path.join(root, STATE_DIR, LATEST_FILE), "utf8")).trim();
    } catch {
      throw new VerifikaError("no verification runs recorded yet", "Run `verifika` first.");
    }
  }
  if (!RUN_ID_PATTERN.test(id)) throw new VerifikaError(`invalid run id "${id}"`);
  try {
    return JSON.parse(
      await readFile(path.join(runDirectory(root, id), RESULT_FILE), "utf8"),
    ) as RunResult;
  } catch {
    throw new VerifikaError(
      `run ${id} not found`,
      "It may have been pruned; older runs are removed automatically.",
    );
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, content);
  try {
    await rename(temporary, file);
  } catch {
    // Windows refuses to replace a file another process has open; fall back to a plain write.
    await writeFile(file, content);
    await rm(temporary, { force: true });
  }
}
