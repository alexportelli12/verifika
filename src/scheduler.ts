export interface Task {
  name: string;
  dependsOn: string[];
}

export type TaskOutcome =
  | { state: "succeeded" }
  | { state: "failed" }
  /** A dependency did not succeed, so the task never started. */
  | { state: "blocked"; dependency: string }
  /** The run stopped (fail-fast or interruption) before the task started. */
  | { state: "not_started" };

export interface ScheduleOptions {
  concurrency: number;
  failFast: boolean;
  /** Aborting stops scheduling and aborts every running task. */
  signal?: AbortSignal;
}

/** Why running tasks were aborted. */
export type StopReason =
  { kind: "fail-fast"; failed: string } | { kind: "interrupted"; reason: unknown };

/**
 * Runs tasks with at most `concurrency` in flight, never starting a task before
 * all of its dependencies succeeded. Tasks start in declaration order whenever
 * they become ready, so scheduling is deterministic for a given set of results.
 *
 * `run` resolves to whether the task succeeded; a rejection counts as failure.
 * Dependencies outside `tasks` are treated as already satisfied.
 */
export async function schedule(
  tasks: readonly Task[],
  options: ScheduleOptions,
  run: (task: Task, signal: AbortSignal) => Promise<boolean>,
): Promise<Map<string, TaskOutcome>> {
  const names = new Set(tasks.map((task) => task.name));
  const outcomes = new Map<string, TaskOutcome>();
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const pending = [...tasks];
  const concurrency = Math.max(1, options.concurrency);
  let stopReason: StopReason | null = null;

  const stop = (reason: StopReason) => {
    if (stopReason) return;
    stopReason = reason;
    for (const entry of running.values()) entry.controller.abort(reason);
  };
  const onAbort = () => stop({ kind: "interrupted", reason: options.signal?.reason });
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const blockedBy = (task: Task): string | undefined =>
    task.dependsOn.find((dependency) => {
      const outcome = outcomes.get(dependency);
      return outcome !== undefined && outcome.state !== "succeeded";
    });
  const isReady = (task: Task): boolean =>
    task.dependsOn.every(
      (dependency) => !names.has(dependency) || outcomes.get(dependency)?.state === "succeeded",
    );

  const start = (task: Task) => {
    const controller = new AbortController();
    const done = run(task, controller.signal)
      .catch(() => false)
      .then((succeeded) => {
        running.delete(task.name);
        outcomes.set(task.name, { state: succeeded ? "succeeded" : "failed" });
        if (!succeeded && options.failFast) stop({ kind: "fail-fast", failed: task.name });
      });
    running.set(task.name, { controller, done });
  };

  try {
    for (;;) {
      // Once stopped, nothing else starts; tasks that never ran are reported as such,
      // not as blocked by a dependency that was itself cut short.
      if (stopReason) {
        for (const task of pending) outcomes.set(task.name, { state: "not_started" });
        pending.length = 0;
      }

      // Resolve blocked tasks repeatedly: blocking cascades down dependency chains.
      let changed = true;
      while (changed) {
        changed = false;
        for (let index = 0; index < pending.length; index++) {
          const task = pending[index] as Task;
          const dependency = blockedBy(task);
          if (dependency !== undefined) {
            outcomes.set(task.name, { state: "blocked", dependency });
            pending.splice(index--, 1);
            changed = true;
          }
        }
      }

      for (let index = 0; index < pending.length && running.size < concurrency; index++) {
        const task = pending[index] as Task;
        if (!isReady(task)) continue;
        pending.splice(index--, 1);
        start(task);
      }

      if (running.size === 0) {
        // Nothing running and nothing startable: remaining tasks wait on dependencies
        // that will never run. Config validation rejects cycles, so this is defensive.
        for (const task of pending) outcomes.set(task.name, { state: "not_started" });
        return outcomes;
      }
      await Promise.race([...running.values()].map((entry) => entry.done));
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
