import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  type ScopedGroup,
  scopeDocuments,
  scopeShortcutsScript,
  scopesByPage,
  searchScopesPlugin,
} from '../../../docs/_site/plugins/search-scopes.js';

// cdkd.dev's search narrows a query to a scope (`@cli deploy`), and Ox Content
// reads a document's scopes from the directories in its id. The docs are one
// flat directory, so docs/_site/plugins/search-scopes.ts gives each document
// the scope of its sidebar group. This fence pins (1) the mapping from the
// sidebar, (2) the id rewrite and what it leaves alone, and (3) that the real
// sidebar gives every group a scope the search dialog offers.

const ROOT = resolve(import.meta.dirname, '../../..');

const GROUPS: ScopedGroup[] = [
  { scope: 'guide', items: [{ path: '/introduction' }, { path: '/wait-modes' }] },
  { scope: 'guide', items: [{ path: '/rollback/' }] },
  { scope: 'cli', items: [{ path: '/cli-deploy' }, {}] },
];

/**
 * The scopes Ox Content's search client derives from a document, as its
 * runtime does (`getOxContentScopesForDoc`): every directory prefix of the id.
 */
const clientScopesOf = (doc: { id: string; url: string }): string[] => {
  const segments = (doc.id || doc.url).replace(/^\/+/, '').toLowerCase().split('/').filter(Boolean);
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'));
};

describe('scopesByPage', () => {
  it('maps every listed page to its group scope, whatever slashes its path has', () => {
    expect([...scopesByPage(GROUPS)]).toEqual([
      ['introduction', 'guide'],
      ['wait-modes', 'guide'],
      ['rollback', 'guide'],
      ['cli-deploy', 'cli'],
    ]);
  });

  it('refuses a page listed under two scopes', () => {
    expect(() =>
      scopesByPage([...GROUPS, { scope: 'reference', items: [{ path: '/cli-deploy' }] }]),
    ).toThrow('/cli-deploy is in two scopes: cli and reference');
  });

  it('refuses a scope a query could not name', () => {
    for (const scope of ['CLI', 'cli ref', 'cli/deploy', '']) {
      expect(() => scopesByPage([{ scope, items: [] }])).toThrow('is not a scope a query can name');
    }
  });
});

describe('scopeDocuments', () => {
  const scopes = scopesByPage(GROUPS);

  it('puts the scope in front of the id, so the search client derives it', () => {
    const [doc] = scopeDocuments([{ id: 'cli-deploy', url: '/cli-deploy' }], scopes);
    expect(doc).toEqual({ id: 'cli/cli-deploy', url: '/cli-deploy' });
    expect(clientScopesOf(doc!)).toEqual(['cli']);
  });

  it('leaves the url, and every other field, as the SSG wrote them', () => {
    const before = { id: 'rollback', url: '/rollback', title: 'Rollback', body: 'text' };
    const [after] = scopeDocuments([before], scopes);
    expect(after).toEqual({ ...before, id: 'guide/rollback' });
    expect(before.id).toBe('rollback');
  });

  it('leaves the home page without a scope', () => {
    const home = { id: 'index', url: '/index' };
    expect(scopeDocuments([home], scopes)).toEqual([home]);
    expect(clientScopesOf(home)).toEqual([]);
  });

  it('stops on an indexed page no sidebar group lists, naming every one', () => {
    expect(() =>
      scopeDocuments(
        [
          { id: 'cli-deploy', url: '/cli-deploy' },
          { id: 'orphaned', url: '/orphaned' },
          { id: 'another', url: '/another' },
        ],
        scopes,
      ),
    ).toThrow('no sidebar group, so no search scope, for /orphaned, /another');
  });
});

describe('scopeShortcutsScript', () => {
  it('carries each scope as data, never as markup', () => {
    const script = scopeShortcutsScript([{ id: 'cli', label: '</script><b>the CLI' }]);
    expect(script).toContain('"id":"cli"');
    // The label reaches the page through `title`, set as a property.
    expect(script).toContain('button.title =');
    expect(script).not.toContain('innerHTML');
  });
});

describe('searchScopesPlugin', () => {
  const run = (documents: unknown[], error?: Error): { documents: unknown[]; index: unknown } => {
    const root = mkdtempSync(join(tmpdir(), 'cdkd-search-scopes-'));
    try {
      mkdirSync(join(root, 'dist/site'), { recursive: true });
      const file = join(root, 'dist/site/search-index.json');
      writeFileSync(file, JSON.stringify({ documents, index: { deploy: [{ doc_idx: 0 }] } }));
      const plugin = searchScopesPlugin({ outDir: 'dist/site', groups: GROUPS });
      (plugin.configResolved as (config: { root: string }) => void)({ root });
      (plugin.closeBundle as (error?: Error) => void)(error);
      return JSON.parse(readFileSync(file, 'utf8')) as { documents: unknown[]; index: unknown };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('rewrites the ids in the emitted index and keeps its postings', () => {
    const out = run([
      { id: 'cli-deploy', url: '/cli-deploy' },
      { id: 'index', url: '/index' },
    ]);
    expect(out.documents).toEqual([
      { id: 'cli/cli-deploy', url: '/cli-deploy' },
      { id: 'index', url: '/index' },
    ]);
    expect(out.index).toEqual({ deploy: [{ doc_idx: 0 }] });
  });

  it('leaves the index of a failed bundle alone', () => {
    const out = run([{ id: 'orphaned', url: '/orphaned' }], new Error('bundle failed'));
    expect(out.documents).toEqual([{ id: 'orphaned', url: '/orphaned' }]);
  });

  it('fails the build on a page without a scope', () => {
    expect(() => run([{ id: 'orphaned', url: '/orphaned' }])).toThrow('/orphaned');
  });
});

describe('the site sidebar', () => {
  const config = readFileSync(join(ROOT, 'docs/_site/vite.config.ts'), 'utf8');
  const offered = [
    .../const SEARCH_SCOPES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(config)![1]!.matchAll(/id: '([^']+)'/g),
  ].map((m) => m[1]);
  const used = [
    .../const navigation\b[^=]*=\s*\[([\s\S]*?)\n\];/
      .exec(config)![1]!
      .matchAll(/^ {4}scope: '([^']+)'/gm),
  ].map((m) => m[1]);

  it('gives every group a scope', () => {
    const groups = [...config.matchAll(/^ {4}title: '[^']+',\n {4}items: \[/gm)].length;
    // Anti-vacuity floor: the sidebar has seven groups today.
    expect(groups).toBeGreaterThanOrEqual(6);
    expect(used).toHaveLength(groups);
  });

  it('offers a shortcut for exactly the scopes its groups use', () => {
    expect([...new Set(used)].sort()).toEqual([...offered].sort());
  });
});
