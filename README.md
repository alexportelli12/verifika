# Verifika

[![CI](https://github.com/alexportelli12/verifika/actions/workflows/ci.yml/badge.svg)](https://github.com/alexportelli12/verifika/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/alexportelli12/verifika)](https://github.com/alexportelli12/verifika/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Run only the checks your change needs. Get one line back when they pass.**

Every repository has a verification gate: format, lint, typecheck, tests, build. Using it well is harder than it looks:

- **Running everything is slow.** A one-line fix waits minutes for checks it cannot affect, so people (and agents) skip the gate or batch changes until the end.
- **Picking checks by hand is unreliable.** It is easy to forget the one that breaks, and "it passed" stops meaning much.
- **Failures are buried in noise.** A test runner can print tens of thousands of lines to report one failed assertion. A coding agent pays for every line in tokens and context, and often never reaches the line that matters.

Verifika fixes this with one config file and one command. You list your checks in `verifika.config.json`, with the files each one covers. Then `vfk` runs only the checks your changes affect, CI runs all of them, and the output says exactly what failed:

```text
$ vfk
PASS 3/3 (4.1s) selective: 2 files changed since HEAD (a1b2c3d); 2 skipped

$ vfk --all
FAIL 4/5 (12s) full run (--all)
typecheck: exit 2
  src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.
Run: vfk logs typecheck
```

## Why Verifika

- **Small output, especially for agents.** On a real Angular project, one failing test produced 94,900 bytes of output with the project's previous verify script (~23,700 tokens). Verifika reported the same failure in 369 bytes (~90 tokens): the test name, the assertion and the totals. Full logs stay on disk until you ask for them.
- **Less waiting.** Locally, only affected checks run: in a 25-check monorepo, a typical edit ran 1–13 of them. Checks that share no build outputs can also run in parallel. On that Angular project, four at a time cut the full gate from 95.5 s to 61.7 s. [Measurements](docs/benchmarks.md).
- **Deterministic and conservative.** Selection comes from your config, file globs, dependencies and git; no heuristics, no LLM. When the scope of a change is unclear, Verifika runs everything or fails loudly. It never quietly skips a check, and in CI it runs the full suite unless you explicitly ask for a selective run.
- **Trustworthy results.** Timeouts, fail-fast, correct exit codes and signal handling. A check only passes once its whole process tree has exited. Tested on Linux, macOS and Windows.
- **Built for humans and coding agents alike.** Live progress on a terminal, one line in agent sessions, JSON for scripts. It ships an [agent skill](skills/verifika/SKILL.md) for Claude Code, Codex, OpenCode and others.
- **Small.** One JSON file, one runtime dependency, no daemon, no cache to invalidate.

_Verifika_ is Maltese for "verification". The command is `vfk`, short for `verifika`; both are installed and identical.

## Get started

Requires Node.js 22.13 or newer.

### With a coding agent

Paste this prompt into Claude Code, Codex, OpenCode or another coding agent, from your repository root. It installs Verifika, writes and validates a config for your project, and reports what it found.

```text
Set up Verifika (https://github.com/alexportelli12/verifika) in this repository.

1. Check that Node.js is 22.13 or newer, and install the project's dependencies if
   they are missing. Install Verifika as a dev dependency with this repository's
   package manager (npm install --save-dev verifika, or the pnpm/yarn equivalent).
   It provides the `vfk` command.
2. Run `npx vfk init` to create verifika.config.json, then refine it by reading
   package.json, the CI workflows and the tool configs:
   - One check per quality gate the project actually has (such as format, lint,
     typecheck, unit tests, build). Do not invent checks for tools it does not use,
     or add a check that another one already fully covers. Every command must be
     non-interactive and exit on its own: no watch mode, no prompts, no dev servers.
   - Give each check `paths` globs for the files that can affect it, so local runs
     select only what a change needs. If unsure, leave `paths` out: the check then
     runs on every change.
   - Add `dependsOn` where one check needs another's output (for example e2e after build).
   - Keep concurrency at 1 unless the checks clearly share no build outputs.
   - Make sure package.json has two scripts: "verify": "vfk" (selective, for local
     work) and "verify:ci": "vfk --all" (the full gate). `vfk init` adds them when
     they are missing. If a "verify" or "verify:ci" script already exists, replace
     it only when the configured checks cover everything it ran; otherwise leave it
     and report the conflict. This is the one exception to the rule below about
     existing scripts.
   - If the CI workflow runs the gate some other way, report that switching it to
     `npm run verify:ci` is recommended. Do not edit the workflow.
   Reference: https://github.com/alexportelli12/verifika/blob/main/docs/configuration.md
3. Validate the config:
   - Run `npx vfk --all`. If a check fails, decide whether the config is wrong (fix it)
     or the project already fails that check (report it; do not fix it).
   - Run `npx vfk plan`. Until this setup is committed, the changed package.json and
     lockfile select every check; that is expected. Explain which checks a typical
     source edit and a documentation-only edit would select once it is committed.
4. Install the agent skill: copy node_modules/verifika/skills/verifika into this
   agent's skills directory (see
   https://github.com/alexportelli12/verifika/blob/main/docs/agents.md).

Do not change source code or existing scripts to make checks pass (except "verify"
and "verify:ci", as step 2 describes), and do not commit.
Finish with: the checks you configured and why, the --all result, the expected
selection for those two edits, the scripts you added, replaced or left (with any
conflicts), any CI recommendation, and any existing failures you found.
```

Review the config it writes before committing it: the commands in it run on every verification.

### By hand

```sh
npm install --save-dev verifika
npx vfk init     # creates verifika.config.json from your package.json scripts,
                 # and adds "verify" / "verify:ci" scripts if they are missing
```

`init` only maps conventional script names (`lint`, `test`, `build`, ...) and leaves every check unfiltered, so open the file and give each check `paths`:

```json
{
  "$schema": "./node_modules/verifika/schemas/verifika.schema.json",
  "version": 1,
  "changes": {
    "invalidateAll": ["package.json", "package-lock.json", "tsconfig*.json"]
  },
  "checks": {
    "format": { "command": "npm run format:check" },
    "lint": { "command": "npm run lint", "paths": ["src/**/*.{ts,html}"] },
    "typecheck": { "command": "npm run typecheck", "paths": ["src/**/*.ts"] },
    "test": { "command": "npm test", "paths": ["src/**", "test/**"] },
    "build": { "command": "npm run build", "paths": ["src/**"], "dependsOn": ["typecheck"] }
  }
}
```

If your repository checks the formatting of every file (for example `prettier --check .`), format the new `verifika.config.json` too. Then:

```sh
npx vfk plan     # which checks would run for your changes, and why
npx vfk          # run them
npx vfk --all    # run everything (do this before you push)
```

`init` adds two scripts unless package.json already has scripts with those names (it never overwrites them):

```json
{ "scripts": { "verify": "vfk", "verify:ci": "vfk --all" } }
```

`npm run verify` runs the checks your changes affect, for quick feedback while you work. `npm run verify:ci` runs every check: it is the full gate, so use it in CI and before you push or open a pull request.

Run logs go to `.verifika/`, which ignores itself in git, so you do not need to edit `.gitignore`. To install globally instead, run `npm install --global verifika`.

## How checks are selected

| Situation                                 | What runs                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `vfk` locally                             | Checks whose `paths` match files changed since `changes.base` (default `HEAD`: your uncommitted and untracked work) |
| `vfk` in CI (`CI` or a known CI variable) | Everything; only `--changed`/`--changed-since` on the command line can narrow it                                    |
| `vfk --all`                               | Everything                                                                                                          |
| `vfk --check lint`                        | `lint` and its dependencies                                                                                         |
| `vfk --changed-since origin/main`         | Checks matching files changed since `merge-base(origin/main, HEAD)`, plus uncommitted and untracked files           |
| A changed file matches `invalidateAll`    | Everything                                                                                                          |
| Git unavailable, no commits, unknown base | Everything, with the reason printed (or an error, when you asked for `--changed`/`--changed-since` explicitly)      |

A check without `paths` runs whenever any file changed; `"always": true` runs it even when nothing changed. Selecting a check also selects its `dependsOn` checks. `vfk plan` shows every decision.

## Output modes

The default is `human` on an interactive terminal and `agent` otherwise. Override with `--mode` or `VERIFIKA_MODE`.

| Mode    | Success                       | Failure                                                         |
| ------- | ----------------------------- | --------------------------------------------------------------- |
| `human` | Live status block, summary    | Failing checks with command and rerun hint, previews, logs hint |
| `agent` | One line: `PASS 4/4 (4.3s) …` | One line per problem, bounded preview, logs command             |
| `json`  | Versioned result document     | Same document, `"status": "failed"`                             |
| `quiet` | Nothing                       | One line on stderr                                              |

In `human` mode on an interactive terminal, a live status block shows progress, each running check with its latest output line, and what the queued checks wait on. Finished checks print above it. In CI, when piped, with `TERM=dumb`, or with `--no-live` / `VERIFIKA_LIVE=0`, `human` mode prints plain lines instead. These are one per check start and end, plus a note every 30 seconds for long checks, and they read well in logs. `NO_COLOR` turns colour off in both.

Exit codes: `0` passed (or nothing to verify), `1` verification failed, `2` usage or configuration error, `128+n` interrupted by a signal (`130` SIGINT, `143` SIGTERM).

## Logs

Every run stores each check's combined stdout/stderr under `.verifika/runs/<run-id>/`. The directory ignores itself in git, and only the last 10 runs are kept (`defaults.keepRuns`).

```sh
vfk logs                  # latest run: statuses and log paths
vfk logs typecheck        # full log of one check
vfk logs --failed         # logs of every failed check
vfk logs test --tail 50   # last 50 lines
```

Logs contain whatever your commands print, which can include secrets. They never leave your machine; keep `.verifika/` out of anything you publish.

## Agent integration

Verifika ships an [agent skill](skills/verifika/SKILL.md) that teaches coding agents when to run selective versus full verification, how to read results, and how not to claim success too early. See [docs/agents.md](docs/agents.md) to install it for Claude Code, Codex or OpenCode.

## Documentation

- [Documentation site](https://alexportelli12.github.io/verifika/docs/): searchable guides and generated reference
- [Website](https://alexportelli12.github.io/verifika/)
- [Configuration reference](docs/configuration.md)
- [CLI reference](docs/cli.md)
- [Agent integration](docs/agents.md)
- [Architecture](docs/architecture.md)
- [Validation and benchmarks](docs/benchmarks.md)
- [Example configs](examples/)
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Trust model

`verifika.config.json` is trusted code: its commands run through your shell with your permissions, exactly like `package.json` scripts. Verifika never puts file names, git refs or other external input into those commands. Review config changes as carefully as script changes.

## License

[MIT](LICENSE)
