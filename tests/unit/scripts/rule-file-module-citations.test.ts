import { describe, expect, it } from 'vite-plus/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Every `.ts` file a `.claude/rules/**` file cites must exist in the tree.
 *
 * ## Why this fence exists
 *
 * `.claude/rules/**` is loaded into every session that touches the matching
 * area, so a wrong statement there PROPAGATES rather than sitting still — the
 * reason those files were removed from `/review-pr`'s down-bias set. Issue
 * [#2599](https://github.com/go-to-k/cdkd/issues/2599) is the concrete case:
 * `src/local/cfn-local-state-provider.ts` was deleted by
 * [#2607](https://github.com/go-to-k/cdkd/issues/2607) and `layout-local.md`
 * kept describing it, in the present tense, as the module that reads a
 * deployed CloudFormation stack — for a whole release cycle, because NOTHING
 * checked it. The rules corpus already has size, count and payload fences
 * (`rule-file-payload.test.ts`); none of them reads what the text SAYS.
 *
 * This is the cheapest derived assertion available over that corpus: a module
 * citation is a claim about the tree, and the tree can answer it.
 *
 * ## The three citation spellings, and why all three are read
 *
 * The corpus writes a module three ways, and a fence that reads only one is
 * green over the other two. The first cut read BARE BASENAMES only and shipped
 * green over a LIVE instance of its own target defect (found in review):
 * `analyzer.md` told future sessions to extend
 * `src/analyzer/intrinsic-resolver.ts` and to write
 * `tests/unit/analyzer/intrinsic-resolver.test.ts` — neither has ever existed
 * under those names; the module is `src/deployment/intrinsic-function-resolver.ts`,
 * named correctly seven lines above. Measured populations (2026-09-06):
 *
 * - **Bare basename** in a code span — `` `docker-runner.ts` ``. 364 of them.
 *   Resolved against a SET OF BASENAMES collected from a repo walk.
 * - **Path form** in a code span — `` `src/analyzer/dag-builder.ts` ``. 246 of
 *   them, invisible to the first cut. Resolved as a path from the repo root,
 *   falling back to `src/<cited>`: the corpus writes both spellings and three
 *   citations are `src`-relative (`utils/aws-region-resolver.ts`,
 *   `cli/commands/gc.ts`, `assets/asset-redirect.ts`). Calibrated against the
 *   pre-fix tree — without that fallback all three are false positives.
 * - **Markdown link** — `` [confirm-prompt.ts](../../src/cli/commands/confirm-prompt.ts) ``.
 *   6 of them. Resolved RELATIVE TO THE RULES DIRECTORY, which is what those
 *   links are relative to.
 *
 * ## Bounds — stated, because an over-claimed fence is the defect it guards
 *
 * - A BARE citation resolves against a basename set, so it only asks "does a
 *   file with this NAME exist anywhere". A module that MOVED still passes; a
 *   path-form citation of the same module would not. This is why the path form
 *   is the better spelling to use in the corpus.
 * - It cannot catch a citation that RESOLVES but describes the wrong
 *   behaviour. The `ecr-puller.ts` half of #2599 was exactly that shape — a
 *   live module with a false parenthetical. Nothing cheap can check those.
 * - A citation naming a path OUTSIDE this repo is not checked at all, and
 *   deliberately so: `gate-sibling-repos.md` cites an absolute
 *   `/Users/.../cdk-local/src/types/state.ts`, which resolves on the
 *   maintainer's machine and does not exist in CI. Verifying it would make
 *   this fence pass or fail on whether a sibling checkout happens to be
 *   present — the hermeticity failure a fence is least able to notice, since
 *   it goes green on the machine you develop on. Such citations are counted
 *   pinned by IDENTITY instead ({@link UNVERIFIABLE_CITATIONS}), so the corpus
 *   cannot quietly drift toward unverifiable references.
 *
 * ## Deliberately-dead citations
 *
 * Rules text cites deleted modules ON PURPOSE — the record of a removal is
 * itself load-bearing (`layout-local.md`'s orphan inventory, the
 * `import-tag-walk.ts` rationale for why `import-helpers.ts` does no tag
 * walk). Those live in {@link DELETED_MODULE_CITATIONS}, and the list is
 * checked in BOTH directions: an unlisted dead citation fails, and a listed
 * one that starts resolving again fails too. A one-directional allow-list
 * rots silently — an entry whose file returns would sit there forever,
 * exempting a citation that no longer needs exempting.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const RULES_DIR = join(REPO_ROOT, '.claude/rules');

/** Directories that hold no first-party source and would swamp the walk. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'cdk.out',
  'coverage',
  '.claude',
  'docs-site',
]);

/**
 * Modules the rules cite that are GONE from the tree on purpose. Key is the
 * BASENAME, whatever spelling the citation used — which is a deliberate
 * looseness with a cost worth naming: a stale PATH-form citation whose
 * basename is listed here (say `src/wrong/place/import-tag-walk.ts`) is
 * exempted too. Keying by full path instead would demand an entry per
 * spelling of a file that no longer exists, which is worse; the entries are
 * few and each is read when it changes. Value is why the citation stays. Adding an entry is a
 * claim that the text is talking about history — if it is talking about the
 * present, fix the text instead.
 */
const DELETED_MODULE_CITATIONS: Record<string, string> = {
  'cfn-local-state-provider.ts':
    'layout-local.md orphan inventory: deleted by go-to-k/cdkd#2607 (issue go-to-k/cdkd#2527); the sentence attributes the deletion and sizes it.',
  'lambda-authorizer.ts':
    'layout-local.md: named as DELETED in slice 12, with a pointer to where the logic survives.',
  'authorizer-context.ts':
    'layout-local.md: named as DELETED alongside lambda-authorizer.ts (zero remaining cdkd consumers).',
  'import-tag-walk.ts':
    'layout-provisioning.md: removed by go-to-k/cdkd#1134, and the removal is the RATIONALE for import-helpers.ts doing no aws:cdk:path tag walk.',
};

/**
 * Floors, so a regex that silently stopped matching cannot pass vacuously.
 * Every figure is a LITERAL from a measurement this fence does not itself
 * perform (2026-09-06: 610 code-span citations, of which 246 are path form,
 * plus 6 markdown links, across 38 of the 45 rule files) — a floor computed
 * from the pool it guards is satisfied by that pool going empty.
 *
 * There is a floor PER SPELLING, not just a grand total: the first cut read
 * one spelling of three and its aggregate floor was comfortably satisfied
 * while 40% of the corpus went unread.
 */
const MIN_CODE_SPAN_CITATIONS = 520;
const MIN_PATH_FORM_CITATIONS = 200;
const MIN_MARKDOWN_LINK_CITATIONS = 5;
const MIN_FILES_WITH_CITATIONS = 30;

/**
 * Citations this fence cannot check, pinned BY IDENTITY rather than counted.
 *
 * A count was tried first and review found two holes in it. It could not tell
 * one unverifiable citation from another, so deleting this entry and adding a
 * different one passed silently. And it was LAUNDERABLE: a stale in-repo path
 * re-spelled with a leading `/` (`` `/src/gone.ts` ``) resolves as absolute,
 * classifies as external, and skips the dead-citation check entirely. An exact
 * set closes both — a new unverifiable citation is a new key, whatever its
 * spelling.
 *
 * Two kinds live here, for two different reasons:
 *
 * - **Out of repo.** `gate-sibling-repos.md` names an absolute path into a
 *   sibling checkout. It resolves on the maintainer's machine and never in CI,
 *   so checking it would make this fence pass where you develop and fail where
 *   it matters — the hermeticity failure a fence is least able to notice.
 * - **`..`-relative.** `docs-page-template.md` writes `../src/x.ts` as an
 *   ILLUSTRATION of a link that must not appear in `docs/`. There is no base
 *   directory that makes it resolvable, and it is not meant to.
 *
 * Keyed `<rule file> :: <cited>`, checked in both directions.
 */
const UNVERIFIABLE_CITATIONS: Record<string, string> = {
  'gate-sibling-repos.md :: /Users/goto/pc/github/cdk-local/src/types/state.ts':
    'absolute path into a sibling checkout; present only on a developer machine, never in CI.',
  'docs-page-template.md :: ../src/x.ts':
    'deliberate placeholder illustrating a relative link that must NOT escape docs/.',
};

function walkFileNames(dir: string, out: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFileNames(join(dir, entry.name), out);
    } else {
      out.add(entry.name);
    }
  }
}

type CitationKind = 'bare' | 'path' | 'link';

/** True when an absolute path lies inside the repo (so the fence may check it). */
function insideRepo(absolutePath: string): boolean {
  const rel = relative(REPO_ROOT, absolutePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

interface Citation {
  ruleFile: string;
  cited: string;
  kind: CitationKind;
}

function collectCitations(): Citation[] {
  const citations: Citation[] = [];
  for (const name of readdirSync(RULES_DIR).sort()) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(join(RULES_DIR, name), 'utf8');
    // Code spans. The character class now admits `/` so the path form is
    // visible; without it the fence read basenames only.
    for (const match of text.matchAll(/`([A-Za-z0-9._/-]+\.ts)`/g)) {
      const cited = match[1] as string;
      // `.d.ts` / `.generated.ts` are SUFFIX fragments, not filenames — the
      // text writes them to name a file KIND. The tell is a leading dot with
      // NO slash; the guard used to be a bare `startsWith('.')`, which also
      // swallowed `../`-relative citations and hid them from every check
      // (review round 3). Those now reach the classifier and land in
      // UNVERIFIABLE_CITATIONS, where they are at least counted by identity.
      if (cited.startsWith('.') && !cited.startsWith('..')) continue;
      citations.push({ ruleFile: name, cited, kind: cited.includes('/') ? 'path' : 'bare' });
    }
    // Markdown links, which the corpus uses for cross-file pointers.
    for (const match of text.matchAll(/\]\(([A-Za-z0-9._/-]+\.ts)\)/g)) {
      citations.push({ ruleFile: name, cited: match[1] as string, kind: 'link' });
    }
  }
  return citations;
}

/**
 * Where a citation points, as an absolute path — or `undefined` for a bare
 * basename, which names no location at all.
 */
function targetOf(citation: Citation): string | undefined {
  if (citation.kind === 'bare') return undefined;
  // A markdown link in a rules file is relative to the rules directory; a
  // path-form code span is relative to the repo root.
  return citation.kind === 'link'
    ? resolve(RULES_DIR, citation.cited)
    : resolve(REPO_ROOT, citation.cited);
}

/**
 * A citation this fence cannot check: it points outside the repo (so checking
 * it would depend on the host machine) or it is `..`-relative with no base
 * that resolves. Both are pinned by identity in {@link UNVERIFIABLE_CITATIONS}.
 */
function isUnverifiable(citation: Citation): boolean {
  // A `..`-prefixed CODE SPAN has no defined base — it is prose, not a link.
  // A markdown LINK is relative to the rules directory and resolves normally,
  // so `..` is ordinary there; four live links start with it. Scoping this to
  // code spans matters: an earlier revision applied it to both and turned four
  // perfectly checkable links into unverifiable ones.
  if (citation.kind !== 'link' && citation.cited.startsWith('..')) return true;
  const target = targetOf(citation);
  return target !== undefined && !insideRepo(target);
}

/** The key {@link UNVERIFIABLE_CITATIONS} pins a citation by. */
function unverifiableKey(citation: Citation): string {
  return `${citation.ruleFile} :: ${citation.cited}`;
}

function resolvesInTree(citation: Citation, repoFileNames: Set<string>): boolean {
  switch (citation.kind) {
    case 'bare':
      return repoFileNames.has(citation.cited);
    case 'path':
      // Repo-root first, then `src/`-relative: the corpus writes both, and
      // three live citations use the shorter form.
      return (
        existsSync(join(REPO_ROOT, citation.cited)) ||
        existsSync(join(REPO_ROOT, 'src', citation.cited))
      );
    case 'link':
      return existsSync(resolve(RULES_DIR, citation.cited));
  }
}

/** The allow-list is keyed by BASENAME, whatever spelling the citation used. */
function basenameOf(cited: string): string {
  return cited.slice(cited.lastIndexOf('/') + 1);
}

describe('.claude/rules module citations resolve against the tree', () => {
  const repoFileNames = new Set<string>();
  walkFileNames(REPO_ROOT, repoFileNames);
  const citations = collectCitations();
  const countOf = (kind: CitationKind) => citations.filter((c) => c.kind === kind).length;

  it('sees every spelling of the corpus it claims to check', () => {
    // The vacuous-pass guard: "no dead citations" and "parsed nothing" are
    // the same green without this, and a per-spelling floor is what the
    // aggregate could not say — the first cut read one spelling of three.
    const codeSpans = countOf('bare') + countOf('path');
    expect(
      codeSpans,
      `Only ${codeSpans} code-span citations found under .claude/rules — the ` +
        'code-span regex has probably stopped matching.'
    ).toBeGreaterThanOrEqual(MIN_CODE_SPAN_CITATIONS);
    expect(
      countOf('path'),
      `Only ${countOf('path')} PATH-form citations found — the character class has ` +
        'probably lost `/`, which is the exact regression that let a stale ' +
        '`src/analyzer/intrinsic-resolver.ts` ship green.'
    ).toBeGreaterThanOrEqual(MIN_PATH_FORM_CITATIONS);
    expect(
      countOf('link'),
      `Only ${countOf('link')} markdown-link citations found — the link regex has ` +
        'probably stopped matching.'
    ).toBeGreaterThanOrEqual(MIN_MARKDOWN_LINK_CITATIONS);
    const files = new Set(citations.map((c) => c.ruleFile));
    expect(
      files.size,
      `Citations came from only ${files.size} rule file(s): ${[...files].sort().join(', ')}.`
    ).toBeGreaterThanOrEqual(MIN_FILES_WITH_CITATIONS);
    // The walk is the other half of the input; an empty or truncated one
    // makes every citation look dead rather than alive, but pin it anyway so
    // the failure names the WALK instead of the text.
    expect(repoFileNames.has('local-start-alb.ts')).toBe(true);
    expect(repoFileNames.has('rule-file-payload.test.ts')).toBe(true);
  });

  it('pins every unverifiable citation by identity, in both directions', () => {
    const found = [...new Set(citations.filter(isUnverifiable).map(unverifiableKey))].sort();
    const pinned = Object.keys(UNVERIFIABLE_CITATIONS).sort();
    // EQUALITY, not a count. A count could not tell one unverifiable citation
    // from another, so swapping this entry for a different one passed silently
    // — and a stale in-repo path re-spelled with a leading `/` laundered
    // itself out of the dead-citation check by classifying as external.
    expect(
      found,
      'The set of .claude/rules citations this fence cannot verify has changed. Each one either ' +
        'points outside the repo (resolves on a developer machine, never in CI) or is ' +
        '`..`-relative with no resolvable base. Prefer naming the repo and path in prose over a ' +
        'machine-specific absolute path; if the citation must stay, add it to ' +
        'UNVERIFIABLE_CITATIONS with the reason.'
    ).toEqual(pinned);
  });

  it('cites no module that is missing from the tree', () => {
    const dead = citations
      .filter(
        (c) =>
          !isUnverifiable(c) &&
          !resolvesInTree(c, repoFileNames) &&
          DELETED_MODULE_CITATIONS[basenameOf(c.cited)] === undefined
      )
      .map((c) => `${c.ruleFile} cites ${c.cited} (${c.kind})`);
    expect(
      [...new Set(dead)].sort(),
      'A .claude/rules file names a .ts file that does not exist. Rules text is loaded into ' +
        'every session working in that area, so a stale name propagates. Fix the sentence to ' +
        'describe what actually ships; if the citation is deliberately HISTORICAL (recording ' +
        'a removal), add the basename to DELETED_MODULE_CITATIONS with the reason.'
    ).toEqual([]);
  });

  it('keeps DELETED_MODULE_CITATIONS honest in the other direction', () => {
    // An entry whose file came back is an exemption nothing needs — and it
    // would silently cover a future stale citation of the same name.
    const resurrected = Object.keys(DELETED_MODULE_CITATIONS)
      .filter((module) => repoFileNames.has(module))
      .sort();
    expect(
      resurrected,
      'These modules exist in the tree again, so their DELETED_MODULE_CITATIONS entries are ' +
        'stale. Drop the entries — the citations resolve on their own now.'
    ).toEqual([]);

    // ...and an entry nothing cites is dead weight that outlives the text it
    // was written for.
    const cited = new Set(citations.map((c) => basenameOf(c.cited)));
    const unused = Object.keys(DELETED_MODULE_CITATIONS)
      .filter((module) => !cited.has(module))
      .sort();
    expect(
      unused,
      'These DELETED_MODULE_CITATIONS entries are cited by no rule file any more. Drop them.'
    ).toEqual([]);
  });
});
