---
name: verifika
description: Verify repository changes with the verifika CLI and act on its results. Use when a repository has a verifika.config.json, when you need to check code you changed, before saying work is done, before committing or opening a pull request, and when diagnosing a failed verification run.
license: MIT
---

# Verifika

Verifika runs a repository's configured checks (lint, typecheck, tests, build, ...) and reports the result in a few lines. Locally it runs only the checks your changes affect; in CI and with `--all` it runs everything. Selection is deterministic: file globs, dependencies and git, never guesswork.

## Is it set up here?

Look for `verifika.config.json` in the repository root (or the package directory in a monorepo). Its `checks` object lists every check name and command. Run the CLI the way the repository does: `npx vfk` when it is a devDependency, `vfk` when installed globally, or a documented wrapper script such as `npm run verify`. `vfk` is short for `verifika`; both commands are identical. The examples below write `vfk`.

## Workflow

1. **While implementing**, after a meaningful change:

   ```sh
   vfk
   ```

   Runs only the checks matching files changed since the configured `changes.base` (by default `HEAD`: your uncommitted and untracked changes). If the environment sets `CI` (some agent sandboxes do), plain `vfk` runs everything; use `vfk --changed` for a selective run there.

2. **To see what would run and why**, without running anything:

   ```sh
   vfk plan
   ```

3. **To rerun one check** while fixing it (its dependencies run too):

   ```sh
   vfk --check typecheck
   ```

4. **Before claiming the task is complete, committing, or opening a pull request**, always run the full suite:

   ```sh
   vfk --all
   ```

5. **To verify a whole branch** rather than just uncommitted work: `vfk --changed-since origin/main` (compares against the merge-base, plus uncommitted and untracked files). Useful for review; it does not replace `vfk --all` before delivery.

Wait for the command to finish. Long suites can take minutes; allow enough time and never report a result you have not seen.

## Reading the result

Non-interactive output (the default for agents) is one line on success:

```text
PASS 4/4 (4.3s) full run (--all)
PASS 2/2 (1.1s) selective: 3 files changed since HEAD (a1b2c3d); 2 skipped
```

On failure, one line per problem, a short preview, and the command for full logs:

```text
FAIL 3/4 (3.2s) full run (--all)
typecheck: exit 2
  src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.
Run: vfk logs typecheck
```

Previews are shown for at most three failed checks. Any further failed check says where its output is instead:

```text
FAIL 1/5 (9.8s) full run (--all)
format: exit 1
  [warn] src/cart.ts
lint: exit 1
  /repo/src/cart.ts
    12:9  error  'total' is assigned a value but never used  no-unused-vars
typecheck: exit 2
  src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.
test: exit 1 (preview omitted: vfk logs test)
Run: vfk logs --failed
```

| Exit code | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| 0         | Every selected check passed (or nothing needed verifying)              |
| 1         | At least one check failed, timed out, could not start, or was blocked  |
| 2         | Usage or configuration error: nothing was verified; fix the invocation |
| 128+n     | Interrupted by a signal (130 SIGINT, 143 SIGTERM): nothing conclusive  |
| 70        | Internal Verifika error: nothing conclusive; report it                 |

Check statuses: `passed`, `failed`, `timed_out`, `error` (could not start, or left processes that could not be cleaned up), `blocked` (a dependency did not pass), `cancelled` (fail-fast stopped it), `interrupted`, and `skipped` (not selected for this run, so **not verified**).

## When verification fails

1. Read the failing check names and previews first; they usually identify the problem.
2. If you need more, read only the failing logs: `vfk logs typecheck`, or `vfk logs --failed` for all of them. For long logs use `vfk logs typecheck --tail 80`.
3. Fix the root cause in the code. Then rerun the failed check (`vfk --check typecheck`), and finish with `vfk --all`.
4. `blocked` checks never ran; fix the dependency they name and rerun.
5. If a failure is unrelated to your change (for example it also fails on the base branch), report it with evidence instead of working around it.

## Rules

- Do not claim success unless you saw `PASS` and exit code 0 from a finished run. Say what ran: "selective verification passed (2 checks)" is not "all checks pass".
- A selective `PASS` only covers the checks it selected. Skipped checks were not verified. Run `vfk --all` before delivery, every time.
- `PASS 0/0` means nothing matched your changes and nothing was verified.
- Do not read logs of passing checks or use `vfk logs` after a `PASS`; there is nothing to diagnose.
- Do not edit `verifika.config.json`, remove checks, narrow `paths`, raise timeouts, or pass `--check` to dodge a failing check, unless the user asked for that change.
- Exit code 2 is not a code failure: read the message (bad flag, unknown check, invalid config, missing git ref) and fix the invocation, or report it.
- Do not raise concurrency (`-j`) beyond what the config sets: the project chose it, and checks that share build outputs fail spuriously when run together.
- Prefer the default agent output. Use `vfk --mode json` only when a script needs structured results; avoid `vfk --mode human` in agent sessions.
