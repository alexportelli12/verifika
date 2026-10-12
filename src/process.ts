import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, readdirSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { OutputCapture } from "./preview.ts";

export interface ExecOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  logFile: string;
  previewLines: number;
  /** Aborting terminates the process tree; `signal.reason` is reported back. */
  signal: AbortSignal;
}

export type ExecOutcome = (
  | {
      kind: "exited";
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      preview: string[];
    }
  | { kind: "timed_out"; durationMs: number; preview: string[] }
  | { kind: "aborted"; reason: unknown; durationMs: number; preview: string[] }
  | { kind: "spawn_error"; error: string; durationMs: number; preview: string[] }
) & {
  /**
   * Set when processes started by the check could not be confirmed terminated.
   * The run must not count such a check as passed.
   */
  cleanupError?: string;
};

const isWindows = process.platform === "win32";
/** Time a terminated process tree gets to exit before it is killed outright. */
const TERMINATE_GRACE_MS = 2_000;
/** Time a killed process gets to disappear before Verifika stops waiting for it. */
const KILL_WAIT_MS = 5_000;
/** Time to wait for output pipes to close once the check's processes are gone. */
const PIPE_DRAIN_MS = 2_000;

const active = new Set<ChildProcess>();

/** Kills every running check immediately. Used when the user interrupts twice. */
export function killAllNow(): void {
  for (const child of active) void killTree(child, true);
}

/**
 * Runs one configured command through the platform shell. The command string is
 * trusted repository configuration; nothing else (file names, refs) is ever
 * interpolated into it.
 *
 * Output from stdout and stderr is streamed straight to `logFile`; only a small
 * bounded preview is kept in memory. After the command exits, any processes it
 * left behind are terminated; if that cannot be confirmed, `cleanupError` is set.
 */
export async function execCheck(options: ExecOptions): Promise<ExecOutcome> {
  const started = performance.now();
  const spawnedAt = Date.now();
  const elapsed = () => Math.round(performance.now() - started);
  const capture = new OutputCapture(options.previewLines);
  const log = createWriteStream(options.logFile);
  const logClosed = new Promise<void>((resolve) => {
    log.once("close", resolve);
    log.once("error", () => resolve());
  });

  if (options.signal.aborted) {
    log.end();
    await logClosed;
    return { kind: "aborted", reason: options.signal.reason, durationMs: 0, preview: [] };
  }

  let child: ChildProcess;
  try {
    child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on POSIX so the whole tree can be signalled together.
      detached: !isWindows,
      windowsHide: true,
    });
  } catch (error) {
    log.end();
    await logClosed;
    return {
      kind: "spawn_error",
      error: (error as Error).message,
      durationMs: elapsed(),
      preview: [],
    };
  }
  active.add(child);

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const decoder = new StringDecoder("utf8");
    stream.pipe(log, { end: false });
    stream.on("data", (chunk: Buffer) => capture.write(stream, decoder.write(chunk)));
    stream.on("end", () => capture.write(stream, decoder.end() + "\n"));
  }

  type Result = { code: number | null; signal: string | null; error?: string; stuck?: boolean };
  let giveUp: (result: Result) => void = () => undefined;
  const resultPromise = new Promise<Result>((resolve) => {
    giveUp = resolve;
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let timedOut = false;
  let abortReason: unknown;
  let terminating: Promise<void> | null = null;
  const terminate = () => {
    terminating ??= terminateTree(child).then((exited) => {
      // Never hang the run on a process that survives SIGKILL (e.g. stuck in the kernel).
      if (!exited) giveUp({ code: null, signal: null, stuck: true });
    });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  const onAbort = () => {
    abortReason = options.signal.reason;
    terminate();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const result = await resultPromise;
  clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);

  let cleanupError: string | undefined;
  if (result.error !== undefined) {
    destroyOutput(child);
  } else if (result.stuck) {
    destroyOutput(child);
    cleanupError = "the command did not exit after being killed";
  } else {
    cleanupError = await reapLeftovers(child, spawnedAt);
  }
  active.delete(child);
  if (terminating) await terminating;
  log.end();
  await logClosed;

  const preview = capture.preview();
  const durationMs = elapsed();
  const extra = cleanupError ? { cleanupError } : {};
  if (result.error !== undefined)
    return { kind: "spawn_error", error: result.error, durationMs, preview };
  if (timedOut) return { kind: "timed_out", durationMs, preview, ...extra };
  if (abortReason !== undefined)
    return { kind: "aborted", reason: abortReason, durationMs, preview, ...extra };
  return {
    kind: "exited",
    exitCode: result.code,
    signal: result.signal,
    durationMs,
    preview,
    ...extra,
  };
}

/**
 * Terminates whatever the check left running after its main process exited and
 * waits for its output pipes to close. Returns a description of what could not
 * be cleaned up, or undefined when everything is confirmed gone.
 *
 * POSIX: every check runs in its own process group, so the group is signalled
 * (SIGTERM, then SIGKILL) until it no longer exists. Windows: the tree cannot be
 * walked from an exited root with taskkill, so descendants are found by parent
 * process id and creation time, and killed.
 */
async function reapLeftovers(child: ChildProcess, spawnedAt: number): Promise<string | undefined> {
  const closed = outputClosed(child);
  let failure: string | undefined;
  if (child.pid !== undefined) {
    if (isWindows) {
      try {
        failure = await killWindowsDescendants(child.pid, spawnedAt);
      } catch (error) {
        failure = `could not inspect the process tree: ${(error as Error).message}`;
      }
    } else if (!(await stopGroup(child.pid))) {
      failure = "processes in the check's process group survived SIGKILL";
    }
  }
  if (!(await settlesWithin(closed, PIPE_DRAIN_MS))) {
    destroyOutput(child);
    failure ??= isWindows
      ? "a process kept the check's output open and could not be stopped"
      : "a process outside the check's process group (for example started with setsid) kept its output open";
  }
  return failure;
}

/** Terminates a still-running check. Resolves to whether its main process exited. */
async function terminateTree(child: ChildProcess): Promise<boolean> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await killTree(child, false);
  if (await settlesWithin(exited, TERMINATE_GRACE_MS)) return true;
  await killTree(child, true);
  return settlesWithin(exited, KILL_WAIT_MS);
}

async function killTree(child: ChildProcess, force: boolean): Promise<void> {
  if (child.pid === undefined) return;
  // taskkill /T walks the tree from a live root; /F is required for console apps.
  if (isWindows) await taskkill([child.pid]);
  else signalGroup(child.pid, force ? "SIGKILL" : "SIGTERM");
}

/** SIGTERM, then SIGKILL, until the process group is gone. Resolves to whether it is. */
async function stopGroup(pid: number): Promise<boolean> {
  if (!groupExists(pid)) return true;
  signalGroup(pid, "SIGTERM");
  if (await waitUntil(() => !groupExists(pid), TERMINATE_GRACE_MS)) return true;
  signalGroup(pid, "SIGKILL");
  return waitUntil(() => !groupExists(pid), KILL_WAIT_MS);
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // kill() also succeeds for zombies. Under a PID 1 that never reaps (Docker without
  // --init, CI container jobs) a killed leftover stays a zombie forever; it is dead,
  // so on Linux the group only counts as alive if a member is not a zombie.
  return process.platform === "linux" ? hasLiveMember(pgid) : true;
}

function hasLiveMember(pgid: number): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return true;
  }
  let members = 0;
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Format: pid (comm) state ppid pgrp ...; comm may itself contain spaces or ")".
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) !== pgid) continue;
      if (state !== "Z") return true;
      members++;
    } catch {
      // The process exited while scanning.
    }
  }
  // Only conclude "all zombies" from positive evidence. If /proc shows no member
  // even though kill() found the group (a /proc from another PID namespace, or a
  // sandbox that hides processes), trust kill() and keep treating it as alive.
  return members === 0;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

export interface ProcessEntry {
  pid: number;
  parentPid: number;
  createdAt: number;
}

/**
 * Processes descending from the check's exited root process. Windows does not
 * reparent orphans, so leftovers still name their exited parent, but process ids
 * are reused. A process only counts as a descendant if it was created after its
 * parent, and a child of the root's id only if no current holder of that id
 * (which must be a newer, unrelated process: the root has exited) predates it.
 */
export function descendantsOf(
  table: ProcessEntry[],
  root: number,
  rootCreatedAt: number,
): ProcessEntry[] {
  const found: ProcessEntry[] = [];
  const reusedRoot = table.find((entry) => entry.pid === root);
  const queue: ProcessEntry[] = [{ pid: root, parentPid: -1, createdAt: rootCreatedAt }];
  while (queue.length > 0) {
    const parent = queue.shift() as ProcessEntry;
    const isRoot = parent.pid === root && parent.createdAt === rootCreatedAt;
    for (const entry of table) {
      if (entry.parentPid !== parent.pid || entry.createdAt < parent.createdAt) continue;
      if (isRoot && reusedRoot && entry.createdAt >= reusedRoot.createdAt) continue;
      if (entry.pid === root || found.some((known) => known.pid === entry.pid)) continue;
      found.push(entry);
      queue.push(entry);
    }
  }
  return found;
}

/** Kills the check's leftover descendants and confirms they are gone. */
async function killWindowsDescendants(
  rootPid: number,
  spawnedAt: number,
): Promise<string | undefined> {
  // A small allowance for the gap between Date.now() and the OS creation timestamp.
  const victims = descendantsOf(await windowsProcessTable(), rootPid, spawnedAt - 100);
  if (victims.length === 0) return undefined;
  await taskkill(victims.map((victim) => victim.pid));
  const deadline = Date.now() + KILL_WAIT_MS;
  for (;;) {
    const table = await windowsProcessTable();
    // Same pid and creation time: the very process we tried to kill is still there.
    const survivors = victims.filter((victim) =>
      table.some((entry) => entry.pid === victim.pid && entry.createdAt === victim.createdAt),
    );
    if (survivors.length === 0) return undefined;
    if (Date.now() >= deadline) {
      return `processes ${survivors.map((victim) => victim.pid).join(", ")} survived taskkill`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const WINDOWS_PROCESS_QUERY =
  "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f " +
  "$_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }";
/** Milliseconds between the Windows FILETIME epoch (1601) and the Unix epoch. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

function windowsProcessTable(): Promise<ProcessEntry[]> {
  // -EncodedCommand avoids every quoting question between Node and PowerShell.
  const encoded = Buffer.from(WINDOWS_PROCESS_QUERY, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const query = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 30_000 },
    );
    const chunks: Buffer[] = [];
    query.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    query.once("error", reject);
    query.once("close", (code) => {
      if (code !== 0) return reject(new Error(`process query exited with ${code}`));
      const entries: ProcessEntry[] = [];
      for (const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) {
        const [pid, parentPid, filetime] = line.trim().split(" ");
        if (!pid || !parentPid || !filetime || !/^\d+$/.test(filetime)) continue;
        const createdAt = Number(BigInt(filetime) / 10_000n) - FILETIME_EPOCH_OFFSET_MS;
        entries.push({ pid: Number(pid), parentPid: Number(parentPid), createdAt });
      }
      resolve(entries);
    });
  });
}

function taskkill(pids: number[]): Promise<void> {
  return new Promise((resolve) => {
    const args = [...pids.flatMap((pid) => ["/PID", String(pid)]), "/T", "/F"];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 30_000 });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

function outputClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.stdout?.closed !== false && child.stderr?.closed !== false) resolve();
    else child.once("close", () => resolve());
  });
}

function destroyOutput(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}
