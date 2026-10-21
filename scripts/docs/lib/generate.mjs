// Turns the allowlisted files into Markdown pages. Nothing here copies facts
// by hand: configuration options come from the JSON schema, flags and exit
// codes from the CLI's own help, examples and the skill from their files.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { REPO_URL, trackedPaths } from "./source.mjs";

const posix = path.posix;

// A page is { route, title, nav, section, markdown }. Routes have no extension;
// "index" is the Start here page.
const SECTIONS = ["Start here", "Guides", "Reference", "Examples", "Agent skill", "Changelog"];
// The guides in reading order; any other docs/*.md page follows alphabetically.
const GUIDE_ORDER = ["configuration", "cli", "agents", "architecture", "benchmarks"];

export class DocsError extends Error {}

// Where a tracked source file is published, or null when it has no page.
function routeFor(file) {
  let match;
  if (file === "README.md") return "index";
  if (file === "CHANGELOG.md") return "changelog";
  if (file === "schemas/verifika.schema.json") return "reference/configuration";
  if (file === "skills/verifika/SKILL.md") return "agent-skill";
  if (file === "examples" || file === "examples/README.md") return "examples/index";
  if ((match = file.match(/^examples\/([^/]+)\.json$/))) return `examples/${match[1]}`;
  if ((match = file.match(/^docs\/([^/]+)\.md$/))) return match[1];
  return null;
}

// Relative link from one page to another, in the form both VitePress and the
// plain .md copies understand.
export function pageLink(from, to) {
  return `${posix.relative(posix.dirname(from), to)}.md`;
}

// Source files link to each other by repository path. Published pages link to
// pages; anything else tracked links to GitHub; anything untracked is plain text.
function rewriteLinks(markdown, { file, route, tracked }) {
  const trackedSet = new Set(tracked);
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(
        /(!?)\[((?:[^\][]|!\[[^\]]*\]\([^)]*\))*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
        (whole, bang, text, target, title) => {
          if (
            /^[a-z][a-z0-9+.-]*:/i.test(target) ||
            target.startsWith("#") ||
            target.startsWith("/")
          )
            return whole;
          const [pathPart, anchor] = target.split("#");
          const resolved = posix
            .normalize(posix.join(posix.dirname(file), pathPart))
            .replace(/\/$/, "");
          const page = bang ? null : routeFor(resolved);
          if (page)
            return `[${text}](${pageLink(route, page)}${anchor ? `#${anchor}` : ""}${title})`;
          if (bang) return text;
          if (trackedSet.has(resolved))
            return `[${text}](${REPO_URL}/blob/main/${resolved}${anchor ? `#${anchor}` : ""})`;
          if (tracked.some((name) => name.startsWith(`${resolved}/`)))
            return `[${text}](${REPO_URL}/tree/main/${resolved})`;
          return text;
        },
      );
    })
    .join("\n");
}

export const firstSentenceOf = (text) =>
  text.replace(/\s+/g, " ").match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
const sentence = (text) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const titleOf = (body, fallback) => body.match(/^# (.+)$/m)?.[1].trim() ?? fallback;
const codeCell = (value) => `\`${String(value).replace(/\|/g, "\\|")}\``;
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ");

// ---- Configuration options, from the JSON schema ----------------------------

const resolveRef = (schema, node) => {
  if (!node.$ref) return node;
  const target = node.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((current, key) => current?.[key], schema);
  if (!target) throw new DocsError(`schema: unresolved reference ${node.$ref}`);
  // The referencing node's own description wins over the shared one.
  return { ...resolveRef(schema, target), ...node, $ref: undefined };
};

const flatten = (schema, node) => {
  const resolved = resolveRef(schema, node);
  if (!resolved.allOf) return resolved;
  return resolved.allOf.reduce((merged, part) => ({ ...flatten(schema, part), ...merged }), {
    ...resolved,
    allOf: undefined,
  });
};

function typeOf(schema, node) {
  const resolved = flatten(schema, node);
  if ("const" in resolved) return JSON.stringify(resolved.const);
  if (resolved.type === "array") {
    const item = resolved.items ? typeOf(schema, resolved.items) : "any";
    return `array of ${item}s`;
  }
  return [].concat(resolved.type ?? "any").join(" or ");
}

function constraintsOf(schema, node) {
  const resolved = flatten(schema, node);
  const parts = [];
  if (resolved.minimum !== undefined && resolved.maximum !== undefined)
    parts.push(`${resolved.minimum} to ${resolved.maximum}`);
  else if (resolved.minimum !== undefined) parts.push(`at least ${resolved.minimum}`);
  if (resolved.minItems)
    parts.push(`at least ${resolved.minItems} item${resolved.minItems > 1 ? "s" : ""}`);
  if (resolved.uniqueItems) parts.push("unique items");
  if (resolved.minLength) parts.push("not empty");
  return parts.join(", ");
}

// One row per option, named by its dotted path. `checks.<name>` stands for
// every check, because the schema describes them through additionalProperties.
function schemaRows(schema, node, prefix = "") {
  const rows = [];
  const resolved = flatten(schema, node);
  const children = Object.entries(resolved.properties ?? {}).filter(([key]) => key !== "$schema");
  for (const [key, property] of children) {
    const name = `${prefix}${key}`;
    const child = flatten(schema, property);
    rows.push({
      name,
      type: typeOf(schema, property),
      required: (resolved.required ?? []).includes(key),
      constraints: constraintsOf(schema, property),
      description: child.description ?? "",
    });
    if (child.type === "object") rows.push(...schemaRows(schema, child, `${name}.`));
  }
  if (typeof resolved.additionalProperties === "object") {
    rows.push(...schemaRows(schema, resolved.additionalProperties, `${prefix}<name>.`));
  }
  return rows;
}

function configurationPage(schema) {
  const rootRequired = schema.required ?? [];
  const sections = Object.entries(schema.properties).filter(([key]) => key !== "$schema");
  const lines = [
    "# Configuration options",
    "",
    "Every option `verifika.config.json` accepts, generated from the JSON schema in `schemas/verifika.schema.json`. A new option appears here when it enters the schema. The [configuration guide](configuration.md) explains how they work together.",
    "",
  ];
  for (const [key, property] of sections) {
    const group = flatten(schema, property);
    lines.push(`## ${key}`, "");
    const rows = [
      {
        name: key,
        type: typeOf(schema, property),
        required: rootRequired.includes(key),
        constraints: constraintsOf(schema, property),
        description: group.description ?? "",
      },
      ...schemaRows(schema, property, `${key}.`),
    ];
    // A group with no leaf options is its own row; otherwise only the leaves.
    const leaves = rows.length > 1 ? rows.slice(1) : rows;
    if (leaves.length > 1 || leaves[0].name !== key)
      lines.push(sentence(group.description ?? ""), "");
    lines.push("| Option | Type | Details |", "| --- | --- | --- |");
    for (const row of leaves) {
      const details = [row.constraints ? `Limits: ${row.constraints}.` : "", row.description]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `| ${codeCell(row.name)} | ${cell(row.type)}${row.required ? ", required" : ""} | ${cell(details)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---- Flags and exit codes, from the CLI's own help ---------------------------

function readCli(root) {
  const run = (args) =>
    execFileSync(process.execPath, [path.join(root, "src/cli.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const help = run(["--help"]).trimEnd();
  const codes = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { ExitCode } from "./src/errors.ts"; console.log(JSON.stringify(ExitCode));`,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  return { help, codes };
}

// The help is a fixed layout: "Heading (applies to):" then rows indented by
// two spaces ("-c, --check <name>") or six ("--all"), with wrapped descriptions
// indented under the description column.
export function parseHelp(help) {
  const sections = [];
  let current = null;
  let last = null;
  for (const line of help.split("\n")) {
    const heading = line.match(/^([A-Z][A-Za-z ]*)(?: \(([^)]*)\))?:$/);
    if (heading) {
      current = { name: heading[1], appliesTo: heading[2] ?? "", rows: [] };
      sections.push(current);
      last = null;
      continue;
    }
    if (!current) continue;
    const flag = line.match(/^ {2}(?:(-\w),\s+| {4})(--[\w-]+)(?: (<[^>]+>))?\s{2,}(\S.*)$/);
    const command = line.match(/^ {2}(vfk\b.*?)\s{2,}(\S.*)$/);
    if (flag) {
      last = { flag: flag[2], short: flag[1] ?? "", argument: flag[3] ?? "", description: flag[4] };
      current.rows.push(last);
    } else if (command) {
      last = { command: command[1], description: command[2] };
      current.rows.push(last);
    } else if (last && /^ {20,}\S/.test(line)) {
      last.description += ` ${line.trim()}`;
    } else {
      last = null;
    }
  }
  return sections;
}

function exitCodeRows(help, codes) {
  const paragraph = help.split(/^Exit codes: /m)[1]?.split(/\nDocs:/)[0];
  if (!paragraph) throw new DocsError("could not find the exit codes in `vfk --help`");
  const rows = paragraph
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .replace(/\([^)]*\)/g, (group) => group.replaceAll(",", "\0")) // commas inside parentheses stay
    .split(/,\s+(?=\d)/)
    .map((part) => part.match(/^(\S+) (.+)$/))
    .filter(Boolean)
    .map((match) => ({ code: match[1], meaning: match[2].replaceAll("\0", ",") }));
  // Codes the CLI defines but its help does not list still get a row.
  for (const [name, value] of Object.entries(codes)) {
    if (!rows.some((row) => row.code === String(value)))
      rows.push({ code: String(value), meaning: `${name.toLowerCase()} error` });
  }
  return rows.sort((a, b) => parseInt(a.code, 10) - parseInt(b.code, 10));
}

function cliPage(root) {
  const { help, codes } = readCli(root);
  const sections = parseHelp(help);
  const commands = sections.find((section) => section.rows.some((row) => row.command));
  if (!commands) throw new DocsError("could not read the commands from `vfk --help`");
  const lines = [
    "# Command-line options",
    "",
    "Commands, flags and exit codes, generated from the CLI's own `vfk --help`. The [CLI guide](cli.md) covers output modes, logs and signals.",
    "",
    "## Commands",
    "",
    "| Command | What it does |",
    "| --- | --- |",
    ...commands.rows.map(
      (row) => `| ${codeCell(row.command)} | ${cell(sentence(row.description))} |`,
    ),
    "",
  ];
  for (const section of sections.filter((candidate) => candidate.rows.some((row) => row.flag))) {
    lines.push(`## ${section.name}`, "");
    if (section.appliesTo) {
      const names = section.appliesTo.split(/,\s*/).map((name) => `\`${name}\``);
      lines.push(`Applies to ${names.join(" and ")}.`, "");
    }
    lines.push("| Flag | Argument | What it does |", "| --- | --- | --- |");
    for (const row of section.rows.filter((candidate) => candidate.flag)) {
      const flags = row.short ? `${row.short}, ${row.flag}` : row.flag;
      lines.push(
        `| ${codeCell(flags)} | ${row.argument ? codeCell(row.argument) : ""} | ${cell(sentence(row.description))} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Exit codes",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    ...exitCodeRows(help, codes).map(
      (row) =>
        `| ${codeCell(row.code)} | ${cell(sentence(row.meaning.replace(/^./, (letter) => letter.toUpperCase())))} |`,
    ),
    "",
    "## Full help",
    "",
    "```text",
    help,
    "```",
    "",
  );
  return lines.join("\n");
}

// ---- Pages -------------------------------------------------------------------

export async function generatePages({ root, files }) {
  const tracked = trackedPaths(root);
  const get = (name) => files.get(name);
  const context = (file, route) => ({ file, route, tracked });
  const fromSource = (file, route) => rewriteLinks(get(file), context(file, route));
  const pages = [];
  const add = (page) => pages.push(page);

  add({
    route: "index",
    title: titleOf(get("README.md"), "Verifika"),
    nav: "Overview",
    section: "Start here",
    markdown: fromSource("README.md", "index"),
  });

  // Guides: the hand-written pages, as they are minus their frontmatter.
  const guides = [...files.keys()].filter((name) => /^docs\/[^/]+\.md$/.test(name));
  const rank = (file) => {
    const index = GUIDE_ORDER.indexOf(posix.basename(file, ".md"));
    return index === -1 ? GUIDE_ORDER.length : index;
  };
  for (const file of guides.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const route = routeFor(file);
    const { body } = parseFrontmatter(get(file));
    const title = titleOf(body, route);
    add({
      route,
      title,
      nav: title,
      section: "Guides",
      markdown: rewriteLinks(body, context(file, route)),
    });
  }

  // Reference pages, generated.
  const schema = JSON.parse(get("schemas/verifika.schema.json"));
  add({
    route: "reference/configuration",
    title: "Configuration options",
    nav: "Configuration options",
    section: "Reference",
    markdown: configurationPage(schema),
  });
  add({
    route: "reference/cli",
    title: "Command-line options",
    nav: "Command-line options",
    section: "Reference",
    markdown: cliPage(root),
  });

  // Examples: the index from examples/README.md, one page per file.
  const exampleFiles = [...files.keys()]
    .filter((name) => /^examples\/[^/]+\.json$/.test(name))
    .sort();
  const readme = get("examples/README.md");
  add({
    route: "examples/index",
    title: "Example configurations",
    nav: "All examples",
    section: "Examples",
    markdown: rewriteLinks(readme, context("examples/README.md", "examples/index")),
  });
  for (const file of exampleFiles) {
    const name = posix.basename(file);
    const route = routeFor(file);
    const row = readme.match(
      new RegExp(`\\[\`${name.replace(".", "\\.")}\`\\]\\([^)]*\\)\\s*\\|\\s*([^|]+?)\\s*\\|`),
    );
    const purpose = row ? `${sentence(row[1])} ` : "";
    add({
      route,
      title: name,
      nav: name,
      section: "Examples",
      markdown: [
        `# ${name}`,
        "",
        `${purpose}Copy it to \`verifika.config.json\` in your project root, adjust the script names and globs, then check the result with \`npx vfk plan\`.`,
        "",
        "```json",
        get(file).trimEnd(),
        "```",
        "",
        `Every option is described in the [configuration options](${pageLink(route, "reference/configuration")}).`,
        "",
      ].join("\n"),
    });
  }

  // Agent skill.
  const { data, body } = parseFrontmatter(get("skills/verifika/SKILL.md"));
  if (!data.description?.trim())
    throw new DocsError("skills/verifika/SKILL.md has no `description` in its frontmatter");
  add({
    route: "agent-skill",
    title: "Agent skill",
    nav: "Agent skill",
    section: "Agent skill",
    markdown: [
      "# Agent skill",
      "",
      sentence(data.description),
      "",
      `This page is the skill file, \`skills/verifika/SKILL.md\`. The [agent integration guide](${pageLink("agent-skill", "agents")}) shows how to install it.`,
      "",
      rewriteLinks(
        body.replace(/^\s*# .*\n+/, ""),
        context("skills/verifika/SKILL.md", "agent-skill"),
      ).trim(),
      "",
    ].join("\n"),
  });

  // Changelog.
  add({
    route: "changelog",
    title: "Changelog",
    nav: "Changelog",
    section: "Changelog",
    markdown: fromSource("CHANGELOG.md", "changelog"),
  });

  return { pages };
}

// Sidebar: sections in a fixed order, pages in the order they were added.
export function buildSidebar(pages) {
  const link = (route) => (route === "index" ? "/" : `/${route}`);
  return SECTIONS.map((section) => ({
    text: section,
    items: pages
      .filter((page) => page.section === section)
      .map((page) => ({ text: page.nav, link: link(page.route) })),
  })).filter((group) => group.items.length);
}
