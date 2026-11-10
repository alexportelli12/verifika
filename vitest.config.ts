import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The CLI integration tests mostly wait on child processes: on 8 cores, 6 workers
    // was the fastest of 2, 4 and 6. On the 3- and 4-core CI runners, where tests share
    // the machine with other checks, 6 starved the timing-sensitive tests, so keep a
    // core free there.
    maxWorkers: Math.min(6, Math.max(2, availableParallelism() - 1)),
    // Shortens Verifika's process-cleanup timers (src/process.ts) to a quarter, so
    // cleanup tests do not wait seconds of real time. Tests that need the real timers
    // override it with "1". Not on Windows: confirming a kill there takes a PowerShell
    // process-table query of up to a few seconds, longer than the shortened kill wait.
    env: { VERIFIKA_TIMING_SCALE: process.platform === "win32" ? "1" : "0.25" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
