import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for issue #1097 pattern 1 (signal handling in integ fixtures).
 *
 * A bash signal handler RETURNS to the interrupted point rather than exiting, so
 * `trap cleanup EXIT INT TERM` runs `cleanup` and then RESUMES the interrupted
 * phase -- the script can walk into the next phase and `exit 0`, reporting PASS
 * while `cleanup` raced a still-live deploy. And a bare `trap cleanup EXIT` with
 * no signal handler at all skips cleanup entirely on Ctrl-C or a harness
 * timeout, leaking billable AWS resources.
 *
 * The only correct form is an explicitly exiting handler per signal:
 *
 *   trap cleanup EXIT
 *   trap 'cleanup; exit 130' INT
 *   trap 'cleanup; exit 143' TERM
 *
 * This test is the lint that keeps the #1097 sweep from rotting: any fixture
 * that arms a resource-cleanup EXIT trap must also arm exiting INT and TERM
 * traps.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

/**
 * Fixtures whose verify.sh is owned by an in-flight PR at the time of the
 * #1097 sweep, so the sweep deliberately skipped them to avoid a cross-lane
 * collision. Each entry is asserted to still be NON-compliant below, so the
 * exception self-expires: once the owning PR lands the correct form, this test
 * fails and forces the entry to be deleted rather than silently lingering.
 */
const PENDING_OTHER_PR: Record<string, string> = {
  'emr-cluster': 'PR #1101 (EMR import round-trip) rewrites this verify.sh',
};

interface FixtureTraps {
  name: string;
  /** Arms an EXIT trap that reaches a cleanup function (vs. a temp-file `rm`). */
  hasCleanupExitTrap: boolean;
  hasExitingIntTrap: boolean;
  hasExitingTermTrap: boolean;
  /** The dangerous bare-function form that resumes the interrupted phase. */
  hasBareSignalTrap: boolean;
}

function readFixtures(): FixtureTraps[] {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => {
      const lines = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8').split('\n');
      const trapLines = lines.map((l) => l.trim()).filter((l) => l.startsWith('trap '));

      const isCleanupExit = (l: string) =>
        /^trap (cleanup|'.*cleanup.*') EXIT$/.test(l) && !l.startsWith('trap - ');

      return {
        name: e.name,
        hasCleanupExitTrap: trapLines.some(isCleanupExit),
        hasExitingIntTrap: trapLines.some((l) => /^trap '.*exit 130' INT$/.test(l)),
        hasExitingTermTrap: trapLines.some((l) => /^trap '.*exit 143' TERM$/.test(l)),
        hasBareSignalTrap: trapLines.some((l) => /^trap [a-z_]+ .*\b(INT|TERM)\b/.test(l)),
      };
    });
}

describe('integ fixture verify.sh signal traps (#1097 pattern 1)', () => {
  const fixtures = readFixtures();

  it('finds the fixture tree', () => {
    expect(fixtures.length).toBeGreaterThan(100);
  });

  it('never uses the bare-function signal trap that resumes the interrupted phase', () => {
    const offenders = fixtures
      .filter((f) => !(f.name in PENDING_OTHER_PR))
      .filter((f) => f.hasBareSignalTrap)
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('arms an exiting INT trap wherever it arms a cleanup EXIT trap', () => {
    const offenders = fixtures
      .filter((f) => !(f.name in PENDING_OTHER_PR))
      .filter((f) => f.hasCleanupExitTrap && !f.hasExitingIntTrap)
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('arms an exiting TERM trap wherever it arms a cleanup EXIT trap', () => {
    const offenders = fixtures
      .filter((f) => !(f.name in PENDING_OTHER_PR))
      .filter((f) => f.hasCleanupExitTrap && !f.hasExitingTermTrap)
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('keeps the in-flight-PR exception list free of already-fixed fixtures', () => {
    // Self-expiring guard: an entry that has become compliant (its PR merged)
    // must be deleted from PENDING_OTHER_PR, not left to mask a future
    // regression in that same fixture.
    const stale = Object.keys(PENDING_OTHER_PR).filter((name) => {
      const f = fixtures.find((x) => x.name === name);
      // A fixture that disappeared entirely is also a stale entry.
      if (!f) return true;
      return !f.hasBareSignalTrap && (!f.hasCleanupExitTrap || f.hasExitingIntTrap);
    });
    expect(stale).toEqual([]);
  });
});
