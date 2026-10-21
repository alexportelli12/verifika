# Contributing

Thanks for helping. Bug reports with a minimal reproduction (config, commands, output of `vfk plan --mode json`) are the most useful contribution.

## Development

Requires Node.js 22.18+ (for running TypeScript sources directly) and git.

```sh
git clone https://github.com/alexportelli12/verifika
cd verifika
npm ci
npm run verify:ci       # the full quality gate, run by Verifika itself
```

`npm run verify:ci` runs `node src/cli.ts --all`, so Verifika verifies itself with the checks in [`verifika.config.json`](verifika.config.json): formatting, lint, typecheck, build, tests, skill validation, a packaged-install smoke test, and the documentation checks described under [Documentation](#documentation). During development, `npm run verify` (`node src/cli.ts`) runs only the checks your changes affect, and `node src/cli.ts logs --failed` shows failures. Run `npm run verify:ci` before opening a pull request.

| Script                | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `npm test`            | Unit and integration tests (Vitest)               |
| `npm run typecheck`   | TypeScript, including tests                       |
| `npm run lint`        | ESLint                                            |
| `npm run format`      | Prettier (write)                                  |
| `npm run build`       | Compile to `dist/`                                |
| `npm run check:skill` | Validate the agent skill against the real CLI     |
| `npm run test:pack`   | Pack, install in isolation, run the installed CLI |
| `npm run docs:build`  | Build the documentation site into `site/docs/`    |
| `npm run check:docs`  | Build the site and fail on a broken link          |
| `npm run prose`       | Vale: British spelling, glossary, sentence length |

## Guidelines

- Keep the product principles in mind: deterministic selection, never reporting unverified work as passed, minimal output, few dependencies.
- New behaviour needs tests at the cheapest level that proves it. Process, signal and git behaviour belongs in `test/integration`.
- Windows matters. Avoid shell-specific syntax in tests; use the fixture script in `test/helpers/fixture-check.mjs`.
- User-visible changes need a `CHANGELOG.md` entry and documentation updates: a change updates its docs in the same pull request (see [Documentation](#documentation)). If you change a CLI flag or output, update `skills/verifika/SKILL.md`; `npm run check:skill` will catch commands that no longer work.
- The JSON output (`schemaVersion: 1`) and config format (`version: 1`) are public contracts. Additive changes only within a version.

## Documentation

The documentation site at <https://alexportelli12.github.io/verifika/docs/> has searchable guides and reference pages. Most of it is generated from files that already own the facts, so a change updates its docs in the same pull request:

| Page                  | Source                                                                   | You do                                           |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Configuration options | `schemas/verifika.schema.json`                                           | Give the option a `description`; nothing else.   |
| Command-line options  | `vfk --help` (`HELP` in `src/main.ts`) and `ExitCode` in `src/errors.ts` | Document the flag in the help text.              |
| Example pages         | `examples/*.json` and the table in `examples/README.md`                  | Add the file and its table row.                  |
| Agent skill           | `skills/verifika/SKILL.md`                                               | Edit the skill; `npm run check:skill` guards it. |
| Changelog             | `CHANGELOG.md`                                                           | Add an entry.                                    |
| Guides                | `docs/*.md`, written by hand                                             | Update the page when a source it lists changes.  |

`npm ci` runs no install scripts. The first `npm run prose` downloads the pinned Vale release from GitHub's release download URL, checks its SHA-256 against the hashes in `scripts/docs/vale.mjs`, and caches the binary in `node_modules/.cache/vale/`. Later runs reuse it. To bump Vale, change the version and hashes in that script.

Each guide lists what it describes in `sources:` frontmatter and the date it was last checked in `reviewed:`. The `docs-fresh` check fails when a branch changes a listed source without touching the page. Update the page, or bump `reviewed` when nothing needs to change. `README.md` and `site/index.html` cannot carry frontmatter, so `docs/freshness.json` holds their declarations. The check compares with the merge base of `HEAD` and origin's default branch; it fails rather than skips when it cannot find one, so run `git fetch origin` or set `VERIFIKA_DOCS_BASE`.

The `docs` check builds the whole site and fails on a broken internal link or when the landing page's setup prompt drifts from the README's. The `prose` check runs [Vale](https://vale.sh) with the Verifika style in `.vale/`: British spelling, a glossary, no filler words and sentences under 30 words. The README is the npm front page and ships in the package, so keep it concise and link to the docs for detail.

Agents and people writing docs here follow the shared `docs-writing` skill from [mexxi](https://github.com/alexportelli12/mexxi/blob/main/skills/docs-writing/SKILL.md). The Vale style and the build scripts are copies of mexxi's, adapted for Verifika, and get extracted into a shared package once a third repository needs them.

The generated pages are written to `docs-site/` and built into `site/docs/`; both are gitignored and not part of the npm package.

## Website

The landing page at <https://alexportelli12.github.io/verifika/> is plain HTML, CSS and JavaScript in `site/`, with no build step of its own; the documentation builds into `site/docs/` beside it. Preview it with any static server from the repository root (for example `python3 -m http.server --directory site`); every URL in it is relative, so it also works under the `/verifika/` path GitHub Pages serves it from. The [website workflow](.github/workflows/pages.yml) runs `npm run docs:build` and deploys `site/` when the site, the docs or their sources change on `main`; it needs Settings → Pages → Source set to "GitHub Actions" (a one-time setting). `site/` is not part of the npm package.

The docs build uses absolute links under `/verifika/docs/`. To preview the site from a server root, build with `DOCS_URL_BASE=/docs/ npm run docs:build` and serve `site/`.

The terminal recordings in `site/media/` are made from the published CLI by `scripts/demo/record.sh`, which needs Docker. It runs [VHS](https://github.com/charmbracelet/vhs) on the demo repository in `scripts/demo/fixture/`, whose checks print fixed output at fixed times, so recordings are repeatable (measured durations can differ by a tenth of a second). Re-record after a release that changes `human` output, and commit the new files.

## Releasing (maintainers)

Pushing a `v<version>` tag runs the [release workflow](.github/workflows/release.yml). It checks that the tag matches `package.json` and is on `main`, runs the full gate, stages the tested tarball on npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, with provenance; no npm token is stored), and creates the GitHub release with the tarball attached. A staged version only becomes public when a maintainer approves it with 2FA, so a compromised workflow cannot publish on its own. Re-running a failed release is safe once its staged version has been approved or rejected: versions already on npm are skipped.

### Releasing a new version

1. In a pull request, update `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`) and add the `CHANGELOG.md` section.
2. Merge to `main` with CI green.
3. Tag the merge commit and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
4. Approve the `release` deployment in the workflow run, if the environment requires a reviewer.
5. Approve the staged version on npmjs.com (`verifika` → staged versions), or with `npm stage list verifika` and `npm stage approve <id>`. Both ask for 2FA.

### One-time setup (first release only)

npm can only attach a trusted publisher to a package that already exists, so the first version is published by hand:

1. Enable two-factor authentication on the npm account (npmjs.com → Account → Two-Factor Authentication).
2. From a clean checkout of `main` at the release commit: `npm ci && npm run verify:ci && npm publish --access public`.
3. On npmjs.com → `verifika` → Settings → Trusted publishing, add a GitHub Actions publisher: user `alexportelli12`, repository `verifika`, workflow `release.yml`, environment `release`. Allow staged publishing only; leave "Allow publish" unchecked. Then, under Publishing access, choose "Require two-factor authentication and disallow tokens".
4. On GitHub → Settings → Environments → `release` (created by the first workflow run, or add it by hand), add yourself as a required reviewer and limit deployments to tags matching `v*.*.*`.
5. Push the `v<version>` tag. The workflow sees the version is already on npm, skips publishing and creates the GitHub release.
