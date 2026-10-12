import { detectCi } from "./ci.ts";
import { VerifikaError } from "./errors.ts";
import { detectChanges, type ChangeDetection } from "./git.ts";
import { compileGlobs } from "./glob.ts";
import type { ChangeSet, CheckConfig, CheckDecision, Selection, VerifikaConfig } from "./types.ts";

export interface PlanRequest {
  /** Run every check. */
  all?: boolean;
  /** Run exactly these checks (plus their dependencies). */
  checks?: string[];
  /** Run selectively against the configured base, even in CI. */
  changed?: boolean;
  /** Run selectively against this ref, even in CI. */
  changedSince?: string;
  env?: NodeJS.ProcessEnv;
}

export type DetectChanges = (root: string, base: string) => Promise<ChangeDetection>;

const MAX_MATCHED_FILES = 10;

/**
 * Decides which checks run and records why. Selection is conservative: when the
 * change scope cannot be determined it either runs everything (implicit
 * selective runs) or fails (explicitly requested selective runs). It never
 * quietly narrows the run.
 */
export async function plan(
  config: VerifikaConfig,
  request: PlanRequest = {},
  detect: DetectChanges = detectChanges,
): Promise<Selection> {
  const requested = [
    request.all === true,
    request.checks !== undefined,
    request.changed === true,
    request.changedSince !== undefined,
  ];
  if (requested.filter(Boolean).length > 1) {
    throw new VerifikaError("use only one of --all, --check, --changed and --changed-since");
  }

  if (request.checks !== undefined) {
    if (request.checks.length === 0)
      throw new VerifikaError("--check needs at least one check name");
    return explicitSelection(config, request.checks);
  }
  if (request.changedSince !== undefined && request.changedSince.trim() === "") {
    throw new VerifikaError("--changed-since needs a git ref, for example origin/main");
  }
  if (request.all) return fullSelection(config, "--all", null);

  const explicitSelective = request.changed === true || request.changedSince !== undefined;
  const ci = detectCi(request.env ?? process.env);
  if (ci.ci && !explicitSelective) {
    return fullSelection(config, `CI detected via ${ci.source}`, null);
  }

  const base = request.changedSince ?? config.base;
  const detection = await detect(config.root, base);
  if (!detection.ok) {
    if (explicitSelective)
      throw new VerifikaError(`cannot determine changes: ${detection.reason}`, detection.hint);
    return fullSelection(config, `change detection unavailable: ${detection.reason}`, null);
  }
  const selection = changedSelection(config, detection.changes);
  // Make a deliberately narrowed CI run visible in every output mode.
  return ci.ci
    ? { ...selection, reason: `${selection.reason}; selective in CI by request` }
    : selection;
}

function explicitSelection(config: VerifikaConfig, names: string[]): Selection {
  const known = new Set(config.checks.map((check) => check.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new VerifikaError(
      `unknown check${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      `Available checks: ${[...known].join(", ")}`,
    );
  }
  const decisions = new Map<string, CheckDecision>();
  for (const name of names) {
    decisions.set(name, {
      name,
      selected: true,
      reason: "requested with --check",
      matchedFiles: [],
    });
  }
  return {
    mode: "explicit",
    reason: `--check ${[...new Set(names)].join(", ")}`,
    changes: null,
    invalidatedBy: null,
    checks: finalize(config, decisions, "not requested"),
  };
}

function fullSelection(
  config: VerifikaConfig,
  reason: string,
  changes: ChangeSet | null,
): Selection {
  return {
    mode: "all",
    reason,
    changes,
    invalidatedBy: null,
    checks: config.checks.map((check) => ({
      name: check.name,
      selected: true,
      reason: "full verification",
      matchedFiles: [],
    })),
  };
}

function changedSelection(config: VerifikaConfig, changes: ChangeSet): Selection {
  const files = changes.files.map((file) => file.path);
  const count =
    files.length === 0 ? "no files" : `${files.length} file${files.length === 1 ? "" : "s"}`;
  const summary = `${count} changed since ${describeBase(changes)}`;

  const invalidates = compileGlobs(config.invalidateAll);
  const invalidatedBy = files.find((file) => invalidates(file)) ?? null;
  if (invalidatedBy) {
    return {
      mode: "changed",
      reason: `${summary}; ${invalidatedBy} invalidates all checks`,
      changes,
      invalidatedBy,
      checks: config.checks.map((check) => ({
        name: check.name,
        selected: true,
        reason: `${invalidatedBy} invalidates all checks`,
        matchedFiles: [invalidatedBy],
      })),
    };
  }

  const decisions = new Map<string, CheckDecision>();
  for (const check of config.checks) {
    const decision = decideByPaths(check, files);
    if (decision) decisions.set(check.name, decision);
  }
  return {
    mode: "changed",
    reason: summary,
    changes,
    invalidatedBy: null,
    checks: finalize(
      config,
      decisions,
      files.length === 0 ? "no changed files" : "no matching changes",
    ),
  };
}

function decideByPaths(check: CheckConfig, files: string[]): CheckDecision | null {
  if (check.always) {
    return { name: check.name, selected: true, reason: "always runs", matchedFiles: [] };
  }
  const include = check.paths ? compileGlobs(check.paths) : () => true;
  const exclude = compileGlobs(check.exclude);
  const matched = files.filter((file) => include(file) && !exclude(file));
  if (matched.length === 0) return null;
  const [first] = matched;
  const more = matched.length > 1 ? ` (+${matched.length - 1} more)` : "";
  return {
    name: check.name,
    selected: true,
    reason: check.paths
      ? `matched ${first}${more}`
      : `no path filter; ${matched.length} changed file${matched.length === 1 ? "" : "s"}`,
    matchedFiles: matched.slice(0, MAX_MATCHED_FILES),
  };
}

/** Adds dependencies of selected checks, then emits decisions in config order. */
function finalize(
  config: VerifikaConfig,
  decisions: Map<string, CheckDecision>,
  skipReason: string,
): CheckDecision[] {
  const byName = new Map(config.checks.map((check) => [check.name, check]));
  const pending = [...decisions.keys()];
  while (pending.length > 0) {
    const name = pending.shift() as string;
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      if (decisions.has(dependency)) continue;
      decisions.set(dependency, {
        name: dependency,
        selected: true,
        reason: `required by ${name}`,
        matchedFiles: [],
      });
      pending.push(dependency);
    }
  }
  return config.checks.map(
    (check) =>
      decisions.get(check.name) ?? {
        name: check.name,
        selected: false,
        reason: skipReason,
        matchedFiles: [],
      },
  );
}

export function describeBase(changes: ChangeSet): string {
  const short = changes.baseCommit.slice(0, 7);
  return changes.base === "HEAD" ? `HEAD (${short})` : `${changes.base} (merge-base ${short})`;
}
