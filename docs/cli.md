# CLI reference

```text
vfk [run] [options]        Verify (selective locally, full in CI)
vfk plan [options]         Show which checks would run and why
vfk logs [check...]        Show logs from the latest run
vfk init [--force]         Create verifika.config.json from package.json scripts
```

The command, if any, comes first. `vfk` with no command is `vfk run`.

`vfk` is short for `verifika`: the package installs both commands, and they are identical. These docs use `vfk`.

## Selection (`run`, `plan`)

At most one of these may be given. Without any, Verifika runs selectively on a developer machine and fully in CI.

| Option                  | Effect                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--all`                 | Run every check.                                                                                                              |
| `-c, --check <name>`    | Run only the named checks and their dependencies. Repeatable or comma-separated.                                              |
| `--changed`             | Select by changes against `changes.base`, even in CI. Fails (exit 2) if git cannot tell.                                      |
| `--changed-since <ref>` | Select by changes since `merge-base(<ref>, HEAD)` plus uncommitted and untracked files. Fails (exit 2) if the ref is unknown. |

See [change detection semantics](configuration.md#change-detection-semantics).

## Execution (`run`)

| Option                  | Effect                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `-j, --concurrency <n>` | Maximum checks running at once. Default: `defaults.concurrency`, which defaults to 1 (sequential).      |
| `--fail-fast`           | After the first failure, terminate running checks and skip pending ones.                                |
| `--no-fail-fast`        | Run every selected check even after failures (overrides `defaults.failFast`).                           |
| `--preview <lines>`     | Failure preview lines per check in human and agent output. Default 10; 0 disables.                      |
| `--no-live`             | In human mode, print progress line by line instead of the live status block. Same as `VERIFIKA_LIVE=0`. |

## Logs (`logs`)

| Usage                    | Effect                                                                          |
| ------------------------ | ------------------------------------------------------------------------------- |
| `vfk logs`               | Summary of the latest run: status, durations, log paths.                        |
| `vfk logs <check> [...]` | Print the full log of each named check.                                         |
| `vfk logs --failed`      | Print the logs of every failed, timed-out or errored check, each with a header. |
| `--tail <lines>`         | Print only the last lines of each log.                                          |
| `--run <id>`             | Read that run instead of the latest.                                            |
| `--no-pager`             | Print log contents directly instead of through the pager.                       |

Logs are stored exactly as the command printed them. When `vfk logs` writes to a pipe or file (as it does for agents), it strips terminal colour codes that some tools emit even when not attached to a terminal; on an interactive terminal they are kept.

On an interactive terminal in `human` mode (the default there), `vfk logs` is formatted for a person. With `--mode agent` or `VERIFIKA_MODE=agent` it stays plain, so an agent running in a pseudo-terminal never waits on a pager:

- The run summary shows the start in local time with its age (`today 01:12, 3m ago`) instead of the UTC timestamp, which is kept when the output goes to a pipe or file.
- Log paths are clickable [OSC 8](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda) `file://` links, unless CI is detected, `TERM` is `dumb` or `VERIFIKA_HYPERLINKS=0`.
- Log contents go through `$PAGER`, or `less -R -F -X` when it is unset (like git, `LESS=FRX` is set for the pager unless you set `LESS`). If the pager program is not installed (for example `less` on Windows), logs print directly. `--tail` and `--no-pager` never page, and nothing is paged when stdout is not a terminal.

## Init (`init`)

`vfk init` writes a starter `verifika.config.json` from conventional `package.json` script names (`--force` overwrites an existing config). It also adds two scripts to `package.json` when they are absent:

```json
{ "scripts": { "verify": "vfk", "verify:ci": "vfk --all" } }
```

`verify` is selective, for local work; `verify:ci` is the full gate for CI and before delivery. Existing scripts with those names are never overwritten: `init` reports them so you can point them at `vfk` once the configured checks cover what they ran. The file keeps its indentation, line endings, key order and trailing newline.

## Output (`--mode`)

`human`, `agent`, `json` or `quiet`. Default: `human` when stdout is a terminal, otherwise `agent`. The `VERIFIKA_MODE` environment variable sets the default. `human` mode uses colour on a terminal unless `NO_COLOR` is set (`FORCE_COLOR` enables it elsewhere).

### Human output

On an interactive terminal, human mode shows a live status block below the finished checks: progress (`[done/selected]`) and elapsed time, each running check with a spinner, its elapsed time and the last line it printed, and the checks still waiting (`test, pack  waiting on build`). The block is redrawn in place about ten times a second and removed when the run ends; finished checks print above it exactly as in line mode, so the scrollback reads the same either way.

The live block is used only when stdout is a terminal, no CI is detected, `TERM` is not `dumb`, and neither `--no-live` nor `VERIFIKA_LIVE=0` is set. Otherwise (including `--mode human` in CI, when piped, or in a log file) human mode prints one line per check start and end, a note every 30 seconds naming the checks still running, then the summary.

Both forms share the same layout:

```text
verifika · selective: 3 files changed since HEAD (a1b2c3d) · 4 checks · 4 parallel
3 skipped (~1m10s saved): format, skill, pack
✓ typecheck  6.1s
✗ lint       2.3s  exit 1
✓ build      4.0s

✗ lint  npm run lint → exit 1 · rerun: vfk -c lint
    /repo/src/cart.ts
      12:9  error  'total' is assigned a value but never used  no-unused-vars
    ✖ 1 problem (1 error, 0 warnings)
○ test  not run: lint failed
✗ verification failed: 2 of 4 checks passed (12s)
Logs: vfk logs lint
```

The time saved is estimated from each skipped check's most recent duration in the retained runs: `~` when every skipped check has one, `≥` when some do not, and no estimate when none do. A failed check shows its command and the command that reruns it. `○` marks a check that never ran because a dependency did not pass; `!` marks checks cancelled by fail-fast or interrupted.

### Agent output

```text
PASS 4/4 (4.3s) full run (--all)
```

```text
FAIL 2/4 (3.2s) selective: 5 files changed since HEAD (a1b2c3d)
typecheck: exit 2
  src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.
e2e: dependency build did not pass
build: timed out after 5m00s
Run: vfk logs --failed
```

The first line is `PASS`, `FAIL` or `INTERRUPTED`, then `passed/selected`, total duration and what was selected. Each selected check that did not pass gets one line. Up to three failed checks get a preview of at most `--preview` lines, chosen in this order: lines that clearly state a failure (assertion errors, compiler errors such as `error TS2322`, `FAIL`/`FAILED` markers) plus the line after each; otherwise lines that mention errors (with the file heading above them, for tools like ESLint); otherwise the last lines of output. Progress output that redraws itself (for example Karma's `Executed 12 of 756`) is collapsed to its final state, and JSON log lines are not treated as failures. ESLint errors are kept with the file heading above them, and its `✖ N problems` summary. Package-manager boilerplate (`npm error ...`, and script banners such as `> app@1.0.0 lint` / `> eslint .` or yarn's `$ eslint .`) is left out. Previews are ANSI-stripped and each line is capped at 200 characters. A failed check beyond the first three gets `(preview omitted: vfk logs <check>)` on its line instead of a preview.

When nothing is selected:

```text
PASS 0/0 (0.0s) selective: no files changed since HEAD (a1b2c3d); 4 skipped
Nothing to verify for these changes. Full run: vfk --all
```

### Quiet output

Nothing on success. On failure, one line on stderr:

```text
verifika: FAIL typecheck (exit 2). Run: vfk logs typecheck
```

### JSON output

For `run` and `plan`, `--mode json` prints exactly one JSON document to stdout, including for usage errors (exit 2) and internal errors (exit 70). `logs`, `init`, `--help` and `--version` always print text. Command output never appears on stdout or stderr in this mode, so the stream is always parseable. The schema is versioned by `schemaVersion`; fields are only added within a version.

```json
{
  "schemaVersion": 1,
  "tool": { "name": "verifika", "version": "0.0.1" },
  "runId": "20261012-143955-042-a1b2c3",
  "status": "failed",
  "exitCode": 1,
  "startedAt": "2026-10-12T14:39:55.123Z",
  "durationMs": 3204,
  "root": "/home/me/project",
  "logsDir": ".verifika/runs/20261012-143955-042-a1b2c3",
  "latest": true,
  "selection": {
    "mode": "changed",
    "reason": "2 files changed since HEAD (a1b2c3d)",
    "base": "HEAD",
    "baseCommit": "a1b2c3d4e5f6...",
    "changedFiles": [{ "path": "src/cart.ts", "status": "modified" }],
    "invalidatedBy": null
  },
  "summary": { "total": 4, "selected": 2, "passed": 1, "failed": 1, "notRun": 0, "skipped": 2 },
  "checks": [
    {
      "name": "typecheck",
      "command": "npm run typecheck",
      "selected": true,
      "status": "failed",
      "reason": "exit 2",
      "exitCode": 2,
      "signal": null,
      "durationMs": 3101,
      "log": ".verifika/runs/20261012-143955-042-a1b2c3/typecheck.log",
      "preview": ["src/cart.ts(14,7): error TS2322: ..."],
      "error": null
    }
  ]
}
```

| Field                   | Values                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                | `passed`, `failed`, `interrupted` (`running` only appears in `run.json` of a run that never finished)                                                                 |
| `selection.mode`        | `all`, `changed`, `explicit`                                                                                                                                          |
| `changedFiles[].status` | `added`, `modified`, `deleted`, `untracked`, `changed` (type change, conflict)                                                                                        |
| `checks[].status`       | `passed`, `failed`, `timed_out`, `error` (could not start, or its processes could not be cleaned up), `blocked`, `cancelled`, `interrupted`, `skipped` (not selected) |
| `summary.failed`        | selected checks that failed, timed out or could not start                                                                                                             |
| `summary.notRun`        | selected checks that were blocked, cancelled or interrupted                                                                                                           |
| `checks[].log`          | path relative to `root`, or `null` when the check never started                                                                                                       |
| `checks[].blockedBy`    | for `blocked` checks only: the dependency that did not pass (added in 0.0.3; absent otherwise)                                                                        |
| `latest`                | `false` when another run started in the same directory after this one; `vfk logs` without `--run` then shows that other run                                           |

Usage and configuration errors in JSON mode print `{"schemaVersion": 1, "status": "error", "exitCode": 2, "error": {"message": "...", "hint": "..."}}`.

`vfk plan --mode json` prints `{"schemaVersion": 1, "kind": "plan", "root", "selection", "checks": [{"name", "selected", "reason", "matchedFiles", "command", "dependsOn", "requiredBy"?}]}`. `requiredBy` (added in 0.0.3) is present only on a check selected solely because other selected checks depend on it, and lists those checks in config order; its `reason` reads `required by test, pack`.

In human mode, `vfk plan` colours `run` green and dims skipped checks, following the same `NO_COLOR` / `FORCE_COLOR` rules as `run`.

## Exit codes

| Code    | Meaning                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------- |
| 0       | All selected checks passed, or nothing needed verifying. Also `plan`, `logs`, `init`, `--help` success. |
| 1       | At least one selected check failed, timed out, could not start, was blocked or cancelled.               |
| 2       | Usage or configuration error. Nothing was verified.                                                     |
| 128 + n | Interrupted by a signal: 129 SIGHUP, 130 SIGINT, 143 SIGTERM.                                           |
| 70      | Internal error (a bug; please report it).                                                               |

A check's own exit code is in the JSON result and the agent output (`typecheck: exit 2`); Verifika's exit code summarises the run.

## Signals

The first SIGINT, SIGTERM or SIGHUP stops scheduling, sends SIGTERM to every running check's process group (on Windows, `taskkill /T /F`), waits up to two seconds, then kills what is left. The run is recorded as `interrupted`. A second signal kills running checks immediately. In human mode the first signal also prints `stopping… (Ctrl-C again to force)` to stderr; the live status block is cleared first and then shows the run as stopping. If Verifika itself is killed with SIGKILL it cannot clean up: because each check runs in its own process group, checks that are already running keep running, and the run stays `running` in `run.json`. Harnesses and CI timeouts that hard-kill processes should send SIGTERM first.

When a check's main process exits, Verifika makes sure nothing it started is left running before recording the result:

- On Linux and macOS each check runs in its own process group. Verifika sends the group SIGTERM, then SIGKILL, and waits until the group no longer exists. Processes that ignore SIGTERM are killed.
- On Windows, Node already places the check in a job object that ends with it, and Verifika additionally lists processes whose parent chain leads back to the check (created after it started) and terminates them with `taskkill /F`. A process that broke away from the job and whose parent chain passes through an already-exited process cannot be traced. This uses PowerShell (`Get-CimInstance`), which adds roughly half a second to a few seconds per check; without PowerShell every check is reported as `error`. Leftovers are confirmed gone by querying the process table again after `taskkill`.
- A command that does not exit even after being killed is abandoned after a few seconds instead of hanging the run.

If any of this cannot be confirmed, the check is reported as `error` with reason `process tree not cleaned up`, whatever its exit code, and the run fails. (A check that already timed out or was cancelled keeps that status, with the cleanup problem added to its reason.) In Linux containers, killed leftovers can remain as zombies when PID 1 does not reap them; Verifika ignores zombies, but running containers with an init process (`docker run --init`, or `tini`) is still recommended. A leftover process could still be writing files or holding ports, so its result cannot count as a pass. What is out of reach is a process that deliberately detaches (`setsid` or Node's `detached` on Linux and macOS; breaking away from the job with a broken parent chain on Windows): if it closes its output it is a daemon by design and is not tracked; if it keeps the check's output open, the check is reported as `error`.

## Environment variables

| Variable              | Effect                                                        |
| --------------------- | ------------------------------------------------------------- |
| `VERIFIKA_MODE`       | Default output mode.                                          |
| `NO_COLOR`            | Disables colour in human mode.                                |
| `FORCE_COLOR`         | Enables colour in human mode without a terminal.              |
| `VERIFIKA_LIVE`       | `0` turns off the live status block (same as `--no-live`).    |
| `VERIFIKA_HYPERLINKS` | `0` turns off clickable log paths in `vfk logs`.              |
| `PAGER`               | Pager for `vfk logs` on a terminal (default `less -R -F -X`). |
