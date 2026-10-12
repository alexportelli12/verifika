# Verifika

[![CI](https://github.com/alexportelli12/verifika/actions/workflows/ci.yml/badge.svg)](https://github.com/alexportelli12/verifika/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/verifika)](https://www.npmjs.com/package/verifika)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run the checks your changes need, concurrently, with minimal output.

Verifika is a small CLI for repository verification. You declare your checks (lint, typecheck, tests, build, ...) in `verifika.config.json`. Locally, Verifika runs only the checks affected by your changes; in CI it runs everything. Successful runs print one line, failures print exactly what failed and how to see the full logs. It works the same for developers, CI pipelines and AI coding agents (Claude Code, Codex, OpenCode, and others).

```text
$ verifika
PASS 3/3 (4.1s) selective: 2 files changed since HEAD (a1b2c3d); 2 skipped

$ verifika --all
FAIL 4/5 (12s) full run (--all)
typecheck: exit 2
  src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.
Run: verifika logs typecheck
```

_Verifika_ is Maltese for "verification".

## Why

- **Deterministic.** Check selection comes from your config, file globs, dependencies and git. No heuristics, no LLM. When the change scope is unclear, Verifika runs everything or fails loudly; it never quietly skips a check.
- **Token-efficient.** Agents get one line on success and a bounded failure preview on failure. Full logs stay on disk until asked for.
- **Fast.** Independent checks run in parallel, within a concurrency limit. One small runtime dependency.
- **Reliable.** Timeouts, fail-fast, process cleanup, correct exit codes and signal handling, tested on Linux, macOS and Windows.

## Install

Requires Node.js 22.13 or newer.

```sh
npm install --save-dev verifika
```

Or run it without installing: `npx verifika`.

## Quick start

Generate a starter config from your `package.json` scripts:

```sh
npx verifika init
```

Or write `verifika.config.json` yourself:

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

Then:

```sh
npx verifika plan     # which checks would run for your changes, and why
npx verifika          # run them
npx verifika --all    # run everything (do this before you push)
```

Add a script so everyone runs the same full gate:

```json
{ "scripts": { "verify": "verifika --all" } }
```

## How checks are selected

| Situation                                      | What runs                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `verifika` locally                             | Checks whose `paths` match files changed since `changes.base` (default `HEAD`: your uncommitted and untracked work) |
| `verifika` in CI (`CI` or a known CI variable) | Everything                                                                                                          |
| `verifika --all`                               | Everything                                                                                                          |
| `verifika --check lint`                        | `lint` and its dependencies                                                                                         |
| `verifika --changed-since origin/main`         | Checks matching files changed since `merge-base(origin/main, HEAD)`, plus uncommitted and untracked files           |
| A changed file matches `invalidateAll`         | Everything                                                                                                          |
| Git unavailable, no commits, unknown base      | Everything, with the reason printed (or an error, when you asked for `--changed`/`--changed-since` explicitly)      |

A check without `paths` runs whenever any file changed; `"always": true` runs it even when nothing changed. Selecting a check also selects its `dependsOn` checks. `verifika plan` shows every decision.

## Output modes

The default is `human` on an interactive terminal and `agent` otherwise. Override with `--mode` or `VERIFIKA_MODE`.

| Mode    | Success                       | Failure                                             |
| ------- | ----------------------------- | --------------------------------------------------- |
| `human` | Live progress, summary        | Failing checks, previews, logs hint                 |
| `agent` | One line: `PASS 4/4 (4.3s) …` | One line per problem, bounded preview, logs command |
| `json`  | Versioned result document     | Same document, `"status": "failed"`                 |
| `quiet` | Nothing                       | One line on stderr                                  |

Exit codes: `0` passed (or nothing to verify), `1` verification failed, `2` usage or configuration error, `128+n` interrupted by a signal (`130` SIGINT, `143` SIGTERM).

## Logs

Every run stores each check's combined stdout/stderr under `.verifika/runs/<run-id>/`. The directory ignores itself in git, and only the last 10 runs are kept (`defaults.keepRuns`).

```sh
verifika logs                    # latest run: statuses and log paths
verifika logs typecheck          # full log of one check
verifika logs --failed           # logs of every failed check
verifika logs test --tail 50     # last 50 lines
```

Logs contain whatever your commands print, which can include secrets. They never leave your machine; keep `.verifika/` out of anything you publish.

## Agent integration

Verifika ships an [agent skill](skills/verifika/SKILL.md) that teaches coding agents when to run selective versus full verification, how to read results, and how not to claim success too early. See [docs/agents.md](docs/agents.md) to install it for Claude Code, Codex or OpenCode.

## Documentation

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
