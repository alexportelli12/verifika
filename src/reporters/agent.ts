import type { RunResult } from "../types.ts";
import {
  describeProblem,
  duration,
  isFailureStatus,
  logsHint,
  MAX_PREVIEWED_FAILURES,
  problems,
  selectionLabel,
  verdict,
  type Output,
  type Reporter,
} from "./reporter.ts";

/**
 * Minimal output for coding agents and other non-interactive callers: one line
 * on success; on failure, one line per problem, a bounded preview, and the
 * command that shows full logs.
 */
export function agentReporter(output: Output): Reporter {
  return { onFinish: (result) => output.out(renderAgent(result)) };
}

export function renderAgent(result: RunResult): string {
  const { summary } = result;
  const lines = [
    `${verdict(result)} ${summary.passed}/${summary.selected} (${duration(result.durationMs)}) ${selectionLabel(result.selection, summary.skipped)}`,
  ];
  if (summary.selected === 0)
    lines.push("Nothing to verify for these changes. Full run: vfk --all");

  let previewed = 0;
  for (const check of problems(result)) {
    lines.push(`${check.name}: ${describeProblem(check)}`);
    if (
      isFailureStatus(check.status) &&
      check.preview.length > 0 &&
      previewed < MAX_PREVIEWED_FAILURES
    ) {
      previewed++;
      lines.push(...check.preview.map((line) => `  ${line}`));
    }
  }
  const hint = logsHint(result);
  if (hint) lines.push(`Run: ${hint}`);
  return `${lines.join("\n")}\n`;
}
