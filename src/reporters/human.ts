import type { CheckStatus, RunResult } from "../types.ts";
import {
  describeProblem,
  duration,
  isFailureStatus,
  logsHint,
  MAX_PREVIEWED_FAILURES,
  problems,
  selectionLabel,
  type Output,
  type Reporter,
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

/**
 * Line-based progress for people: one line when a check starts and one when it
 * ends, a periodic note while long checks run, then a summary. No cursor
 * movement, so it reads the same in terminals, logs and CI.
 */
export function humanReporter(
  output: Output,
  style: Style,
  options: { heartbeat?: boolean } = {},
): Reporter {
  const running = new Map<string, number>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  return {
    onStart({ selection, selected }) {
      const skipped = selection.checks.length - selected.length;
      output.out(`${style.bold("verifika")} ${selectionLabel(selection, skipped)}\n`);
      if (selected.length === 0) {
        output.out(style.dim("Nothing to verify for these changes. Full run: vfk --all\n"));
        return;
      }
      if (skipped > 0) {
        const names = selection.checks
          .filter((check) => !check.selected)
          .map((check) => check.name);
        output.out(style.dim(`skipped: ${names.join(", ")}\n`));
      }
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
      const detail = check.status === "passed" ? "" : ` ${describeProblem(check)}`;
      output.out(
        `${symbol(check.status, style)} ${check.name} ${style.dim(duration(check.durationMs))}${detail}\n`,
      );
    },
    onFinish(result) {
      if (heartbeat) clearInterval(heartbeat);
      output.out(renderSummary(result, style));
    },
  };
}

export function renderSummary(result: RunResult, style: Style): string {
  const { summary } = result;
  const lines: string[] = [];
  const failing = problems(result);
  let previewed = 0;
  if (failing.length > 0) lines.push("");
  for (const check of failing) {
    if (!isFailureStatus(check.status)) {
      lines.push(`${symbol(check.status, style)} ${check.name}: ${describeProblem(check)}`);
      continue;
    }
    lines.push(
      `${symbol(check.status, style)} ${style.bold(check.name)}: ${describeProblem(check)}`,
    );
    if (check.preview.length > 0 && previewed < MAX_PREVIEWED_FAILURES) {
      previewed++;
      lines.push(...check.preview.map((line) => style.dim(`    ${line}`)));
    }
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
    default:
      return style.yellow("!");
  }
}
