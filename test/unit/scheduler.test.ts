import { describe, expect, it } from "vitest";
import { schedule, type Task } from "../../src/scheduler.ts";

interface Controlled {
  started: string[];
  maxConcurrent: number;
  finish(name: string, ok: boolean): void;
  aborted: Map<string, unknown>;
  run: (task: Task, signal: AbortSignal) => Promise<boolean>;
}

/** A task runner whose tasks finish only when the test says so. */
function controlled(): Controlled {
  const resolvers = new Map<string, (ok: boolean) => void>();
  const state: Controlled = {
    started: [],
    maxConcurrent: 0,
    aborted: new Map(),
    finish(name, ok) {
      const resolve = resolvers.get(name);
      if (!resolve) throw new Error(`${name} is not running`);
      resolvers.delete(name);
      resolve(ok);
    },
    run(task, signal) {
      state.started.push(task.name);
      return new Promise<boolean>((resolve) => {
        resolvers.set(task.name, resolve);
        state.maxConcurrent = Math.max(state.maxConcurrent, resolvers.size);
        signal.addEventListener("abort", () => {
          state.aborted.set(task.name, signal.reason);
          resolvers.delete(task.name);
          resolve(false);
        });
      });
    },
  };
  return state;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const task = (name: string, ...dependsOn: string[]): Task => ({ name, dependsOn });

describe("schedule", () => {
  it("never exceeds the concurrency limit and starts tasks in declaration order", async () => {
    const runner = controlled();
    const done = schedule(
      [task("a"), task("b"), task("c"), task("d")],
      { concurrency: 2, failFast: false },
      runner.run,
    );
    await tick();
    expect(runner.started).toEqual(["a", "b"]);
    runner.finish("b", true);
    await tick();
    expect(runner.started).toEqual(["a", "b", "c"]);
    runner.finish("a", true);
    runner.finish("c", true);
    await tick();
    runner.finish("d", true);
    const outcomes = await done;
    expect(runner.maxConcurrent).toBe(2);
    expect([...outcomes.values()].every((outcome) => outcome.state === "succeeded")).toBe(true);
  });

  it("waits for dependencies to succeed", async () => {
    const runner = controlled();
    const done = schedule(
      [task("test", "build"), task("build")],
      { concurrency: 4, failFast: false },
      runner.run,
    );
    await tick();
    expect(runner.started).toEqual(["build"]);
    runner.finish("build", true);
    await tick();
    expect(runner.started).toEqual(["build", "test"]);
    runner.finish("test", true);
    expect((await done).get("test")).toEqual({ state: "succeeded" });
  });

  it("blocks dependents of failed tasks transitively but keeps running independent ones", async () => {
    const runner = controlled();
    const done = schedule(
      [task("build"), task("test", "build"), task("e2e", "test"), task("lint")],
      { concurrency: 4, failFast: false },
      runner.run,
    );
    await tick();
    runner.finish("build", false);
    await tick();
    runner.finish("lint", true);
    const outcomes = await done;
    expect(outcomes.get("build")).toEqual({ state: "failed" });
    expect(outcomes.get("test")).toEqual({ state: "blocked", dependency: "build" });
    expect(outcomes.get("e2e")).toEqual({ state: "blocked", dependency: "test" });
    expect(outcomes.get("lint")).toEqual({ state: "succeeded" });
  });

  it("aborts running tasks and skips pending ones on fail-fast", async () => {
    const runner = controlled();
    const done = schedule(
      [task("a"), task("b"), task("c")],
      { concurrency: 2, failFast: true },
      runner.run,
    );
    await tick();
    runner.finish("a", false);
    const outcomes = await done;
    expect(runner.aborted.get("b")).toEqual({ kind: "fail-fast", failed: "a" });
    expect(outcomes.get("c")).toEqual({ state: "not_started" });
    expect(runner.started).toEqual(["a", "b"]);
  });

  it("aborts everything when the external signal fires", async () => {
    const runner = controlled();
    const controller = new AbortController();
    const done = schedule(
      [task("a"), task("b")],
      { concurrency: 1, failFast: false, signal: controller.signal },
      runner.run,
    );
    await tick();
    controller.abort("SIGINT");
    const outcomes = await done;
    expect(runner.aborted.get("a")).toEqual({ kind: "interrupted", reason: "SIGINT" });
    expect(outcomes.get("b")).toEqual({ state: "not_started" });
  });

  it("treats a rejected task as a failure", async () => {
    const outcomes = await schedule(
      [task("a"), task("b", "a")],
      { concurrency: 1, failFast: false },
      async () => {
        throw new Error("boom");
      },
    );
    expect(outcomes.get("a")).toEqual({ state: "failed" });
    expect(outcomes.get("b")).toEqual({ state: "blocked", dependency: "a" });
  });

  it("ignores dependencies that are not part of the run", async () => {
    const outcomes = await schedule(
      [task("test", "build")],
      { concurrency: 1, failFast: false },
      async () => true,
    );
    expect(outcomes.get("test")).toEqual({ state: "succeeded" });
  });

  it("returns immediately for an empty task list", async () => {
    expect((await schedule([], { concurrency: 1, failFast: false }, async () => true)).size).toBe(
      0,
    );
  });
});
