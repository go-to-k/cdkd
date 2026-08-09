import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for issue #1417: a CI-enforced generated matrix that no
 * documented pre-push step regenerates.
 *
 * CI carries a staleness guard per generated matrix — it runs the generator and
 * fails if the working tree changes. The list of generators a contributor is
 * told to run before pushing lived ONLY in prose, in
 * `.claude/skills/verify-pr/SKILL.md`, and it drifted: CI grew to nine guards
 * while the skill still named four. The failure mode is a CI round-trip, and it
 * is worst for the matrices staled by changes nobody associates with a
 * generated file — `handled-property-wiring` records the METHOD NAMES that seed
 * each handled property, so an ordinary private-method rename inside a provider
 * stales it.
 *
 * This test makes the drift impossible: whatever CI enforces, the
 * `gen:all-matrices` aggregate task must regenerate.
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

describe('gen:all-matrices covers every CI staleness guard (#1417)', () => {
  // Parser floor: "found nothing" and "everything matches" look identical
  // otherwise, which is the vacuous pass `.claude/rules/testing.md` forbids.
  it('parses a plausible number of guards out of ci.yml', () => {
    const ci = ciStalenessGuardTasks();
    expect(ci.size).toBeGreaterThanOrEqual(9);
    // Spot-check both ends: the oldest guard and the one whose absence from the
    // skill's list caused #1417.
    expect(ci.has('integ-coverage')).toBe(true);
    expect(ci.has('gen:handled-property-wiring')).toBe(true);
  });

  it('regenerates every matrix CI checks for staleness', () => {
    const missing = [...ciStalenessGuardTasks()].filter((t) => !aggregateTasks().has(t)).sort();
    expect(
      missing,
      `CI runs a staleness guard for these, but \`gen:all-matrices\` does not regenerate them — ` +
        `add them to the task in vite.config.ts:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  // The inverse direction: an entry that no longer corresponds to a CI guard is
  // dead weight that slows every /verify-pr run, and usually means the guard was
  // renamed rather than removed.
  it('does not chain a task CI no longer guards', () => {
    const stale = [...aggregateTasks()].filter((t) => !ciStalenessGuardTasks().has(t)).sort();
    expect(
      stale,
      `\`gen:all-matrices\` regenerates these, but CI has no staleness guard for them — ` +
        `remove them or restore the guard:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });

  // The skill is what a human actually follows; keep it pointing at the
  // aggregate rather than re-listing (and re-drifting from) the set.
  it('the verify-pr skill regenerates via the aggregate task', () => {
    const skill = readFileSync(join(REPO_ROOT, '.claude/skills/verify-pr/SKILL.md'), 'utf8');
    expect(skill).toContain('vp run gen:all-matrices');
  });
});
