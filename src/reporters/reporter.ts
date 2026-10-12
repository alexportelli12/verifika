import { formatSeconds } from "../format.ts";
import type { CheckResult, CheckStatus, RunResult, Selection } from "../types.ts";

export type OutputMode = "human" | "agent" | "json" | "quiet";
export const OUTPUT_MODES: readonly OutputMode[] = ["human", "agent", "json", "quiet"];

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

export interface StartInfo {
  runId: string;
  selection: Selection;
  selected: string[];
  concurrency: number;
  /** `dependsOn` of each selected check. */
  dependsOn: Record<string, string[]>;
}

/** Receives run events. Only `onFinish` is required; streaming modes use the rest. */
export interface Reporter {
  onStart?(info: StartInfo): void;
  onCheckStart?(name: string): void;
  /** The latest non-empty line a running check printed, ANSI-stripped. Only sent when implemented. */
  onCheckOutput?(name: string, line: string): void;
  onCheckEnd?(result: CheckResult): void;
  onFinish(result: RunResult): void;
  /** Releases anything the reporter holds (such as the terminal), however the run ended. */
  dispose?(): void;
}

/** Previews are shown for at most this many failed checks, to keep output bounded. */
export const MAX_PREVIEWED_FAILURES = 3;

export function isFailureStatus(status: CheckStatus): boolean {
  return status === "failed" || status === "timed_out" || status === "error";
}

/** Selected checks that did not pass, in config order. */
export function problems(result: RunResult): CheckResult[] {
  return result.checks.filter((check) => check.selected && check.status !== "passed");
}

/** One-phrase description of what was selected and why. */
export function selectionLabel(
  selection: Pick<Selection, "mode" | "reason">,
  skipped: number,
): string {
  switch (selection.mode) {
    case "all":
      return `full run (${selection.reason})`;
    case "explicit":
      return `explicit: ${selection.reason}${skipped > 0 ? `; ${skipped} skipped` : ""}`;
    case "changed":
      return `selective: ${selection.reason}${skipped > 0 ? `; ${skipped} skipped` : ""}`;
  }
}

export function describeProblem(check: CheckResult): string {
  return check.error ? `${check.reason}: ${check.error}` : check.reason;
}

/** The single next command that shows the relevant diagnostics. */
export function logsHint(result: RunResult): string | null {
  const withLogs = problems(result).filter((check) => isFailureStatus(check.status) && check.log);
  if (withLogs.length === 0) return null;
  return logsCommand(result, withLogs.length === 1 ? (withLogs[0]?.name ?? "") : "--failed");
}

/** `vfk logs <target>`, naming the run when a later run has become the latest. */
function logsCommand(result: RunResult, target: string): string {
  const command = `vfk logs ${target}`;
  return result.latest ? command : `${command} --run ${result.runId}`;
}

/**
 * Decides which failed checks get their preview printed: at most
 * MAX_PREVIEWED_FAILURES, in config order. The rest get a note pointing at their
 * log, so a hidden preview never looks like one that found nothing.
 */
export function previewDecider(
  result: RunResult,
): (check: CheckResult) => { show: boolean; note: string } {
  let previewed = 0;
  return (check) => {
    if (!isFailureStatus(check.status) || check.preview.length === 0) {
      return { show: false, note: "" };
    }
    if (previewed < MAX_PREVIEWED_FAILURES) {
      previewed++;
      return { show: true, note: "" };
    }
    return { show: false, note: ` (preview omitted: ${logsCommand(result, check.name)})` };
  };
}

export function verdict(result: RunResult): string {
  return result.status === "passed"
    ? "PASS"
    : result.status === "interrupted"
      ? "INTERRUPTED"
      : "FAIL";
}

export function duration(ms: number | null): string {
  return ms === null ? "-" : formatSeconds(ms);
}
