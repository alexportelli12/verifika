import type { Output, Reporter } from "./reporter.ts";

/**
 * Writes the versioned run result (schemaVersion 1) as the only thing on
 * stdout. Check output never reaches the terminal, so stdout is always valid JSON.
 */
export function jsonReporter(output: Output): Reporter {
  return { onFinish: (result) => output.out(`${JSON.stringify(result, null, 2)}\n`) };
}
