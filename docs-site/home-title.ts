// Home-page `<title>` for cdkd.dev.
//
// Search engines (Google in particular) take a result's headline from the
// `<title>` tag, and the home page shipped `<title>cdkd</title>` — the bare
// site name, with no hint of what the project does. The SSG composes the tag
// as `<page title> - <siteName>` and collapses to the bare site name ONLY when
// the page title equals it; there is no frontmatter or `ssg` option to
// suppress the suffix (probed: `titleSuffix`, `titleTemplate`, `head:` — all
// ignored, each build yielding `… - cdkd`). Setting the long title in
// frontmatter therefore renders `cdkd - The fastest way to deploy AWS CDK. -
// cdkd`, and also breaks og-template.ts's home detection, which keys on the
// title being the site name.
//
// So the frontmatter stays `title: cdkd` (the OG image, JSON-LD, llms.txt and
// the hero keep working off it) and this plugin rewrites the title surfaces
// of dist/site/index.html after the SSG has emitted it. The home title is
// DERIVED from docs/index.md's `hero.text` rather than written as a literal,
// so the hero headline and the search-result headline cannot drift apart —
// tests/unit/scripts/docs-site-home-title.test.ts fences the derivation and
// the rewrite.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite-plus';
import { parse as parseYaml } from 'yaml';

/**
 * `hero.text` from an entry page's frontmatter, or undefined when absent,
 * not a string, or blank. Parsed with the `yaml` package cdkd already ships
 * (src/cli/yaml-cfn.ts) — five review rounds of a hand-rolled walk each
 * found one more YAML shape it misread (`hero.actions[].text` taken for
 * `hero.text`, blank lines and comments ending the block, `\n` / `\uXXXX`
 * escapes), which is the signal to use the real parser. A frontmatter the
 * parser rejects THROWS on purpose: Ox Content swallows the same parse
 * failure (measured: `transformAsync` returns `frontmatter: {}` and renders
 * the page without its hero), so this throw is the only thing that stops a
 * heroless home page shipping under the bare title. The value is returned
 * trimmed so the blank check and the headline agree on a quoted `"  a  "`.
 */
export function heroTextOf(markdown: string): string | undefined {
  // Same delimiter shape as Ox Content's own parseFrontmatter (CRLF-tolerant).
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!fm) return undefined;
  const doc: unknown = parseYaml(fm[1]);
  const hero = (doc as { hero?: unknown } | null)?.hero;
  const text = (hero as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined;
}

/** `<siteName> - <hero.text>` — what the home page's `<title>` should read. */
export function homeTitleOf(siteName: string, indexMarkdown: string): string {
  const text = heroTextOf(indexMarkdown);
  if (!text) {
    throw new Error('[home-title] docs/index.md has no `hero.text` to derive the home title from');
  }
  return `${siteName} - ${text}`;
}

const escapeAttr = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/** The four (bare → rewritten) needles, in the order they appear in the head. */
const titleNeedles = (siteName: string, homeTitle: string): Array<[string, string]> => {
  const bare = escapeAttr(siteName);
  const full = escapeAttr(homeTitle);
  return [
    [`<title>${bare}</title>`, `<title>${full}</title>`],
    [`<meta property="og:title" content="${bare}">`, `<meta property="og:title" content="${full}">`],
    [`<meta name="twitter:title" content="${bare}">`, `<meta name="twitter:title" content="${full}">`],
    [`"headline":${JSON.stringify(siteName)}`, `"headline":${JSON.stringify(homeTitle)}`],
  ];
};

/**
 * Rewrite the `<title>`, `og:title`, `twitter:title` and JSON-LD `headline`
 * of an emitted home page whose title is the bare `siteName`. Every other
 * page (whose title is `X - siteName`) and a home page already carrying the
 * long title pass through unchanged, so the rewrite is idempotent and cannot
 * touch the sidebar / header, which name the site in other elements. The
 * WebSite `"name"` in the same JSON-LD block is left alone on purpose: that
 * IS the site name.
 */
export function rewriteHomeTitle(html: string, siteName: string, homeTitle: string): string {
  let out = html;
  for (const [from, to] of titleNeedles(siteName, homeTitle)) {
    // Replacer FUNCTION: a string replacement would expand `$&`, `$'`, `$$`
    // inside the title text.
    out = out.replace(from, () => to);
  }
  return out;
}

export interface HomeTitlePluginOptions {
  siteName: string;
  /** Directory the SSG emits into (`dist/site`), relative to the Vite root. */
  outDir: string;
  /** Entry page source whose `hero.text` supplies the headline (`docs/index.md`), relative to the Vite root. */
  indexMarkdownPath: string;
}

/**
 * Vite plugin: runs in `closeBundle` AFTER the Ox Content SSG has written the
 * site and patches the home page in place. Two things sequence it, and both
 * are load-bearing: `enforce: 'post'` sorts it after oxContent's plugins
 * (which carry no `enforce`), and Rolldown runs `closeBundle` hooks
 * sequentially, so oxContent's async hook has finished writing before this
 * one reads. Build-only: the dev server never emits index.html, so there is
 * nothing to patch (`vp run docs:dev` shows the bare title by design). Fails
 * the build rather than shipping the bare title if the emitted head no longer
 * has the shape it rewrites.
 */
export function homeTitlePlugin(options: HomeTitlePluginOptions): Plugin {
  let root = process.cwd();
  return {
    name: 'cdkd:docs-home-title',
    enforce: 'post',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    closeBundle(error) {
      // A failed bundle: leave its own error as the build's verdict rather
      // than replacing it with an ENOENT on a site that was never written.
      if (error) return;
      // No existence guard on purpose: ox-content logs and swallows most SSG
      // failures, so a missing index.html after a build is exactly the case
      // that must fail loudly rather than no-op on an empty site.
      const indexHtml = join(resolve(root, options.outDir), 'index.html');
      const homeTitle = homeTitleOf(
        options.siteName,
        readFileSync(resolve(root, options.indexMarkdownPath), 'utf8')
      );
      const before = readFileSync(indexHtml, 'utf8');
      const after = rewriteHomeTitle(before, options.siteName, homeTitle);
      // "Rewritten", not "rewritten somewhere": the long form must be present
      // AND the bare form gone (String.replace touches the first match only).
      const missing = titleNeedles(options.siteName, homeTitle)
        .filter(([from, to]) => !after.includes(to) || after.includes(from))
        .map(([from]) => from);
      if (missing.length > 0) {
        throw new Error(
          `[home-title] ${indexHtml}: could not rewrite ${missing.join(', ')} — the SSG's head shape changed; update docs-site/home-title.ts`
        );
      }
      if (after !== before) writeFileSync(indexHtml, after);
    },
  };
}
