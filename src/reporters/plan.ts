import type { ChangeStatus, Selection, VerifikaConfig } from "../types.ts";
import { selectionLabel } from "./reporter.ts";

const STATUS_LETTER: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  untracked: "?",
  changed: "~",
};

/** Text rendering of a plan. `maxFiles` bounds the changed-file list. */
export function renderPlan(selection: Selection, maxFiles: number): string {
  const skipped = selection.checks.filter((check) => !check.selected).length;
  const lines = [`Plan: ${selectionLabel(selection, skipped)}`];
  const files = selection.changes?.files;
  if (files) {
    lines.push(`Changed files (${files.length}):`);
    for (const file of files.slice(0, maxFiles))
      lines.push(`  ${STATUS_LETTER[file.status]} ${file.path}`);
    if (files.length > maxFiles)
      lines.push(`  … ${files.length - maxFiles} more (vfk plan --mode json lists all)`);
  }
  lines.push("Checks:");
  const width = Math.max(...selection.checks.map((check) => check.name.length));
  for (const check of selection.checks) {
    lines.push(
      `  ${check.selected ? "run " : "skip"}  ${check.name.padEnd(width)}  ${check.reason}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function planJson(selection: Selection, config: VerifikaConfig): string {
  const byName = new Map(config.checks.map((check) => [check.name, check]));
  const document = {
    schemaVersion: 1,
    kind: "plan",
    root: config.root,
    selection: {
      mode: selection.mode,
      reason: selection.reason,
      base: selection.changes?.base ?? null,
      baseCommit: selection.changes?.baseCommit ?? null,
      changedFiles: selection.changes?.files ?? [],
      invalidatedBy: selection.invalidatedBy,
    },
    checks: selection.checks.map((decision) => ({
      ...decision,
      command: byName.get(decision.name)?.command ?? "",
      dependsOn: byName.get(decision.name)?.dependsOn ?? [],
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
