import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The CLI integration tests mostly wait on child processes, so more workers than
    // cores still pays off; 6 was the fastest stable count of 2, 4 and 6 measured.
    maxWorkers: 6,
    // Shortens Verifika's process-cleanup timers (src/process.ts) to a quarter, so
    // cleanup tests do not wait seconds of real time. Tests that need the real timers
    // override it with "1".
    env: { VERIFIKA_TIMING_SCALE: "0.25" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
