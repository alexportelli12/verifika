import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
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

export type ExecOutcome =
  | {
      kind: "exited";
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      preview: string[];
    }
  | { kind: "timed_out"; durationMs: number; preview: string[] }
  | { kind: "aborted"; reason: unknown; durationMs: number; preview: string[] }
  | { kind: "spawn_error"; error: string; durationMs: number; preview: string[] };

const isWindows = process.platform === "win32";
/** Time a terminated process tree gets to exit before it is killed outright. */
const TERMINATE_GRACE_MS = 2_000;
/** Time to wait for output pipes to close after the command itself exited. */
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
 * bounded preview is kept in memory.
 */
export async function execCheck(options: ExecOptions): Promise<ExecOutcome> {
  const started = performance.now();
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

  let timedOut = false;
  let abortReason: unknown;
  let terminating: Promise<void> | null = null;
  const terminate = () => {
    terminating ??= terminateTree(child);
    return terminating;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, options.timeoutMs);
  const onAbort = () => {
    abortReason = options.signal.reason;
    void terminate();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const result = await new Promise<{ code: number | null; signal: string | null; error?: string }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);

  if (result.error === undefined) {
    // The shell has exited, but descendants may still hold the output pipes open.
    // Reap the rest of the process group so nothing outlives the check.
    await drainAndReap(child);
  } else {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  active.delete(child);
  if (terminating) await terminating;
  log.end();
  await logClosed;

  const preview = capture.preview();
  const durationMs = elapsed();
  if (result.error !== undefined)
    return { kind: "spawn_error", error: result.error, durationMs, preview };
  if (timedOut) return { kind: "timed_out", durationMs, preview };
  if (abortReason !== undefined)
    return { kind: "aborted", reason: abortReason, durationMs, preview };
  return { kind: "exited", exitCode: result.code, signal: result.signal, durationMs, preview };
}

async function drainAndReap(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    if (child.stdout?.closed !== false && child.stderr?.closed !== false) resolve();
    else child.once("close", () => resolve());
  });
  if (!isWindows) signalGroup(child, "SIGTERM");
  if (await settlesWithin(closed, PIPE_DRAIN_MS)) return;
  if (!isWindows) signalGroup(child, "SIGKILL");
  if (await settlesWithin(closed, PIPE_DRAIN_MS)) return;
  // Something outside our process group still holds the pipes; stop reading them.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function terminateTree(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await killTree(child, false);
  if (await settlesWithin(exited, TERMINATE_GRACE_MS)) return;
  await killTree(child, true);
}

async function killTree(child: ChildProcess, force: boolean): Promise<void> {
  if (child.pid === undefined) return;
  if (isWindows) {
    // taskkill /T walks the tree from the shell process; /F is required for console apps.
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  signalGroup(child, force ? "SIGKILL" : "SIGTERM");
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
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
