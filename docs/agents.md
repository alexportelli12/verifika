# Agent integration

Verifika has no agent-specific runtime behaviour. Any agent that can run a shell command can use it: when stdout is not a terminal, output defaults to the compact `agent` mode, and exit codes carry the result.

What agents need is the right habits: run selective checks while iterating, run the full suite before delivery, read only failing logs, and never report success without a finished `PASS`. The bundled skill teaches exactly that.

## The skill

[`skills/verifika/SKILL.md`](../skills/verifika/SKILL.md) follows the [Agent Skills](https://agentskills.io) format (a directory with a `SKILL.md` containing `name` and `description` frontmatter), which Claude Code, Codex and OpenCode all load. One skill serves all of them. It is about 110 lines, and agents load the body only when the description matches the task.

The skill ships in the npm package (`node_modules/verifika/skills/verifika/`) and in this repository. Every `vfk` command it mentions is executed against the real CLI in this repository's test suite (`npm run check:skill`), so it cannot drift from the CLI.

## Install the skill

Copy the `skills/verifika` directory into a skills location your agent reads. From a project with Verifika installed:

| Agent       | Personal (all projects)               | Project (commit it for your team) |
| ----------- | ------------------------------------- | --------------------------------- |
| Claude Code | `~/.claude/skills/verifika/`          | `.claude/skills/verifika/`        |
| Codex       | `~/.agents/skills/verifika/`          | `.agents/skills/verifika/`        |
| OpenCode    | `~/.config/opencode/skills/verifika/` | `.opencode/skills/verifika/`      |

```sh
# Claude Code, personal
mkdir -p ~/.claude/skills && cp -R node_modules/verifika/skills/verifika ~/.claude/skills/

# Codex, personal
mkdir -p ~/.agents/skills && cp -R node_modules/verifika/skills/verifika ~/.agents/skills/

# OpenCode, personal
mkdir -p ~/.config/opencode/skills && cp -R node_modules/verifika/skills/verifika ~/.config/opencode/skills/

# Any agent, project-level (example for Claude Code)
mkdir -p .claude/skills && cp -R node_modules/verifika/skills/verifika .claude/skills/
```

Without a local install, take the skill from GitHub:

```sh
git clone --depth 1 https://github.com/alexportelli12/verifika /tmp/verifika
cp -R /tmp/verifika/skills/verifika ~/.claude/skills/
```

Recent OpenCode versions also read Claude-compatible `.claude/skills/` directories, so one project-level copy can serve several agents; check your agent's documentation if a location is not picked up. Restart the agent session after installing; skills are discovered at startup.

## Without the skill

For agents without skill support, put the essentials in your project's `AGENTS.md` / `CLAUDE.md`:

```markdown
## Verification

- Run `npx vfk` (or `npm run verify`) after changes; it runs only the affected checks.
- Before saying a task is done, committing or opening a PR, run the full gate, `npx vfk --all` (or `npm run verify:ci`), and require `PASS` with exit code 0. `npm run verify` is selective and is not the gate.
- On failure, read the printed preview, then `npx vfk logs <check>` (or `--failed`). Do not read logs of passing checks.
- A selective PASS does not cover skipped checks. Exit 2 means a usage/config error, not a passing run.
```

## Typical session

```text
$ npx vfk                        # after editing src/cart.ts
FAIL 1/2 (2.8s) selective: 1 file changed since HEAD (a1b2c3d); 3 skipped
typecheck: exit 2
  src/cart.ts(14,7): error TS2322: Type 'string' is not assignable to type 'number'.
Run: vfk logs typecheck

$ npx vfk --check typecheck      # after the fix
PASS 1/1 (2.1s) explicit: --check typecheck; 4 skipped

$ npx vfk --all                  # before delivery
PASS 5/5 (14s) full run (--all)
```

## Wiring into existing workflows

- **npm scripts.** `vfk init` adds `"verify": "vfk"` (selective) and `"verify:ci": "vfk --all"` (the full gate). Because `npm run verify` is selective, it is not the pre-delivery gate: agents and workflows that need the authoritative gate before delivery must run `npm run verify:ci` (or `npx vfk --all`). If your workflow is hard-wired to `npm run verify` as its gate, point that workflow at `npm run verify:ci` rather than turning `verify` back into a full run.
- **CI.** Run `npm run verify:ci` (or `npx vfk --all`). Plain `npx vfk` also runs everything in CI, but the explicit gate does not depend on CI detection. Use `--mode json` if a later step needs structured results, and upload `.verifika/runs/` as an artifact if you want logs (they may contain secrets).
- **Hooks.** For a pre-push hook, use `npx vfk --changed-since origin/main` for speed, but keep `--all` in CI.
