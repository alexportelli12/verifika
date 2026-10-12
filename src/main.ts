import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { findConfigFile, loadConfig } from "./config.ts";
import { ExitCode, VerifikaError } from "./errors.ts";
import { initConfig } from "./init.ts";
import { showLogs } from "./logs.ts";
import { plan, type PlanRequest } from "./planner.ts";
import { killAllNow } from "./process.ts";
import { agentReporter } from "./reporters/agent.ts";
import { detectCi } from "./ci.ts";
import { colors, humanReporter, plain, type SkipEstimate, type Style } from "./reporters/human.ts";
import { jsonReporter } from "./reporters/json.ts";
import { liveReporter, type LiveTerminal } from "./reporters/live.ts";
import { planJson, renderPlan } from "./reporters/plan.ts";
import { quietReporter } from "./reporters/quiet.ts";
import { OUTPUT_MODES, type Output, type OutputMode, type Reporter } from "./reporters/reporter.ts";
import { runVerification } from "./runner.ts";
import { estimateSkipped } from "./runs.ts";

export interface Io extends Output {
  cwd: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Stdout as a terminal, when it is one; enables the live status block in human mode. */
  terminal?: LiveTerminal;
}

const COMMANDS = ["run", "plan", "logs", "init", "help"] as const;
type Command = (typeof COMMANDS)[number];
const DEFAULT_PREVIEW_LINES = 10;

export const HELP = `vfk - run the checks your changes need, with minimal output
(vfk is short for verifika; the two commands are identical)

Usage:
  vfk [run] [options]             Verify (selective locally, full in CI)
  vfk plan [options]              Show which checks would run and why
  vfk logs [check...]             Show logs from the latest run
  vfk init [--force]              Create verifika.config.json from package.json scripts

Selection (run, plan):
      --all                       Run every check
  -c, --check <name>              Run only these checks and their dependencies
                                  (repeatable or comma-separated)
      --changed                   Select by changes against changes.base, even in CI
      --changed-since <ref>       Select by changes since merge-base(<ref>, HEAD),
                                  including uncommitted and untracked files

Execution (run):
  -j, --concurrency <n>           Maximum checks running at once (default 1)
      --fail-fast                 Stop everything after the first failure
      --no-fail-fast              Run every selected check even after a failure
      --preview <lines>           Failure preview lines per check (default ${DEFAULT_PREVIEW_LINES}, 0 = off)
      --no-live                   Print progress line by line instead of a live
                                  status block (or set VERIFIKA_LIVE=0)

Logs:
      --failed                    Print logs of every failed check
      --tail <lines>              Print only the last lines of each log
      --run <id>                  Read a specific run instead of the latest

Output:
      --mode <mode>               human | agent | json | quiet
                                  (default: human on a terminal, agent otherwise;
                                  or set VERIFIKA_MODE)
General:
      --config <path>             Use this config file instead of searching upward
  -h, --help                      Show this help
  -v, --version                   Show the version

Exit codes: 0 passed or nothing to verify, 1 verification failed,
2 usage or configuration error, 128+signal interrupted (130 SIGINT, 143 SIGTERM).
Docs: https://github.com/alexportelli12/verifika
`;

const SHARED = {
  config: { type: "string" },
  mode: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const satisfies ParseArgsConfig["options"];

const SELECTION = {
  all: { type: "boolean" },
  check: { type: "string", short: "c", multiple: true },
  changed: { type: "boolean" },
  "changed-since": { type: "string" },
} as const satisfies ParseArgsConfig["options"];

const OPTIONS = {
  run: {
    ...SHARED,
    ...SELECTION,
    concurrency: { type: "string", short: "j" },
    "fail-fast": { type: "boolean" },
    "no-fail-fast": { type: "boolean" },
    preview: { type: "string" },
    "no-live": { type: "boolean" },
  },
  plan: { ...SHARED, ...SELECTION },
  logs: {
    ...SHARED,
    failed: { type: "boolean" },
    tail: { type: "string" },
    run: { type: "string" },
  },
  init: { ...SHARED, force: { type: "boolean" } },
  help: SHARED,
} as const satisfies Record<Command, ParseArgsConfig["options"]>;

export function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  };
  return manifest.version;
}

export async function main(argv: string[], io: Io): Promise<number> {
  let mode = guessMode(argv, io);
  try {
    const first = argv[0];
    const command: Command = COMMANDS.includes(first as Command) ? (first as Command) : "run";
    const rest = command === "run" && first !== "run" ? argv : argv.slice(1);
    const { values, positionals } = parse(rest, command);
    mode = resolveMode(values.mode, io);

    if (values.version) {
      io.out(`${version()}\n`);
      return ExitCode.Passed;
    }
    if (values.help || command === "help") {
      io.out(HELP);
      return ExitCode.Passed;
    }
    if (command === "init") return await runInit(io, values);
    if (command !== "logs" && positionals.length > 0) {
      throw new VerifikaError(
        `unexpected argument "${positionals[0]}"`,
        "Commands (plan, logs, init) must come first; use --check <name> to select checks.",
      );
    }

    const configFile = findConfigFile(io.cwd, values.config as string | undefined);
    const config = loadConfig(configFile);

    if (command === "logs") {
      return await showLogs(
        {
          root: config.root,
          checks: positionals,
          failed: Boolean(values.failed),
          ...(values.run !== undefined ? { runId: values.run as string } : {}),
          ...(values.tail !== undefined ? { tail: integerOption(values.tail, "--tail", 1) } : {}),
          stripAnsi: !io.isTTY,
        },
        io,
      );
    }

    const request: PlanRequest = {
      all: Boolean(values.all),
      // An empty value (e.g. `--check "$UNSET"`) must fail, not widen into a default run.
      ...(values.check !== undefined
        ? {
            checks: (values.check as string[]).flatMap((value) =>
              value
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean),
            ),
          }
        : {}),
      changed: Boolean(values.changed),
      env: io.env,
      ...(values["changed-since"] !== undefined
        ? { changedSince: values["changed-since"] as string }
        : {}),
    };
    const selection = await plan(config, request);

    if (command === "plan") {
      if (mode === "json") io.out(planJson(selection, config));
      else if (mode !== "quiet") io.out(renderPlan(selection, mode === "human" ? 50 : 20));
      return ExitCode.Passed;
    }

    if (values["fail-fast"] && values["no-fail-fast"]) {
      throw new VerifikaError("use only one of --fail-fast and --no-fail-fast");
    }
    const failFast = values["fail-fast"] ? true : values["no-fail-fast"] ? false : config.failFast;
    const concurrency =
      values.concurrency !== undefined
        ? integerOption(values.concurrency, "--concurrency", 1)
        : config.concurrency;
    const previewLines =
      values.preview !== undefined
        ? integerOption(values.preview, "--preview", 0)
        : DEFAULT_PREVIEW_LINES;

    const skipped = selection.checks.filter((check) => !check.selected).map((check) => check.name);
    const reporter = reporterFor(mode, io, {
      live: values["no-live"] !== true,
      // Only people see the estimate; other modes skip reading earlier runs.
      ...(mode === "human" && skipped.length > 0
        ? { skipEstimate: await estimateSkipped(config.root, skipped) }
        : {}),
    });
    try {
      const result = await withInterruptHandling(
        () => reporter.onInterrupt?.(),
        (signal) =>
          runVerification({
            config,
            selection,
            concurrency,
            failFast,
            previewLines,
            signal,
            reporter,
            version: version(),
            env: io.env,
          }),
      );
      return result.exitCode;
    } finally {
      reporter.dispose?.();
    }
  } catch (error) {
    if (error instanceof VerifikaError) {
      reportError(error, mode, io);
      return ExitCode.Usage;
    }
    // Keep stdout parseable in JSON mode even for bugs; otherwise let cli.ts print the stack.
    if (mode !== "json") throw error;
    const message = error instanceof Error ? error.message : String(error);
    io.err(
      `verifika: internal error: ${error instanceof Error ? (error.stack ?? message) : message}\n`,
    );
    io.out(
      `${JSON.stringify({ schemaVersion: 1, status: "error", exitCode: ExitCode.Internal, error: { message: `internal error: ${message}`, hint: "This is a bug; please report it." } }, null, 2)}\n`,
    );
    return ExitCode.Internal;
  }
}

async function runInit(io: Io, values: Values): Promise<number> {
  const root = values.config ? path.dirname(path.resolve(io.cwd, values.config as string)) : io.cwd;
  const { file, checks } = await initConfig(root, Boolean(values.force));
  io.out(`Created ${path.relative(io.cwd, file) || file} with checks: ${checks.join(", ")}\n`);
  io.out(
    'Review the commands, add "paths" to checks that only some files affect, format the file if your repository checks formatting, then run: vfk plan\n',
  );
  return ExitCode.Passed;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

function parse(args: string[], command: Command): { values: Values; positionals: string[] } {
  try {
    const options: ParseArgsConfig["options"] = OPTIONS[command];
    const { values, positionals } = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: true,
    });
    return { values: values as Values, positionals };
  } catch (error) {
    const message = (error as Error).message.replace(/\. To specify a positional argument.*$/s, "");
    throw new VerifikaError(message, `Run "vfk --help" for usage.`);
  }
}

function integerOption(value: unknown, flag: string, min: number): number {
  const number = Number(value);
  if (typeof value !== "string" || !/^\d+$/.test(value) || number < min) {
    throw new VerifikaError(`${flag} expects an integer >= ${min}, got "${String(value)}"`);
  }
  return number;
}

function resolveMode(value: unknown, io: Io): OutputMode {
  const requested = (value as string | undefined) ?? io.env.VERIFIKA_MODE;
  if (requested === undefined || requested === "") return io.isTTY ? "human" : "agent";
  if (!OUTPUT_MODES.includes(requested as OutputMode)) {
    throw new VerifikaError(
      `unknown mode "${requested}"`,
      `Use one of: ${OUTPUT_MODES.join(", ")}`,
    );
  }
  return requested as OutputMode;
}

/** Best-effort mode before argument parsing succeeds, so even usage errors honour --mode json. */
function guessMode(argv: string[], io: Io): OutputMode {
  const index = argv.findIndex((arg) => arg === "--mode" || arg.startsWith("--mode="));
  const value =
    index === -1
      ? io.env.VERIFIKA_MODE
      : argv[index]?.includes("=")
        ? argv[index]?.slice(7)
        : argv[index + 1];
  return OUTPUT_MODES.includes(value as OutputMode)
    ? (value as OutputMode)
    : io.isTTY
      ? "human"
      : "agent";
}

function reporterFor(
  mode: OutputMode,
  io: Io,
  options: { live: boolean; skipEstimate?: SkipEstimate },
): Reporter {
  switch (mode) {
    case "human": {
      const style = humanStyle(io);
      // The live block redraws in place, so it needs a real, capable terminal that
      // nobody is logging; everywhere else the line reporter is the fallback.
      const live =
        options.live &&
        io.terminal !== undefined &&
        io.isTTY &&
        !detectCi(io.env).ci &&
        io.env.TERM !== "dumb" &&
        !isOff(io.env.VERIFIKA_LIVE);
      const estimate = options.skipEstimate ? { skipEstimate: options.skipEstimate } : {};
      if (live && io.terminal) return liveReporter(io.terminal, style, estimate);
      return humanReporter(io, style, { heartbeat: io.isTTY, ...estimate });
    }
    case "agent":
      return agentReporter(io);
    case "json":
      return jsonReporter(io);
    case "quiet":
      return quietReporter(io);
  }
}

/** Colour on a terminal unless NO_COLOR is set; FORCE_COLOR enables it elsewhere. */
function humanStyle(io: Io): Style {
  const color =
    io.isTTY && !io.env.NO_COLOR ? true : Boolean(io.env.FORCE_COLOR && io.env.FORCE_COLOR !== "0");
  return color ? colors : plain;
}

function isOff(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function reportError(error: VerifikaError, mode: OutputMode, io: Io): void {
  if (mode === "json") {
    const document = {
      schemaVersion: 1,
      status: "error",
      exitCode: ExitCode.Usage,
      error: { message: error.message, hint: error.hint ?? null },
    };
    io.out(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  io.err(`verifika: ${error.message}\n${error.hint ? `${error.hint}\n` : ""}`);
}

/**
 * First SIGINT/SIGTERM/SIGHUP stops scheduling and terminates running checks
 * gracefully; a second one kills them immediately.
 */
async function withInterruptHandling<T>(
  onFirstSignal: () => void,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) killAllNow();
    else {
      onFirstSignal();
      controller.abort(signal);
    }
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    return await operation(controller.signal);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}
