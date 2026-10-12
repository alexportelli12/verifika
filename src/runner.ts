import { constants } from "node:os";
import path from "node:path";
import { formatSeconds } from "./format.ts";
import { execCheck, type ExecOutcome } from "./process.ts";
import type { Reporter } from "./reporters/reporter.ts";
import { createRunId, logPath, markLatest, prepareRun, pruneRuns, writeRunResult } from "./runs.ts";
import { schedule, type StopReason, type TaskOutcome } from "./scheduler.ts";
import type {
  CheckConfig,
  CheckResult,
  RunResult,
  RunStatus,
  Selection,
  VerifikaConfig,
} from "./types.ts";

export interface RunOptions {
  config: VerifikaConfig;
  selection: Selection;
  concurrency: number;
  failFast: boolean;
  previewLines: number;
  /** Aborted with the signal name (e.g. "SIGINT") when the user interrupts. */
  signal: AbortSignal;
  reporter: Reporter;
  version: string;
  env?: NodeJS.ProcessEnv;
}

export async function runVerification(options: RunOptions): Promise<RunResult> {
  const { config, selection, reporter } = options;
  const started = performance.now();
  const runId = createRunId();
  const root = config.root;
  await prepareRun(root, runId);

  const byName = new Map(config.checks.map((check) => [check.name, check]));
  const results = new Map<string, CheckResult>(
    selection.checks.map((decision) => {
      const check = byName.get(decision.name) as CheckConfig;
      return [decision.name, initialResult(check, decision.selected, decision.reason)];
    }),
  );

  const result: RunResult = {
    schemaVersion: 1,
    tool: { name: "verifika", version: options.version },
    runId,
    status: "running",
    exitCode: 1,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    root,
    logsDir: path.posix.dirname(logPath(runId, "x")),
    selection: {
      mode: selection.mode,
      reason: selection.reason,
      base: selection.changes?.base ?? null,
      baseCommit: selection.changes?.baseCommit ?? null,
      changedFiles: selection.changes?.files ?? [],
      invalidatedBy: selection.invalidatedBy,
    },
    summary: { total: 0, selected: 0, passed: 0, failed: 0, notRun: 0, skipped: 0 },
    checks: [],
  };
  const snapshot = (): RunResult => ({
    ...result,
    checks: [...results.values()],
    summary: summarize([...results.values()]),
  });

  // Record the run before anything executes, so `verifika logs` never shows a stale
  // earlier run as "latest" if this one is killed.
  await writeRunResult(root, snapshot());
  await markLatest(root, runId);
  await pruneRuns(root, config.keepRuns, runId);

  const selected = config.checks.filter((check) => results.get(check.name)?.selected);
  reporter.onStart?.({
    runId,
    selection,
    selected: selected.map((check) => check.name),
    concurrency: options.concurrency,
  });

  const env = { ...(options.env ?? process.env), VERIFIKA: "1", VERIFIKA_RUN_ID: runId };
  let firstFailure: string | null = null;
  const outcomes = await schedule(
    selected,
    { concurrency: options.concurrency, failFast: options.failFast, signal: options.signal },
    async (task, signal) => {
      const check = byName.get(task.name) as CheckConfig;
      reporter.onCheckStart?.(check.name);
      const log = logPath(runId, check.name);
      const outcome = await execCheck({
        command: check.command,
        cwd: root,
        env: { ...env, VERIFIKA_CHECK: check.name },
        timeoutMs: check.timeoutMs,
        logFile: path.join(root, log),
        previewLines: options.previewLines,
        signal,
      });
      const checkResult = completedResult(
        results.get(check.name) as CheckResult,
        check,
        outcome,
        log,
      );
      results.set(check.name, checkResult);
      reporter.onCheckEnd?.(checkResult);
      const passed = checkResult.status === "passed";
      if (!passed && isFailure(checkResult.status)) firstFailure ??= check.name;
      return passed;
    },
  );

  const interrupted = options.signal.aborted;
  for (const [name, outcome] of outcomes) {
    const updated = notRunResult(
      results.get(name) as CheckResult,
      outcome,
      interrupted,
      firstFailure,
    );
    if (updated) results.set(name, updated);
  }

  const checks = [...results.values()];
  const status: RunStatus = interrupted
    ? "interrupted"
    : checks.every((check) => !check.selected || check.status === "passed")
      ? "passed"
      : "failed";
  const final: RunResult = {
    ...result,
    status,
    exitCode:
      status === "passed" ? 0 : status === "failed" ? 1 : signalExitCode(options.signal.reason),
    durationMs: Math.round(performance.now() - started),
    checks,
    summary: summarize(checks),
  };
  await writeRunResult(root, final);
  reporter.onFinish(final);
  return final;
}

function initialResult(check: CheckConfig, selected: boolean, reason: string): CheckResult {
  return {
    name: check.name,
    command: check.command,
    selected,
    status: selected ? "interrupted" : "skipped",
    reason: selected ? "did not finish" : reason,
    exitCode: null,
    signal: null,
    durationMs: null,
    log: null,
    preview: [],
    error: null,
    warning: null,
  };
}

function completedResult(
  base: CheckResult,
  check: CheckConfig,
  outcome: ExecOutcome,
  log: string,
): CheckResult {
  const common = {
    ...base,
    durationMs: outcome.durationMs,
    log,
    preview: outcome.preview,
    warning: outcome.warning ?? null,
  };
  switch (outcome.kind) {
    case "exited":
      if (outcome.exitCode === 0)
        return { ...common, status: "passed", reason: "exit 0", exitCode: 0, preview: [] };
      return {
        ...common,
        status: "failed",
        reason: outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.exitCode}`,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      };
    case "timed_out":
      return {
        ...common,
        status: "timed_out",
        reason: `timed out after ${formatSeconds(check.timeoutMs)}`,
      };
    case "spawn_error":
      return { ...common, status: "error", reason: "could not start", error: outcome.error };
    case "aborted": {
      const stop = outcome.reason as StopReason | undefined;
      return stop?.kind === "fail-fast"
        ? {
            ...common,
            status: "cancelled",
            reason: `cancelled after ${stop.failed} failed (fail-fast)`,
          }
        : { ...common, status: "interrupted", reason: "interrupted" };
    }
  }
}

function notRunResult(
  base: CheckResult,
  outcome: TaskOutcome,
  interrupted: boolean,
  firstFailure: string | null,
): CheckResult | null {
  if (outcome.state === "blocked") {
    return { ...base, status: "blocked", reason: `dependency ${outcome.dependency} did not pass` };
  }
  if (outcome.state !== "not_started") return null;
  if (interrupted)
    return { ...base, status: "interrupted", reason: "run interrupted before it started" };
  return {
    ...base,
    status: "cancelled",
    reason: firstFailure ? `not started: ${firstFailure} failed (fail-fast)` : "not started",
  };
}

function isFailure(status: CheckResult["status"]): boolean {
  return status === "failed" || status === "timed_out" || status === "error";
}

export function summarize(checks: CheckResult[]): RunResult["summary"] {
  const selected = checks.filter((check) => check.selected);
  return {
    total: checks.length,
    selected: selected.length,
    passed: selected.filter((check) => check.status === "passed").length,
    failed: selected.filter((check) => isFailure(check.status)).length,
    notRun: selected.filter((check) =>
      ["blocked", "cancelled", "interrupted"].includes(check.status),
    ).length,
    skipped: checks.length - selected.length,
  };
}

/** Conventional shell exit code for death by signal: 128 + signal number. */
export function signalExitCode(reason: unknown): number {
  const signals = constants.signals as Record<string, number | undefined>;
  const number = typeof reason === "string" ? signals[reason] : undefined;
  return 128 + (number ?? constants.signals.SIGINT);
}
