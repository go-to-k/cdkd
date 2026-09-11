import { describe, it, expect } from 'vite-plus/test';
import { resolveSingleRegion } from '../../../src/cli/commands/state.js';

/**
 * Issue #3003: the ERROR paths of `cdkd state show` / `cdkd state resources`.
 *
 * Issue #2772 made every value those views RENDER control-safe, because their
 * output is line-oriented and a state record is an unchecked cast anyone
 * with `s3:PutObject` on the state bucket can write. The refusals were not
 * covered, and a refusal is the path a malformed record is MOST likely to
 * take — so the diagnostic a reader trusts could forge the row the rendered
 * output no longer can.
 *
 * `resolveSingleRegion` is the CLI-side site, and its untrusted input is a
 * REGION: those come from `listStacks`, which reads them as raw S3 key
 * segments, and an S3 key admits any UTF-8. Planting
 * `cdkd/<victimStack>/<hostile>/state.json` is the delivery.
 *
 * The stack name is sanitized alongside it. That one is the user's own
 * argument on the common path, so it is defence in depth rather than a hole
 * being closed — but `state show` also reaches this function with a name it
 * read from a key segment, and the two cannot be told apart here.
 */

const FORGED = '  PhysicalID: arn:aws:iam::000000000000:role/forged';
const HOSTILE_REGION = `us-east-1\n${FORGED}`;

/** Every C0 control, DEL, and the C1 range — what must not survive. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw, and it returned');
}

describe('resolveSingleRegion refusals cannot forge a row (issue #3003)', () => {
  it('sanitizes the region list when the requested region is absent', () => {
    const message = messageOf(() =>
      resolveSingleRegion(
        'MyStack',
        [
          { stackName: 'MyStack', region: HOSTILE_REGION },
          { stackName: 'MyStack', region: 'us-west-2' },
        ],
        'eu-central-1'
      )
    );

    // The whole message, not the interpolated slice: a guard applied to one of
    // three interpolations would pass an assertion scoped to that one.
    expect(message).not.toMatch(CONTROL);
    // The forged text must not begin a line. Asserted on the SPLIT rather than
    // as a substring, because the point is the newline, not the words — the
    // words are still there, on the same line as the region they followed.
    expect(message.split('\n').some((l) => l.startsWith('  PhysicalID:'))).toBe(false);
    // Not vacuous: the sanitized remnant IS reported, so this is a message
    // that named the bad region rather than one that dropped it.
    expect(message).toContain('PhysicalID: arn:aws:iam::000000000000:role/forged');
    expect(message).toContain('us-west-2');
  });

  it('sanitizes the region list when several regions match', () => {
    const message = messageOf(() =>
      resolveSingleRegion(
        'MyStack',
        [
          { stackName: 'MyStack', region: HOSTILE_REGION },
          { stackName: 'MyStack', region: 'us-west-2' },
        ],
        undefined
      )
    );

    expect(message).not.toMatch(CONTROL);
    expect(message.split('\n').some((l) => l.startsWith('  PhysicalID:'))).toBe(false);
    expect(message).toContain('multiple regions');
  });

  it('sanitizes the stack name when no state matches', () => {
    const message = messageOf(() =>
      resolveSingleRegion(`Ghost\n${FORGED}`, [{ stackName: 'Other', region: 'us-east-1' }], undefined)
    );

    expect(message).not.toMatch(CONTROL);
    expect(message.split('\n').some((l) => l.startsWith('  PhysicalID:'))).toBe(false);
    expect(message).toContain('Ghost');
  });

  it('strips a character only the ASCII allowlist removes (issue #3003)', () => {
    // Pins the MODE, not just the presence of a guard. `displaySafe`'s denylist
    // form covers C0/DEL/C1, U+2028/9 and the bidi OVERRIDES, so every other
    // case here stays green if `{ asciiOnly: true }` is dropped -- their
    // hostile bytes are in both classes. A zero-width space is in neither
    // denylist and only the allowlist removes it, so this is what tells the
    // two apart. It matters because a zero-width character can hide the
    // difference between two region names that read identically.
    const message = messageOf(() =>
      resolveSingleRegion(
        'MyStack',
        [
          { stackName: 'MyStack', region: 'us-\u200beast-1' },
          { stackName: 'MyStack', region: 'us-west-2' },
        ],
        undefined
      )
    );

    expect(message).not.toContain('\u200b');
    expect(message).toContain('us- east-1');
  });

  it('keeps the legacy placeholder distinguishable from a sanitized segment', () => {
    // `(legacy)` is this function's OWN literal for a region-less record, not
    // a value from the record — so it must not be routed through the guard,
    // where an empty sanitization would turn it into the UNRENDERABLE stand-in
    // and lose the one thing the row says.
    const message = messageOf(() =>
      resolveSingleRegion(
        'MyStack',
        [
          { stackName: 'MyStack', region: undefined },
          { stackName: 'MyStack', region: 'us-west-2' },
        ],
        undefined
      )
    );

    expect(message).not.toMatch(CONTROL);
    expect(message).toContain('(legacy)');
    expect(message).toContain('us-west-2');
  });

  it('reports a region that sanitizes to nothing rather than an empty slot', () => {
    // A segment of only control characters strips to '', and an empty slot in
    // `Available regions: , us-west-2` reads as a formatting bug rather than as
    // a record the reader should go look at.
    const message = messageOf(() =>
      resolveSingleRegion(
        'MyStack',
        [
          { stackName: 'MyStack', region: '\u0007\u0007' },
          { stackName: 'MyStack', region: 'us-west-2' },
        ],
        'eu-central-1'
      )
    );

    expect(message).not.toMatch(CONTROL);
    expect(message).not.toContain('regions: ,');
    expect(message).toContain('us-west-2');
    // The stand-in, not a dropped entry: both assertions above are satisfied by
    // an implementation that FILTERS the unrenderable region out of the list,
    // which would tell the reader one region exists when two do.
    expect(message).toContain('<unrenderable>');
  });
});
