import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Used when `PAGER` is unset: quit if one screen, keep colours, leave output on screen. */
export const DEFAULT_PAGER = "less -R -F -X";

/** The pager command line from `PAGER`, or the default. */
export function pagerCommand(env: NodeJS.ProcessEnv): string {
  const configured = env.PAGER?.trim();
  return configured ? configured : DEFAULT_PAGER;
}

/**
 * Whether the pager's program exists, so a missing one (e.g. `less` on Windows)
 * falls back to plain output instead of a shell error. Checks the first word of
 * the command (which may be quoted): a path, or a name looked up on PATH (with
 * PATHEXT on Windows).
 */
export function pagerAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const program = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  if (program === "") return false;
  const isWindows = process.platform === "win32";
  const extensions = isWindows
    ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
    : [""];
  const candidates =
    program.includes("/") || program.includes("\\")
      ? [program]
      : (env.PATH ?? env.Path ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, program));
  return candidates.some((candidate) =>
    extensions.some((extension) => {
      try {
        accessSync(candidate + extension, isWindows ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

export type Write = (text: string) => void | Promise<void>;

/**
 * Pipes everything `produce` writes into the pager, which takes over the
 * terminal until the user quits it. Quitting early is not an error: further
 * output is dropped. Ctrl-C belongs to the pager meanwhile, so Verifika ignores
 * SIGINT until the pager exits (as git does).
 */
export async function withPager(
  command: string,
  env: NodeJS.ProcessEnv,
  produce: (write: Write) => Promise<void>,
): Promise<void> {
  // Like git: colours and quit-if-one-screen for a plain `less`, unless the user configured LESS.
  const child = spawn(command, {
    shell: true,
    stdio: ["pipe", "inherit", "inherit"],
    env: { LESS: "FRX", ...env },
  });
  const ignoreInterrupt = () => undefined;
  process.on("SIGINT", ignoreInterrupt);
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let closed = false;
  const stdin = child.stdin;
  stdin.on("error", () => {
    // EPIPE: the user quit the pager before reading everything.
    closed = true;
  });
  child.once("close", () => {
    closed = true;
  });
  try {
    await produce((text) => {
      if (closed) return;
      if (!stdin.write(text)) {
        return new Promise<void>((resolve) => {
          const done = () => {
            stdin.off("drain", done);
            child.off("close", done);
            resolve();
          };
          stdin.once("drain", done);
          child.once("close", done);
        });
      }
    });
  } finally {
    stdin.end();
    await exited;
    process.off("SIGINT", ignoreInterrupt);
  }
}
