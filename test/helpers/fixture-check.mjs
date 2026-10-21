// Controlled check command used by integration tests. Copied into each temporary
// repository and invoked as `node check.mjs <action> ...` so commands need no
// shell-specific quoting on any platform.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

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
  case "stubborn": {
    // stubborn <pidfile>: leaves a grandchild that ignores SIGTERM and does not hold
    // the output pipes, then exits 0. Only an explicit kill can stop it.
    const script = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(args[0])}, String(process.pid)); setInterval(() => {}, 1000);`;
    spawn(process.execPath, ["-e", script], { stdio: "ignore" }).unref();
    while (!existsSync(args[0])) await sleep(20);
    break;
  }
  case "escape": {
    // escape <pidfile>: leaves a grandchild in a new session/process group that keeps
    // the output pipes open, then exits 0.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    writeFileSync(args[0], String(child.pid));
    child.unref();
    break;
  }
  case "daemon":
    // daemon <pidfile>: records its pid, then runs forever (started in the background by the shell).
    writeFileSync(args[0], String(process.pid));
    setInterval(() => {}, 1000);
    break;
  case "trap-term": {
    // trap-term <marker> <ready>: background leftover that records SIGTERM in <marker>.
    process.on("SIGTERM", () => {
      writeFileSync(args[0], "terminated");
      process.exit(0);
    });
    writeFileSync(args[1], "ready");
    setInterval(() => {}, 1000);
    break;
  }
  case "wait-for":
    // wait-for <file> [ready]: writes <ready> if given, then exits once <file> exists.
    if (args[1]) writeFileSync(args[1], "ready");
    while (!existsSync(args[0])) await sleep(20);
    break;
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
  case "color":
    // Tools such as the Angular CLI force colour even when piped.
    process.stdout.write("\u001b[31merror\u001b[39m: \u001b[1mbroken\u001b[22m\n");
    process.exitCode = 1;
    break;
  case "env":
    process.stdout.write(
      `${process.env.VERIFIKA} ${process.env.VERIFIKA_CHECK} ${process.env.VERIFIKA_RUN_ID}\n`,
    );
    break;
  default:
    process.stderr.write(`unknown action ${action}\n`);
    process.exitCode = 99;
}
