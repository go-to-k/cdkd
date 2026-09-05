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
 * - **Path form** in a code span — `` `src/analyzer/dag-builder.ts` ``. 247 of
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
 *   pinned by IDENTITY instead ({@link EXEMPT_CITATIONS}), so the corpus
 *   cannot quietly drift toward unverifiable references. A `..`-relative code
 *   span is unverifiable for a different reason — it has no base directory
 *   that resolves — and is pinned in the same place.
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
 * perform (2026-09-06: 611 code-span citations, of which 247 are path form,
 * plus 6 markdown links, across 39 of the 45 rule files) — a floor computed
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
 * Keyed `<rule file> :: <cited>`, and kept honest in both directions: an entry
 * that stops being cited fails, and an entry that starts RESOLVING fails —
 * because an exemption for something checkable hides the NEXT defect at that
 * path rather than excusing this one.
 *
 * The residual, measured rather than assumed: adding an entry for a path that
 * does NOT resolve silences it completely, and no assertion here can tell a
 * legitimate exemption from a lazy one. That is what an allow-list IS. What
 * the fence can do it does — it refuses to let one be added silently, to let
 * one outlive its citation, or to let one cover a path that has started
 * resolving. The rest is the reason line, which is why each entry carries one.
 */
const EXEMPT_CITATIONS: Record<string, string> = {
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
      // NO SLASH, and the guard now says exactly that. Two earlier spellings
      // each left a hole one spelling over: a bare `startsWith('.')` swallowed
      // every `../`-relative citation (round 3), and `!startsWith('..')`
      // still swallowed `./src/gone.ts` — measured round 4, invisible to all
      // four checks, in the very revision that closed the `/`-prefixed
      // laundering. The corpus's only dot-led citations are `.d.ts` and
      // `.generated.ts`, neither of which carries a slash.
      if (cited.startsWith('.') && !cited.includes('/')) continue;
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
function candidateTargetsOf(citation: Citation): string[] {
  if (citation.kind === 'bare') return [];
  // The corpus writes a path three ways and all three are legitimate, so all
  // three are tried rather than guessed at from the citation's syntax:
  // relative to the rules directory (every markdown link, and a `../`-relative
  // code span), relative to the repo root (the common code-span form), and
  // relative to `src/` (three citations use the shorter spelling).
  return [
    resolve(RULES_DIR, citation.cited),
    resolve(REPO_ROOT, citation.cited),
    resolve(REPO_ROOT, 'src', citation.cited),
  ];
}

/** The key {@link EXEMPT_CITATIONS} pins a citation by. */
function exemptKey(citation: Citation): string {
  return `${citation.ruleFile} :: ${citation.cited}`;
}

function resolvesInTree(citation: Citation, repoFileNames: Set<string>): boolean {
  switch (citation.kind) {
    case 'bare':
      return repoFileNames.has(citation.cited);
    case 'path':
    case 'link':
      return candidateTargetsOf(citation).some(existsSync);
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

  it('keeps every exemption honest in both directions', () => {
    const cited = new Map(citations.map((c) => [exemptKey(c), c]));
    const pinned = Object.keys(EXEMPT_CITATIONS).sort();

    // An entry nothing cites any more outlives the text it was written for.
    expect(
      pinned.filter((key) => !cited.has(key)),
      'These EXEMPT_CITATIONS entries are cited by no rule file any more. Drop them.'
    ).toEqual([]);

    // ...and an entry that RESOLVES is an exemption for something checkable,
    // which hides the NEXT defect at that path rather than excusing this one.
    // This is the direction a count could never express: it could see how
    // many exemptions there were, never whether any had stopped earning its
    // place.
    //
    // Asked ONLY of citations every candidate base keeps inside the repo. An
    // out-of-repo path's resolution is exactly the machine-dependent fact this
    // fence refuses to depend on — and the first cut of this very assertion
    // consulted it, so it passed in CI and failed on the maintainer's machine,
    // where the sibling checkout happens to exist. The hermeticity bug the
    // fence exists to prevent, reproduced inside the fence.
    expect(
      pinned.filter((key) => {
        const citation = cited.get(key);
        if (citation === undefined) return false;
        const targets = candidateTargetsOf(citation);
        if (targets.length > 0 && !targets.some(insideRepo)) return false;
        return resolvesInTree(citation, repoFileNames);
      }),
      'These EXEMPT_CITATIONS entries now RESOLVE, so the exemption does nothing except hide ' +
        'future breakage at that path. Drop them — the citations are checked on their own.'
    ).toEqual([]);
  });

  it('cites no module that is missing from the tree', () => {
    const dead = citations
      .filter(
        (c) =>
          EXEMPT_CITATIONS[exemptKey(c)] === undefined &&
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
