import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addVerifyScripts } from "../../src/init.ts";
import { tempDir, writeFiles } from "../helpers/repo.ts";

function withManifest(text: string): { root: string; read: () => string } {
  const root = tempDir();
  writeFiles(root, { "package.json": text });
  return { root, read: () => readFileSync(path.join(root, "package.json"), "utf8") };
}

describe("addVerifyScripts", () => {
  it("appends both scripts, keeping indentation, key order and the trailing newline", async () => {
    const original = {
      name: "app",
      scripts: { test: "vitest run", lint: "eslint ." },
      devDependencies: { verifika: "^0.0.3" },
    };
    for (const indent of ["  ", "    ", "\t"]) {
      const { root, read } = withManifest(`${JSON.stringify(original, null, indent)}\n`);
      expect(await addVerifyScripts(root)).toEqual({ added: ["verify", "verify:ci"], kept: [] });
      const expected = {
        ...original,
        scripts: { ...original.scripts, verify: "vfk", "verify:ci": "vfk --all" },
      };
      expect(read()).toBe(`${JSON.stringify(expected, null, indent)}\n`);
    }
  });

  it("keeps CRLF line endings, a missing trailing newline and one-line manifests", async () => {
    const crlf = withManifest('{\r\n  "scripts": {\r\n    "test": "x"\r\n  }\r\n}');
    await addVerifyScripts(crlf.root);
    expect(crlf.read()).toBe(
      '{\r\n  "scripts": {\r\n    "test": "x",\r\n    "verify": "vfk",\r\n    "verify:ci": "vfk --all"\r\n  }\r\n}',
    );
    const compact = withManifest('{"scripts":{"test":"x"}}\n');
    await addVerifyScripts(compact.root);
    expect(compact.read()).toBe(
      '{"scripts":{"test":"x","verify":"vfk","verify:ci":"vfk --all"}}\n',
    );
  });

  it("never overwrites existing scripts", async () => {
    const text = `${JSON.stringify({ scripts: { verify: "npm run lint && npm test" } }, null, 2)}\n`;
    const { root, read } = withManifest(text);
    expect(await addVerifyScripts(root)).toEqual({
      added: ["verify:ci"],
      kept: [{ name: "verify", command: "npm run lint && npm test" }],
    });
    expect(JSON.parse(read()).scripts).toEqual({
      verify: "npm run lint && npm test",
      "verify:ci": "vfk --all",
    });

    const both = `${JSON.stringify({ scripts: { verify: "vfk", "verify:ci": "make ci" } }, null, 2)}\n`;
    const untouched = withManifest(both);
    expect((await addVerifyScripts(untouched.root)).added).toEqual([]);
    expect(untouched.read()).toBe(both);
  });

  it("creates the scripts object when there is none", async () => {
    const { root, read } = withManifest('{\n  "name": "app"\n}\n');
    await addVerifyScripts(root);
    expect(read()).toBe(
      '{\n  "name": "app",\n  "scripts": {\n    "verify": "vfk",\n    "verify:ci": "vfk --all"\n  }\n}\n',
    );
  });
});
