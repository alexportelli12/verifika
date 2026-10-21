// The README and the landing page both carry the agent setup prompt. The
// landing page is static HTML with no build step, so a check (rather than
// injection) keeps its copy button from drifting from the README.
const decodeAttribute = (text) =>
  text
    .replace(/&#10;/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const flat = (text) => text.replace(/\s+/g, " ").trim();

// The prompt is the README's first fenced block that starts "Set up Verifika".
export function readmePrompt(readme) {
  const block = [...readme.matchAll(/```text\n([\s\S]*?)\n```/g)].find((match) =>
    match[1].startsWith("Set up Verifika"),
  );
  return block?.[1];
}

export function checkConsistency(files) {
  const problems = [];
  const prompt = readmePrompt(files.get("README.md") ?? "");
  if (!prompt)
    return [
      'README.md: the agent setup prompt (a text block starting "Set up Verifika") is missing',
    ];
  const landing = files.get("site/index.html") ?? "";
  const copyValues = [...landing.matchAll(/data-copy=(["'])([\s\S]*?)\1/g)].map((match) =>
    decodeAttribute(match[2]),
  );
  if (!copyValues.some((value) => flat(value) === flat(prompt)))
    problems.push("site/index.html: the setup prompt's copy button must carry the README's prompt");
  const shown = [...landing.matchAll(/<pre[^>]*data-prompt[^>]*>([\s\S]*?)<\/pre>/g)].map((match) =>
    flat(decodeAttribute(match[1].replace(/<[^>]+>/g, ""))),
  );
  if (!shown.includes(flat(prompt)))
    problems.push(
      "site/index.html: the setup prompt shown (the <pre data-prompt> block) must match the README's",
    );
  return problems;
}
