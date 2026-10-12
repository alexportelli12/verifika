import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VerifikaError } from "./errors.ts";
import type { CheckConfig, VerifikaConfig } from "./types.ts";

export const CONFIG_FILE = "verifika.config.json";
export const CHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_TIMEOUT_MS = 600_000;
/** Largest delay setTimeout accepts (about 24.8 days); larger values would fire immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
/** Device names Windows reserves in every directory; they cannot be log file names. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const DEFAULT_KEEP_RUNS = 10;

/** Half the available cores, between 1 and 4: checks such as tsc and test runners are multi-threaded themselves. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
}

/** Walks up from `cwd` to find verifika.config.json, or uses the explicit path. */
export function findConfigFile(cwd: string, explicit?: string): string {
  if (explicit) {
    const file = path.resolve(cwd, explicit);
    if (!isFile(file)) throw new VerifikaError(`config file not found: ${explicit}`);
    return file;
  }
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, CONFIG_FILE);
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new VerifikaError(
        `no ${CONFIG_FILE} found in ${cwd} or any parent directory`,
        "Create one with: verifika init",
      );
    }
    directory = parent;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function loadConfig(file: string): VerifikaConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new VerifikaError(`cannot read ${file}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new VerifikaError(
      `${path.basename(file)} is not valid JSON: ${(error as Error).message}`,
    );
  }
  return parseConfig(raw, file);
}

/** Validates raw JSON and applies defaults. Reports every problem at once. */
export function parseConfig(raw: unknown, file: string): VerifikaConfig {
  const errors: string[] = [];
  const v = new Validator(errors);

  if (!v.object(raw, "config")) throw configError(file, errors);
  v.keys(raw, "config", ["$schema", "version", "defaults", "changes", "checks"]);
  v.string(raw.$schema, "$schema");

  if (raw.version !== 1) {
    errors.push(
      raw.version === undefined
        ? "version: required; set it to 1"
        : `version: unsupported value ${JSON.stringify(raw.version)}; this release supports 1`,
    );
  }

  const defaults = raw.defaults ?? {};
  let concurrency = defaultConcurrency();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let failFast = false;
  let keepRuns = DEFAULT_KEEP_RUNS;
  if (v.object(defaults, "defaults")) {
    v.keys(defaults, "defaults", ["concurrency", "timeoutMs", "failFast", "keepRuns"]);
    concurrency = v.integer(defaults.concurrency, "defaults.concurrency", 1, 64) ?? concurrency;
    timeoutMs = v.integer(defaults.timeoutMs, "defaults.timeoutMs", 1, MAX_TIMEOUT_MS) ?? timeoutMs;
    failFast = v.boolean(defaults.failFast, "defaults.failFast") ?? failFast;
    keepRuns = v.integer(defaults.keepRuns, "defaults.keepRuns", 1, 1000) ?? keepRuns;
  }

  const changes = raw.changes ?? {};
  let base = "HEAD";
  let invalidateAll: string[] = [];
  if (v.object(changes, "changes")) {
    v.keys(changes, "changes", ["base", "invalidateAll"]);
    base = v.string(changes.base, "changes.base") ?? base;
    invalidateAll = v.globs(changes.invalidateAll, "changes.invalidateAll", true) ?? [];
  }
  // A config edit can change what every check means, so it always invalidates everything.
  if (!invalidateAll.includes(CONFIG_FILE)) invalidateAll = [...invalidateAll, CONFIG_FILE];

  const checks: CheckConfig[] = [];
  if (raw.checks === undefined) {
    errors.push("checks: required; declare at least one check");
  } else if (v.object(raw.checks, "checks")) {
    const entries = Object.entries(raw.checks);
    if (entries.length === 0) errors.push("checks: declare at least one check");
    for (const [name, value] of entries) {
      const at = `checks.${name}`;
      if (!CHECK_NAME_PATTERN.test(name)) {
        errors.push(
          `${at}: invalid name; use letters, digits, ".", "_" or "-", starting with a letter or digit`,
        );
      }
      if (RESERVED_NAMES.test(name)) {
        errors.push(`${at}: "${name}" is a reserved device name on Windows; choose another name`);
      }
      const clash = entries.find(
        ([other]) => other !== name && other.toLowerCase() === name.toLowerCase(),
      );
      if (clash && clash[0] < name) {
        errors.push(`${at}: differs from "${clash[0]}" only by case; log files would collide`);
      }
      if (!v.object(value, at)) continue;
      v.keys(value, at, ["command", "paths", "exclude", "always", "dependsOn", "timeoutMs"]);
      const command = v.string(value.command, `${at}.command`, true);
      const paths = v.globs(value.paths, `${at}.paths`, false);
      const exclude = v.globs(value.exclude, `${at}.exclude`, true) ?? [];
      const always = v.boolean(value.always, `${at}.always`) ?? false;
      const dependsOn = v.stringArray(value.dependsOn, `${at}.dependsOn`) ?? [];
      const checkTimeout = v.integer(value.timeoutMs, `${at}.timeoutMs`, 1, MAX_TIMEOUT_MS);
      if (always && paths) {
        errors.push(
          `${at}: "always" and "paths" cannot be combined; an always-run check ignores paths`,
        );
      }
      if (always && exclude.length > 0) {
        errors.push(`${at}: "always" and "exclude" cannot be combined`);
      }
      checks.push({
        name,
        command: command ?? "",
        paths,
        exclude,
        always,
        dependsOn,
        timeoutMs: checkTimeout ?? timeoutMs,
      });
    }
    validateDependencies(checks, errors);
  }

  if (errors.length > 0) throw configError(file, errors);
  return {
    file,
    root: path.dirname(file),
    concurrency,
    timeoutMs,
    failFast,
    keepRuns,
    base,
    invalidateAll,
    checks,
  };
}

function validateDependencies(checks: CheckConfig[], errors: string[]): void {
  const byName = new Map(checks.map((check) => [check.name, check]));
  for (const check of checks) {
    const seen = new Set<string>();
    for (const dependency of check.dependsOn) {
      if (dependency === check.name) {
        errors.push(`checks.${check.name}.dependsOn: a check cannot depend on itself`);
      } else if (!byName.has(dependency)) {
        errors.push(`checks.${check.name}.dependsOn: unknown check "${dependency}"`);
      } else if (seen.has(dependency)) {
        errors.push(`checks.${check.name}.dependsOn: "${dependency}" is listed twice`);
      }
      seen.add(dependency);
    }
  }
  const cycle = findCycle(checks, byName);
  if (cycle) errors.push(`checks: dependency cycle ${cycle.join(" -> ")}`);
}

function findCycle(checks: CheckConfig[], byName: Map<string, CheckConfig>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    if (state.get(name) === "done") return null;
    if (state.get(name) === "visiting") return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, "visiting");
    stack.push(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      if (dependency === name || !byName.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, "done");
    return null;
  };
  for (const check of checks) {
    const cycle = visit(check.name);
    if (cycle) return cycle;
  }
  return null;
}

function configError(file: string, errors: string[]): VerifikaError {
  return new VerifikaError(
    `invalid ${path.basename(file)}:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
  );
}

type JsonObject = Record<string, unknown> & {
  [key: string]: unknown;
};

/** Small collecting validator; each method returns `undefined` for absent or invalid values. */
class Validator {
  private readonly errors: string[];

  constructor(errors: string[]) {
    this.errors = errors;
  }

  object(value: unknown, at: string): value is JsonObject {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return true;
    this.errors.push(`${at}: expected an object`);
    return false;
  }

  keys(value: JsonObject, at: string, allowed: string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.errors.push(`${at}: unknown property "${key}" (allowed: ${allowed.join(", ")})`);
      }
    }
  }

  string(value: unknown, at: string, required = false): string | undefined {
    if (value === undefined) {
      if (required) this.errors.push(`${at}: required`);
      return undefined;
    }
    if (typeof value === "string" && value.trim() !== "") return value;
    this.errors.push(`${at}: expected a non-empty string`);
    return undefined;
  }

  boolean(value: unknown, at: string): boolean | undefined {
    if (value === undefined || typeof value === "boolean") return value;
    this.errors.push(`${at}: expected true or false`);
    return undefined;
  }

  integer(value: unknown, at: string, min: number, max?: number): number | undefined {
    if (value === undefined) return undefined;
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= min &&
      (max === undefined || value <= max)
    ) {
      return value;
    }
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    this.errors.push(`${at}: expected an integer ${range}`);
    return undefined;
  }

  stringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string" && item.trim() !== "")
    ) {
      return value as string[];
    }
    this.errors.push(`${at}: expected an array of non-empty strings`);
    return undefined;
  }

  /** Glob lists must be portable: forward slashes, relative to the config directory. */
  globs(value: unknown, at: string, allowEmpty: boolean): string[] | undefined {
    const list = this.stringArray(value, at);
    if (list === undefined) return undefined;
    if (list.length === 0 && !allowEmpty) {
      this.errors.push(
        `${at}: must not be empty; omit it to match every file, or use "always": true`,
      );
      return undefined;
    }
    const normalized: string[] = [];
    for (const pattern of list) {
      if (pattern.includes("\\")) {
        this.errors.push(
          `${at}: "${pattern}" contains a backslash; use forward slashes on every platform`,
        );
      } else if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) {
        this.errors.push(
          `${at}: "${pattern}" is absolute; patterns are relative to the config directory`,
        );
      } else {
        normalized.push(pattern.replace(/^(\.\/)+/, ""));
      }
    }
    return normalized;
  }
}
