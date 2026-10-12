# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). The CLI flags, exit codes, configuration format (`version: 1`) and JSON output (`schemaVersion: 1`) are the public API.

## [1.0.0] - 2026-10-12

First stable release.

### Added

- `verifika` / `verifika run`: runs configured checks concurrently with dependency ordering, per-check timeouts, optional fail-fast, process-tree cleanup and signal handling.
- Hybrid selection: selective runs from git changes locally (`changes.base`, `--changed`, `--changed-since <ref>` with merge-base semantics), full runs in CI and with `--all`, explicit `--check`. Global invalidation (`invalidateAll`), `paths`/`exclude` globs, `always` checks and `dependsOn`.
- Conservative fallbacks: full runs when git cannot determine changes implicitly; exit 2 when an explicit comparison is impossible.
- Output modes: `human` (live progress), `agent` (one line on success, bounded failure preview), `json` (versioned result, `schemaVersion: 1`) and `quiet`.
- `verifika plan` to show selection decisions and reasons without running checks.
- `verifika logs` with `--failed`, `--tail` and `--run`; logs stored in a self-ignoring `.verifika/` directory with retention (`defaults.keepRuns`).
- `verifika init` to create a starter config from `package.json` scripts.
- JSON schema for `verifika.config.json` with editor autocomplete.
- Agent skill (`skills/verifika/SKILL.md`) for Claude Code, Codex, OpenCode and other agents.
- Distributed as a prebuilt package tarball attached to the GitHub release (not yet on the npm registry).

### Known limitations

- No per-check lock: checks that write shared outputs need `dependsOn` or `concurrency: 1` (see the configuration reference).
- Leftover background processes cannot be reaped on Windows once a check's main process has exited, or on POSIX when they leave the process group; Verifika reports them as a check warning.
- Not yet published to the npm registry.

[1.0.0]: https://github.com/alexportelli12/verifika/releases/tag/v1.0.0
