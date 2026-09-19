import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for issue #1417: a CI-enforced generated matrix that no
 * documented pre-push step regenerates.
 *
 * CI used to carry one staleness guard PER generated matrix — ten steps, each
 * running its own generator and failing on a non-empty `git diff`. The list a
 * contributor is told to run before pushing lived separately, and it drifted:
 * CI grew to nine guards while the skill still named four. The two lists are
 * now ONE list: CI runs the `gen:all-matrices` aggregate, the same task the
 * skill names, and fails on any resulting diff.
 *
 * So the drift this file guards against is structural rather than arithmetic.
 * What it asserts is that the collapse HOLDS: CI's staleness guard regenerates
 * through the aggregate, never through a generator the aggregate does not
 * chain, and the skill still points at the same task.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml');
const VITE_CONFIG = join(REPO_ROOT, 'vite.config.ts');

/**
 * The generator tasks CI runs inside a staleness guard.
 *
 * A guard is a step that runs a generator and then `git diff --quiet`s its
 * output. Matching on that PAIR is what keeps the check honest: a plain
 * `- run: vp run audit:*:check` is a critic, not a staleness guard, and running
 * it would not regenerate anything.
 */
function ciStalenessGuardTasks(): Set<string> {
  const yml = readFileSync(CI_YML, 'utf8');
  const tasks = new Set<string>();

  // Steps are `- name: … \n run: | \n <lines>`; split on the step boundary and
  // keep the blocks that both run a generator and diff its output.
  for (const block of yml.split(/^ {6}- /m)) {
    if (!/git diff --quiet/.test(block)) continue;
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      // Only actual command lines count. A `#` comment and the
      // `echo "::error::… run \`vp run X\`"` remediation both name tasks that
      // the step does NOT run — including them would drag
      // `audit:coverage:regenerate` (10-30 min, needs AWS creds) into the
      // aggregate.
      if (!line.startsWith('vp run ')) continue;
      const task = line.slice('vp run '.length).trim();
      // `--check` critics validate; they regenerate nothing.
      if (task.endsWith(':check')) continue;
      tasks.add(task);
    }
  }
  return tasks;
}

/** The tasks `gen:all-matrices` chains together. */
function aggregateTasks(): Set<string> {
  const config = readFileSync(VITE_CONFIG, 'utf8');
  const block = /'gen:all-matrices':\s*\{[\s\S]*?\n {6}\},/.exec(config);
  expect(block, 'gen:all-matrices task not found in vite.config.ts').not.toBeNull();
  return new Set([...block![0].matchAll(/'vp run ([a-z][a-z0-9:-]*)'/g)].map((m) => m[1]!));
}

describe('CI regenerates through gen:all-matrices (#1417)', () => {
  // Parser floor: "found nothing" and "everything matches" look identical
  // otherwise, which is the vacuous pass `.claude/rules/testing.md` forbids.
  it('parses a staleness guard out of ci.yml', () => {
    expect(ciStalenessGuardTasks().size).toBeGreaterThanOrEqual(1);
  });

  // THE AGGREGATE IS NOW THE ONLY LIST, which is what this assertion is for.
  // Before the collapse, `ci.yml` enumerated the generators and this file
  // compared the two enumerations in both directions, so dropping one from
  // either side reddened. CI carries no enumeration any more, so a generator
  // deleted from `gen:all-matrices` would simply stop being checked, silently
  // and forever — exactly the drift #1417 is about, one level up.
  //
  // So the set is PINNED here rather than floored. The point is not to know the
  // number: it is that removing a generator has to be a deliberate edit in two
  // files, and that whoever makes it reads why. Adding one is the same edit.
  // Tasks deliberately OUTSIDE the aggregate (and so absent here) are the ones
  // vite.config.ts documents as such: `audit:coverage:regenerate` and
  // `audit:stateful-candidates:regenerate` (minutes, and they call AWS),
  // `gen:cfn-schemas-from-zip` and `gen:aws-cli-removals` (their capture is
  // the oracle, and re-capturing on a schedule nobody controls is noise).
  it('chains exactly the generators CI regenerates through it', () => {
    expect([...aggregateTasks()].sort()).toEqual(
      [
        'cli-flag-coverage',
        'format',
        'gen:enrichment-coverage',
        'gen:handled-property-wiring',
        'gen:nested-key-coverage',
        'gen:property-coverage',
        'gen:sdk-attr-coverage',
        'gen:unsupported-types',
        'gen:update-wrap-coverage',
        'integ-coverage',
        'integ-ledger-normalize',
        'scenario-coverage',
      ].sort(),
    );
  });

  it('every task CI regenerates is the aggregate itself', () => {
    const direct = [...ciStalenessGuardTasks()].filter((t) => t !== 'gen:all-matrices').sort();
    expect(
      direct,
      `CI runs these generators in a staleness guard of their own. Regenerate ` +
        `through \`vp run gen:all-matrices\` instead, and register the generator ` +
        `in that task in vite.config.ts, so the contributor's step and CI's ` +
        `cannot drift:\n  ${direct.join('\n  ')}`
    ).toEqual([]);
  });

  // The skill is what a human actually follows; keep it pointing at the
  // aggregate rather than re-listing (and re-drifting from) the set.
  it('the verify-pr skill regenerates via the aggregate task', () => {
    const skill = readFileSync(join(REPO_ROOT, '.claude/skills/verify-pr/SKILL.md'), 'utf8');
    expect(skill).toContain('vp run gen:all-matrices');
  });
});
