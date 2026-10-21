---
sources:
  - schemas/verifika.schema.json
  - src/config.ts
  - src/planner.ts
  - src/ci.ts
  - src/git.ts
  - src/glob.ts
reviewed: 2026-10-21
---

# Configuration reference

Verifika reads `verifika.config.json`, searching from the current directory upwards (or the file given with `--config`). The directory containing the file is the **project root**: commands run there, and every glob is relative to it.

The format is plain JSON (no comments, no code execution). Add `$schema` for editor autocomplete and validation:

```json
{ "$schema": "./node_modules/verifika/schemas/verifika.schema.json" }
```

When Verifika is not a local dependency, use `https://raw.githubusercontent.com/alexportelli12/verifika/main/schemas/verifika.schema.json`.

## Full example

```json
{
  "$schema": "./node_modules/verifika/schemas/verifika.schema.json",
  "version": 1,
  "defaults": {
    "concurrency": 1,
    "timeoutMs": 300000,
    "failFast": false,
    "keepRuns": 10
  },
  "changes": {
    "base": "HEAD",
    "invalidateAll": ["package.json", "package-lock.json", "tsconfig*.json", "angular.json"]
  },
  "checks": {
    "format": { "command": "npm run format:check" },
    "lint": {
      "command": "npm run lint",
      "paths": ["src/**/*.{ts,html}"],
      "exclude": ["src/**/*.generated.ts"]
    },
    "typecheck": { "command": "npm run typecheck", "paths": ["src/**/*.ts"] },
    "unit": { "command": "npm test -- --run", "paths": ["src/**"], "timeoutMs": 600000 },
    "build": { "command": "npm run build", "paths": ["src/**"] },
    "e2e": { "command": "npm run e2e", "paths": ["src/**", "e2e/**"], "dependsOn": ["build"] },
    "audit": { "command": "npm audit --omit=dev", "always": true }
  }
}
```

## Top level

| Field      | Required | Description                                                |
| ---------- | -------- | ---------------------------------------------------------- |
| `$schema`  | no       | Schema reference for editors. Ignored by Verifika.         |
| `version`  | yes      | Must be `1`. Future incompatible formats get a new number. |
| `defaults` | no       | Run-wide settings (below).                                 |
| `changes`  | no       | Change detection settings (below).                         |
| `checks`   | yes      | Object of checks keyed by name. At least one.              |

Unknown properties are errors, so typos never silently disable a setting.

## `defaults`

| Field         | Default               | Description                                                                                                                               |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency` | `1`                   | Maximum checks running at once (1–64). Override with `-j`. See [checks that share outputs](#checks-that-share-outputs) before raising it. |
| `timeoutMs`   | `600000` (10 minutes) | Per-check timeout. A check that exceeds it is killed (with its child processes) and reported `timed_out`.                                 |
| `failFast`    | `false`               | Stop all running and pending checks after the first failure. Override with `--fail-fast` / `--no-fail-fast`.                              |
| `keepRuns`    | `10`                  | How many runs of logs to keep in `.verifika/runs` (1–1000).                                                                               |

## `changes`

| Field           | Default  | Description                                                                                       |
| --------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `base`          | `"HEAD"` | Git ref that local selective runs compare against (see [semantics](#change-detection-semantics)). |
| `invalidateAll` | `[]`     | Globs. If any changed file matches, every check runs. `verifika.config.json` is always included.  |

Put files here whose change can affect any check: dependency manifests and lockfiles, compiler configs, shared tool configs.

## `checks.<name>`

Names may contain letters, digits, `.`, `_` and `-`, and must start with a letter or digit. They are used in log file names and on the command line.

| Field       | Default    | Description                                                                                                  |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `command`   | (required) | Shell command, run from the project root. Exit code `0` passes.                                              |
| `paths`     | (none)     | Globs. In selective runs the check runs only if a changed file matches. Omitted: runs when any file changed. |
| `exclude`   | `[]`       | Globs. Matching changed files never select this check.                                                       |
| `always`    | `false`    | Run on every run, even when nothing changed. Cannot be combined with `paths` or `exclude`.                   |
| `dependsOn` | `[]`       | Checks that must pass first. Selecting this check selects them too. Cycles are rejected.                     |
| `timeoutMs` | default    | Timeout for this check, overriding `defaults.timeoutMs`.                                                     |

### Commands

Commands run through the platform shell (`/bin/sh -c` on Linux and macOS, `cmd.exe /d /s /c` on Windows), with the project root as working directory and stdin closed. Prefer package scripts (`npm run lint`) so the same command works on every OS.

Each command receives the environment of the Verifika process plus:

| Variable          | Value                                         |
| ----------------- | --------------------------------------------- |
| `VERIFIKA`        | `1`                                           |
| `VERIFIKA_CHECK`  | the check name                                |
| `VERIFIKA_RUN_ID` | the run id, e.g. `20261012-143955-042-a1b2c3` |

Checks run with piped (non-TTY) output, so most tools disable colours and interactive prompts automatically. Output is written to the check's log file; only a short preview is kept in memory.

### Dependencies

`dependsOn` expresses "must pass before". It does not mean "rerun when the dependency's files change": if `build` is selected, `e2e` is not selected because of it. If a dependency fails, its dependents are reported `blocked` and count as not passed.

### Checks that share outputs

Checks run one at a time by default. Set `defaults.concurrency` (or pass `-j`) to run independent checks in parallel, which can cut a full run substantially (34% on one real project; see [benchmarks](benchmarks.md)).

Only raise it when the checks running together do not write the same files. Examples of sharing that breaks under concurrency:

- a `build` that deletes and recreates `dist/` while another check reads `dist/` (tests importing built packages, a packaging check);
- two scripts that restage the same vendor or generated directory;
- tools that share a cache directory without locking it (for example the Angular CLI's `.angular/cache` used by both `ng build` and `ng test`);
- browser test suites competing for a fixed port.

Running such checks concurrently produces real but misleading failures (missing modules, crashed browsers, timeouts). Verifika reports them as failures, never as passes, but they waste time. Version 1 has no per-check lock. Choose one of:

- keep the default sequential execution;
- `dependsOn`, when one check genuinely needs another's output first (it also pulls the dependency into selective runs and blocks on its failure);
- restructuring the scripts so each check builds into its own output directory, then raising `concurrency`.

## Glob syntax

Globs use forward slashes on every platform and are matched against paths relative to the project root.

| Pattern     | Matches                   |
| ----------- | ------------------------- |
| `*`         | any characters except `/` |
| `**`        | any number of directories |
| `?`         | one character except `/`  |
| `[abc]`     | one of the characters     |
| `{ts,html}` | either alternative        |

Matching is case-sensitive and includes dotfiles (`**/*.md` matches `.github/README.md`). `*.md` matches only at the root; use `**/*.md` for any depth. Patterns must not be absolute or contain backslashes.

Files outside the project root (in a monorepo, for example a root lockfile) are reported as `../path`. `**` never matches them, but explicit patterns can: `"invalidateAll": ["../package-lock.json"]`.

## Change detection semantics

For a selective run against base ref `B`, the changed files are the union of:

1. `git diff --name-status --no-renames <merge-base(B, HEAD)>`: everything that differs between the merge-base and the working tree, which covers commits on your branch plus staged and unstaged changes;
2. `git ls-files --others --exclude-standard`: untracked, non-ignored files.

The merge-base (three-dot) comparison means `--changed-since origin/main` asks "what did this branch change?" and ignores commits that landed on `main` after you branched. With the default base `HEAD`, the merge-base is `HEAD`, so only uncommitted and untracked work counts.

Renames are counted as a deletion of the old path plus an addition of the new path, so checks for either location run. Deleted files count as changed, because deleting a file can break code that imported it. File names are never interpreted by a shell.

When the change set cannot be determined:

| Cause                                      | Implicit selective run (`vfk`)     | Explicit (`--changed`, `--changed-since`) |
| ------------------------------------------ | ---------------------------------- | ----------------------------------------- |
| Not a git repository, or git not installed | Runs everything, prints the reason | Exit 2 with the reason                    |
| Repository has no commits yet              | Runs everything, prints the reason | Exit 2                                    |
| Base ref does not exist                    | Runs everything, prints the reason | Exit 2, with a hint to fetch              |
| No merge-base (shallow clone, unrelated)   | Runs everything, prints the reason | Exit 2, with a hint to unshallow          |

In CI, shallow clones are common. `vfk` in CI runs everything without consulting git. If you opt into `--changed-since` in CI, fetch enough history (`actions/checkout` with `fetch-depth: 0`).

## CI detection

A run counts as CI when `CI` is set to anything other than `false`/`0`/empty, or when any provider variable is set (`GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TRAVIS`, `JENKINS_URL`, `TF_BUILD`, `TEAMCITY_VERSION`, `BITBUCKET_BUILD_NUMBER`, `CODEBUILD_BUILD_ID`, `DRONE`, `APPVEYOR`, `SEMAPHORE`). Environment variables can only turn CI mode on. `CI=false` does not cancel a provider variable, because some build setups export it for unrelated reasons. No variable disables detection. In CI, plain `vfk` always runs every check. A selective CI run needs an explicit `--changed` or `--changed-since <ref>` on the command line, and its output says `selective in CI by request`.

## Run storage

Logs live in `.verifika/` under the project root. Verifika writes `.verifika/.gitignore` containing `*`, so the directory is ignored without touching your own `.gitignore`. Each run directory contains one `<check>.log` per executed check and `run.json`, the same document `--mode json` prints. The latest run, which `vfk logs` shows by default, is the newest run directory. Run ids sort by start time.

Several Verifika processes can share a project directory safely (for example two agents, or an agent and an editor integration):

- Each run directory is created atomically with its `run.json` and an owner record naming the process, which is removed when the run finishes.
- Retention (`keepRuns`) never deletes a run whose owner is still running. Runs left behind by a process that crashed are pruned like finished runs, and so are half-created directories older than an hour.
- "Latest" is derived from the run directories rather than stored in a shared file. Concurrent runs cannot leave it pointing at an older run, and retention (which always keeps the newest runs) can never remove it. If another run started while yours was in progress, your run's result has `"latest": false` and its logs hint includes `--run <id>`, so it always leads to your own logs.
