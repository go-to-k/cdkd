/**
 * `src/provisioning/wait-abandoned.ts` — the marker four already-deleted
 * classifiers read (issue [#3236](https://github.com/go-to-k/cdkd/issues/3236)).
 *
 * Written because round 3's review measured the module as entirely unfenced:
 * replacing `isWaitAbandonedError`'s `.cause` walk with a depth-0 check left
 * 82 cases green across four files. A predicate whose WALK nothing exercises
 * is a predicate that silently stops walking — and the walk is the half that
 * matters, since cdkd wraps errors and the marked one is routinely one or two
 * hops down by the time a classifier sees it.
 */
import { describe, it, expect } from 'vite-plus/test';
import { isWaitAbandonedError, markWaitAbandoned } from '../../../src/provisioning/wait-abandoned.js';

/** Chain `depth` plain wrappers over a marked error, newest first. */
function wrapped(depth: number): Error {
  let error: Error = markWaitAbandoned(new Error('abandoned'));
  for (let i = 0; i < depth; i++) {
    error = Object.assign(new Error(`wrapper ${i}`), { cause: error });
  }
  return error;
}

describe('markWaitAbandoned / isWaitAbandonedError', () => {
  it('recognises a directly marked error', () => {
    expect(isWaitAbandonedError(markWaitAbandoned(new Error('x')))).toBe(true);
  });

  it('refuses an unmarked error', () => {
    expect(isWaitAbandonedError(new Error('x'))).toBe(false);
  });

  it.each([1, 2, 3, 4])('walks %i cause hop(s) — the shape production actually produces', (depth) => {
    // Every provider catch re-wraps as a `ProvisioningError` threading the
    // original as `cause` (issue #2040), so a classifier never sees the marked
    // error at depth 0 on the wrapped paths.
    expect(isWaitAbandonedError(wrapped(depth))).toBe(true);
  });

  it('stops at the bound rather than walking forever', () => {
    // The bound is `retryable-errors.ts`'s, and equality is the requirement:
    // a marker this predicate finds deeper than `isMarkedNonRetryable` can
    // reach means two classifiers disagreeing about one chain. Depth 5 is the
    // last hop INSIDE the bound; 5 wrappers puts the marker at index 5, one
    // past it.
    expect(isWaitAbandonedError(wrapped(4))).toBe(true);
    expect(isWaitAbandonedError(wrapped(5))).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isWaitAbandonedError(a)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not an error'],
    ['a plain object', { message: 'x' }],
  ])('refuses %s without throwing', (_label, value) => {
    expect(isWaitAbandonedError(value)).toBe(false);
  });

  it('returns a FROZEN error unmarked rather than throwing', () => {
    // `markNonRetryable`'s rule, for its reason: callers use this inline
    // (`throw markWaitAbandoned(...)`), so a `TypeError` raised here would
    // REPLACE the error the caller meant to raise. Losing the marker degrades
    // to the pre-fix behaviour; losing the error loses the diagnosis.
    const frozen = Object.freeze(new Error('frozen'));
    expect(() => markWaitAbandoned(frozen)).not.toThrow();
    expect(isWaitAbandonedError(markWaitAbandoned(frozen))).toBe(false);
  });

  it('marks with a NON-ENUMERABLE property', () => {
    // Asserted through `propertyIsEnumerable`, which is the ONLY discriminator
    // for a symbol key. The first cut used `Object.keys` and
    // `JSON.stringify({...error})`, and review measured both passing
    // identically with `enumerable: true` — `Object.keys` never returns
    // symbols and `JSON.stringify` never serializes them, so the test fenced
    // nothing while its own comment explained why it could not fail.
    const error = markWaitAbandoned(new Error('x'));
    expect(error.propertyIsEnumerable(Symbol.for('cdkd.waitAbandoned'))).toBe(false);
    // ...and it is genuinely SET, so the assertion above is not passing on an
    // absent property.
    expect(Object.getOwnPropertySymbols(error)).toContain(Symbol.for('cdkd.waitAbandoned'));
  });

  it('marks the INSTANCE, never a shared prototype', () => {
    // `E extends Error` rather than `object`: the reader is a prototype-chain
    // lookup, so marking a class would mark every instance of it.
    class Custom extends Error {}
    const one = markWaitAbandoned(new Custom('one'));
    const two = new Custom('two');
    expect(isWaitAbandonedError(one)).toBe(true);
    expect(isWaitAbandonedError(two)).toBe(false);
  });
});
