/** Exit codes are part of the public CLI contract; see docs/cli.md. */
export const ExitCode = {
  Passed: 0,
  Failed: 1,
  Usage: 2,
} as const;

/**
 * A problem with how Verifika was invoked or configured. These never represent
 * check results, so they always exit with the usage code rather than a pass.
 */
export class VerifikaError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "VerifikaError";
    this.hint = hint;
  }
}
