import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { oxSlug, stripFences } from '../../ox-slug.js';

// Messages cdkd prints, the skill it distributes, the README and the
// changelog fragments link readers to https://cdkd.dev. Each link has to be
// well formed, stand on its own (a stray `$` before it breaks the link in a
// terminal), land on a page the site builds from docs/_contents, and name
// an anchor that page has.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CONTENTS = join(ROOT, 'docs', '_contents');
// Everything up to a character that ends a link in prose, Markdown or code.
const LINK = /https?:\/\/cdkd\.dev[^\s"'`<>()[\]{}]*/g;
const SHAPE = /^https:\/\/cdkd\.dev(?:\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?)?$/;
const OPENS_LINK = /^$|[\s([<{'"`]$/;

const walk = (dir: string, keep: (file: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });

const sources = [
  ...walk(join(ROOT, 'src'), (file) => file.endsWith('.ts')),
  ...walk(join(ROOT, 'plugins'), (file) => file.endsWith('.md')),
  ...walk(join(ROOT, 'changelog.d', 'entries'), (file) => file.endsWith('.md')),
  join(ROOT, 'README.md'),
];

const links = sources.flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(LINK)].map((m) => ({
    where: relative(ROOT, file),
    // Sentence punctuation after a link is not part of it.
    url: m[0].replace(/[.,;:!?]+$/, ''),
    before: text.slice(Math.max(0, m.index - 1), m.index),
  }));
});

const pageFor = (path: string): string => {
  const slug = path.replace(/^\/|\/$/g, '');
  return join(CONTENTS, slug === '' ? 'index.md' : `${slug}.md`);
};

const headingIds = (page: string): Set<string> =>
  new Set(
    [...stripFences(readFileSync(page, 'utf8')).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) =>
      oxSlug(m[1]!)
    )
  );

describe('cdkd.dev links in shipped text', () => {
  it('finds the links it checks', () => {
    // A pattern that stopped matching would pass every case below vacuously.
    expect(links.some((link) => link.where.startsWith('src/') && link.url.includes('#'))).toBe(true);
    expect(links.some((link) => link.where.startsWith('plugins/'))).toBe(true);
    expect(links.some((link) => link.where.startsWith('changelog.d/'))).toBe(true);
  });

  it.each(links.map((link) => [`${link.where} -> ${link.url}`, link]))('%s', (_name, link) => {
    expect(link.url, 'not a cdkd.dev page or section link').toMatch(SHAPE);
    expect(link.before, 'the link is glued to the character before it').toMatch(OPENS_LINK);
    const [path, anchor] = link.url.replace(/^https:\/\/cdkd\.dev/, '').split('#');
    const page = pageFor(path ?? '');
    expect(() => statSync(page), `no page for ${path}`).not.toThrow();
    if (anchor) expect([...headingIds(page)]).toContain(anchor);
  });
});
