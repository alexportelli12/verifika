// Controlled check command used by integration tests. Copied into each temporary
// repository and invoked as `node check.mjs <action> ...` so commands need no
// shell-specific quoting on any platform.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const [action, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

switch (action) {
  case "pass":
    process.stdout.write(`ok ${args[0] ?? ""}\n`);
    break;
  case "fail":
    process.stdout.write("starting up\nnoise line\n");
    process.stderr.write(`src/app.ts(3,7): error TS2322: ${args[1] ?? "broken"}\n`);
    process.exitCode = Number(args[0] ?? 1);
    break;
  case "timeline": {
    // timeline <file> <name> <ms>: records start/end so tests can check overlap and order.
    const [file, name, ms] = args;
    appendFileSync(file, `start ${name} ${Date.now()}\n`);
    await sleep(Number(ms));
    appendFileSync(file, `end ${name} ${Date.now()}\n`);
    break;
  }
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "tree": {
    // tree <pidfile>: starts a grandchild that would run forever, then hangs itself.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    writeFileSync(args[0], String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case "orphan": {
    // orphan <pidfile>: leaves a background grandchild holding stdout, then exits 0.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    writeFileSync(args[0], String(child.pid));
    child.unref();
    break;
  }
  case "big": {
    // big <megabytes>: floods stdout, then fails.
    const line = `${"x".repeat(99)}\n`;
    const chunk = line.repeat(10_000);
    for (let i = 0; i < Number(args[0]); i++) {
      if (!process.stdout.write(chunk))
        await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    process.stderr.write("error: flood finished\n");
    process.exitCode = 1;
    break;
  }
  case "env":
    process.stdout.write(
      `${process.env.VERIFIKA} ${process.env.VERIFIKA_CHECK} ${process.env.VERIFIKA_RUN_ID}\n`,
    );
    break;
  default:
    process.stderr.write(`unknown action ${action}\n`);
    process.exitCode = 99;
}
