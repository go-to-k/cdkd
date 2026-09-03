import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

// The docs/ tree is published as the cdkd.dev site (vite.docs.config.ts, Ox
// Content SSG). Two link classes broke silently before this fence existed:
//
//  1. Cross-doc anchor links (`other.md#fragment`) whose fragment does not
//     match any heading in the target — the page renders, the fragment 404s.
//     Found live on the first build: `why-cdkd.md` linked
//     `cli-reference.md#cdkd-rollback` while the real heading slug is
//     `cdkd-rollback-revert-a-failed-deploy`.
//  2. Sidebar `navigation` entries in vite.docs.config.ts pointing at pages
//     that do not exist — whether the alpha SSG plugin hard-fails on that is
//     unverified, so CI's docs build cannot be trusted to catch a typo.
//
// docs/_generated/** is excluded as a SOURCE (machine-written; its link
// hygiene is the generators' concern — issue tracked separately), but stays a
// valid TARGET.

const ROOT = resolve(import.meta.dirname, '../../..');
const DOCS = join(ROOT, 'docs');

const walkMarkdown = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
};

const handWrittenDocs = walkMarkdown(DOCS).filter(
  (f) => !relative(DOCS, f).startsWith('_generated')
);

// Line-state fence tracking rather than a column-0 regex: docs/ carries
// list-indented fences (e.g. state-management.md, troubleshooting.md) whose
// contents must not surface as phantom headings or links.
const stripFences = (markdown: string): string => {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const m = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      if (m && m[1].startsWith(fence[0]) && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

// Ox Content's heading-permalink slug, derived from the built site's actual
// ids (e.g. "Teardown (`cdkd bootstrap --destroy`, issue #1010)" →
// "teardown-cdkd-bootstrap-destroy-issue-1010", "`--no-wait`" → "no-wait",
// "pre-v0.94.0" → "pre-v0-94-0"): lowercase, every non-alphanumeric run
// becomes one hyphen, leading/trailing hyphens dropped. NOTE this differs
// from GitHub's slugger (which preserves consecutive hyphens); the site is
// the rendering that matters.
const oxSlug = (heading: string): string =>
  heading
    // Inline markdown links contribute their TEXT to the site's id, not
    // their URL: "Bounded growth (issue [#885](https://...))" renders as
    // id="bounded-growth-issue-885" (read off the built site).
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const headingSlugsOf = (file: string): Set<string> => {
  const slugs = new Set<string>();
  for (const line of stripFences(readFileSync(file, 'utf8')).split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) slugs.add(oxSlug(m[1]));
  }
  return slugs;
};

describe('published docs cross-links', () => {
  // The slug function is itself an assumption about the SSG's behavior; pin
  // it against ids read off the built site so a plugin upgrade that changes
  // the algorithm fails here instead of silently 404ing every anchor.
  it('slugifies the way the built site does', () => {
    expect(oxSlug('`cdkd rollback` (revert a failed deploy)')).toBe(
      'cdkd-rollback-revert-a-failed-deploy'
    );
    expect(oxSlug('Teardown (`cdkd bootstrap --destroy`, issue #1010)')).toBe(
      'teardown-cdkd-bootstrap-destroy-issue-1010'
    );
    expect(oxSlug('`--no-wait`')).toBe('no-wait');
    expect(oxSlug('Migration from pre-v0.94.0')).toBe('migration-from-pre-v0-94-0');
    expect(oxSlug('Wait semantics')).toBe('wait-semantics');
    // Unicode-punctuation run collapse is where sluggers genuinely diverge
    // (GitHub's slugger would keep separators); these three are pinned
    // against ids read off the built site.
    expect(oxSlug('`AWS::ECS::Service` — steady state')).toBe('aws-ecs-service-steady-state');
    expect(oxSlug('`cdkd scrub` (state secret hygiene: clean + audit)')).toBe(
      'cdkd-scrub-state-secret-hygiene-clean-audit'
    );
    expect(oxSlug('Bounded growth (issue [#885](https://github.com/go-to-k/cdkd/issues/885))')).toBe(
      'bounded-growth-issue-885'
    );
  });

  it('every relative md#fragment link resolves to a real heading', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const file of handWrittenDocs) {
      const body = stripFences(readFileSync(file, 'utf8'));
      for (const m of body.matchAll(/\]\(([^)#\s]+\.md)#([^)\s]+)\)/g)) {
        const [, target, fragment] = m;
        if (/^[a-z]+:/.test(target)) continue; // absolute URLs are out of scope
        checked += 1;
        const targetPath = resolve(dirname(file), target);
        if (!existsSync(targetPath)) {
          failures.push(`${relative(ROOT, file)} -> missing file ${target}`);
          continue;
        }
        if (!headingSlugsOf(targetPath).has(fragment)) {
          failures.push(`${relative(ROOT, file)} -> ${target}#${fragment} (no such heading)`);
        }
      }
    }
    // Anti-vacuity floor: the corpus carries well over this many anchor links
    // today; a refactor that silently stops the extractor from seeing any
    // would otherwise pass as "no failures".
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(failures).toEqual([]);
  });

  // Same-page `](#fragment)` links were the fence's blind spot: the cross-doc
  // test above only matches `file.md#fragment`. Five TOC/see-below links
  // shipped with GitHub-style slugs (`#proxy--corporate-network`) that 404 on
  // the site, whose slugger collapses every non-alphanumeric run to ONE
  // hyphen (issue #2467 lane, maintainer report 2026-09-03).
  it('every same-page #fragment link resolves to a heading in its own file', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const file of handWrittenDocs) {
      const body = stripFences(readFileSync(file, 'utf8'));
      const slugs = headingSlugsOf(file);
      for (const m of body.matchAll(/\]\(#([^)\s]+)\)/g)) {
        checked += 1;
        if (!slugs.has(m[1])) {
          failures.push(`${relative(ROOT, file)} -> #${m[1]} (no such heading on the page)`);
        }
      }
    }
    // Anti-vacuity floor: the corpus carries ~28 same-page anchors today.
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(failures).toEqual([]);
  });

  it('every relative md link (no fragment) resolves to a real file', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const file of handWrittenDocs) {
      const body = stripFences(readFileSync(file, 'utf8'));
      for (const m of body.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
        const [, target] = m;
        if (/^[a-z]+:/.test(target)) continue;
        checked += 1;
        if (!existsSync(resolve(dirname(file), target))) {
          failures.push(`${relative(ROOT, file)} -> missing file ${target}`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(50);
    expect(failures).toEqual([]);
  });
});

// Nav groups parsed from vite.docs.config.ts: [group title, page paths].
const navGroups = (): Array<[string, string[]]> => {
  const config = readFileSync(join(ROOT, 'vite.docs.config.ts'), 'utf8');
  const groups: Array<[string, string[]]> = [];
  for (const g of config.matchAll(/title: '([^']+)',\s*\n\s*items: \[([\s\S]*?)\],\s*\n\s*\}/g)) {
    const paths = [...g[2].matchAll(/path: '\/([^']+)'/g)].map((m) => m[1]);
    if (paths.length > 0) groups.push([g[1], paths]);
  }
  return groups;
};

describe('site navigation config', () => {
  it('every sidebar navigation path points at an existing docs page', () => {
    const paths = navGroups().flatMap(([, p]) => p);
    // Anti-vacuity floor: the sidebar carries ~23 entries today.
    expect(paths.length).toBeGreaterThanOrEqual(20);
    const missing = paths.filter((p) => !existsSync(join(DOCS, `${p}.md`)));
    expect(missing).toEqual([]);
  });

  // Every published docs page must be deliberately placed: either reachable
  // from the sidebar navigation, or marked `unlisted: true` so it leaves the
  // sitemap / llms.txt / pagination. A page in neither state is a silent
  // public publication — the nine machine-generated coverage matrices shipped
  // that way (issue #2467; their generators now emit the frontmatter).
  it('every docs page is a sidebar entry or unlisted', () => {
    const navPaths = new Set(navGroups().flatMap(([, p]) => p));
    // The entry page is the site root; it has no sidebar entry by design.
    const exempt = new Set(['index']);
    const failures: string[] = [];
    let checked = 0;
    for (const file of walkMarkdown(DOCS)) {
      const slug = relative(DOCS, file).replace(/\.md$/, '');
      checked += 1;
      const head = readFileSync(file, 'utf8').slice(0, 400);
      // Scope the test to the FIRST frontmatter block only — a lazy
      // whole-head match would also accept "unlisted: true" appearing in
      // body prose before a `---` thematic break (reviewer note).
      const fm = /^---\n([\s\S]*?)\n---/.exec(head);
      const unlisted = fm !== null && /\bunlisted:\s*true\b/.test(fm[1]);
      if (navPaths.has(slug) && unlisted) {
        failures.push(`docs/${slug}.md is BOTH a sidebar entry and unlisted (contradictory)`);
        continue;
      }
      if (navPaths.has(slug) || exempt.has(slug) || unlisted) continue;
      failures.push(`docs/${slug}.md is neither in the sidebar nav nor unlisted`);
    }
    // Anti-vacuity floor: docs/ holds far more pages than this.
    expect(checked).toBeGreaterThanOrEqual(40);
    expect(failures).toEqual([]);
  });

  // Maintainer policy (2026-09-03): user-facing pages must not surface GitHub
  // issue/PR references — they are internal provenance. Contributor-facing
  // pages (the Contributing group) and unlisted internal docs may keep them.
  it('user-facing pages carry no issue/PR references', () => {
    const groups = navGroups();
    expect(groups.map(([t]) => t)).toContain('Contributing');
    const userFacing = groups.filter(([t]) => t !== 'Contributing').flatMap(([, p]) => p);
    expect(userFacing.length).toBeGreaterThanOrEqual(15);
    const failures: string[] = [];
    for (const p of userFacing) {
      const body = stripFences(readFileSync(join(DOCS, `${p}.md`), 'utf8'))
        // Inline code spans may legitimately show a literal # token.
        .replace(/`[^`\n]*`/g, '');
      for (const m of body.matchAll(/issue #\d+|github\.com\/[^\s)]*\/issues\/\d+|\(#\d{3,5}\)|PR #\d+/g)) {
        failures.push(`docs/${p}.md: ${m[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
