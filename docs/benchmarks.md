# Validation and benchmarks

Before 1.0.0, Verifika was run against two real projects and compared with the sequential `verify-runner` script those projects used before. The source repositories were not modified: all runs happened in disposable clones, with a `verifika.config.json` that translated each project's existing `npm run verify` checks one to one.

Measured on 2026-10-12. Machine: 8 vCPU (QEMU), 15 GiB RAM, Linux 6.12, Node 24.19.0. Every timed run waited for a 1-minute load average below 1.5 (idle ≈ 0.5); the load at the start of each run was 1.29–1.48. Treat the numbers as indicative for this machine, not as guarantees.

## Projects

| Project                      | Shape                                                                                                 | Checks                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Angular admin app            | Angular 20, Karma + ChromeHeadless, ESLint, Prettier                                                  | 4: lint, test, format, build                                                               |
| Angular + Functions monorepo | Angular app, 4 npm workspaces, 2 Cloud Functions codebases, Vitest, Karma, Playwright, coverage gates | 25: format, lint/test/coverage-gate per package, builds, offline evals, two browser suites |

Neither project had failing checks at the tested commits (4/4 and 25/25 passed with both runners). No check calls a paid or external service.

## Correctness

- Every run that had a failing check exited non-zero and reported it. No run reported success incorrectly.
- Check selection matched the configuration's intent in all 20 probes: source, spec, stylesheet, template and documentation edits, untracked files, renames (both paths counted), and `package.json` (global invalidation). For example, in the monorepo a change in a shared package selected the 13 dependent checks, and a documentation change selected only `format`.
- `--changed-since main` on a feature branch selected checks from the branch commit plus an uncommitted edit; an unknown ref exited 2 with a hint.
- `--fail-fast` cancelled the remaining checks after the first failure (11 s instead of 18 s).
- Running the monorepo's 25 checks at `-j 4` produced genuine race failures: several scripts delete and rebuild shared `dist/` and vendor directories. Verifika reported them as failures, never as passes. That project uses `"concurrency": 1`; see [checks that share outputs](configuration.md#checks-that-share-outputs).

## Wall-clock time

Angular admin app, 3 interleaved rounds:

| Runner                                | Median | Range       |
| ------------------------------------- | ------ | ----------- |
| previous runner (sequential)          | 95.5 s | 90.3–97.3 s |
| `verifika --all` (default, 4 at once) | 61.7 s | 61.6–61.7 s |
| `verifika --all -j 1`                 | 94.6 s | 92.5–95.9 s |

Running independent checks concurrently cut this project's full run by 34%. Run one at a time, Verifika takes the same time as the previous runner, within noise.

Monorepo, a single round:

| Runner                              | Time    |
| ----------------------------------- | ------- |
| previous runner (sequential)        | 223.0 s |
| `verifika --all` (`concurrency: 1`) | 221.9 s |

Here Verifika runs sequentially by configuration, so the times match. The gain on this project comes from selective runs: a typical edit runs 1–13 of the 25 checks instead of all of them.

## Startup overhead

20 runs each after 2 warm-ups:

| Command                                | Median   |
| -------------------------------------- | -------- |
| `node -e 0` (baseline)                 | 32.8 ms  |
| `verifika --version`                   | 68.6 ms  |
| `verifika plan` (clean tree, runs git) | 101.7 ms |

That is about 36 ms of module loading and about 70 ms for planning, which is negligible next to checks that take seconds or minutes.

## Memory

Verifika's own peak RSS was 61–65 MB, against about 50 MB for the previous runner, and it does not grow with output size: logs stream to disk. The largest process in either run was the tool itself (an Angular build or Karma at 1.2–2.3 GB), unchanged by the runner.

## Output size

Tokens are approximated as bytes ÷ 4.

| Case                                           | Previous runner                                        | Verifika (agent mode)                                   |
| ---------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Success, Angular admin app                     | 78 B (~20 tokens)                                      | 32 B (~8 tokens)                                        |
| Success, monorepo                              | 395 B (~99 tokens)                                     | 36 B (~9 tokens)                                        |
| Success, `--mode quiet`                        | —                                                      | 0 B                                                     |
| One failing Karma assertion                    | 94,900 B (~23.7k tokens), full output dump             | 369 B (~92 tokens): test name, assertion, totals        |
| One failing Vitest assertion (monorepo)        | —                                                      | 504 B (~126 tokens): test name, assertion               |
| Failing test + type error (monorepo, 3 checks) | 23,056 B (~5.8k tokens), only 1 of 3 failures reported | 1,793 B (~450 tokens), all 3 plus the blocked dependent |
| Lint + type error (Angular admin app)          | 762 B, lint only (stops at first failure)              | 1,007 B, all 3 failing checks                           |

The previous runner stops at the first failure and prints that check's entire output. Verifika runs every selected check, reports each failure in one line with a short preview, and leaves the full logs on disk for `verifika logs`.

The two single-assertion rows were measured after the preview improvements described below. The validation run surfaced a weakness, and it was fixed before release: in the first measurement the preview was crowded out by Karma progress lines and by JSON log lines that contain "error". Previews now rank failure markers (`FAILED`, `FAIL`, `AssertionError`, `Expected`, `error TS…`) above exception lines and generic mentions of "error", and collapse progress output.

## Reproducing

The configs and raw measurements are not part of this repository because they describe private projects. To measure your own project, time `npm run verify` (or your current gate) against `verifika --all` and `verifika --all -j 1`, a few rounds each on an idle machine, and compare output with `wc -c`.
