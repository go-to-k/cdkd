/**
 * The mutation harness's SHARD DENOMINATOR and the matrix that feeds it must
 * agree, and the harness must still read the variable the workflow sets.
 *
 * WHY THIS IS A FENCE RATHER THAN CARE. `.github/workflows/hooks.yml` runs
 * `.claude/hooks/lib/command-match-mutants.sh` once per `matrix.shard` value
 * with `CDKD_MUTANT_SHARD: <shard>/<total>`, and the harness selects every
 * `total`-th mutant starting at `index`. The union of the shards is the whole
 * list ONLY when the matrix enumerates `0 .. total-1` exactly. Raise the
 * denominator without extending the matrix and the mutants at the missing
 * residues are never run — every surviving shard reports a clean tally, the
 * job goes green, and the coverage is simply gone. That is the vacuous-pass
 * shape the harness itself exists to remove, arriving through its runner
 * (code review round 32, which found the harness also accepted `0/08` and
 * silently disabled sharding — fixed there with a base-10 coercion).
 *
 * Extending the matrix without raising the denominator is the other
 * direction, and it is NOT harmless either: a shard whose index is outside
 * the total refuses with exit 2, so the job reds — loud, but for a reason
 * nobody would guess from the message. Both directions are asserted.
 *
 * The third assertion is the one that keeps the other two from going
 * decorative: if the harness stops reading `CDKD_MUTANT_SHARD` — renamed,
 * removed, or refactored into a flag — the workflow keeps setting an
 * environment variable nothing consumes, and every shard runs the FULL list.
 * Four times the work, four green ticks, and no signal at all.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const WORKFLOW = '.github/workflows/hooks.yml';
const HARNESS = '.claude/hooks/lib/command-match-mutants.sh';
const JOB = 'mutation-harness';
const ENV_NAME = 'CDKD_MUTANT_SHARD';

type Step = { env?: Record<string, string> };
type Job = { strategy?: { matrix?: { shard?: unknown } }; steps?: Step[] };

function shardJob(): Job {
  const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as { jobs?: Record<string, Job> };
  const job = doc.jobs?.[JOB];
  // A missing job is a REFUSAL, not a skip: the assertions below would all
  // pass vacuously over `undefined`, which is exactly the failure this file
  // is about.
  expect(job, `${WORKFLOW} has no \`${JOB}\` job — did it get renamed?`).toBeTruthy();
  return job as Job;
}

function shardSpecs(job: Job): string[] {
  const specs = (job.steps ?? [])
    .map((s) => s.env?.[ENV_NAME])
    .filter((v): v is string => typeof v === 'string');
  expect(
    specs.length,
    `no step in \`${JOB}\` sets \`${ENV_NAME}\`, so the matrix feeds nothing`,
  ).toBeGreaterThan(0);
  return specs;
}

describe('mutation harness shard matrix', () => {
  it('enumerates exactly 0 .. total-1, so the shards union to the whole list', () => {
    const job = shardJob();
    const shard = job.strategy?.matrix?.shard;
    expect(Array.isArray(shard), `\`${JOB}\`'s matrix has no \`shard\` array`).toBe(true);
    const values = shard as unknown[];

    for (const spec of shardSpecs(job)) {
      // `${{ matrix.shard }}/4` — the denominator is what follows the slash.
      const total = Number(spec.slice(spec.lastIndexOf('/') + 1));
      expect(
        Number.isInteger(total) && total > 0,
        `\`${ENV_NAME}: ${spec}\` has no readable denominator`,
      ).toBe(true);
      expect(
        values.length,
        `\`${ENV_NAME}: ${spec}\` divides the list into ${total} shards but the matrix ` +
          `enumerates ${values.length} of them. Every residue the matrix omits is a set of ` +
          `mutants NOTHING runs, and every shard that does run still reports a clean tally.`,
      ).toBe(total);
      expect(
        [...values].sort((a, b) => Number(a) - Number(b)),
        `the matrix must be exactly 0 .. ${total - 1}: a gap drops those mutants silently and ` +
          `a value >= ${total} makes that shard refuse with exit 2 for an unguessable reason.`,
      ).toEqual(Array.from({ length: total }, (_, i) => i));
    }
  });

  it('the harness still reads the variable the workflow sets', () => {
    const src = readFileSync(HARNESS, 'utf8');
    expect(
      src.includes(`\${${ENV_NAME}:-}`),
      `${HARNESS} no longer reads \`${ENV_NAME}\`, so every shard would run the FULL mutant ` +
        `list: four times the work, four green ticks, and no sharding at all.`,
    ).toBe(true);
  });

  it('refuses a shard selection that comes back empty', () => {
    // The refusal is what makes a mis-set denominator loud rather than green.
    // Asserted on the SOURCE because running it costs a full baseline suite;
    // the four refusal paths themselves are measured by hand at each change,
    // which the harness's own comment records.
    const src = readFileSync(HARNESS, 'utf8');
    expect(
      src.includes('selected NO mutants'),
      `${HARNESS} lost its empty-selection refusal, so a shard that matches nothing would ` +
        `report a green over no measurement.`,
    ).toBe(true);
    expect(
      src.includes('10#'),
      `${HARNESS} lost its base-10 coercion, so a leading zero (\`0/08\`) makes bash abort the ` +
        `shard block as an octal arithmetic error and the run silently takes the whole list.`,
    ).toBe(true);
  });
});
