/**
 * `importableOutputKeys` / `importableOutputs` / `hasReadableExportSet` against
 * a record whose `outputs` bag or `exportNames` field a hand edit or a
 * truncation left unreadable (issue go-to-k/cdkd#3192).
 *
 * WHY THESE THREE AND NOT THE CALL SITES. The helper is the single chokepoint
 * for "what does this stack export", and that is measured rather than
 * asserted — `grep -rn "state.exportNames" src/` returns exactly two readers,
 * `importableOutputKeys` here and `exportNamesCarriedFrom` beside it (which
 * only tests `=== undefined` and copies, so it dereferences nothing). So
 * unlike the `outputs` BAG — where every flow indexes the container a line
 * before the walk, which is why `malformed-resources-bag.ts`'s header insists
 * the guard goes at the LOAD — nothing reads `exportNames` earlier than this
 * function, and guarding here dominates every consumer of it: the exports
 * index rebuild, the deploy-time resolver's `Fn::ImportValue` state scan,
 * `cdkd diff`'s no-change merge, the local-command loader, and the deploy
 * engine's export-set comparison.
 *
 * What FAILING CLOSED buys, per arm:
 *
 * - a non-object `outputs` used to publish `Object.keys('abcdef')` —
 *   `['0'…'5']` — one fabricated export per character into
 *   `cdkd/_index/<region>/exports.json`, the namespace every other stack's
 *   `Fn::ImportValue` binds against;
 * - a non-array `exportNames` used to throw a bare
 *   `TypeError: state.exportNames.filter is not a function`, reached from
 *   `cdkd diff` among others.
 *
 * Both halves are two-sided here: every case that pins a refusal has a floor
 * beside it pinning that a healthy, an empty and an absent record answer
 * exactly as they did before.
 */

import { describe, expect, it } from 'vite-plus/test';
import {
  hasReadableExportSet,
  importableOutputKeys,
  importableOutputs,
} from '../../../src/types/state.js';
import type { StackState } from '../../../src/types/state.js';

type ExportSetView = Pick<StackState, 'outputs' | 'exportNames'>;

function record(outputs: unknown, exportNames?: unknown): ExportSetView {
  return {
    outputs: outputs as StackState['outputs'],
    ...(exportNames !== undefined && { exportNames: exportNames as StackState['exportNames'] }),
  };
}

/**
 * Every shape a hand-edited `outputs` can carry that is not a readable bag.
 *
 * `undefined` is in the table on purpose even though it is an ORDINARY record
 * rather than a defect (`cdkd scrub` round-trips one deliberately): this
 * function's answer for it is `[]` either way, and that is exactly what the
 * pre-fix `?? {}` produced — so the row is the proof that the fail-closed arm
 * moved NO verdict for the one shape the sibling helpers exempt.
 */
const UNREADABLE_BAGS: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['absent', undefined],
  ['a string', 'abcdef'],
  ['a list', ['a', 'b']],
  ['a number', 5],
  ['a boolean', true],
];

/** Every shape a hand-edited `exportNames` can carry that is not an array. */
const UNREADABLE_EXPORT_NAMES: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['a string', 'abc'],
  ['a number', 5],
  ['an object', { Vpc: true }],
  ['a boolean', true],
];

describe('importableOutputKeys — the `outputs` bag arm (go-to-k/cdkd#3192)', () => {
  for (const [label, bag] of UNREADABLE_BAGS) {
    it(`publishes NOTHING when the bag is ${label}`, () => {
      // Both arms of the function, because the `exportNames === undefined`
      // branch is the one that used to call `Object.keys` on the raw bag and
      // the other one called `Object.hasOwn` against it.
      expect(importableOutputKeys(record(bag))).toEqual([]);
      expect(importableOutputKeys(record(bag, ['Anything']))).toEqual([]);
      // The rebuilt bag, not just the key list: `importableOutputs` indexes
      // `outputs[name]` and is what the exports index actually ingests.
      expect(importableOutputs(record(bag))).toEqual({});
      expect(importableOutputs(record(bag, ['Anything']))).toEqual({});
    });
  }

  it('is the STRING case that fabricated, so pin what it used to produce', () => {
    // The measured defect, spelled as the value it produced rather than as a
    // count: `Object.keys('abcdef')` is `['0'…'5']`, so the pre-fix code
    // published SIX exports whose values were the record's own characters.
    // Asserting `[]` alone would also pass for a bag that merely resolved to
    // nothing, so the control is that the fabricated keys are the ones absent.
    const keys = importableOutputKeys(record('abcdef'));
    expect(keys).toEqual([]);
    expect(keys).not.toContain('0');
    expect(Object.keys(importableOutputs(record('abcdef')))).toEqual([]);
  });

  it('FLOOR: a healthy pre-v9 record still publishes every key', () => {
    const bag = { VpcId: 'vpc-1', 'prod:VpcId': 'vpc-1' };
    expect(importableOutputKeys(record(bag)).sort()).toEqual(['VpcId', 'prod:VpcId']);
    expect(importableOutputs(record(bag))).toEqual(bag);
  });

  it('FLOOR: a healthy v9 record still publishes the intersection, and only it', () => {
    const bag = { VpcId: 'vpc-1', 'prod:VpcId': 'vpc-1' };
    expect(importableOutputKeys(record(bag, ['prod:VpcId']))).toEqual(['prod:VpcId']);
    expect(importableOutputs(record(bag, ['prod:VpcId']))).toEqual({ 'prod:VpcId': 'vpc-1' });
    // A name the bag does not hold is still dropped — the pre-existing rule,
    // asserted here so the new guard cannot be mistaken for it.
    expect(importableOutputKeys(record(bag, ['prod:VpcId', 'Gone']))).toEqual(['prod:VpcId']);
  });

  it('FLOOR: an EMPTY bag and an EMPTY set both still mean "exports nothing"', () => {
    expect(importableOutputKeys(record({}))).toEqual([]);
    expect(importableOutputKeys(record({ A: 1 }, []))).toEqual([]);
    expect(importableOutputs(record({ A: 1 }, []))).toEqual({});
  });
});

describe('importableOutputKeys — the `exportNames` arm (go-to-k/cdkd#3192)', () => {
  for (const [label, names] of UNREADABLE_EXPORT_NAMES) {
    it(`reads ${label} as an EMPTY export set rather than throwing`, () => {
      const bag = { VpcId: 'vpc-1', Topic: 'topic-1' };
      // No throw at all — the pre-fix behaviour was a bare
      // `TypeError: state.exportNames.filter is not a function`.
      expect(() => importableOutputKeys(record(bag, names))).not.toThrow();
      expect(importableOutputKeys(record(bag, names))).toEqual([]);
      expect(importableOutputs(record(bag, names))).toEqual({});
    });
  }

  it('reads a corrupt set as EMPTY, never as UNKNOWN — the fail-open direction', () => {
    // THE decision this arm encodes, as its own case. Falling back to the
    // `exportNames === undefined` branch would have been the easier fix and is
    // the wrong one: that branch publishes EVERY key, so a corrupted field
    // would make a plain `CfnOutput('VpcId')` the index's producer of export
    // `VpcId` — precisely the binding issue #2193 exists to close, re-opened
    // by a guard. The discriminator is the bag having a key the legacy rule
    // WOULD have published.
    const keys = importableOutputKeys(record({ VpcId: 'vpc-1' }, 'not-an-array'));
    expect(keys).toEqual([]);
    expect(keys, 'a corrupt exportNames fell back to the legacy every-key rule').not.toContain(
      'VpcId'
    );
  });

  it('a set whose EVERY element is a non-string is DAMAGED, not exports-nothing', () => {
    // Review of go-to-k/cdkd#3206 round 2. `hasReadableExportSet` used to
    // answer TRUE here while `importableOutputKeys` answered `[]`, so the
    // exports-index rebuild dropped the producer with NO warning — the same
    // silent contribute-nothing shape the warning exists to close. It was
    // nearly written off on the claim that the only closing predicate would
    // also fire on `exportNames: []`; the floor below is why that was wrong.
    expect(hasReadableExportSet(record({ '0': 'fabricated' }, [0]))).toBe(false);
    expect(hasReadableExportSet(record({ A: 1 }, [null, 5, {}]))).toBe(false);
    expect(importableOutputKeys(record({ '0': 'fabricated' }, [0]))).toEqual([]);
  });

  it('FLOOR: `[]` and a PARTIALLY non-string set both stay READABLE', () => {
    // The two shapes that make `some` the right polarity and `every` the wrong
    // one. `[]` is how a record says it exports nothing — the v9 semantics —
    // and `['Real', 0]` still has a usable name to publish, so reporting it
    // damaged would both warn spuriously and stop `Real` being published.
    expect(hasReadableExportSet(record({ A: 1 }, []))).toBe(true);
    expect(hasReadableExportSet(record({ '0': 'f', Real: 'v' }, ['Real', 0]))).toBe(true);
    expect(importableOutputKeys(record({ '0': 'f', Real: 'v' }, ['Real', 0]))).toEqual(['Real']);
    // ...and a string name merely ABSENT from the bag is readable too: that is
    // the ordinary "an alias whose value did not resolve publishes nothing".
    expect(hasReadableExportSet(record({ A: 1 }, ['Gone']))).toBe(true);
  });

  it('drops a NON-STRING element instead of coercing it into a key', () => {
    // `Object.hasOwn` does not throw on a number — it COERCES — so a
    // `exportNames: [0]` against a bag holding `"0"` would have published that
    // key. The bag below holds BOTH a numeric-looking key and a real one, so
    // the case discriminates the filter from a blanket refusal.
    const bag = { '0': 'fabricated', Real: 'value' };
    expect(importableOutputKeys(record(bag, [0, 'Real']))).toEqual(['Real']);
    expect(importableOutputs(record(bag, [0, 'Real']))).toEqual({ Real: 'value' });
  });

  it('FLOOR: the non-string filter is the IDENTITY on a healthy string set', () => {
    const bag = { A: 1, B: 2, C: 3 };
    expect(importableOutputKeys(record(bag, ['C', 'A', 'B']))).toEqual(['C', 'A', 'B']);
  });

  it('FLOOR: a `__proto__` export name still survives the rebuild (#2193 review)', () => {
    // The prototype-free reconstruction predates this change and must not have
    // been traded away by the narrowing above: a JSON-parsed bag can carry an
    // OWN `__proto__` key, and assigning it onto a plain object literal walks
    // the setter and loses it.
    const bag = JSON.parse('{"__proto__":"payload","Other":"o"}') as Record<string, unknown>;
    const picked = importableOutputs(record(bag, ['__proto__']));
    expect(Object.keys(picked)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(picked)).toBeNull();
  });
});

describe('hasReadableExportSet', () => {
  it('answers the question `[]` cannot: damaged versus exports-nothing', () => {
    // The reason this predicate is exported at all. `importableOutputKeys`
    // returns `[]` for both, so a caller that must SAY which one it got — the
    // exports-index rebuild, whose silence would leave the next
    // `Fn::ImportValue` miss naming the CONSUMER — cannot re-derive it.
    expect(hasReadableExportSet(record({ A: 1 }, []))).toBe(true);
    expect(hasReadableExportSet(record('abcdef'))).toBe(false);
    expect(hasReadableExportSet(record({ A: 1 }, 'nope'))).toBe(false);
  });

  it('agrees with importableOutputKeys on every shape in both tables', () => {
    // Not a tautology through one shared call: this compares the two EXPORTED
    // entry points, which is what reds if either grows its own inline copy of
    // the test — the drift a single predicate exists to prevent. A readable
    // record may legitimately answer `[]` (it exports nothing), so the
    // implication is one-directional and asserted as such.
    for (const [label, bag] of UNREADABLE_BAGS) {
      expect(hasReadableExportSet(record(bag)), `bag ${label}`).toBe(false);
      expect(importableOutputKeys(record(bag)), `bag ${label}`).toEqual([]);
    }
    for (const [label, names] of UNREADABLE_EXPORT_NAMES) {
      expect(hasReadableExportSet(record({ A: 1 }, names)), `exportNames ${label}`).toBe(false);
      expect(importableOutputKeys(record({ A: 1 }, names)), `exportNames ${label}`).toEqual([]);
    }
    expect(hasReadableExportSet(record({ A: 1 }))).toBe(true);
    expect(importableOutputKeys(record({ A: 1 }))).toEqual(['A']);
  });

  it('answers FALSE for an ABSENT bag, which is NOT what hasReadableOutputs says', () => {
    // The two predicates ask different questions and the divergence is
    // deliberate: `hasReadableOutputs` ("is this record damaged") exempts an
    // absent bag, because a record with no outputs is one cdkd writes on
    // purpose. This one asks "can an export set be read off it", and it
    // cannot. Pinned so a later reader does not "fix" one to match the other;
    // the exports-index rebuild tests for absence BEFORE calling this.
    expect(hasReadableExportSet(record(undefined))).toBe(false);
    expect(importableOutputKeys(record(undefined))).toEqual([]);
  });
});
