import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VerifikaError } from "./errors.ts";
import type { RunResult } from "./types.ts";

export const STATE_DIR = ".verifika";
const RUNS_DIR = "runs";
const RESULT_FILE = "run.json";
/** Present while a run is in progress; names the process that owns it. */
const OWNER_FILE = "owner.json";
const TEMP_PREFIX = ".tmp-";
const RUN_ID_PATTERN = /^\d{8}-\d{6}-\d{3}-[0-9a-f]{6}$/;
/** Owners on another host cannot be checked; trust their runs as active for this long. */
const FOREIGN_OWNER_GRACE_MS = 24 * 60 * 60 * 1000;
/** Half-created run directories older than this were abandoned by a crashed process. */
const ABANDONED_TEMP_MS = 60 * 60 * 1000;

interface Owner {
  pid: number;
  host: string;
  startedAt: string;
}

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
 * Creates a new run directory and returns its id. The directory is assembled
 * under a temporary name (with its initial `run.json` and an owner record) and
 * renamed into place, so other Verifika processes never see a run without them.
 * The state directory ignores itself in git, so logs never count as changes.
 */
export async function createRun(
  root: string,
  initial: (runId: string) => RunResult,
): Promise<string> {
  const stateDir = path.join(root, STATE_DIR);
  const runsDir = path.join(stateDir, RUNS_DIR);
  try {
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      path.join(stateDir, ".gitignore"),
      "# Created by verifika; run logs stay local.\n*\n",
      {
        flag: "wx",
      },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    for (let attempt = 0; ; attempt++) {
      const runId = createRunId();
      const temporary = path.join(runsDir, `${TEMP_PREFIX}${runId}`);
      await mkdir(temporary);
      const owner: Owner = {
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
      };
      await writeFile(path.join(temporary, OWNER_FILE), `${JSON.stringify(owner)}\n`);
      await writeFile(
        path.join(temporary, RESULT_FILE),
        `${JSON.stringify(initial(runId), null, 2)}\n`,
      );
      try {
        await rename(temporary, runDirectory(root, runId));
        return runId;
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (attempt >= 4) throw error;
      }
    }
  } catch (error) {
    throw new VerifikaError(`cannot create a run in ${stateDir}: ${(error as Error).message}`);
  }
}

export async function writeRunResult(root: string, result: RunResult): Promise<void> {
  const directory = runDirectory(root, result.runId);
  // Recreate the directory if something removed it; never lose the final result.
  await mkdir(directory, { recursive: true });
  await writeAtomic(path.join(directory, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
}

/** Marks a run as finished, which makes it eligible for retention. */
export async function releaseRun(root: string, runId: string): Promise<void> {
  await rm(path.join(runDirectory(root, runId), OWNER_FILE), { force: true });
}

/**
 * The most recently started run: the newest run directory. There is no shared
 * pointer to keep in sync, so concurrent invocations cannot leave "latest" on an
 * older run, and it can never name a run that retention has removed (retention
 * always keeps the newest runs). Run directories appear atomically and their ids
 * sort chronologically, so the answer only ever moves forward.
 */
export async function readLatest(root: string): Promise<string | null> {
  try {
    const runs = (await readdir(path.join(root, STATE_DIR, RUNS_DIR)))
      .filter((name) => RUN_ID_PATTERN.test(name))
      .sort();
    return runs.at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keeps the newest `keep` runs, so the latest run is never removed. Never deletes `current` or any run whose
 * owning process is still alive, so concurrent invocations cannot remove each
 * other's logs. Also clears half-created directories abandoned by crashes.
 */
export async function pruneRuns(root: string, keep: number, current: string): Promise<void> {
  const directory = path.join(root, STATE_DIR, RUNS_DIR);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const runs = names.filter((name) => RUN_ID_PATTERN.test(name)).sort();
  // Only ever the oldest runs: the newest `keep` (which include the latest run) always stay.
  const candidates = runs
    .slice(0, Math.max(0, runs.length - keep))
    .filter((name) => name !== current);
  const doomed: string[] = [];
  for (const name of candidates) {
    if (!(await isActiveRun(path.join(directory, name)))) doomed.push(name);
  }
  for (const name of names.filter((entry) => entry.startsWith(TEMP_PREFIX))) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > ABANDONED_TEMP_MS) doomed.push(name);
  }
  await Promise.all(
    doomed.map((name) =>
      rm(path.join(directory, name), { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

async function isActiveRun(directory: string): Promise<boolean> {
  let owner: Owner;
  try {
    owner = JSON.parse(await readFile(path.join(directory, OWNER_FILE), "utf8")) as Owner;
  } catch (error) {
    // No owner record: the run finished (or its directory is unreadable; leave it alone).
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (owner.host !== os.hostname()) {
    return Date.now() - Date.parse(owner.startedAt) < FOREIGN_OWNER_GRACE_MS;
  }
  return isProcessAlive(owner.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readRun(root: string, runId?: string): Promise<RunResult> {
  const id = runId ?? (await readLatest(root));
  if (id === null) {
    throw new VerifikaError("no verification runs recorded yet", "Run `vfk` first.");
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

/** Writes via a uniquely named temporary file and rename, so readers never see partial content. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, content);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file);
      return;
    } catch {
      // Windows refuses to replace a file another process is reading; retry briefly,
      // then write in place rather than lose the content.
      if (attempt >= 9) {
        await writeFile(file, content);
        await rm(temporary, { force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
