# CLI reference

```text
verifika [run] [options]        Verify (selective locally, full in CI)
verifika plan [options]         Show which checks would run and why
verifika logs [check...]        Show logs from the latest run
verifika init [--force]         Create verifika.config.json from package.json scripts
```

The command, if any, comes first. `verifika` with no command is `verifika run`.

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

| Option                  | Effect                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `-j, --concurrency <n>` | Maximum checks running at once. Default: `defaults.concurrency`.                   |
| `--fail-fast`           | After the first failure, terminate running checks and skip pending ones.           |
| `--no-fail-fast`        | Run every selected check even after failures (overrides `defaults.failFast`).      |
| `--preview <lines>`     | Failure preview lines per check in human and agent output. Default 10; 0 disables. |

## Logs (`logs`)

| Usage                         | Effect                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `verifika logs`               | Summary of the latest run: status, durations, log paths.                        |
| `verifika logs <check> [...]` | Print the full log of each named check.                                         |
| `verifika logs --failed`      | Print the logs of every failed, timed-out or errored check, each with a header. |
| `--tail <lines>`              | Print only the last lines of each log.                                          |
| `--run <id>`                  | Read that run instead of the latest.                                            |

## Output (`--mode`)

`human`, `agent`, `json` or `quiet`. Default: `human` when stdout is a terminal, otherwise `agent`. The `VERIFIKA_MODE` environment variable sets the default. `human` mode uses colour on a terminal unless `NO_COLOR` is set (`FORCE_COLOR` enables it elsewhere).

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
Run: verifika logs --failed
```

The first line is `PASS`, `FAIL` or `INTERRUPTED`, then `passed/selected`, total duration and what was selected. Each selected check that did not pass gets one line. Up to three failed checks get a preview of at most `--preview` lines: lines that look like errors (with the file heading above them, for tools like ESLint), or the last lines of output when nothing looks like an error. Package-manager boilerplate (`npm error ...`) is left out. Previews are ANSI-stripped and each line is capped at 200 characters.

When nothing is selected:

```text
PASS 0/0 (0.0s) selective: no files changed since HEAD (a1b2c3d); 4 skipped
Nothing to verify for these changes. Full run: verifika --all
```

### Quiet output

Nothing on success. On failure, one line on stderr:

```text
verifika: FAIL typecheck (exit 2). Run: verifika logs typecheck
```

### JSON output

For `run` and `plan`, `--mode json` prints exactly one JSON document to stdout, including for usage errors (exit 2) and internal errors (exit 70). `logs`, `init`, `--help` and `--version` always print text. Command output never appears on stdout or stderr in this mode, so the stream is always parseable. The schema is versioned by `schemaVersion`; fields are only added within a version.

```json
{
  "schemaVersion": 1,
  "tool": { "name": "verifika", "version": "1.0.0" },
  "runId": "20261012-143955-042-a1b2c3",
  "status": "failed",
  "exitCode": 1,
  "startedAt": "2026-10-12T14:39:55.123Z",
  "durationMs": 3204,
  "root": "/home/me/project",
  "logsDir": ".verifika/runs/20261012-143955-042-a1b2c3",
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
      "error": null,
      "warning": null
    }
  ]
}
```

| Field                   | Values                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `status`                | `passed`, `failed`, `interrupted` (`running` only appears in `run.json` of a run that never finished)                       |
| `selection.mode`        | `all`, `changed`, `explicit`                                                                                                |
| `changedFiles[].status` | `added`, `modified`, `deleted`, `untracked`, `changed` (type change, conflict)                                              |
| `checks[].status`       | `passed`, `failed`, `timed_out`, `error` (could not start), `blocked`, `cancelled`, `interrupted`, `skipped` (not selected) |
| `summary.failed`        | selected checks that failed, timed out or could not start                                                                   |
| `summary.notRun`        | selected checks that were blocked, cancelled or interrupted                                                                 |
| `checks[].log`          | path relative to `root`, or `null` when the check never started                                                             |

Usage and configuration errors in JSON mode print `{"schemaVersion": 1, "status": "error", "exitCode": 2, "error": {"message": "...", "hint": "..."}}`.

`verifika plan --mode json` prints `{"schemaVersion": 1, "kind": "plan", "root", "selection", "checks": [{"name", "selected", "reason", "matchedFiles", "command", "dependsOn"}]}`.

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

The first SIGINT, SIGTERM or SIGHUP stops scheduling, sends SIGTERM to every running check's process group (on Windows, `taskkill /T /F`), waits up to two seconds, then kills what is left. The run is recorded as `interrupted`. A second signal kills running checks immediately. If Verifika itself is killed with SIGKILL it cannot clean up: because each check runs in its own process group, checks that are already running keep running, and the run stays `running` in `run.json`. Harnesses and CI timeouts that hard-kill processes should send SIGTERM first.

After a check's main process exits, Verifika also terminates anything still left in its process group on Linux and macOS (such as a forgotten background server). Two cases are out of reach: processes that leave the group (for example with `setsid`), and on Windows any descendant that outlives the check's main process, because the tree can no longer be found once its root has exited. If such a process keeps the output pipe open, Verifika stops reading after about four seconds and attaches a warning to the check (`warning` in JSON, a `warning:` line in agent output). The check's result is unaffected, but the process may still be running.

## Environment variables

| Variable        | Effect                                           |
| --------------- | ------------------------------------------------ |
| `VERIFIKA_MODE` | Default output mode.                             |
| `VERIFIKA_CI`   | `1`/`0` forces CI detection on or off.           |
| `NO_COLOR`      | Disables colour in human mode.                   |
| `FORCE_COLOR`   | Enables colour in human mode without a terminal. |
