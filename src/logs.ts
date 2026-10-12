import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { open } from "node:fs/promises";
import path from "node:path";
import { VerifikaError } from "./errors.ts";
import { duration, isFailureStatus, selectionLabel, type Output } from "./reporters/reporter.ts";
import { plain, symbol } from "./reporters/human.ts";
import { stripAnsi } from "./preview.ts";
import { readRun } from "./runs.ts";
import type { CheckResult, RunResult } from "./types.ts";

export interface LogsRequest {
  root: string;
  runId?: string;
  checks: string[];
  failed: boolean;
  tail?: number;
  /** Remove terminal colour codes some tools emit even when piped (default when not on a TTY). */
  stripAnsi?: boolean;
}

/**
 * Prints diagnostics from a recorded run. With no arguments it lists the run's
 * checks and log files; with check names or `--failed` it prints log contents.
 * Returns the exit code.
 */
export async function showLogs(request: LogsRequest, output: Output): Promise<number> {
  const run = await readRun(request.root, request.runId);
  if (request.checks.length === 0 && !request.failed) {
    output.out(renderRunSummary(run));
    return 0;
  }

  let targets: CheckResult[];
  if (request.failed) {
    targets = run.checks.filter((check) => check.selected && isFailureStatus(check.status));
    if (targets.length === 0) {
      output.out(`No failed checks in run ${run.runId} (${run.status}).\n`);
      return 0;
    }
  } else {
    const byName = new Map(run.checks.map((check) => [check.name, check]));
    const unknown = request.checks.filter((name) => !byName.has(name));
    if (unknown.length > 0) {
      throw new VerifikaError(
        `no check named ${unknown.join(", ")} in run ${run.runId}`,
        `Checks in that run: ${run.checks.map((check) => check.name).join(", ")}`,
      );
    }
    targets = request.checks.map((name) => byName.get(name) as CheckResult);
  }

  const headers = request.failed || targets.length > 1;
  for (const check of targets) {
    if (headers) output.out(`── ${check.name}: ${check.status} (${check.reason}) ──\n`);
    if (!check.log) {
      output.out(`${check.name} has no log: ${check.status} (${check.reason})\n`);
      continue;
    }
    await printLog(path.join(request.root, check.log), request, output);
  }
  return 0;
}

export function renderRunSummary(run: RunResult): string {
  const lines = [
    `Run ${run.runId} · ${run.status} · ${duration(run.durationMs)} · ${run.startedAt}`,
    selectionLabel(run.selection, run.summary.skipped),
  ];
  if (run.status === "running")
    lines.push("This run has not finished (or the process was killed).");
  const ran = run.checks.filter((check) => check.selected);
  const width = Math.max(0, ...ran.map((check) => check.name.length));
  for (const check of ran) {
    const parts = [`  ${symbol(check.status, plain)} ${check.name.padEnd(width)}`];
    parts.push(duration(check.durationMs).padStart(6));
    if (check.status !== "passed") parts.push(check.reason);
    if (check.log) parts.push(check.log);
    lines.push(parts.join("  "));
  }
  // One line for everything not selected; large configs would otherwise list dozens.
  const skipped = run.checks.filter((check) => !check.selected);
  if (skipped.length > 0) {
    const reasons = [...new Set(skipped.map((check) => check.reason))].join("; ");
    lines.push(
      `  – skipped (${skipped.length}): ${skipped.map((check) => check.name).join(", ")} (${reasons})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function printLog(
  file: string,
  { tail, stripAnsi: strip = false }: LogsRequest,
  output: Output,
): Promise<void> {
  try {
    if (tail !== undefined) {
      const text = await readTail(file, tail);
      const shown = strip ? stripAnsi(text) : text;
      output.out(shown.endsWith("\n") || shown === "" ? shown : `${shown}\n`);
      return;
    }
    if (strip) {
      // Line by line, so an escape sequence is never split across chunks.
      const lines = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) output.out(`${stripAnsi(line)}\n`);
      return;
    }
    let last = "";
    for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
      output.out(chunk as string);
      last = chunk as string;
    }
    if (last !== "" && !last.endsWith("\n")) output.out("\n");
  } catch (error) {
    throw new VerifikaError(`cannot read log ${file}: ${(error as Error).message}`);
  }
}

/** Reads the last `lines` lines without loading the whole file. */
export async function readTail(file: string, lines: number): Promise<string> {
  if (lines <= 0) return "";
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const blockSize = 64 * 1024;
    let position = size;
    let buffer = Buffer.alloc(0);
    let newlines = 0;
    while (position > 0 && newlines <= lines) {
      const length = Math.min(blockSize, position);
      position -= length;
      const block = Buffer.alloc(length);
      await handle.read(block, 0, length, position);
      buffer = Buffer.concat([block, buffer]);
      newlines = block.reduce((count, byte) => (byte === 0x0a ? count + 1 : count), newlines);
    }
    const text = buffer.toString("utf8");
    if (text === "") return "";
    const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    return `${all.slice(-lines).join("\n")}\n`;
  } finally {
    await handle.close();
  }
}
