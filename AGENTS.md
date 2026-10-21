# AGENTS.md

Verifika is a Node.js CLI (`verifika`, short `vfk`) that verifies itself: the checks in `verifika.config.json` run through its own source in `src/`. [CONTRIBUTING.md](CONTRIBUTING.md) has the full development guide; this is the short version.

## Install

Node.js 22.18 or newer (TypeScript sources run directly) and git.

```sh
npm ci
```

## Run

```sh
node src/cli.ts --help   # the CLI from source
npm run build            # compile to dist/ (what the package ships)
```

There is no app or data to seed. Tests create their own temporary git repositories.

## Test and verify

```sh
npm run verify   # the full gate: node src/cli.ts --all (CI runs the same)
npm run vfk      # only the checks your changes affect, for quick feedback
npm test         # Vitest unit and integration tests
node src/cli.ts logs --failed   # logs of the checks that failed
```

`npm run verify` must pass before committing or opening a pull request. The first `prose` check downloads a pinned Vale binary into `node_modules/.cache/vale/`. The `docs-fresh` check compares with origin's default branch, so run `git fetch origin` first.

## Website preview

The landing page and docs site in `site/` are static. To preview them on a port (`PORT` honoured, default 4300):

```sh
DOCS_URL_BASE=/docs/ npm run docs:build
python3 -m http.server "${PORT:-4300}" --directory site
```

There is no preview deployment: GitHub Pages deploys from `main` only.

## Conventions

- Product principles, test placement, Windows support and documentation rules are in [CONTRIBUTING.md](CONTRIBUTING.md#guidelines).
- User-visible changes need a `CHANGELOG.md` entry and their docs updated in the same pull request.
