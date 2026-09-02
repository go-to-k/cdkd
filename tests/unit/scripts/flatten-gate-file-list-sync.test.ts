import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `flatten-before-rebase-gate.sh` blocks an unflattened `git rebase` only when
 * the branch touches an APPEND-SHAPED generated file -- one every lane appends
 * to at the same place, so every lane conflicts there. That list lives in TWO
 * places by necessity:
 *
 *   1. `APPEND_SHAPED` in the hook, which decides whether the gate FIRES;
 *   2. `references/ship.md` section 9, which carries the RESOLUTION recipe the
 *      hook's refusal message points the caller at.
 *
 * A file in the hook but not in ship.md refuses with a pointer to a recipe that
 * does not cover it. A file in ship.md but not the hook is a documented
 * conflict the gate never catches -- which is the pre-hook status quo, i.e. the
 * exact gap go-to-k/cdkd#2428 / go-to-k/cdkd#2450 walked into on five lanes
 * across two runs.
 *
 * This is the same two-halves-must-name-the-same-files invariant
 * `cross-cutting-list-sync.test.ts` fences for the integ gates, and it is a
 * TEST rather than a sentence for the reason `references/retro.md` section 10-b
 * gives: the rule this gate enforces was already written down and was violated
 * anyway.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const HOOK = join(repoRoot, '.claude', 'hooks', 'flatten-before-rebase-gate.sh');
const SHIP = join(
  repoRoot,
  '.claude',
  'skills',
  'work-issues',
  'references',
  'ship.md',
);

/**
 * The hook's list, read from the assignment rather than hard-coded here: a
 * copy in this file would be a THIRD place to drift, which is what the test
 * exists to prevent.
 */
function hookFiles(): string[] {
  const src = readFileSync(HOOK, 'utf8');
  const m = src.match(/^APPEND_SHAPED='([^']*)'/m);
  expect(
    m,
    `flatten-before-rebase-gate.sh no longer assigns APPEND_SHAPED as a single-quoted ` +
      `space-separated literal, so this fence cannot read the list it is supposed to ` +
      `compare. Restore that shape, or rewrite this reader in the same commit -- do not ` +
      `delete the fence, which would leave the hook and ship.md free to drift.`,
  ).not.toBeNull();
  return m![1]!.split(/\s+/).filter(Boolean);
}

describe('flatten-before-rebase-gate append-shaped file list', () => {
  it('names at least the changelog (an empty list makes the gate inert)', () => {
    const files = hookFiles();
    expect(
      files,
      `APPEND_SHAPED is empty or lost the changelog. The gate only fires when a branch ` +
        `touches one of these files, so an empty list is a gate that can never block ` +
        `while still reading as installed.`,
    ).toContain('docs/changelog-cdkd.md');
  });

  it('every file the hook gates is one ship.md section 9 tells you how to resolve', () => {
    const ship = readFileSync(SHIP, 'utf8');
    for (const f of hookFiles()) {
      expect(
        ship.includes(f),
        `flatten-before-rebase-gate.sh gates on "${f}", but ` +
          `.claude/skills/work-issues/references/ship.md never mentions it. The hook's ` +
          `refusal sends the caller to ship.md section 9 for the resolution recipe, so a ` +
          `file the gate blocks on and that document does not cover is a refusal with no ` +
          `way forward. Add the recipe there, or drop the file from APPEND_SHAPED.`,
      ).toBe(true);
    }
  });

  it('ship.md section 9 names no generated file the hook lets through', () => {
    const ship = readFileSync(SHIP, 'utf8');
    const files = hookFiles();
    // DERIVED from ship.md, not hard-coded. An earlier revision listed the two
    // files here and claimed the check "has to fail when ship.md gains a THIRD
    // such file" -- measured, it could not: a hard-coded list only ever asks
    // about its own members, so a third file in ship.md left it 3/3 green. The
    // whole point of this direction is the file nobody remembered to add.
    const documented = [...new Set(ship.match(/docs\/[A-Za-z0-9._/-]*\.(?:md|tsv)/g) ?? [])];
    expect(
      documented,
      `No generated-file path was found in ship.md at all, so this direction is ` +
        `vacuous. The regex that reads them has drifted from how ship.md spells its ` +
        `paths -- re-derive it rather than deleting the check.`,
    ).toContain('docs/changelog-cdkd.md');
    // Only the APPEND-SHAPED ones are the hook's business. ship.md mentions
    // other docs in passing, so the set is narrowed by the one property that
    // makes a file this gate's concern: every lane appends to it at the same
    // place. That property is not derivable from prose, so it is named -- but
    // the FAILURE mode is now the safe one, since a new path appearing in
    // ship.md shows up here as an unclassified file rather than silently.
    // ONLY the paths ship.md actually yields today, minus the two the hook
    // gates. Listing names that do not appear defeats the property this check
    // exists for: a pre-excluded name can never "show up as unclassified", so
    // the list would quietly absorb a real append-shaped file the day ship.md
    // started mentioning it. Measured 2026-09-03 -- ship.md yields exactly
    // three paths, and an earlier revision of this list carried fourteen
    // entries, thirteen of them dead (one of which the regex cannot even emit).
    const knownNotAppendShaped = new Set([
      // GENERATED and REGENERATED, not appended. ship.md section 9 names this
      // one in the conflict guidance right after the flatten rule, and its
      // remedy is the opposite shape: "resolve-to-upstream + regenerate", never
      // keep-both. Flattening cannot prevent a conflict in a file the generator
      // rewrites wholesale, so gating on it would refuse a rebase for nothing.
      'docs/cli-flag-coverage.md',
    ]);
    // Every exclusion must still be EARNED. Without this, an entry whose path
    // ship.md no longer mentions sits here forever, silently pre-excluding a
    // name the day ship.md starts mentioning it again -- which is how the
    // previous fourteen-entry list came to be thirteen-fourteenths dead.
    for (const f of knownNotAppendShaped) {
      expect(
        documented.includes(f),
        `knownNotAppendShaped lists "${f}", which ship.md no longer names. Remove it: a ` +
          `dead exclusion cannot protect anything and will silently swallow that path if ` +
          `ship.md mentions it again.`,
      ).toBe(true);
    }
    for (const f of documented) {
      if (knownNotAppendShaped.has(f)) continue;
      expect(
        files.includes(f),
        `ship.md section 9 names "${f}", flatten-before-rebase-gate.sh does not gate on ` +
          `it, and it is not on this test's known-not-append-shaped list. Either add it ` +
          `to APPEND_SHAPED (if every lane appends to it at the same place, so an ` +
          `unflattened rebase re-conflicts once per commit), or add it to ` +
          `knownNotAppendShaped with that judgement recorded.`,
      ).toBe(true);
    }
  });
});
