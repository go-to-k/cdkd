import { describe, expect, it } from 'vite-plus/test';

import {
  AWS_MESSAGE_MAX_CODE_POINTS,
  ROLE_ARN_MAX_CODE_POINTS,
  displayAwsMessage,
  displayIdent,
} from '../../../src/utils/display-safe.js';
import { PARTITION_TABLE } from '../../../src/utils/aws-partition.js';

/**
 * `ROLE_ARN_MAX_CODE_POINTS` must not fall behind the partition table.
 *
 * The constant is a transcribed sum — `27 + <longest partition> + 512 + 64` —
 * and go-to-k/cdkd#3397's review found the middle term one short: it said
 * `aws-iso-e` (9) while `PARTITION_TABLE` has carried `aws-us-gov` (10) all
 * along. The consequence was exactly the failure the constant exists to
 * prevent, on exactly one input — a maximal GovCloud role ARN rendering
 * `[cut: 1 more characters withheld]` inside the sentence whose only job is to
 * say which role failed.
 *
 * `src/utils/display-safe.ts` is a documented no-import LEAF, so it cannot read
 * the table itself and the number has to stay transcribed. A TEST can import
 * both, which is what makes this the right place for the check: the fence is
 * the thing that holds the two in sync, not a comment asking the next author to
 * remember.
 *
 * DERIVED from the table rather than pinned at 10 — a pinned expectation goes
 * stale in the same direction as the constant did, and would pass while a newly
 * added longer partition put the real maximum out of reach.
 */
describe('ROLE_ARN_MAX_CODE_POINTS vs the real ARN grammar (issue #3397)', () => {
  /** `arn:` (4) + `:iam::` (6) + a 12-digit account id (12) + `:role` (5) = 27. */
  const FIXED_SEGMENTS = 27;
  /**
   * IAM's documented maxima. The PATH bound of 512 COUNTS ITS OWN SLASHES --
   * the path is `/team/sub/`, leading and trailing slash included -- which is
   * why no separator is added between it and the name below, and why `:role`
   * above carries no trailing `/`. Getting that wrong is what this case caught
   * on its first run: a fixture spelling `:role/` + path + `/` + name is 615
   * code points, two longer than any ARN AWS will issue, and it would have
   * reported the (now correct) constant as too small.
   */
  const MAX_PATH = 512;
  const MAX_NAME = 64;

  const longestPartition = Math.max(...PARTITION_TABLE.map((p) => p.partition.length));

  it('sees a non-empty partition table, and one with a plausible longest entry', () => {
    // The floor. An empty or unparsed table makes `Math.max(...[])` `-Infinity`
    // and every comparison below vacuously true -- the "a fence must prove it
    // sees its input" rule, and the reason this case exists separately.
    expect(PARTITION_TABLE.length).toBeGreaterThanOrEqual(5);
    expect(longestPartition).toBeGreaterThanOrEqual(10);
    // Pinned so the derivation cannot silently start reading a different field.
    expect(PARTITION_TABLE.map((p) => p.partition)).toContain('aws-us-gov');
  });

  it('is at least as large as the longest ARN the partition table admits', () => {
    expect(
      ROLE_ARN_MAX_CODE_POINTS,
      'the cap is shorter than an ARN a partition in PARTITION_TABLE can produce, so a ' +
        'legitimate maximal role ARN renders truncated in the message that identifies it'
    ).toBeGreaterThanOrEqual(FIXED_SEGMENTS + longestPartition + MAX_PATH + MAX_NAME);
  });

  it('renders a MAXIMAL GovCloud role ARN without cutting it', () => {
    // The behavioural half. The arithmetic above can be satisfied by a constant
    // that is right for the wrong reason; this asserts the OBSERVABLE -- that
    // `displayIdent` returns the value unchanged -- which is what the caller
    // actually depends on.
    const path = `/${'p'.repeat(MAX_PATH - 2)}/`;
    expect(path.length, 'the path bound counts its own slashes').toBe(MAX_PATH);
    const arn = `arn:aws-us-gov:iam::123456789012:role${path}${'n'.repeat(MAX_NAME)}`;
    expect(Array.from(arn).length).toBe(FIXED_SEGMENTS + 'aws-us-gov'.length + MAX_PATH + MAX_NAME);

    const shown = displayIdent(arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
    expect(shown, 'a legitimate maximal ARN must render byte-identically').toBe(arn);
    expect(shown).not.toContain('withheld');
  });

  it('is also BOUNDED ABOVE, so a cap that never fires cannot pass', () => {
    // Pair the floor with a CEILING. The floor alone is satisfied by any
    // enormous value, and an enormous cap is not a correct cap -- it is the
    // absence of one, which is what the bound exists to provide against an
    // attacker-supplied ARN.
    //
    // This case is here because the FIRST version of it was vacuous, in the
    // exact shape `.claude/rules/testing.md` names: it asserted that
    // `'a'.repeat(ROLE_ARN_MAX_CODE_POINTS + 1)` truncates, deriving its input
    // FROM the subject, so the input grew with the constant and the assertion
    // held for every value including `+ 100000`. A mutation probe raising the
    // cap by 100000 stayed GREEN. The two repairs below are independent on
    // purpose: a bound that cannot scale with the subject, and a literal input
    // that cannot either.
    expect(
      ROLE_ARN_MAX_CODE_POINTS,
      'the cap is far larger than the grammar needs, so it bounds nothing in practice'
    ).toBeLessThanOrEqual(FIXED_SEGMENTS + longestPartition + MAX_PATH + MAX_NAME + 64);

    // A LITERAL length, independent of the constant in both directions.
    const tooLong = 'a'.repeat(50_000);
    const shown = displayIdent(tooLong, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
    expect(shown).toContain('withheld');
    expect(Array.from(shown).length).toBeLessThan(2_000);
  });
});

/**
 * `displayAwsMessage` — AWS's own error text, sanitized, bounded, and MARKED.
 *
 * The helper go-to-k/cdkd#3408 round 2 asked for. Both sites that bound an AWS
 * message were spelling `truncateCodePoints(displaySafe(x), CAP).text` and
 * discarding `truncated`, so a cut message ended mid-sentence looking complete.
 * On a diagnostic that is worse than the flood the cap prevents: the reader
 * acts on a sentence whose second half is missing and has no way to know.
 */
describe('displayAwsMessage (issue #3397 review round 2)', () => {
  it('passes an ordinary AWS sentence through untouched', () => {
    const real =
      'User: arn:aws:iam::111122223333:user/dev is not authorized to perform: sts:AssumeRole';
    expect(displayAwsMessage(real)).toBe(real);
    expect(displayAwsMessage(real)).not.toContain('withheld');
  });

  it('bounds an echoed payload and MARKS the cut', () => {
    // A literal length, independent of the constant in both directions.
    const shown = displayAwsMessage(`ValidationException: rejected ${'E'.repeat(200_000)}`);
    expect(Array.from(shown).length).toBeLessThan(AWS_MESSAGE_MAX_CODE_POINTS + 200);
    expect(shown, 'a cut message must not read as a complete one').toContain('withheld');
    // ...and the diagnosis survives the cut.
    expect(shown).toContain('ValidationException');
  });

  it('still SANITIZES, so the cap did not replace the charset guard', () => {
    // The two jobs are independent and a repair to one must not drop the other.
    const esc = String.fromCharCode(0x1b);
    const shown = displayAwsMessage(`rejected ${esc}[2K\rEvil`);
    expect(shown).not.toContain(esc);
    expect(shown).not.toContain('\r');
    expect(shown).toContain('rejected');
  });

  it('marks NOTHING at exactly the bound', () => {
    // The off-by-one `truncateCodePoints` exists to get right: a value the
    // window fits exactly was not cut, so it must not be marked.
    const exact = 'x'.repeat(AWS_MESSAGE_MAX_CODE_POINTS);
    expect(displayAwsMessage(exact)).toBe(exact);
    expect(displayAwsMessage(`${exact}y`)).toContain('withheld');
  });
});
