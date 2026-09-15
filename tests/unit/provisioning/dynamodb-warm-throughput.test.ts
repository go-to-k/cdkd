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
  toCfnInteger,
  toFiniteNumber,
} from '../../../src/provisioning/dynamodb-warm-throughput.js';
import { coerceCfnInteger } from '../../../src/provisioning/config-shape.js';

describe('toFiniteNumber (the ONE CFn-numeric rule, issue #1857 PR review)', () => {
  // This rule was written by hand THREE times: here, as
  // `dynamodb-table-provider.ts`'s `capacityNumber` (byte-identical), and as
  // `dynamodb-globaltable-provider.ts`'s `toFiniteNumber` (a different spelling
  // of the same total function). Both copies are gone; these cases are the
  // union of what the three answered, so a future edit to the survivor cannot
  // quietly move any of them.
  //
  // The zero-valued shapes are the load-bearing half. `Number()` maps ALL of
  // `null` / `''` / `'   '` / `[]` / `false` to **0**, so accepting them would
  // (a) let a live capacity of 0 compare EQUAL to a desired `null` and suppress
  // a real UpdateTable, and (b) send a warm throughput of 0 that nobody
  // declared.
  it.each([
    ['a number', 12000, 12000],
    ['a zero', 0, 0],
    ['a negative (AWS decides, not this reader)', -1, -1],
    ['a YAML-borne numeric string', '12000', 12000],
    ['a numeric string with surrounding space', ' 12000 ', 12000],
    ['a decimal string', '0.5', 0.5],
    ['undefined', undefined, undefined],
    ['null', null, undefined],
    ['an empty string', '', undefined],
    ['a whitespace-only string', '   ', undefined],
    ['a non-numeric string', 'twelve', undefined],
    ['an empty array', [], undefined],
    ['a populated array', [1], undefined],
    ['false', false, undefined],
    ['true', true, undefined],
    ['an object (an unresolved intrinsic)', { 'Fn::If': ['c', 1, 2] }, undefined],
    ['NaN', Number.NaN, undefined],
    ['Infinity', Number.POSITIVE_INFINITY, undefined],
  ])('reads %s', (_label, input, expected) => {
    expect(toFiniteNumber(input)).toBe(expected);
  });
});

describe('toCfnInteger (CloudFormation\'s MEASURED Integer grammar, issue #2698)', () => {
  // Every row below with a `cfn` column is a row of the live A/B on
  // `AWS::Logs::LogGroup.RetentionInDays` (us-east-1, 2026-09-14, the table on
  // the helper's doc comment). The reader must answer a NUMBER exactly where
  // CloudFormation accepted a number, and `undefined` everywhere it rejected —
  // the difference from `toFiniteNumber` is the whole point, so each rejected
  // spelling is ALSO asserted to be one `Number()` accepts, or the row would
  // pin nothing the older reader did not already do.
  it.each([
    ['a JSON number', 30, 30],
    ['a decimal string', '60', 60],
    ['a signed string', '+30', 30],
    ['a padded string', ' 30 ', 30],
    ['a padded signed string', '\t+30\n', 30],
    ['a leading-zero string (coerceCfnInteger measurement, 007)', '007', 7],
    ['a negative (a caller decides, not this reader)', -1, -1],
    ['a negative string', '-1', -1],
    ['a zero (a caller decides, not this reader)', 0, 0],
    ['a string zero', '0', 0],
  ])('reads %s as the integer CloudFormation reads', (_label, input, expected) => {
    expect(toCfnInteger(input)).toBe(expected);
  });

  it.each([
    ['a hex string', '0x1e', 30],
    ['an exponent string', '1e3', 1000],
    ['a decimal-point string', '30.5', 30.5],
    ['a decimal-point string spelling an integer', '30.0', 30],
    ['an octal string', '0o36', 30],
    ['a binary string', '0b11110', 30],
    ['a non-integer number', 30.5, 30.5],
  ])('REFUSES %s, which Number() would have forwarded as %s', (_label, input, viaNumber) => {
    expect(toCfnInteger(input)).toBeUndefined();
    // The discriminator against the older reader — without this the row is
    // satisfiable by any function that returns `undefined`.
    expect(toFiniteNumber(input)).toBe(viaNumber);
  });

  it.each([
    ['an empty string (CloudFormation: property ABSENT)', ''],
    ['a whitespace-only string (CloudFormation: property ABSENT)', '   '],
    ['undefined', undefined],
    ['null', null],
    ['a non-numeric string', 'abc'],
    ['true', true],
    ['false', false],
    ['an empty array', []],
    ['an object (an unresolved intrinsic)', { Ref: 'X' }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 53],
    ['an unsafe integer string', '9007199254740993'],
  ])('answers undefined for %s (absent or unusable is the CALLER\'s question)', (_label, input) => {
    expect(toCfnInteger(input)).toBeUndefined();
  });

  it('is coerceCfnInteger plus a trim and nothing else — the two grammars cannot drift', () => {
    // The digits grammar is REUSED from `config-shape.ts`; the trim is the one
    // measured difference between the two properties (a nested
    // `PasswordLength` rejected `" 12 "`, a top-level `RetentionInDays`
    // accepted `" 30 "`). So on every UNPADDED input the two agree exactly, and
    // a padded input is the only one where they part — asserted in both
    // directions so neither helper can quietly absorb the other's rule.
    const unpadded: unknown[] = [30, '30', '+30', '007', '0x1e', '1e3', '30.5', '', 'abc', null, 0, '0', -1, 30.5];
    for (const input of unpadded) {
      expect(toCfnInteger(input), `unpadded ${JSON.stringify(input)}`).toBe(coerceCfnInteger(input));
    }
    expect(toCfnInteger(' 30 ')).toBe(30);
    expect(coerceCfnInteger(' 30 ')).toBeUndefined();
  });
});

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

  // Issue #3135: the block is FORWARDED, so a member is read through
  // CloudFormation's measured DynamoDB Integer grammar (`coerceCfnInteger`,
  // NO trim — the DynamoDB table on `toCfnInteger`'s doc), not `Number()`.
  // Each spelling below is one CloudFormation was measured to REJECT on
  // `AWS::DynamoDB::Table.ProvisionedThroughput` (us-east-1, 2026-09-14), and
  // `Number()` forwarded a number for every one of them.
  describe('reads a member through the measured DynamoDB Integer grammar (issue #3135)', () => {
    it.each([
      ['a padded string', ' 7 ', 7],
      ['a trailing-space string', '7 ', 7],
      ['a hex string', '0x9', 9],
      ['an exponent string', '1e1', 10],
      ['a decimal-point string', '6.5', 6.5],
      ['a whole-valued decimal string', '6.0', 6],
      ['a fractional NUMBER', 6.5, 6.5],
    ])('DROPS %s and NAMES the member, never reading it as absent', (_label, value, numberReading) => {
      // The premise the case rests on: the wider reader accepted it, so the
      // pre-fix binary forwarded THIS number for a template CloudFormation
      // refuses. Stated in the assertion so a future widening of
      // `toFiniteNumber` cannot make the case vacuous.
      expect(toFiniteNumber(value)).toBe(numberReading);

      const coercion = coerceWarmThroughput({
        ReadUnitsPerSecond: value,
        WriteUnitsPerSecond: 4000,
      });
      // Dropped and NAMED — the same arm an unresolved intrinsic takes, so
      // the provider's diagnostic reports it; NOT read as an absent member
      // (an absent member is not named) and NOT forwarded.
      expect(coercion.spec).toEqual({ WriteUnitsPerSecond: 4000 });
      expect(coercion.droppedMembers).toEqual(['ReadUnitsPerSecond']);
    });

    it('still accepts every spelling CloudFormation accepts: a signed and a zero-padded digit string', () => {
      expect(coerceWarmThroughput({ ReadUnitsPerSecond: '+8', WriteUnitsPerSecond: '010' })).toEqual({
        spec: { ReadUnitsPerSecond: 8, WriteUnitsPerSecond: 10 },
        droppedMembers: [],
      });
    });

    it('refuses the whole block when its only member is a rejected spelling', () => {
      expect(coerceWarmThroughput({ WriteUnitsPerSecond: ' 12000 ' })).toEqual({
        droppedMembers: ['WriteUnitsPerSecond'],
      });
    });
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
