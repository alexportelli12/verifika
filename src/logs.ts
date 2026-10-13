import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VerifikaError } from "./errors.ts";
import { withPager, type Write } from "./pager.ts";
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
  /** Page log contents through this command (only on a terminal, never with `tail`). */
  pager?: string;
  env?: NodeJS.ProcessEnv;
  /** For a person at a terminal: local and relative start time, optionally clickable log paths. */
  display?: { now: Date; hyperlinks: boolean };
}

/**
 * Prints diagnostics from a recorded run. With no arguments it lists the run's
 * checks and log files; with check names or `--failed` it prints log contents.
 * Returns the exit code.
 */
export async function showLogs(request: LogsRequest, output: Output): Promise<number> {
  const run = await readRun(request.root, request.runId);
  if (request.checks.length === 0 && !request.failed) {
    output.out(renderRunSummary(run, request.display));
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
  const print = async (write: Write) => {
    for (const check of targets) {
      if (headers) await write(`── ${check.name}: ${check.status} (${check.reason}) ──\n`);
      if (!check.log) {
        await write(`${check.name} has no log: ${check.status} (${check.reason})\n`);
        continue;
      }
      await printLog(path.join(request.root, check.log), request, write);
    }
  };
  if (request.pager !== undefined && request.tail === undefined) {
    await withPager(request.pager, request.env ?? process.env, print);
  } else {
    await print((text) => output.out(text));
  }
  return 0;
}

export function renderRunSummary(run: RunResult, display?: LogsRequest["display"]): string {
  const started = display ? describeTime(new Date(run.startedAt), display.now) : run.startedAt;
  const lines = [
    `Run ${run.runId} · ${run.status} · ${duration(run.durationMs)} · ${started}`,
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
    if (check.log) {
      parts.push(
        display?.hyperlinks ? hyperlink(check.log, path.join(run.root, check.log)) : check.log,
      );
    }
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

/**
 * `today 01:12, 3m ago`; `yesterday 23:40, 2h ago`; otherwise the local date.
 * Local time, because that is what the user's clock shows.
 */
export function describeTime(time: Date, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(time)) / 86_400_000);
  const date =
    days === 0
      ? "today"
      : days === 1
        ? "yesterday"
        : `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  return `${date} ${clock}, ${ago(now.getTime() - time.getTime())}`;
}

function ago(ms: number): string {
  if (ms < 60_000) return ms < 1_000 ? "just now" : `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** An OSC 8 terminal hyperlink to a local file; terminals without support show just the text. */
export function hyperlink(text: string, file: string): string {
  return `\u001b]8;;${pathToFileURL(file).href}\u001b\\${text}\u001b]8;;\u001b\\`;
}

async function printLog(
  file: string,
  { tail, stripAnsi: strip = false }: LogsRequest,
  write: Write,
): Promise<void> {
  try {
    if (tail !== undefined) {
      const text = await readTail(file, tail);
      const shown = strip ? stripAnsi(text) : text;
      await write(shown.endsWith("\n") || shown === "" ? shown : `${shown}\n`);
      return;
    }
    if (strip) {
      // Line by line, so an escape sequence is never split across chunks.
      const lines = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) await write(`${stripAnsi(line)}\n`);
      return;
    }
    let last = "";
    for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
      await write(chunk as string);
      last = chunk as string;
    }
    if (last !== "" && !last.endsWith("\n")) await write("\n");
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
