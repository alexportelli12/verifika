# Contributing

Thanks for helping. Bug reports with a minimal reproduction (config, commands, output of `verifika plan --mode json`) are the most useful contribution.

## Development

Requires Node.js 22.18+ (for running TypeScript sources directly) and git.

```sh
git clone https://github.com/alexportelli12/verifika
cd verifika
npm ci
npm run verify          # the full quality gate, run by Verifika itself
```

`npm run verify` runs `node src/cli.ts --all`, so Verifika verifies itself with the checks in [`verifika.config.json`](verifika.config.json): formatting, lint, typecheck, build, tests, skill validation and a packaged-install smoke test. During development, `npm run verifika` runs only the checks your changes affect, and `npm run verifika -- logs --failed` shows failures.

| Script                | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `npm test`            | Unit and integration tests (Vitest)               |
| `npm run typecheck`   | TypeScript, including tests                       |
| `npm run lint`        | ESLint                                            |
| `npm run format`      | Prettier (write)                                  |
| `npm run build`       | Compile to `dist/`                                |
| `npm run check:skill` | Validate the agent skill against the real CLI     |
| `npm run test:pack`   | Pack, install in isolation, run the installed CLI |

## Guidelines

- Keep the product principles in mind: deterministic selection, never reporting unverified work as passed, minimal output, few dependencies.
- New behaviour needs tests at the cheapest level that proves it. Process, signal and git behaviour belongs in `test/integration`.
- Windows matters. Avoid shell-specific syntax in tests; use the fixture script in `test/helpers/fixture-check.mjs`.
- User-visible changes need a `CHANGELOG.md` entry and documentation updates. If you change a CLI flag or output, update `skills/verifika/SKILL.md`; `npm run check:skill` will catch commands that no longer work.
- The JSON output (`schemaVersion: 1`) and config format (`version: 1`) are public contracts. Additive changes only within a version.

## Releasing (maintainers)

1. Update `version` in `package.json` and the `CHANGELOG.md` section.
2. Merge to `main` with CI green.
3. Tag and push: `git tag v1.2.3 && git push origin v1.2.3`.

The release workflow verifies the tag matches `package.json`, runs the full gate, publishes to npm through trusted publishing with provenance, and creates the GitHub release from the changelog.
