import { describe, it, expect } from 'vite-plus/test';

/**
 * The two `WarmThroughput` rules BOTH DynamoDB providers read
 * (`src/provisioning/dynamodb-warm-throughput.ts`).
 *
 * They live in their own file, named for the module, because a third consumer's
 * author looks for `<module>.test.ts` — these describes previously sat inside a
 * suite named for the `AWS::DynamoDB::GlobalTable` delete retry, where nothing
 * about the filename said the rules are shared. The per-provider suites
 * (`dynamodb-globaltable-provider-delete-retry-warm-throughput.test.ts`,
 * `dynamodb-table-provider-warm-throughput*.test.ts`) still exercise the same
 * module through each provider's write sites; this file pins the RULE.
 *
 * Provenance, since the module header is precise about it: only the
 * `AWS::DynamoDB::Table` spelling ever shipped (issues #1760 / #1768, PR
 * #1808). Issue #1857 lifted it here so `AWS::DynamoDB::GlobalTable` could not
 * answer the same question differently.
 */

import {
  WARM_THROUGHPUT_MEMBERS,
  coerceWarmThroughput,
  isWarmThroughputDecrease,
} from '../../../src/provisioning/dynamodb-warm-throughput.js';

describe('coerceWarmThroughput (issue #1857 / #1808)', () => {
  it('coerces a stringly-typed CFn member to a number', () => {
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '12000' })).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: [],
    });
  });

  it('produces a wire-identical block for a quoted and an already-numeric value', () => {
    // The whole point of coercion: the two templates must be indistinguishable
    // downstream. Compared by SERIALIZATION, not by `toEqual`, because
    // `toEqual` treats 12000 and '12000' as different anyway while a member
    // ORDER divergence — which does change the wire bytes — it would miss.
    const quoted = coerceWarmThroughput({
      ReadUnitsPerSecond: '12000',
      WriteUnitsPerSecond: '4000',
    });
    const numeric = coerceWarmThroughput({
      ReadUnitsPerSecond: 12000,
      WriteUnitsPerSecond: 4000,
    });
    expect(JSON.stringify(quoted.spec)).toBe(JSON.stringify(numeric.spec));
    expect(JSON.stringify(quoted.spec)).toBe(
      '{"ReadUnitsPerSecond":12000,"WriteUnitsPerSecond":4000}'
    );
  });

  it('emits members in a fixed order regardless of the template order', () => {
    const reversed = coerceWarmThroughput({
      WriteUnitsPerSecond: 4000,
      ReadUnitsPerSecond: 12000,
    });
    expect(JSON.stringify(reversed.spec)).toBe(
      '{"ReadUnitsPerSecond":12000,"WriteUnitsPerSecond":4000}'
    );
    // The order is the module's exported one, so a reordering there fails here
    // rather than only downstream of a wire comparison.
    expect([...WARM_THROUGHPUT_MEMBERS]).toEqual(['ReadUnitsPerSecond', 'WriteUnitsPerSecond']);
  });

  it('drops only the unusable member and NAMES it, sending the usable one', () => {
    expect(
      coerceWarmThroughput({
        ReadUnitsPerSecond: '12000',
        WriteUnitsPerSecond: { Ref: 'Unresolved' },
      })
    ).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: ['WriteUnitsPerSecond'],
    });
  });

  it('refuses the whole block when no member is usable', () => {
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: { Ref: 'Unresolved' } })).toEqual({
      droppedMembers: ['ReadUnitsPerSecond'],
    });
    // Present-but-not-an-object: no member to name, so no dropped list.
    expect(coerceWarmThroughput('nonsense')).toEqual({ droppedMembers: [] });
    expect(coerceWarmThroughput([12000])).toEqual({ droppedMembers: [] });
    // An empty declaration asks for nothing; there is nothing to send.
    expect(coerceWarmThroughput({})).toEqual({ droppedMembers: [] });
  });

  it('reports an ABSENT member as absent rather than as dropped', () => {
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: 12000 })).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: [],
    });
  });

  it('ignores a non-member key such as the live block`s Status', () => {
    // `DescribeTable` returns `WarmThroughput: {ReadUnitsPerSecond, Status}`.
    // `Status` is not a capacity and must neither be sent nor counted as a
    // dropped member — a `droppedMembers: ['Status']` here would make every
    // live-derived block report a refusal it did not suffer.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: 12000, Status: 'ACTIVE' })).toEqual({
      spec: { ReadUnitsPerSecond: 12000 },
      droppedMembers: [],
    });
    // ...and a block carrying ONLY `Status` has no member at all, so it is
    // refused with nothing to name. This is the shape the GlobalTable
    // provider's `Object.keys(spec).length > 0` live-map gate skips.
    expect(coerceWarmThroughput({ Status: 'UPDATING' })).toEqual({ droppedMembers: [] });
  });

  it('answers sendability through the ONE predicate — the presence of `spec`', () => {
    // Anything asking "should this be sent?" tests `spec` rather than deriving
    // a second opinion about the same bag; a second spelling is what
    // eventually disagrees with the coercion that builds the request.
    // `dynamodb-table-provider.ts` names that test `isSendableWarmThroughput`
    // and defines it AS this success, so the two providers agree structurally.
    // Both polarities pinned so a future refactor cannot make `spec` present
    // for an unusable bag or absent for a usable one.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '12000' }).spec).toBeDefined();
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: { Ref: 'X' } }).spec).toBeUndefined();
    expect(coerceWarmThroughput(undefined).spec).toBeUndefined();
  });

  it('refuses a WHITESPACE-only member instead of reading it as zero', () => {
    // The ONE shape the drafted GlobalTable spelling answered differently from
    // the shipped Table one (issue #1857 vs issue #1808): a bare
    // `Number('   ')` is 0, not NaN, so a naive coercion would have sent a
    // request for zero warm units — a value nobody declared and one AWS
    // cannot honour. The shared rule takes the REFUSING answer, and NAMES the
    // member so the refusal message can say which half was unusable.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '   ' })).toEqual({
      droppedMembers: ['ReadUnitsPerSecond'],
    });
    // The usable half of a partially-whitespace block still goes out.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: '\t\n', WriteUnitsPerSecond: 4000 })).toEqual(
      {
        spec: { WriteUnitsPerSecond: 4000 },
        droppedMembers: ['ReadUnitsPerSecond'],
      }
    );
  });

  it('refuses every other `Number()`-coerces-to-zero shape too', () => {
    // `Number(null)` / `Number('')` / `Number([])` / `Number(false)` are all 0.
    // Each is pinned because they arrive by different routes (an explicit YAML
    // null, a collapsed `Fn::Sub`, an `Fn::If` arm, a boolean context flag) and
    // a coercion that let any one through would send zero warm units.
    for (const value of [null, '', [], false, true, {}]) {
      expect(coerceWarmThroughput({ ReadUnitsPerSecond: value }).spec).toBeUndefined();
    }
    // `null` is a DECLARED member, so it is named; `undefined` is absence.
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: null }).droppedMembers).toEqual([
      'ReadUnitsPerSecond',
    ]);
    expect(coerceWarmThroughput({ ReadUnitsPerSecond: undefined }).droppedMembers).toEqual([]);
  });
});

describe('isWarmThroughputDecrease (issue #1857 / #1768)', () => {
  it('is a decrease when every declared member is at-or-below live and one is strictly below', () => {
    expect(
      isWarmThroughputDecrease(
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
        { ReadUnitsPerSecond: 20000, WriteUnitsPerSecond: 4000 }
      )
    ).toBe(true);
  });

  it('is NOT a decrease when the value is unchanged', () => {
    expect(
      isWarmThroughputDecrease({ ReadUnitsPerSecond: 12000 }, { ReadUnitsPerSecond: 12000 })
    ).toBe(false);
  });

  it('is NOT a decrease when the value rises — the increase must still be sent', () => {
    expect(
      isWarmThroughputDecrease({ ReadUnitsPerSecond: 20000 }, { ReadUnitsPerSecond: 12000 })
    ).toBe(false);
  });

  it('fails OPEN on a MIXED block: one member down, one up is a real increase', () => {
    expect(
      isWarmThroughputDecrease(
        { ReadUnitsPerSecond: 8000, WriteUnitsPerSecond: 9000 },
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }
      )
    ).toBe(false);
  });

  it('considers DECLARED members only — an absent member cannot lower anything', () => {
    // Write is 4000 live and not declared at all. Only the declared read half
    // decides, and it IS below live.
    expect(
      isWarmThroughputDecrease(
        { ReadUnitsPerSecond: 8000 },
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 }
      )
    ).toBe(true);
  });

  it('fails OPEN when the live side is absent or has no counterpart', () => {
    expect(isWarmThroughputDecrease({ ReadUnitsPerSecond: 8000 }, undefined)).toBe(false);
    expect(
      isWarmThroughputDecrease({ ReadUnitsPerSecond: 8000 }, { WriteUnitsPerSecond: 4000 })
    ).toBe(false);
  });

  it('fails OPEN when nothing is declared', () => {
    expect(isWarmThroughputDecrease({}, { ReadUnitsPerSecond: 12000 })).toBe(false);
    expect(isWarmThroughputDecrease(undefined, { ReadUnitsPerSecond: 12000 })).toBe(false);
  });
});
