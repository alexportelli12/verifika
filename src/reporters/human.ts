import { formatSeconds } from "../format.ts";
import type { CheckResult, CheckStatus, RunResult } from "../types.ts";
import {
  describeProblem,
  duration,
  isFailureStatus,
  logsHint,
  previewDecider,
  problems,
  selectionLabel,
  type Output,
  type Reporter,
  type StartInfo,
} from "./reporter.ts";

export interface Style {
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const wrap = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;
export const colors: Style = {
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
};
const identity = (text: string) => text;
export const plain: Style = {
  green: identity,
  red: identity,
  yellow: identity,
  dim: identity,
  bold: identity,
};

/** How often to remind the user which checks are still running. */
const HEARTBEAT_MS = 30_000;

/** Estimated time saved by skipping checks, from their durations in earlier runs. */
export interface SkipEstimate {
  /** Sum of the last recorded durations of skipped checks that have one. */
  knownMs: number;
  /** Skipped checks with no recorded duration. */
  unknown: number;
}

export interface HumanOptions {
  heartbeat?: boolean;
  skipEstimate?: SkipEstimate;
}

/**
 * Line-based progress for people: one line when a check starts and one when it
 * ends, a periodic note while long checks run, then a summary. No cursor
 * movement, so it reads the same in terminals, logs and CI.
 */
export function humanReporter(output: Output, style: Style, options: HumanOptions = {}): Reporter {
  const running = new Map<string, number>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let width = 0;

  return {
    onStart(info) {
      output.out(renderStart(info, style, options.skipEstimate));
      width = nameWidth(info.selected);
      if (info.selected.length === 0) return;
      if (options.heartbeat) {
        heartbeat = setInterval(() => {
          if (running.size === 0) return;
          const now = performance.now();
          const list = [...running]
            .map(([name, since]) => `${name} ${duration(now - since)}`)
            .join(", ");
          output.out(style.dim(`… running: ${list}\n`));
        }, HEARTBEAT_MS);
        heartbeat.unref();
      }
    },
    onCheckStart(name) {
      running.set(name, performance.now());
      output.out(style.dim(`▸ ${name}\n`));
    },
    onCheckEnd(check) {
      running.delete(check.name);
      output.out(renderCheckEnd(check, style, width));
    },
    onFinish(result) {
      if (heartbeat) clearInterval(heartbeat);
      output.out(renderSummary(result, style));
    },
  };
}

export function nameWidth(names: string[]): number {
  return Math.max(0, ...names.map((name) => name.length));
}

/**
 * The run header (`verifika · <selection> · <n> checks · <j> parallel`), then
 * the skipped checks with the time skipping them saved.
 */
export function renderStart(
  { selection, selected, concurrency }: StartInfo,
  style: Style,
  estimate?: SkipEstimate,
): string {
  const header = [style.bold("verifika"), selectionLabel(selection, 0)];
  header.push(`${selected.length} check${selected.length === 1 ? "" : "s"}`);
  if (selected.length > 0) header.push(`${concurrency} parallel`);
  let text = `${header.join(" · ")}\n`;
  const skipped = selection.checks.filter((check) => !check.selected).map((check) => check.name);
  if (skipped.length > 0) {
    text += style.dim(
      `${skipped.length} skipped${savedNote(skipped.length, estimate)}: ${skipped.join(", ")}\n`,
    );
  }
  if (selected.length === 0) {
    text += style.dim("Nothing to verify for these changes. Full run: vfk --all\n");
  }
  return text;
}

/** ` (~40s saved)`, ` (≥40s saved)` when some durations are unknown, or nothing when none are known. */
function savedNote(skipped: number, estimate: SkipEstimate | undefined): string {
  if (!estimate || estimate.unknown >= skipped) return "";
  return ` (${estimate.unknown > 0 ? "≥" : "~"}${formatSeconds(estimate.knownMs)} saved)`;
}

/** The permanent line printed when a check finishes; durations line up in a column. */
export function renderCheckEnd(check: CheckResult, style: Style, width = 0): string {
  const time = style.dim(duration(check.durationMs).padStart(5));
  const detail = check.status === "passed" ? "" : `  ${describeProblem(check)}`;
  return `${symbol(check.status, style)} ${check.name.padEnd(width)} ${time}${detail}\n`;
}

export function renderSummary(result: RunResult, style: Style): string {
  const { summary } = result;
  const lines: string[] = [];
  const failing = problems(result);
  const decide = previewDecider(result);
  const width = nameWidth(failing.map((check) => check.name));
  if (failing.length > 0) lines.push("");
  for (const check of failing) {
    const name = check.name.padEnd(width);
    if (check.status === "blocked") {
      lines.push(
        style.dim(`${symbol(check.status, plain)} ${name}  ${blockedReason(check, result)}`),
      );
      continue;
    }
    if (!isFailureStatus(check.status)) {
      lines.push(`${symbol(check.status, style)} ${name}  ${describeProblem(check)}`);
      continue;
    }
    const preview = decide(check);
    const rerun = `rerun: vfk -c ${check.name}`;
    lines.push(
      `${symbol(check.status, style)} ${style.bold(name)}  ${check.command} → ${describeProblem(check)}${style.dim(` · ${rerun}${preview.note}`)}`,
    );
    if (preview.show) lines.push(...check.preview.map((line) => style.dim(`    ${line}`)));
  }
  const time = duration(result.durationMs);
  if (result.status === "passed") {
    lines.push(style.green(`✓ ${summary.passed} of ${summary.selected} checks passed (${time})`));
  } else {
    const what = result.status === "interrupted" ? "interrupted" : "failed";
    lines.push(
      style.red(
        `✗ verification ${what}: ${summary.passed} of ${summary.selected} checks passed (${time})`,
      ),
    );
  }
  const hint = logsHint(result);
  if (hint) lines.push(style.dim(`Logs: ${hint}`));
  return `${lines.join("\n")}\n`;
}

/** `not run: build failed`, naming what happened to the dependency that blocked the check. */
function blockedReason(check: CheckResult, result: RunResult): string {
  const dependency = result.checks.find((other) => other.name === check.blockedBy);
  if (!dependency) return `not run: ${check.reason}`;
  const outcome =
    dependency.status === "timed_out"
      ? "timed out"
      : isFailureStatus(dependency.status)
        ? "failed"
        : "did not run";
  return `not run: ${dependency.name} ${outcome}`;
}

export function symbol(status: CheckStatus, style: Style): string {
  switch (status) {
    case "passed":
      return style.green("✓");
    case "failed":
    case "timed_out":
    case "error":
      return style.red("✗");
    case "skipped":
      return style.dim("–");
    case "blocked":
      return style.dim("○");
    default:
      return style.yellow("!");
  }
}
