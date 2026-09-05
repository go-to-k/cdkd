import { describe, expect, it } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `<name>.ts` a `.claude/rules/**` file cites must exist in the tree.
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
 * citation is a claim about the tree, and the tree can answer it. It cannot
 * catch a citation that resolves but describes the wrong behavior (the
 * `ecr-puller.ts` half of #2599 was exactly that shape — a live module with a
 * false parenthetical), so it is a floor, not a guarantee.
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
 * basename as cited; value is why the citation stays. Adding an entry is a
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
 * Both are literals taken from a measurement the fence does not itself
 * perform (`grep -o` over the corpus, 2026-09-05: 366 citations across 12 of
 * the rule files) — a floor computed from the pool it guards is satisfied by
 * that pool going empty.
 */
const MIN_CITATIONS = 250;
const MIN_FILES_WITH_CITATIONS = 8;

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

interface Citation {
  ruleFile: string;
  module: string;
}

function collectCitations(): Citation[] {
  const citations: Citation[] = [];
  for (const name of readdirSync(RULES_DIR).sort()) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(join(RULES_DIR, name), 'utf8');
    // Backticked code spans only. Bare prose mentions are excluded on
    // purpose: `.claude/rules/**` writes real module names in code spans by
    // convention, and matching unquoted text would pull in sentence
    // fragments that merely END in `.ts`.
    for (const match of text.matchAll(/`([A-Za-z0-9._-]+\.ts)`/g)) {
      const module = match[1] as string;
      // `.d.ts` / `.generated.ts` are SUFFIX fragments, not filenames — the
      // text writes them to name a file KIND. A leading dot is the tell.
      if (module.startsWith('.')) continue;
      citations.push({ ruleFile: name, module });
    }
  }
  return citations;
}

describe('.claude/rules module citations resolve against the tree', () => {
  const repoFileNames = new Set<string>();
  walkFileNames(REPO_ROOT, repoFileNames);
  const citations = collectCitations();

  it('sees the corpus it claims to check', () => {
    // The vacuous-pass guard: "no dead citations" and "parsed nothing" are
    // the same green without this.
    expect(
      citations.length,
      `Only ${citations.length} module citations found under .claude/rules — the ` +
        'code-span regex has probably stopped matching. Re-measure with ' +
        `grep -oE '\`[A-Za-z0-9._-]+\\.ts\`' .claude/rules/*.md | wc -l before lowering this floor.`
    ).toBeGreaterThanOrEqual(MIN_CITATIONS);
    const files = new Set(citations.map((c) => c.ruleFile));
    expect(
      files.size,
      `Citations came from only ${files.size} rule file(s): ${[...files].join(', ')}.`
    ).toBeGreaterThanOrEqual(MIN_FILES_WITH_CITATIONS);
    // The walk is the other half of the input; an empty or truncated one
    // makes every citation look dead rather than making them look alive, but
    // pin it anyway so the failure names the WALK instead of the text.
    expect(repoFileNames.has('local-start-alb.ts')).toBe(true);
    expect(repoFileNames.has('rule-file-payload.test.ts')).toBe(true);
  });

  it('cites no module that is missing from the tree', () => {
    const dead = citations
      .filter(
        (c) => !repoFileNames.has(c.module) && DELETED_MODULE_CITATIONS[c.module] === undefined
      )
      .map((c) => `${c.ruleFile} cites \`${c.module}\``);
    expect(
      [...new Set(dead)].sort(),
      'A .claude/rules file names a module that does not exist. Rules text is loaded into ' +
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
    const cited = new Set(citations.map((c) => c.module));
    const unused = Object.keys(DELETED_MODULE_CITATIONS)
      .filter((module) => !cited.has(module))
      .sort();
    expect(
      unused,
      'These DELETED_MODULE_CITATIONS entries are cited by no rule file any more. Drop them.'
    ).toEqual([]);
  });
});
