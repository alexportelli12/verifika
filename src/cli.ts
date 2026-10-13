#!/usr/bin/env node
import { ExitCode } from "./errors.ts";
import { main } from "./main.ts";
import { systemTerminal } from "./reporters/live.ts";

const write = (stream: NodeJS.WriteStream) => (text: string) => {
  stream.write(text);
};

// A closed pipe (e.g. `verifika logs lint | head`) is not an error worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  out: write(process.stdout),
  err: write(process.stderr),
  ...(process.stdout.isTTY
    ? { terminal: systemTerminal(write(process.stdout), write(process.stderr), process.stdout) }
    : {}),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `verifika: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = ExitCode.Internal;
  },
);
