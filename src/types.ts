/** A check as declared in verifika.config.json, after validation and defaults. */
export interface CheckConfig {
  name: string;
  command: string;
  /** Include globs. `undefined` means the check is relevant to every changed file. */
  paths: string[] | undefined;
  exclude: string[];
  always: boolean;
  dependsOn: string[];
  timeoutMs: number;
}

export interface VerifikaConfig {
  /** Absolute path of the config file. */
  file: string;
  /** Absolute directory the config lives in. Commands run here; globs are relative to it. */
  root: string;
  concurrency: number;
  timeoutMs: number;
  failFast: boolean;
  keepRuns: number;
  base: string;
  invalidateAll: string[];
  /** Checks in declaration order. */
  checks: CheckConfig[];
}

export type ChangeStatus = "added" | "modified" | "deleted" | "untracked" | "changed";

export interface ChangedFile {
  /** POSIX path relative to the config root. Paths outside the root start with `../`. */
  path: string;
  status: ChangeStatus;
}

export type SelectionMode = "all" | "changed" | "explicit";

export interface ChangeSet {
  /** Ref the user asked to compare against, e.g. `HEAD` or `origin/main`. */
  base: string;
  /** Commit actually diffed against (merge-base of base and HEAD). */
  baseCommit: string;
  files: ChangedFile[];
}

export interface Selection {
  mode: SelectionMode;
  /** Human-readable reason for the mode, e.g. why full verification was chosen. */
  reason: string;
  changes: ChangeSet | null;
  /** The file that triggered `invalidateAll`, if any. */
  invalidatedBy: string | null;
  checks: CheckDecision[];
}

export interface CheckDecision {
  name: string;
  selected: boolean;
  /** Why the check was selected or skipped. */
  reason: string;
  /** Changed files that matched this check's paths (bounded). */
  matchedFiles: string[];
}

export type CheckStatus =
  "passed" | "failed" | "timed_out" | "error" | "blocked" | "cancelled" | "interrupted" | "skipped";

export interface CheckResult {
  name: string;
  command: string;
  selected: boolean;
  status: CheckStatus;
  reason: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  /** Log path relative to the config root, when output was captured. */
  log: string | null;
  /** Short excerpt of failing output, ANSI-stripped and bounded. */
  preview: string[];
  /** Spawn or internal error message. */
  error: string | null;
  /** Non-fatal problem worth surfacing, e.g. a process that outlived the check. */
  warning: string | null;
}

/** `running` is only ever on disk, for a run that has not finished (or crashed). */
export type RunStatus = "running" | "passed" | "failed" | "interrupted";

export interface RunResult {
  schemaVersion: 1;
  tool: { name: "verifika"; version: string };
  runId: string;
  status: RunStatus;
  exitCode: number;
  startedAt: string;
  durationMs: number;
  root: string;
  logsDir: string;
  selection: {
    mode: SelectionMode;
    reason: string;
    base: string | null;
    baseCommit: string | null;
    changedFiles: ChangedFile[];
    invalidatedBy: string | null;
  };
  summary: {
    total: number;
    selected: number;
    passed: number;
    /** Selected checks that failed, timed out or could not start. */
    failed: number;
    /** Selected checks that never ran: blocked, cancelled or interrupted. */
    notRun: number;
    /** Checks not selected for this run. */
    skipped: number;
  };
  checks: CheckResult[];
}
