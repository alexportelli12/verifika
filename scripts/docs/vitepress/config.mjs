// Copied into docs-site/.vitepress/ by build.mjs, next to site-data.json (the
// generated sidebar). Search is VitePress's built-in local index: no service.
import { defineConfig } from "vitepress";
import siteData from "./site-data.json";

const base = process.env.DOCS_BASE ?? "/verifika/docs/";

export default defineConfig({
  lang: "en-GB",
  title: "Verifika",
  description:
    "Docs for Verifika: a verification CLI that runs only the checks your change needs, for developers and coding agents.",
  base,
  outDir: process.env.DOCS_OUT_DIR,
  appearance: "force-dark", // the landing page is dark only
  // public/ holds the plain .md copies; they ship as files, not as pages.
  srcExclude: ["public/**"],
  cleanUrls: false,
  ignoreDeadLinks: false, // a broken internal link fails the build; the `docs` check relies on it
  head: [["link", { rel: "icon", href: `${base}favicon.svg`, type: "image/svg+xml" }]],
  markdown: {
    config(md) {
      // Sources are plain Markdown. Raw HTML would let text such as <name>
      // become a Vue element, so escape it instead.
      md.set({ html: false });
    },
  },
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Guides", link: "/configuration.html" },
      { text: "Reference", link: "/reference/configuration.html" },
      { text: "Examples", link: "/examples/" },
      { text: "Landing page", link: "https://alexportelli12.github.io/verifika/" },
    ],
    sidebar: siteData.sidebar,
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/alexportelli12/verifika" }],
    outline: [2, 3],
  },
});
