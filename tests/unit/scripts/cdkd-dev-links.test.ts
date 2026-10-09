import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { oxSlug, stripFences } from '../../ox-slug.js';

// Messages cdkd prints and the skill it distributes link readers to
// https://cdkd.dev. Each link has to land on a page the site builds from
// docs/_contents, and an anchor on a heading that page has.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CONTENTS = join(ROOT, 'docs', '_contents');
const LINK = /https:\/\/cdkd\.dev(\/[a-z0-9/_-]*)(?:#([a-z0-9-]+))?/g;

const walk = (dir: string, keep: (file: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });

const sources = [
  ...walk(join(ROOT, 'src'), (file) => file.endsWith('.ts')),
  ...walk(join(ROOT, 'plugins'), (file) => file.endsWith('.md')),
];

const links = sources.flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(LINK)].map((m) => ({
    where: relative(ROOT, file),
    path: m[1]!,
    anchor: m[2],
  }))
);

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
    expect(links.some((link) => link.where.startsWith('src/') && link.anchor)).toBe(true);
    expect(links.some((link) => link.where.startsWith('plugins/'))).toBe(true);
  });

  it.each(links.map((link) => [`${link.where} -> ${link.path}${link.anchor ? `#${link.anchor}` : ''}`, link]))(
    '%s',
    (_name, link) => {
      const page = pageFor(link.path);
      expect(() => statSync(page), `no page for ${link.path}`).not.toThrow();
      if (link.anchor) expect([...headingIds(page)]).toContain(link.anchor);
    }
  );
});
