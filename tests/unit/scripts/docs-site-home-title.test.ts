import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  heroTextOf,
  homeTitleOf,
  homeTitlePlugin,
  rewriteHomeTitle,
} from '../../../docs-site/home-title.js';

// cdkd.dev's home page shipped `<title>cdkd</title>`, so a Google result for
// the site read "cdkd" and nothing else. docs-site/home-title.ts patches the
// SSG's output into `cdkd - <hero.text>`; this fence pins (1) the derivation
// from docs/index.md, so the hero headline and the search headline cannot
// drift apart, (2) the rewrite against a head captured from a real build, and
// (3) that no other page's title is touched.

const ROOT = resolve(import.meta.dirname, '../../..');
const INDEX_MD = readFileSync(join(ROOT, 'docs/index.md'), 'utf8');
const SITE_NAME = 'cdkd';

// Lines of dist/site/index.html as Ox Content 3.0.0-beta.11 emits them (each
// line verbatim; unrelated head lines cut). The plugin's build-time guard is
// what catches a shape change, this fence what the rewrite does to the shape
// it knows.
const HOME_HEAD = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '  <title>cdkd</title>',
  '  <meta name="description" content="Deploy AWS CDK apps directly via AWS APIs — up to 15x faster, no CloudFormation.">',
  '  <meta property="og:title" content="cdkd">',
  '  <meta name="twitter:card" content="summary_large_image">',
  '  <meta name="twitter:title" content="cdkd">',
  '  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"cdkd","url":"https://cdkd.dev","@id":"https://cdkd.dev#website"},{"@type":"TechArticle","headline":"cdkd","description":"Deploy AWS CDK apps directly via AWS APIs — up to 15x faster, no CloudFormation.","url":"https://cdkd.dev/","@id":"https://cdkd.dev/#article","isPartOf":{"@id":"https://cdkd.dev#website"}}]}</script>',
  '</head>',
  '<body>',
  '    <a href="/index.html" class="header-title" aria-label="cdkd">',
  '  <h1 class="hero-name">cdkd</h1>',
  '</body>',
].join('\n');

describe('docs-site home title', () => {
  it('derives the home title from docs/index.md hero.text', () => {
    expect(heroTextOf(INDEX_MD)).toBe('The fastest way to deploy AWS CDK.');
    expect(homeTitleOf(SITE_NAME, INDEX_MD)).toBe('cdkd - The fastest way to deploy AWS CDK.');
  });

  it('reads hero.text as YAML, not by line shape', () => {
    // Another block's `text` key, quoting, blank lines and comments — every
    // shape a hand-rolled walk misread in review, now the parser's problem.
    const md = '---\ntitle: x\nfeatures:\n  - text: wrong\nhero:\n  name: x\n  text:   The right one.  \n---\n';
    expect(heroTextOf(md)).toBe('The right one.');
    expect(heroTextOf('---\nhero:\n  text: "Quoted: yes."\n---\n')).toBe('Quoted: yes.');
    expect(heroTextOf('---\nhero:\n\n  name: x\n\n  text: After blanks.\nfeatures: []\n---\n')).toBe(
      'After blanks.'
    );
    expect(heroTextOf('---\nhero:\n  name: x\nother:\n  text: wrong\n---\n')).toBeUndefined();
    expect(heroTextOf('---\nhero: # why\n  text: b\n---\n')).toBe('b');
    expect(heroTextOf('---\nhero:\n  name: x\n# note\n  text: d\n---\n')).toBe('d');
    expect(heroTextOf('---\nhero:\n  text: Fast. # todo\n---\n')).toBe('Fast.');
    expect(heroTextOf('---\nhero:\n  text: "C# fast" # todo\n---\n')).toBe('C# fast');
    expect(heroTextOf('---\nhero:\n  text: C#fast\n---\n')).toBe('C#fast');
    expect(heroTextOf("---\nhero:\n  text: 'it''s'\n---\n")).toBe("it's");
    expect(heroTextOf('---\nhero:\n  text: "a\\u0041b"\n---\n')).toBe('aAb');
    // `---` inside a value is not the closing fence (mutant: `\n---` -> `---`
    // shipped `cdkd - a` here); a quoted value comes back trimmed.
    expect(heroTextOf('---\nhero:\n  text: a --- b\n---\n')).toBe('a --- b');
    expect(heroTextOf('---\nhero:\n  text: "  a  "\n---\n')).toBe('a');
    expect(heroTextOf('---\r\nhero:\r\n  text: crlf\r\n---\r\n')).toBe('crlf');
    // Absent / not a string / blank — bare, quoted, comment-only, null.
    expect(heroTextOf('---\ntitle: x\n---\n')).toBeUndefined();
    expect(heroTextOf('no frontmatter at all\n')).toBeUndefined();
    expect(heroTextOf('---\n# nothing but a comment\n---\n')).toBeUndefined();
    expect(heroTextOf('---\nhero: plain scalar\n---\n')).toBeUndefined();
    expect(heroTextOf('---\nhero:\n  text: 42\n---\n')).toBeUndefined();
    for (const v of ['  ', '" "', "' '", '# todo', '#only', '~']) {
      expect(heroTextOf(`---\nhero:\n  text: ${v}\n---\n`), v).toBeUndefined();
      expect(() => homeTitleOf(SITE_NAME, `---\nhero:\n  text: ${v}\n---\n`), v).toThrow(/hero\.text/);
    }
    // Malformed YAML is the parser's error, not a silently wrong headline.
    expect(() => heroTextOf('---\nhero:\n  text: "a" b "c"\n---\n')).toThrow();
  });

  it('does not fall through to hero.actions[].text when hero.text is removed', () => {
    // Regression fence for the shipped-once bug: a line-shape walk took
    // `hero.actions[0].text` ("Get Started") for `hero.text` and shipped
    // `cdkd - Get Started`. Structurally impossible for a YAML parse; kept so
    // a return to line matching fails here.
    const withoutText = INDEX_MD.replace(/^  text: .*\n/m, '');
    expect(withoutText).not.toBe(INDEX_MD);
    expect(withoutText).toMatch(/^      text: Get Started$/m);
    expect(heroTextOf(withoutText)).toBeUndefined();
    expect(() => homeTitleOf(SITE_NAME, withoutText)).toThrow(/hero\.text/);
  });

  it('rewrites every title surface of the home page and nothing else', () => {
    const homeTitle = homeTitleOf(SITE_NAME, INDEX_MD);
    const out = rewriteHomeTitle(HOME_HEAD, SITE_NAME, homeTitle);
    expect(out).toContain('<title>cdkd - The fastest way to deploy AWS CDK.</title>');
    expect(out).toContain('<meta property="og:title" content="cdkd - The fastest way to deploy AWS CDK.">');
    expect(out).toContain('<meta name="twitter:title" content="cdkd - The fastest way to deploy AWS CDK.">');
    expect(out).toContain('"headline":"cdkd - The fastest way to deploy AWS CDK."');
    // The site's own name stays the site's name everywhere else.
    expect(out).toContain('"@type":"WebSite","name":"cdkd"');
    expect(out).toContain('aria-label="cdkd"');
    expect(out).toContain('<h1 class="hero-name">cdkd</h1>');
    expect(out).not.toContain('<title>cdkd</title>');
    // Idempotent: a second pass finds nothing to rewrite.
    expect(rewriteHomeTitle(out, SITE_NAME, homeTitle)).toBe(out);
  });

  it('leaves a non-home page untouched', () => {
    const page = HOME_HEAD.replaceAll('"cdkd"', '"Getting Started - cdkd"').replace(
      '<title>cdkd</title>',
      '<title>Getting Started - cdkd</title>'
    );
    expect(rewriteHomeTitle(page, SITE_NAME, homeTitleOf(SITE_NAME, INDEX_MD))).toBe(page);
  });

  it('escapes a title that carries HTML-significant characters', () => {
    const out = rewriteHomeTitle(HOME_HEAD, SITE_NAME, 'cdkd - CDK & "friends" <fast>');
    expect(out).toContain('<title>cdkd - CDK &amp; &quot;friends&quot; &lt;fast&gt;</title>');
    expect(out).toContain('content="cdkd - CDK &amp; &quot;friends&quot; &lt;fast&gt;"');
    expect(out).toContain('"headline":"cdkd - CDK & \\"friends\\" <fast>"');
  });

  it('passes replacement-pattern characters through literally', () => {
    // `$'` / `$&` / `$$` are expansions for a STRING replacement; a title
    // holding one produced a nested, corrupted head before the replacer
    // became a function.
    const out = rewriteHomeTitle(HOME_HEAD, SITE_NAME, "cdkd - $' $& $$ ok");
    expect(out).toContain("<title>cdkd - $' $&amp; $$ ok</title>");
    expect(out).toContain('"headline":"cdkd - $\' $& $$ ok"');
  });

  describe('plugin', () => {
    const run = (html: string, markdown = INDEX_MD, bundleError?: Error): string => {
      const dir = mkdtempSync(join(tmpdir(), 'home-title-'));
      try {
        mkdirSync(join(dir, 'site'));
        writeFileSync(join(dir, 'site/index.html'), html);
        writeFileSync(join(dir, 'index.md'), markdown);
        const plugin = homeTitlePlugin({
          siteName: SITE_NAME,
          outDir: 'site',
          indexMarkdownPath: 'index.md',
        }) as unknown as {
          configResolved: (c: { root: string }) => void;
          closeBundle: (error?: Error) => void;
        };
        plugin.configResolved({ root: dir });
        plugin.closeBundle(bundleError);
        return readFileSync(join(dir, 'site/index.html'), 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('patches index.html under the resolved Vite root', () => {
      expect(run(HOME_HEAD)).toContain('<title>cdkd - The fastest way to deploy AWS CDK.</title>');
    });

    it('stands down when the bundle itself failed', () => {
      // The bundle's own error must stay the verdict: the page is left
      // exactly as found, even one that would otherwise be rewritten.
      expect(run(HOME_HEAD, INDEX_MD, new Error('bundle failed'))).toBe(HOME_HEAD);
    });

    it('fails the build when ANY of the four surfaces stops matching', () => {
      // Review probe: a `<title>`-only guard let a reordered og:title ship
      // bare while the build stayed green.
      const reordered = HOME_HEAD.replace(
        '<meta property="og:title" content="cdkd">',
        '<meta content="cdkd" property="og:title">'
      );
      expect(() => run(reordered)).toThrow(/og:title/);
      expect(() => run(HOME_HEAD.replace('<title>cdkd</title>', '<title>CDKD</title>'))).toThrow(
        /<title>cdkd<\/title>/
      );
      // A duplicated tag: the first is rewritten, the second survives bare —
      // "rewritten somewhere" is not "rewritten".
      const duplicated = HOME_HEAD.replace(
        '  <meta name="twitter:title" content="cdkd">',
        '  <meta name="twitter:title" content="cdkd">\n  <meta name="twitter:title" content="cdkd">'
      );
      expect(() => run(duplicated)).toThrow(/twitter:title/);
    });

    it('is a no-op on an already-patched page and build-only', () => {
      const patched = rewriteHomeTitle(HOME_HEAD, SITE_NAME, homeTitleOf(SITE_NAME, INDEX_MD));
      expect(run(patched)).toBe(patched);
      const p = homeTitlePlugin({ siteName: 'x', outDir: 'o', indexMarkdownPath: 'i' });
      expect(p.apply).toBe('build');
      // Sorts it after oxContent's plugins (which carry no `enforce`) whatever
      // the array order — the docstring calls it load-bearing, so pin it.
      expect(p.enforce).toBe('post');
    });
  });
});
