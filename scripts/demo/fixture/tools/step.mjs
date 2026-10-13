// Stand-in for a real tool: prints a fixed script of output lines at fixed
// times, so the recorded demo is identical on every run.
const steps = {
  format: [
    [300, "Checking formatting..."],
    [500, "All matched files use Prettier code style!"],
  ],
  lint: [
    [400, "Linting 48 files"],
    [700, "src/cart.ts"],
    [600, "src/checkout.ts"],
    [300, "0 problems"],
  ],
  typecheck: [
    [600, "tsc --noEmit -p tsconfig.json"],
    [1500, "Found 0 errors."],
  ],
  test: [
    [700, "✓ test/money.test.ts (6 tests)"],
    [600, "✓ test/cart.test.ts (14 tests)"],
    [800, "✓ test/checkout.test.ts (9 tests)"],
    [700, "✓ test/inventory.test.ts (11 tests)"],
    [200, "Tests  40 passed (40)"],
  ],
  build: [
    [500, "vite v7 building for production..."],
    [900, "✓ 212 modules transformed."],
    [300, "dist/assets/index.js  84.2 kB"],
  ],
  e2e: [
    [600, "Running 6 tests using 2 workers"],
    [900, "✓ checkout › pays with saved card"],
    [700, "✓ cart › applies discount code"],
    [200, "6 passed (2.4s)"],
  ],
  docs: [[1200, "Built 18 pages"]],
};

for (const [delay, line] of steps[process.argv[2]] ?? []) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  console.log(line);
}
