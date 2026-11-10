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
    // override it with "1". Not on Windows: confirming a kill there takes a PowerShell
    // process-table query of up to a few seconds, longer than the shortened kill wait.
    env: { VERIFIKA_TIMING_SCALE: process.platform === "win32" ? "1" : "0.25" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
