/**
 * Issue #2301 item 3 -- `ResourceDeleteResult.indeterminateGuards`, the channel
 * a provider uses to tell the destroy runner that a PRE-FLIGHT SAFETY GUARD ran
 * and could not reach a verdict.
 *
 * The pair under test is a WRITE (`withIndeterminateGuard`, called by a
 * provider) and a READ (`deleteIndeterminateGuards`, called by the runner that
 * persists the value into `deployments/*.jsonl`). They are tested together
 * because the value's whole job is to survive that hop: the record is DURABLE,
 * so a shape the writer can produce and the reader mangles is a defect that
 * outlives the run.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  deleteIndeterminateGuards,
  withIndeterminateGuard,
} from '../../../src/deployment/delete-outcome.js';
import type { ResourceDeleteResult } from '../../../src/types/resource.js';

const GUARD = { guard: 'cc-delete-region-identity', reason: 'probe denied' };

describe('withIndeterminateGuard (issue #2301)', () => {
  it('leaves a `void` return UNTOUCHED when there is no guard to carry', () => {
    // The hot path: ~80 providers return `void` and every guard that reaches a
    // verdict must keep that shape, or every ordinary delete starts allocating
    // an object the runner then has to interpret.
    expect(withIndeterminateGuard(undefined, undefined)).toBeUndefined();
  });

  it('leaves an existing outcome untouched when there is no guard to carry', () => {
    const skipped: ResourceDeleteResult = { outcome: 'skipped', reason: 'bad id' };
    // By IDENTITY: a copy would be indistinguishable by value while quietly
    // dropping any field a future arm adds.
    expect(withIndeterminateGuard(skipped, undefined)).toBe(skipped);
  });

  it('promotes a `void` return to a `deleted` outcome carrying the guard', () => {
    const result = withIndeterminateGuard(undefined, GUARD);
    expect(result).toEqual({ outcome: 'deleted', indeterminateGuards: [GUARD] });
  });

  it('KEEPS a `skipped` outcome and its reason while attaching the guard', () => {
    // The two facts are independent, and collapsing the skip into a `deleted`
    // would tell the runner to drop the state record of a live resource --
    // the exact data loss issue #1752 exists to stop.
    const result = withIndeterminateGuard({ outcome: 'skipped', reason: 'bad id' }, GUARD);
    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'bad id',
      indeterminateGuards: [GUARD],
    });
  });

  it('does not THROW when an untyped producer set a NON-ARRAY field', () => {
    // The spread that appends would throw on a non-iterable, so the writer is
    // defensive about the same population the reader is. A crash here would be
    // introduced BY the hardening, inside the delete path.
    const result = withIndeterminateGuard(
      { outcome: 'deleted', indeterminateGuards: 42 } as unknown as ResourceDeleteResult,
      GUARD
    );
    expect(deleteIndeterminateGuards(result)).toEqual([GUARD]);
  });

  it('APPENDS rather than replacing, so two guards on one delete both survive', () => {
    const second = { guard: 'some-other-guard', reason: 'also could not answer' };
    const first = withIndeterminateGuard(undefined, GUARD);
    expect(deleteIndeterminateGuards(withIndeterminateGuard(first, second))).toEqual([
      GUARD,
      second,
    ]);
  });
});

describe('deleteIndeterminateGuards (issue #2301)', () => {
  it('is EMPTY for the back-compat `void` return and for a plain deleted outcome', () => {
    expect(deleteIndeterminateGuards(undefined)).toEqual([]);
    expect(deleteIndeterminateGuards({ outcome: 'deleted' })).toEqual([]);
    expect(deleteIndeterminateGuards({ outcome: 'skipped', reason: 'bad id' })).toEqual([]);
  });

  it('returns the guards a provider reported', () => {
    expect(deleteIndeterminateGuards({ outcome: 'deleted', indeterminateGuards: [GUARD] })).toEqual(
      [GUARD]
    );
  });

  it('TRIMS, so a padded value cannot land verbatim in the durable event store', () => {
    const padded = { guard: '  cc-delete-region-identity  ', reason: '\tprobe denied\n' };
    expect(
      deleteIndeterminateGuards({
        outcome: 'deleted',
        indeterminateGuards: [padded],
      } as ResourceDeleteResult)
    ).toEqual([GUARD]);
  });

  it('DROPS a malformed entry instead of defaulting it, and keeps its well-formed siblings', () => {
    // Opposite of `deleteSkipReason`'s choice, deliberately: an
    // `UNSPECIFIED_SKIP_REASON`-style default here would count toward the
    // destroy summary's tally and send the operator chasing a row that names
    // neither a check nor a cause. Every shape below is one an UNTYPED
    // producer can really emit -- a JS provider, a hand-built double, a future
    // arm -- which is why they are dropped rather than trusted to the types.
    const raw = [
      GUARD,
      null,
      'not-an-object',
      { guard: 'no-reason' },
      { reason: 'no-guard' },
      { guard: 42, reason: 'non-string guard' },
      { guard: 'non-string-reason', reason: { nested: true } },
      { guard: '   ', reason: 'blank guard' },
      { guard: 'blank-reason', reason: '   ' },
    ];
    expect(
      deleteIndeterminateGuards({
        outcome: 'deleted',
        indeterminateGuards: raw,
      } as unknown as ResourceDeleteResult)
    ).toEqual([GUARD]);
  });

  it('does NOT THROW on a non-array field, which a `.length` read would', () => {
    // The read happens inside the destroy loop, so a TypeError here is a crash
    // introduced by the very hardening that was supposed to make the path
    // safer -- the failure mode `deleteSkipReason`'s `typeof` note records.
    expect(
      deleteIndeterminateGuards({
        outcome: 'deleted',
        indeterminateGuards: 'not-an-array',
      } as unknown as ResourceDeleteResult)
    ).toEqual([]);
  });
});
