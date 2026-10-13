# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). The CLI flags, exit codes, configuration format (`version: 1`) and JSON output (`schemaVersion: 1`) are the public API.

## [0.0.3] - 2026-10-13

### Added

- Live status block in `human` mode on an interactive terminal: progress and elapsed time, each running check with a spinner, its elapsed time and latest output line, and what queued checks wait on. Finished checks print above it as in line mode. Line output remains the fallback in CI, when piped, with `TERM=dumb`, and with the new `--no-live` flag or `VERIFIKA_LIVE=0`.
- `human` output: a `verifika · <selection> · <n> checks · <j> parallel` header, aligned durations, the command and a rerun hint (`vfk -c <check>`) on failure lines, a `○ not run: build failed` marker for checks blocked by a failed dependency, and an estimate of the time saved by skipped checks from their last recorded durations.
- In `human` mode, the first interrupt prints `stopping… (Ctrl-C again to force)`.
- `vfk logs` on a terminal: local and relative start time (`today 01:12, 3m ago`), clickable OSC 8 log paths (opt out with `VERIFIKA_HYPERLINKS=0`), and paging through `$PAGER` or `less -R -F -X` (`--no-pager` to opt out; never with `--tail`, when piped, or in `agent` mode).
- `vfk plan` in `human` mode colours `run` and dims skipped checks.
- `vfk init` adds `"verify": "vfk"` and `"verify:ci": "vfk --all"` to `package.json` when they are absent, keeping its indentation, line endings, key order and trailing newline; existing scripts are never overwritten.
- JSON (additive, `schemaVersion: 1`): `checks[].blockedBy` on blocked checks in run results, naming the dependency that did not pass; `checks[].requiredBy` in plan output on checks selected only as dependencies.

### Changed

- **`npm run verify` is now selective.** The recommended scripts are `"verify": "vfk"` for local work and `"verify:ci": "vfk --all"` for the full gate; use `npm run verify:ci` (or `vfk --all`) in CI and before delivery. The README setup prompt, docs and agent skill say so, and the prompt only replaces an existing `verify` script when the configured checks cover what it ran. If you followed the 0.0.2 setup, your `"verify": "vfk --all"` script still runs the full gate; to adopt the split, rename it to `verify:ci` and add `"verify": "vfk"` by hand (`vfk init` only adds scripts when it creates the config).
- A check pulled in by several dependents now names all of them (`required by test, pack`), in plan output and reasons.
- Failure previews leave out package-manager script banners (`> app@1.0.0 lint`, `> eslint .`, yarn's `$ …`).

### Fixed

- ESLint failure previews showed only the `✖ N problems` summary; they now keep each `line:col  error` line under its file heading, plus the summary.
- A failed check whose preview was hidden by the three-preview limit looked as if nothing was found; its line now says `(preview omitted: vfk logs <check>)`, in `human` and `agent` output.

## [0.0.2] - 2026-10-12

### Changed

- `vfk` is now the advertised command: `--help`, run hints (`Run: vfk logs <check>`), error hints, the README, the docs and the agent skill use it. `verifika` keeps working and is identical.

### Added

- README: a copy-paste prompt that has a coding agent install Verifika, write and validate a config, and install the skill.

## [0.0.1] - 2026-10-12

First public release.

### Added

- `vfk`: a shorthand executable for `verifika`, installed by the same package.
- `verifika` / `verifika run`: runs configured checks concurrently with dependency ordering, per-check timeouts, optional fail-fast, process-tree cleanup and signal handling.
- Safety defaults: checks run sequentially unless `defaults.concurrency` or `-j` opts into parallelism; CI always runs the full suite unless `--changed`/`--changed-since` is passed explicitly (environment variables cannot switch CI mode off); a check passes only if its process tree was confirmed cleaned up; concurrent Verifika invocations in one directory keep their run records and logs apart.
- Hybrid selection: selective runs from git changes locally (`changes.base`, `--changed`, `--changed-since <ref>` with merge-base semantics), full runs in CI and with `--all`, explicit `--check`. Global invalidation (`invalidateAll`), `paths`/`exclude` globs, `always` checks and `dependsOn`.
- Conservative fallbacks: full runs when git cannot determine changes implicitly; exit 2 when an explicit comparison is impossible.
- Output modes: `human` (live progress), `agent` (one line on success, bounded failure preview), `json` (versioned result, `schemaVersion: 1`) and `quiet`.
- `verifika plan` to show selection decisions and reasons without running checks.
- `verifika logs` with `--failed`, `--tail` and `--run`; logs stored in a self-ignoring `.verifika/` directory with retention (`defaults.keepRuns`).
- `verifika init` to create a starter config from `package.json` scripts.
- JSON schema for `verifika.config.json` with editor autocomplete.
- Agent skill (`skills/verifika/SKILL.md`) for Claude Code, Codex, OpenCode and other agents.
- Published to npm as `verifika`; the package tarball is also attached to the GitHub release.

### Known limitations

- No per-check lock: checks that write shared outputs need `dependsOn` or `concurrency: 1` (see the configuration reference).
- A process that deliberately detaches from the check (on Linux and macOS: leaves the process group, for example via `setsid`; on Windows: breaks away from the job with an exited intermediate parent) is not tracked unless it keeps the check's output open, in which case the check is reported as `error`.
- On Windows, confirming cleanup queries the process table with PowerShell after each check, which costs roughly 0.5–3 s per check.

[0.0.3]: https://github.com/alexportelli12/verifika/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/alexportelli12/verifika/releases/tag/v0.0.2
[0.0.1]: https://github.com/alexportelli12/verifika/releases/tag/v0.0.1
