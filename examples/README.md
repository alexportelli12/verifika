# Example configurations

Starting points to copy into your project as `verifika.config.json`. Adjust script names and globs to your layout, then check the result with `npx vfk plan`.

| File                                             | For                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [`node-library.json`](node-library.json)         | A TypeScript library: format, lint, typecheck, tests, build; 3 checks at once, since none shares outputs |
| [`angular-app.json`](angular-app.json)           | An Angular app with unit tests, a production build and Playwright e2e                                    |
| [`nx-monorepo.json`](nx-monorepo.json)           | An Nx workspace using `nx affected` inside each check                                                    |
| [`monorepo-package.json`](monorepo-package.json) | One package of a monorepo, invalidated by the root lockfile                                              |

Checks run one at a time unless `defaults.concurrency` says otherwise. The Angular and Nx examples stay sequential on purpose: `ng build` and `ng test` share the Angular cache, and Nx targets often share build outputs. See [checks that share outputs](../docs/configuration.md#checks-that-share-outputs).
