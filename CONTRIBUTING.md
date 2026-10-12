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

Pushing a `v<version>` tag runs the [release workflow](.github/workflows/release.yml). It checks that the tag matches `package.json` and is on `main`, runs the full gate, publishes the tested tarball to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance; no npm token is stored), and creates the GitHub release with the tarball attached. Versions already on npm are not published again, so a failed run can be re-run safely.

### Releasing a new version

1. In a pull request, update `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`) and add the `CHANGELOG.md` section.
2. Merge to `main` with CI green.
3. Tag the merge commit and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
4. Approve the `release` deployment in the workflow run, if the environment requires a reviewer.

### One-time setup (first release only)

npm can only attach a trusted publisher to a package that already exists, so the first version is published by hand:

1. Enable two-factor authentication on the npm account (npmjs.com → Account → Two-Factor Authentication).
2. From a clean checkout of `main` at the release commit: `npm ci && npm run verify && npm publish --access public`.
3. On npmjs.com → `verifika` → Settings → Trusted publishing, add a GitHub Actions publisher: user `alexportelli12`, repository `verifika`, workflow `release.yml`, environment `release`. Then, under Publishing access, choose "Require two-factor authentication and disallow tokens".
4. On GitHub → Settings → Environments → `release` (created by the first workflow run, or add it by hand), add yourself as a required reviewer and limit deployments to tags matching `v*.*.*`.
5. Push the `v<version>` tag. The workflow sees the version is already on npm, skips publishing and creates the GitHub release.
