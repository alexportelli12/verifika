import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { defaultConcurrency, findConfigFile, loadConfig, parseConfig } from "../../src/config.ts";
import { VerifikaError } from "../../src/errors.ts";
import { tempDir, writeFiles } from "../helpers/repo.ts";

const FILE = "/repo/verifika.config.json";
const schema = JSON.parse(
  readFileSync(new URL("../../schemas/verifika.schema.json", import.meta.url), "utf8"),
) as object;
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

function errorsOf(raw: unknown): string {
  try {
    parseConfig(raw, FILE);
  } catch (error) {
    expect(error).toBeInstanceOf(VerifikaError);
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
}

describe("parseConfig", () => {
  it("applies defaults to a minimal config", () => {
    const config = parseConfig({ version: 1, checks: { lint: { command: "npm run lint" } } }, FILE);
    expect(config).toMatchObject({
      root: path.dirname(FILE),
      concurrency: defaultConcurrency(),
      timeoutMs: 600_000,
      failFast: false,
      keepRuns: 10,
      base: "HEAD",
      invalidateAll: ["verifika.config.json"],
    });
    expect(config.checks).toEqual([
      {
        name: "lint",
        command: "npm run lint",
        paths: undefined,
        exclude: [],
        always: false,
        dependsOn: [],
        timeoutMs: 600_000,
      },
    ]);
  });

  it("keeps declaration order and per-check overrides", () => {
    const config = parseConfig(
      {
        version: 1,
        defaults: { concurrency: 2, timeoutMs: 5000, failFast: true, keepRuns: 3 },
        changes: { base: "origin/main", invalidateAll: ["./package.json", "verifika.config.json"] },
        checks: {
          build: { command: "b", paths: ["src/**"], exclude: ["src/**/*.md"] },
          test: { command: "t", dependsOn: ["build"], timeoutMs: 100 },
          audit: { command: "a", always: true },
        },
      },
      FILE,
    );
    expect(config.checks.map((check) => check.name)).toEqual(["build", "test", "audit"]);
    expect(config.invalidateAll).toEqual(["package.json", "verifika.config.json"]);
    expect(config.checks[1]).toMatchObject({ dependsOn: ["build"], timeoutMs: 100 });
    expect(config.checks[0]).toMatchObject({ timeoutMs: 5000, exclude: ["src/**/*.md"] });
    expect(config).toMatchObject({
      concurrency: 2,
      failFast: true,
      keepRuns: 3,
      base: "origin/main",
    });
  });

  it.each([
    [null, "config: expected an object"],
    [{ checks: { a: { command: "x" } } }, "version: required"],
    [{ version: 2, checks: { a: { command: "x" } } }, "version: unsupported value 2"],
    [{ version: 1 }, "checks: required"],
    [{ version: 1, checks: {} }, "checks: declare at least one check"],
    [
      { version: 1, check: {}, checks: { a: { command: "x" } } },
      'config: unknown property "check"',
    ],
    [{ version: 1, checks: { a: {} } }, "checks.a.command: required"],
    [
      { version: 1, checks: { a: { command: "  " } } },
      "checks.a.command: expected a non-empty string",
    ],
    [
      { version: 1, checks: { a: { command: "x", path: [] } } },
      'checks.a: unknown property "path"',
    ],
    [{ version: 1, checks: { "-a": { command: "x" } } }, "checks.-a: invalid name"],
    [{ version: 1, checks: { "a/b": { command: "x" } } }, "checks.a/b: invalid name"],
    [
      { version: 1, checks: { a: { command: "x", paths: [] } } },
      "checks.a.paths: must not be empty",
    ],
    [
      { version: 1, checks: { a: { command: "x", paths: "src" } } },
      "checks.a.paths: expected an array",
    ],
    [{ version: 1, checks: { a: { command: "x", paths: ["src\\a"] } } }, "contains a backslash"],
    [{ version: 1, checks: { a: { command: "x", paths: ["/src"] } } }, "is absolute"],
    [{ version: 1, checks: { a: { command: "x", paths: ["C:/src"] } } }, "is absolute"],
    [
      { version: 1, checks: { a: { command: "x", always: true, paths: ["a"] } } },
      "cannot be combined",
    ],
    [
      { version: 1, checks: { a: { command: "x", always: true, exclude: ["a"] } } },
      "cannot be combined",
    ],
    [
      { version: 1, checks: { a: { command: "x", always: "yes" } } },
      "checks.a.always: expected true or false",
    ],
    [
      { version: 1, checks: { a: { command: "x", timeoutMs: 0 } } },
      "checks.a.timeoutMs: expected an integer >= 1",
    ],
    [{ version: 1, checks: { a: { command: "x", timeoutMs: 1.5 } } }, "expected an integer"],
    [
      { version: 1, defaults: { concurrency: 0 }, checks: { a: { command: "x" } } },
      "between 1 and 64",
    ],
    [
      { version: 1, defaults: { keepRuns: 0 }, checks: { a: { command: "x" } } },
      "defaults.keepRuns",
    ],
    [
      { version: 1, defaults: { failfast: true }, checks: { a: { command: "x" } } },
      'unknown property "failfast"',
    ],
    [
      { version: 1, changes: { base: "" }, checks: { a: { command: "x" } } },
      "changes.base: expected a non-empty string",
    ],
    [{ version: 1, checks: { a: { command: "x", dependsOn: ["b"] } } }, 'unknown check "b"'],
    [{ version: 1, checks: { a: { command: "x", dependsOn: ["a"] } } }, "cannot depend on itself"],
    [
      { version: 1, checks: { a: { command: "x", dependsOn: ["b", "b"] }, b: { command: "y" } } },
      "listed twice",
    ],
  ])("rejects %j with a precise error", (raw, message) => {
    expect(errorsOf(raw)).toContain(message);
  });

  it("detects dependency cycles", () => {
    const message = errorsOf({
      version: 1,
      checks: {
        a: { command: "x", dependsOn: ["b"] },
        b: { command: "x", dependsOn: ["c"] },
        c: { command: "x", dependsOn: ["a"] },
      },
    });
    expect(message).toContain("dependency cycle a -> b -> c -> a");
  });

  it("reports every problem at once", () => {
    const message = errorsOf({ version: 3, checks: { a: { command: 1, timeoutMs: -1 } } });
    expect(message.split("\n  - ")).toHaveLength(4);
  });
});

describe("JSON schema", () => {
  const valid: unknown[] = [
    { version: 1, checks: { a: { command: "x" } } },
    {
      $schema: "./node_modules/verifika/schemas/verifika.schema.json",
      version: 1,
      defaults: { concurrency: 3, timeoutMs: 1000, failFast: true, keepRuns: 5 },
      changes: { base: "origin/main", invalidateAll: ["package.json"] },
      checks: {
        build: { command: "b", paths: ["src/**"], exclude: ["**/*.md"], timeoutMs: 5 },
        test: { command: "t", dependsOn: ["build"] },
        audit: { command: "a", always: true },
      },
    },
  ];
  const invalid: unknown[] = [
    { checks: { a: { command: "x" } } },
    { version: 2, checks: { a: { command: "x" } } },
    { version: 1, checks: {} },
    { version: 1, checks: { "-a": { command: "x" } } },
    { version: 1, checks: { a: { command: " " } } },
    { version: 1, checks: { a: { command: "x", paths: [] } } },
    { version: 1, checks: { a: { command: "x", paths: ["a\\b"] } } },
    { version: 1, checks: { a: { command: "x", paths: ["/abs"] } } },
    { version: 1, checks: { a: { command: "x", always: true, paths: ["a"] } } },
    { version: 1, checks: { a: { command: "x", extra: 1 } } },
    { version: 1, defaults: { concurrency: 0 }, checks: { a: { command: "x" } } },
  ];

  it.each(valid)("accepts what the runtime accepts: %j", (raw) => {
    expect(() => parseConfig(raw, FILE)).not.toThrow();
    expect(validateSchema(raw), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it.each(invalid)("rejects what the runtime rejects: %j", (raw) => {
    expect(() => parseConfig(raw, FILE)).toThrow(VerifikaError);
    expect(validateSchema(raw)).toBe(false);
  });

  it("validates the repository's own config", () => {
    const own = JSON.parse(
      readFileSync(new URL("../../verifika.config.json", import.meta.url), "utf8"),
    );
    expect(validateSchema(own), JSON.stringify(validateSchema.errors)).toBe(true);
  });
});

describe("loading", () => {
  it("finds the nearest config walking upwards", () => {
    const root = tempDir();
    writeFiles(root, {
      "verifika.config.json": JSON.stringify({ version: 1, checks: { a: { command: "x" } } }),
      "packages/app/src/index.ts": "",
    });
    expect(findConfigFile(path.join(root, "packages/app/src"))).toBe(
      path.join(root, "verifika.config.json"),
    );
  });

  it("uses an explicit path and reports a missing one", () => {
    const root = tempDir();
    writeFiles(root, { "custom.json": "{}" });
    expect(findConfigFile(root, "custom.json")).toBe(path.join(root, "custom.json"));
    expect(() => findConfigFile(root, "missing.json")).toThrow("config file not found");
  });

  it("explains how to start when no config exists", () => {
    const root = tempDir();
    try {
      findConfigFile(root);
      throw new Error("expected failure");
    } catch (error) {
      if (!(error instanceof VerifikaError)) throw error;
      expect(error.message).toContain("no verifika.config.json found");
      expect(error.hint).toContain("verifika init");
    }
  });

  it("accepts a UTF-8 byte order mark and rejects malformed JSON", () => {
    const root = tempDir();
    writeFiles(root, {
      "bom.json": `\uFEFF${JSON.stringify({ version: 1, checks: { a: { command: "x" } } })}`,
      "bad.json": "{ version: 1 }",
    });
    expect(loadConfig(path.join(root, "bom.json")).checks).toHaveLength(1);
    expect(() => loadConfig(path.join(root, "bad.json"))).toThrow("is not valid JSON");
  });
});

describe("example configurations", () => {
  const examples = ["node-library", "angular-app", "nx-monorepo", "monorepo-package"];

  it.each(examples)("examples/%s.json is valid", (name) => {
    const raw = JSON.parse(
      readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), "utf8"),
    );
    expect(validateSchema(raw), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(() => parseConfig(raw, FILE)).not.toThrow();
  });
});
