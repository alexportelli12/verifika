import {
  describeProblem,
  logsHint,
  problems,
  verdict,
  type Output,
  type Reporter,
} from "./reporter.ts";

/** Silent on success. On failure, a single actionable line on stderr. */
export function quietReporter(output: Output): Reporter {
  return {
    onFinish(result) {
      if (result.status === "passed") return;
      const failed = problems(result)
        .map((check) => `${check.name} (${describeProblem(check)})`)
        .join(", ");
      const hint = logsHint(result);
      output.err(`verifika: ${verdict(result)} ${failed}${hint ? `. Run: ${hint}` : ""}\n`);
    },
  };
}
