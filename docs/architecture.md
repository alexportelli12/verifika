# Architecture

Verifika is a pipeline of small modules with one direction of data flow. Execution and presentation are separate: the runner emits events and a final `RunResult`; reporters only format them.

```text
cli.ts ─ main.ts ── config.ts ──► VerifikaConfig
                 └─ planner.ts ─► Selection          (git.ts, glob.ts, ci.ts)
                 └─ runner.ts ──► RunResult          (scheduler.ts, process.ts, runs.ts)
                       │ events
                       ▼
                 reporters/{human,agent,json,quiet}.ts
                 logs.ts (reads runs written by runs.ts)
```

| Module         | Responsibility                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `config.ts`    | Find, parse and validate `verifika.config.json`; apply defaults; reject cycles. Collects every error.              |
| `git.ts`       | Compute the change set: merge-base diff plus untracked files. Never throws for repository state.                   |
| `glob.ts`      | POSIX, case-sensitive glob matching (picomatch with platform detection disabled).                                  |
| `planner.ts`   | Turn a request (`--all`, `--check`, `--changed-since`, CI) and a change set into per-check decisions with reasons. |
| `scheduler.ts` | Dependency-aware, concurrency-limited scheduling. Pure: knows nothing about processes.                             |
| `process.ts`   | Run one command: shell spawn, process groups, timeouts, abort, tree kill, streaming to the log file.               |
| `preview.ts`   | Bounded failure excerpt from streamed output.                                                                      |
| `runs.ts`      | Run ids, `.verifika/` layout, atomic run creation, latest run, retention.                                          |
| `runner.ts`    | Glue: create the run, schedule checks, map outcomes to statuses, compute the exit code.                            |
| `reporters/*`  | Presentation only.                                                                                                 |

## Design decisions

**Conservative selection.** Any doubt about the change set widens the run to everything (when selection was implicit) or fails with exit 2 (when the user asked for a specific comparison). A check is never skipped because git failed. CI runs everything unless told otherwise, so a path rule cannot reduce CI coverage by accident.

**Merge-base comparisons.** `--changed-since <ref>` diffs the working tree against `merge-base(<ref>, HEAD)`. That is "what this branch changes", which is what a reviewer or CI gate means, and it is stable while the base branch moves. Uncommitted and untracked files are always included: verification is about the code on disk.

**Renames as delete plus add.** `--no-renames` reports both paths, so checks that cover either the old or new location run. Rename detection would only save work at the cost of missed checks.

**Shell commands, trusted config.** Commands are strings run by the platform shell, like package scripts. This keeps configs portable (`npm run lint` works everywhere, including `.cmd` shims on Windows) and familiar. The config file is trusted; nothing derived from the repository state (file names, refs) is ever placed in a command. Git is invoked with argument arrays, never a shell, and refs starting with `-` are rejected.

**Confirmed cleanup.** On POSIX each check runs in its own process group (`detached`), so a timeout, fail-fast or Ctrl-C can signal the whole tree at once: SIGTERM, a two-second grace period, then SIGKILL. After a check exits, the rest of its group is terminated the same way and Verifika polls until the group is gone, which also stops a background process from holding the output pipe open. On Windows the tree is killed with `taskkill /T /F` while its root is alive; once the root has exited, descendants are found by parent process id and creation time and killed. If cleanup cannot be confirmed, the check is an `error`, never a pass. A process that survives SIGKILL is abandoned after a bounded wait so the run cannot hang.

**Bounded memory.** Check output is piped straight into the log file with backpressure. The only in-memory output is the preview: at most `--preview` lines of at most 200 characters, plus one partial line capped at 4 KB per stream. A check can print gigabytes without affecting Verifika.

**Stable, explicit results.** Every selected check ends in exactly one status. Any status other than `passed` makes the run fail. The JSON document is versioned (`schemaVersion: 1`) and identical to the `run.json` written to disk, so tools can read either.

**Concurrent invocations.** Run directories are created by renaming a fully prepared temporary directory, carry an owner record (pid and host) until they finish, and are only pruned once that owner is gone. The latest run is the newest run directory, never a separately written pointer, so it cannot go backwards or name a pruned run. Logs hints name the run explicitly when another run has since become the latest.

**Sequential by default.** Only the project knows which of its scripts share build outputs, so parallelism is opt-in through `defaults.concurrency` or `-j`.

**CI mode only strengthens.** Environment variables can switch CI mode on but never off; narrowing a CI run requires an explicit command-line flag.

**Run records first.** `run.json` (status `running`) is written, and the run becomes the latest run directory, before any check starts. If Verifika is killed outright, `vfk logs` shows that unfinished run rather than a misleading earlier one.

**No caching.** v1 does not skip checks because "nothing relevant changed since the last pass". Cache correctness depends on inputs Verifika cannot see (environment, tool versions, network), and a wrong cache hit reports success for unverified code. Selective runs already avoid most unnecessary work, explicitly and visibly.

**One runtime dependency.** `picomatch` (zero dependencies) for well-tested glob semantics. Argument parsing uses `node:util` `parseArgs`; validation is hand-written so error messages can be precise. Startup is a few dozen milliseconds on top of Node itself.

## Testing

- `test/unit`: config validation (including agreement with the JSON schema via Ajv), planner decisions, glob semantics, scheduler ordering and limits with controllable fake tasks, preview extraction, reporters, CI detection.
- `test/integration`: real temporary git repositories (staged, unstaged, untracked, renames, deletions, detached HEAD, merge-base, shallow clones, subdirectory configs, hostile file names) and the CLI end to end: exit codes, every output mode, logs, timeouts, fail-fast, concurrency, dependency ordering, signals and process-tree cleanup.
- `scripts/check-skill.mjs`: validates the skill's frontmatter and runs every command it documents.
- `scripts/pack-smoke.mjs`: packs the package, installs the tarball in an isolated project and runs the installed binary.

CI runs all of it on Linux, macOS and Windows with every supported Node.js major.
