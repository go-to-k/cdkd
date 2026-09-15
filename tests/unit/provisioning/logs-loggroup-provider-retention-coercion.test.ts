/**
 * `AWS::Logs::LogGroup` `RetentionInDays` coercion (issues #2521, #2698, #2699).
 *
 * CloudFormation is stringly typed and coerces `RetentionInDays: '30'` to the
 * number its schema declares. The AWS SDK does not — it serializes whatever it
 * is handed — so the provider used to put a JSON STRING on the wire, and its
 * update-side comparison read the state record's `'30'` as different from the
 * template's `30` and re-issued a `PutRetentionPolicy` on every deploy.
 *
 * Issues #2698 / #2699 replaced the guess about WHICH spellings CloudFormation
 * accepts with a live A/B (the table is on `toCfnInteger` in
 * `src/provisioning/dynamodb-warm-throughput.ts`). Every row below whose
 * `before` names a forwarded or deleted call is a row that measurement moved:
 * hex / exponent / decimal-point strings are REFUSED rather than forwarded as
 * their `Number()` reading; `false`, `null`, `0` and `'0'` are REFUSED rather
 * than routed to `DeleteRetentionPolicy`; a whitespace-only string joins `''`
 * as CloudFormation's spelling of "no retention"; and a numeric `0` on a
 * `desiredFromAwsReadback` bag (`cdkd drift --revert`) stays the delete-arm
 * value `readCurrentState` writes for a never-expiring log group.
 *
 * The sibling half of the same issue lives in
 * `tests/unit/provisioning/stateful-types.test.ts`, where the stateful guard
 * reads the same property out of a state record.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AssociateKmsKeyCommand,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DeleteRetentionPolicyCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    // Hoisted so the replay-downgrade case can read what the provider
    // ANNOUNCED — a warn-and-skip that is not asserted is a silent skip with
    // a green suite (review probe: deleting the warn call reddened nothing).
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PHYSICAL_ID = '/cdkd/retention-coercion-test';

/** Distinguishes "the key is absent" from "the key holds `undefined`". */
const ABSENT = Symbol('absent');
/** Marks a matrix row as a CREATE, which has no previous side at all. */
const ABSENT_PREVIOUS = Symbol('create');

/**
 * WHICH refusal arm a value must land in. The five arms carry five distinct
 * `detail` strings, and matching only their shared prefix leaves all of them
 * collapsible into one with nothing red — the failure this selector exists to
 * stop, and the one the non-finite arm shipped with until it was measured.
 */
const arm = (value: unknown): RegExp => {
  if (typeof value === 'number' && !Number.isFinite(value)) return /declares a non-finite number/;
  if (value === null) return /declares null/;
  if (value === 0 || value === '0') return /declares zero/;
  if (typeof value === 'number' && Number.isInteger(value) && value < 0) {
    return /declares a negative number/;
  }
  if (value === '-1') return /declares a negative number/;
  if (typeof value === 'string') return /a string that is not a CloudFormation Integer/;
  return /is of type (number|boolean|array|object)/;
};

const REFUSAL_PREFIX = /RetentionInDays must be a positive CloudFormation Integer/;

const sentAll = (Command: new (input: never) => unknown) =>
  mockSend.mock.calls.filter((c) => c[0] instanceof Command).map((c) => c[0]);
const sent = (Command: new (input: never) => unknown) => sentAll(Command)[0];

/**
 * The refusal's SCOPE, as a table that runs.
 *
 * Three review rounds each found a hole in a PROSE statement of this scope --
 * the coercible negative that fell through to `DeleteRetentionPolicy`, the
 * unusable value silenced by the wrong change gate, and then wrong cells in
 * the hand-written table that replaced those sentences. A fourth paragraph
 * was not going to be the one that is right, so the table is here instead,
 * where a wrong cell is a red test rather than a comment nobody can check.
 *
 * `before` records what the PRE-#2521 code did, because that is what makes a
 * row's `expect` reviewable: the old send gate was `if (retentionInDays)` on
 * the RAW value, so `'0'` and `-1` really did go on the wire and AWS rejected
 * them, while the old change gate compared RAW values with `!==`.
 */
type RetentionOutcome =
  | { readonly call: 'none' }
  | { readonly call: 'put'; readonly days: number }
  | { readonly call: 'delete' }
  | { readonly call: 'refuse' };

const NONE: RetentionOutcome = { call: 'none' };
const DELETE: RetentionOutcome = { call: 'delete' };
const REFUSE: RetentionOutcome = { call: 'refuse' };
const PUT = (days: number): RetentionOutcome => ({ call: 'put', days });

/** A create has no previous side, so the value alone decides. */
const CREATE_MATRIX: ReadonlyArray<{
  readonly value: unknown;
  readonly expect: RetentionOutcome;
  readonly before: string;
}> = [
  { value: 30, expect: PUT(30), before: 'Put(30)' },
  { value: '30', expect: PUT(30), before: "Put('30') -> AWS rejects a string" },
  // Measured accepted by CloudFormation (issue #2698's table): a sign and
  // surrounding whitespace are part of its Integer grammar.
  { value: '+30', expect: PUT(30), before: 'Put(30)' },
  { value: ' 30 ', expect: PUT(30), before: 'Put(30)' },
  // --- CloudFormation's spellings of "no retention" (measured) -------------
  { value: '', expect: NONE, before: 'no call (falsy)' },
  { value: '   ', expect: NONE, before: 'refused (#2521)' },
  { value: ABSENT, expect: NONE, before: 'no call (absent)' },
  // --- the falsy family CloudFormation REJECTS (issue #2699) ---------------
  // Every one of these was skipped as never-expire on the strength of being
  // falsy (or, for `'0'`, of coercing to the falsy number). The Logs handler
  // rejects `0` / `'0'` by enum and `false` by type; `null` is rejected by
  // `update-stack` itself, and cdkd's resolver never produces one here
  // (`AWS::NoValue` omits the key).
  { value: 0, expect: REFUSE, before: 'no call (falsy)' },
  { value: '0', expect: REFUSE, before: "Put('0') -> AWS rejects; then no call (#2521)" },
  { value: false, expect: REFUSE, before: 'no call (falsy)' },
  { value: null, expect: REFUSE, before: 'no call (falsy)' },
  // --- spellings `Number()` accepted and CloudFormation rejects (#2698) ----
  // The pre-#2698 reader FORWARDED these as their `Number()` reading.
  { value: '0x1e', expect: REFUSE, before: 'Put(30) forwarded' },
  { value: '1e3', expect: REFUSE, before: 'Put(1000) forwarded' },
  { value: '30.5', expect: REFUSE, before: 'Put(30.5) forwarded' },
  { value: '30.0', expect: REFUSE, before: 'Put(30) forwarded' },
  { value: 30.5, expect: REFUSE, before: 'Put(30.5) forwarded' },
  // --- not a number at all ------------------------------------------------
  { value: 'abc', expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: true, expect: REFUSE, before: 'Put(true) -> AWS rejects' },
  { value: [], expect: REFUSE, before: 'Put([]) -> AWS rejects' },
  { value: {}, expect: REFUSE, before: 'Put({}) -> AWS rejects' },
  { value: -1, expect: REFUSE, before: 'Put(-1) -> AWS rejects' },
  { value: '-1', expect: REFUSE, before: "Put('-1') -> AWS rejects" },
  { value: Infinity, expect: REFUSE, before: 'Put(Infinity) -> AWS rejects' },
  { value: -Infinity, expect: REFUSE, before: 'Put(-Infinity) -> AWS rejects' },
  // FALSY, so it reached the send gate's `else` and, on the update path,
  // deleted a live retention. Refused ahead of the falsy return since round 4.
  { value: NaN, expect: REFUSE, before: 'no call (falsy)' },
];

/**
 * The update path, where the PREVIOUS side decides as much as the value does.
 * Its spelling is load-bearing and the rows say so: `-1` over `-1` is an
 * unchanged import record and passes, while `-1` over `'-1'` is a change and
 * is refused.
 *
 * `readback` marks a row driven with `UpdateContext.desiredFromAwsReadback`,
 * the bag `cdkd drift --revert` hands `update()`.
 */
const UPDATE_MATRIX: ReadonlyArray<{
  readonly value: unknown;
  readonly previous: unknown;
  readonly expect: RetentionOutcome;
  readonly before: string;
  readonly readback?: true;
}> = [
  // --- no real change -----------------------------------------------------
  { value: 30, previous: 30, expect: NONE, before: 'no call' },
  { value: '30', previous: 30, expect: NONE, before: "Put('30') -> AWS rejects" },
  { value: 30, previous: '30', expect: NONE, before: 'Put(30) for a retention that had not changed' },
  { value: '30', previous: '30', expect: NONE, before: 'no call' },
  // Two more spellings of ONE retention, measured accepted by CloudFormation:
  // the coerced comparison must read them as unchanged too.
  { value: '+30', previous: 30, expect: NONE, before: 'no call' },
  { value: ' 30 ', previous: 30, expect: NONE, before: 'no call' },
  // --- a real retention change -------------------------------------------
  { value: 90, previous: 30, expect: PUT(90), before: 'Put(90)' },
  { value: '90', previous: 30, expect: PUT(90), before: "Put('90') -> AWS rejects" },
  { value: ' 90 ', previous: 30, expect: PUT(90), before: 'Put(90)' },
  { value: 30, previous: ABSENT, expect: PUT(30), before: 'Put(30)' },
  { value: 30, previous: 'abc', expect: PUT(30), before: 'Put(30)' },
  { value: 30, previous: false, expect: PUT(30), before: 'Put(30)' },
  // A previous side the pre-#2698 reader FORWARDED as 30: AWS holds 30, the
  // record spells it in hex, and the corrected template still compares as a
  // change (the coerced sides differ), so the Put goes out — redundant, safe.
  { value: 30, previous: '0x1e', expect: PUT(30), before: 'no call (both read 30)' },
  // --- never-expire: the delete arm --------------------------------------
  { value: ABSENT, previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: '', previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  // Whitespace-only is CloudFormation's "absent" (measured, #2699): the live
  // retention is REMOVED there, so it is here.
  { value: '   ', previous: 30, expect: DELETE, before: 'refused (#2521)' },
  // cdkd's OWN never-expire spelling, on the ONE bag that carries it: a
  // `drift --revert` over a console-added retention on a never-expiring log
  // group is desired `0` (the observed baseline) over live `30`.
  { value: 0, previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy', readback: true },
  { value: 0, previous: 0, expect: NONE, before: 'no call', readback: true },
  // --- refused: the falsy family CloudFormation rejects (#2699) -----------
  // Each of these DELETED a live retention before, on a template
  // CloudFormation refuses to deploy at all.
  { value: 0, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: '0', previous: 30, expect: REFUSE, before: "Put('0') -> AWS rejects; then Delete (#2521)" },
  { value: '0', previous: 0, expect: REFUSE, before: "Put('0') -> AWS rejects; then no call (#2521)" },
  { value: false, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: null, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: 0, previous: 'abc', expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: false, previous: 'abc', expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: null, previous: '   ', expect: REFUSE, before: 'DeleteRetentionPolicy' },
  // The readback flag licenses NUMERIC zero alone — `readCurrentState` writes
  // a number, so a string zero or a boolean on that bag is not cdkd's spelling
  // and stays refused.
  { value: '0', previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy', readback: true },
  { value: false, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy', readback: true },
  // --- refused: spellings `Number()` accepted and CloudFormation rejects ---
  { value: '0x1e', previous: 30, expect: REFUSE, before: 'no call (both read 30)' },
  { value: '0x1e', previous: 60, expect: REFUSE, before: 'Put(30) forwarded' },
  { value: '1e3', previous: 30, expect: REFUSE, before: 'Put(1000) forwarded' },
  { value: '30.5', previous: 30, expect: REFUSE, before: 'Put(30.5) forwarded' },
  { value: 30.5, previous: 30, expect: REFUSE, before: 'Put(30.5) forwarded' },
  // --- refused: not a number at all ----------------------------------------
  { value: 'abc', previous: 30, expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: true, previous: 30, expect: REFUSE, before: 'Put(true) -> AWS rejects' },
  { value: [], previous: 30, expect: REFUSE, before: 'Put([]) -> AWS rejects' },
  { value: -1, previous: 30, expect: REFUSE, before: 'Put(-1) -> AWS rejects' },
  { value: '-1', previous: 30, expect: REFUSE, before: "Put('-1') -> AWS rejects" },
  // Round 2's blocker: an unusable value whose previous side is absent or
  // differently unusable. Both coerce to `undefined`, so the COERCED gate the
  // first fix used read them as unchanged and dropped the property silently.
  { value: 'abc', previous: ABSENT, expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: 'abc', previous: 'xyz', expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: 'abc', previous: '', expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: -1, previous: '-1', expect: REFUSE, before: 'Put(-1) -> AWS rejects' },
  // Round 3's finding: `JSON.stringify` renders Infinity / NaN / null alike,
  // so a stringify-only gate read this pair as unchanged and skipped the
  // refusal. `.inf` is a YAML spelling an import record can carry.
  { value: Infinity, previous: null, expect: REFUSE, before: 'Put(Infinity) -> AWS rejects' },
  // --- unchanged AND unusable: the import no-op, which must stay a no-op ---
  { value: 'abc', previous: 'abc', expect: NONE, before: 'no call (raw ===)' },
  { value: '   ', previous: '   ', expect: NONE, before: 'no call (raw ===)' },
  { value: -1, previous: -1, expect: NONE, before: 'no call (raw ===)' },
  { value: 0, previous: 0, expect: NONE, before: 'no call (raw ===)' },
  { value: '0x1e', previous: '0x1e', expect: NONE, before: 'no call (raw ===)' },
  // Structurally identical but never the same REFERENCE, which is why the
  // gate is not a bare `Object.is`.
  { value: [], previous: [], expect: NONE, before: 'Put([]) -> AWS rejects (raw !== by reference)' },
  { value: {}, previous: {}, expect: NONE, before: 'Put({}) -> AWS rejects (raw !== by reference)' },
  // The row that pins the gate's `Object.is` arm, and the ONLY one that does:
  // every other unchanged pair is already carried by the stringify arm, so
  // deleting `Object.is` reddened nothing until this row existed. `Infinity`
  // renders `'null'`, which the stringify arm excludes, so reference identity
  // is all that is left to recognise it as unchanged.
  { value: Infinity, previous: Infinity, expect: NONE, before: 'Put(Infinity) -> AWS rejects' },
  // Falsy non-finite over a live retention, and the readback-flagged zero
  // beside it: `NaN` is REFUSED (round 4) on every bag, where `0` is refused
  // on a template bag and deletes on a readback one — pinned apart rather
  // than argued apart.
  { value: NaN, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: NaN, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy', readback: true },
  { value: -Infinity, previous: 30, expect: REFUSE, before: 'Put(-Infinity) -> AWS rejects' },
  // --- the previous side is PRESENT but UNUSABLE ---------------------------
  // Both sides coerce to `undefined`, so the coerced gate alone issues
  // NOTHING and cdkd records absence while AWS may still hold a retention.
  // `previousRetentionUnknown` is what keeps these on the pre-#2521 answer.
  // Reachable through an imported record, which persists the template value
  // without ever having called PutRetentionPolicy — and, since #2698, through
  // a record whose hex spelling the OLD reader forwarded as a real retention.
  { value: ABSENT, previous: 'abc', expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: '', previous: [], expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: ABSENT, previous: '0x1e', expect: DELETE, before: 'DeleteRetentionPolicy' },
  // The NEGATIVE control for that clause, and the one call this change still
  // drops on purpose: a FALSY previous is not unknown. Every falsy value was
  // skipped by the pre-coercion truthiness test too, so no Put was ever issued
  // for it and AWS provably holds no retention — the pre-#2521 Delete was
  // redundant. Without this row the clause could be widened to every
  // `!sameRawRetention` with nothing red.
  { value: ABSENT, previous: '', expect: NONE, before: 'DeleteRetentionPolicy (redundant)' },
  { value: ABSENT, previous: false, expect: NONE, before: 'DeleteRetentionPolicy (redundant)' },
  // A whitespace-only previous is CloudFormation's "absent" (measured), so it
  // is not unknown either; the clause excludes it explicitly since #2699 —
  // it is TRUTHY, so the falsy test above does not reach it.
  { value: ABSENT, previous: '   ', expect: NONE, before: 'DeleteRetentionPolicy' },
  { value: '', previous: '   ', expect: NONE, before: 'DeleteRetentionPolicy' },
];

describe('LogsLogGroupProvider RetentionInDays coercion (#2521)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new LogsLogGroupProvider();
  });

  /**
   * Drive one matrix row and report what actually went out. Returns the same
   * shape the row declares, so a mismatch prints both sides.
   */
  const runRow = async (
    value: unknown,
    previous: unknown | typeof ABSENT,
    readback = false
  ): Promise<RetentionOutcome> => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    const props = value === ABSENT ? {} : { RetentionInDays: value };
    let threw: Error | undefined;
    if (previous === ABSENT_PREVIOUS) {
      await provider
        .create('Lg', RESOURCE_TYPE, { LogGroupName: PHYSICAL_ID, ...props })
        .catch((e: Error) => {
          threw = e;
        });
    } else {
      const prev = previous === ABSENT ? {} : { RetentionInDays: previous };
      await provider
        .update(
          'Lg',
          PHYSICAL_ID,
          RESOURCE_TYPE,
          props,
          prev,
          // `undefined` on the ordinary rows, so the flag's ABSENCE is what
          // most of the table runs under — a row cannot pass by a default the
          // production callers do not set.
          readback ? { desiredFromAwsReadback: true } : undefined
        )
        .catch((e: Error) => {
          threw = e;
        });
    }
    const puts = sentAll(PutRetentionPolicyCommand);
    const deletes = sentAll(DeleteRetentionPolicyCommand);
    // At most ONE retention command, always. Reading only the first would hide
    // a regression that issues a Put AND a Delete — `runRow` would report the
    // Put and the row would stay green with a stray delete on the wire.
    expect(
      puts.length + deletes.length,
      'more than one retention command went out for a single update'
    ).toBeLessThanOrEqual(1);
    if (threw) {
      // A row expecting a CALL must not be satisfied by an unrelated throw,
      // and a row expecting REFUSE must be satisfied only by THIS refusal.
      expect(threw.message, 'threw for a reason other than the retention guard').toMatch(
        REFUSAL_PREFIX
      );
      // Checked AFTER the sends are read, not instead of them: a refusal that
      // MUTATED first and then threw is the failure this whole PR is about,
      // and returning REFUSE on the throw alone would report it as clean.
      // Measured — moving the guard below the send block makes `-1` over `30`
      // issue DeleteRetentionPolicy and then throw.
      expect(
        puts.length + deletes.length,
        'the refusal fired only AFTER mutating the live retention'
      ).toBe(0);
      return REFUSE;
    }
    if (puts.length > 0) return PUT(puts[0].input.retentionInDays as number);
    if (deletes.length > 0) return DELETE;
    return NONE;
  };

  describe('the refusal SCOPE, as a table that runs', () => {
    // Floors first: a matrix that lost its rows, or that stopped covering an
    // outcome class, would let every assertion below pass vacuously. The
    // counts are LITERALS read off the arrays above, not derived from them.
    it('the matrices keep their per-class row COUNTS', () => {
      // COUNTS, not set membership. A set is blind to re-classification:
      // flipping one row's `expect` to make a regression green leaves every
      // class populated and the length unchanged, so the floor stays green —
      // which is exactly how somebody would neutralise this table. The
      // numbers below are LITERALS; a deliberate row change edits them and
      // the diff shows which class moved.
      //
      // `delete` is absent from the create side by construction: a create has
      // no live retention to remove, so a create row acquiring that class is
      // a defect rather than a new case.
      const tally = (rows: ReadonlyArray<{ readonly expect: RetentionOutcome }>) =>
        rows.reduce<Record<string, number>>(
          (acc, r) => ({ ...acc, [r.expect.call]: (acc[r.expect.call] ?? 0) + 1 }),
          {}
        );
      expect(tally(CREATE_MATRIX)).toEqual({ put: 4, none: 3, refuse: 18 });
      expect(tally(UPDATE_MATRIX)).toEqual({ none: 19, put: 7, delete: 7, refuse: 28 });
      expect(CREATE_MATRIX.length).toBe(25);
      expect(UPDATE_MATRIX.length).toBe(61);
    });

    // NOT `JSON.stringify`: it is the very non-injectivity these rows exist to
    // pin, so it printed the `Infinity` row as `null` — two different rows
    // would have shared a title, and a reader matching a failure to a row
    // would have been sent to the wrong one.
    const label = (v: unknown): string =>
      typeof v === 'number' || typeof v === 'symbol' ? String(v) : (JSON.stringify(v) ?? 'absent');

    it('keeps the rows that are the ONLY witness to a gate arm', () => {
      // The per-class counts freeze how MANY rows each outcome has; they say
      // nothing about WHICH. Measured: swapping the `Infinity over Infinity`
      // row for any other `none` row AND deleting the gate's `Object.is` arm
      // left all 69 tests green, because that row is the arm's only witness.
      // So the witnesses are named. Each pair below reds exactly one mutation
      // and nothing else does; losing the row loses the mutation silently.
      const has = (value: unknown, previous: unknown, readback = false): boolean =>
        UPDATE_MATRIX.some(
          (r) =>
            Object.is(r.value, value) &&
            Object.is(r.previous, previous) &&
            (r.readback === true) === readback
        );
      // The gate's `Object.is` arm: `Infinity` renders `'null'`, which the
      // stringify arm excludes, so reference identity is all that recognises
      // this pair as unchanged.
      expect(has(Infinity, Infinity), 'the Object.is arm lost its only witness').toBe(true);
      // The gate's `!== 'null'` exclusion.
      expect(has(Infinity, null), "the !== 'null' exclusion lost its only witness").toBe(true);
      // The non-finite refusal arm.
      expect(has(NaN, 30), 'the non-finite arm lost its only witness').toBe(true);
      // The `null` arm (issue #2699): refused where #2521 had it deleting.
      expect(has(null, 30), 'the null arm lost its only witness').toBe(true);
      // `isAbsentRetention`'s readback-only `0` arm, BOTH polarities: the same
      // pair must DELETE on a readback bag and REFUSE on a template bag, and
      // the string zero must stay refused on the readback bag — the three rows
      // that pin the arm to `desiredFromAwsReadback && raw === 0` exactly.
      expect(has(0, 30, true), 'the readback zero arm lost its delete witness').toBe(true);
      expect(has(0, 30), 'the readback zero arm lost its template-bag control').toBe(true);
      expect(has('0', 30, true), 'the readback zero arm lost its string-zero control').toBe(true);
      // The whitespace-only member of the absent family (issue #2699), and the
      // `previousRetentionUnknown` exclusion for it on the PREVIOUS side.
      expect(has('   ', 30), 'the whitespace-only absent witness was lost').toBe(true);
      expect(has(ABSENT, '   '), "that clause's whitespace-previous control was lost").toBe(true);
      // The stringify arm, which a bare `Object.is` would break.
      expect(
        UPDATE_MATRIX.some(
          (r) => Array.isArray(r.value) && Array.isArray(r.previous) && r.expect.call === 'none'
        ),
        'the stringify arm lost its unchanged-array witness'
      ).toBe(true);
      // The send gate's `previousRetentionUnknown` clause, and the negative
      // control that stops it being widened to every changed raw value.
      expect(has(ABSENT, 'abc'), 'previousRetentionUnknown lost its only witness').toBe(true);
      // `Boolean(rawPreviousRetention)`'s witness is `false` (the `''` row
      // beside it is also excluded by `isAbsentRetention` since #2699, so it
      // no longer pins the truthiness test on its own).
      expect(has(ABSENT, false), "that clause's falsy-previous control was lost").toBe(true);
      expect(has(ABSENT, ''), "the empty-string previous control was lost").toBe(true);
    });

    for (const row of CREATE_MATRIX) {
      it(`create: ${label(row.value)} -> ${row.expect.call} (was: ${row.before})`, async () => {
        expect(await runRow(row.value, ABSENT_PREVIOUS)).toEqual(row.expect);
      });
    }

    for (const row of UPDATE_MATRIX) {
      const bag = row.readback ? ' [readback]' : '';
      it(`update: ${label(row.value)} over ${label(row.previous)}${bag} -> ${row.expect.call} (was: ${row.before})`, async () => {
        expect(await runRow(row.value, row.previous, row.readback === true)).toEqual(row.expect);
      });
    }
  });

  describe('create', () => {
    it('sends a NUMBER for a stringly-typed retention', async () => {
      await provider.create('Lg', RESOURCE_TYPE, {
        LogGroupName: PHYSICAL_ID,
        RetentionInDays: '30',
      });

      const cmd = sent(PutRetentionPolicyCommand);
      expect(cmd).toBeDefined();
      // The DISCRIMINATOR is the TYPE, not the presence: the pre-fix code
      // reached this call too (a non-empty string is truthy) and put `'30'` on
      // the wire, so asserting only that a retention was applied passes
      // against the defect.
      expect(cmd.input.retentionInDays).toBe(30);
      expect(typeof cmd.input.retentionInDays).toBe('number');
    });

    it('still applies a numeric retention unchanged', async () => {
      await provider.create('Lg', RESOURCE_TYPE, {
        LogGroupName: PHYSICAL_ID,
        RetentionInDays: 14,
      });
      expect(sent(PutRetentionPolicyCommand).input.retentionInDays).toBe(14);
    });

    it('applies NO retention for the never-expire spellings', async () => {
      // Absent, `''` and a whitespace-only string are CloudFormation's
      // MEASURED spellings of no retention (issue #2699; `0` is not — the Logs
      // handler rejects it by enum, so it is refused below). The coercion must
      // not turn any of them into a `PutRetentionPolicy` — nor, since the
      // create path has no delete arm, into anything else.
      for (const properties of [
        { LogGroupName: PHYSICAL_ID },
        { LogGroupName: PHYSICAL_ID, RetentionInDays: '' },
        { LogGroupName: PHYSICAL_ID, RetentionInDays: '  ' },
      ]) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        await provider.create('Lg', RESOURCE_TYPE, properties);
        expect(sent(CreateLogGroupCommand)).toBeDefined();
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
      }
    });

    it('REFUSES a truthy non-number, and a NEGATIVE one, rather than sending it', async () => {
      // The first group is exactly the values the old truthiness test
      // forwarded to CloudWatch Logs, which rejected them. The refusal names
      // the property one layer earlier; it must not become a silent skip, or
      // a template typo would deploy a log group with no retention and no
      // complaint.
      //
      // The NEGATIVES are the review round's blocker. They COERCE, so a
      // refusal gated on coercibility alone waved them through; they then
      // fail the `> 0` send test and the create path silently applies no
      // retention at all (the update path's twin below is worse -- it
      // DELETES a live one).
      //
      // The third group is issue #2698's: spellings `Number()` reads and
      // CloudFormation rejects, which the old reader FORWARDED as numbers.
      for (const value of [
        'abc',
        true,
        [],
        {},
        -1,
        '-1',
        -30,
        NaN,
        Infinity,
        -Infinity,
        '0x1e',
        '1e3',
        '30.5',
        30.5,
      ]) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const err = await provider
          .create('Lg', RESOURCE_TYPE, { LogGroupName: PHYSICAL_ID, RetentionInDays: value })
          .catch((e: Error) => e);
        expect(err, `RetentionInDays: ${JSON.stringify(value)} must be refused`).toBeInstanceOf(
          Error
        );
        expect((err as Error).message).toMatch(REFUSAL_PREFIX);
        // ...and the ARM, not just the shared prefix. The refusal has five
        // branches with five `detail` strings; matching only the prefix leaves
        // them swappable, and a collapse to one string, with nothing red.
        expect((err as Error).message).toMatch(arm(value));
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
        // The refusal fires INSIDE the post-create try, so the log group it
        // just created must be retired rather than orphaned -- an orphan
        // fails the NEXT deploy with an already-exists cdkd never recorded.
        expect(
          sent(DeleteLogGroupCommand),
          `RetentionInDays: ${JSON.stringify(value)}: the partially-created log group was not cleaned up`
        ).toBeDefined();
      }
    });

    it('REFUSES zero in both spellings, and `false` / `null`, instead of skipping them (issue #2699)', async () => {
      // The boundary issue #2521 deliberately did NOT cross, and the live A/B
      // then settled: the Logs handler rejects `0` / `'0'` by enum and `false`
      // by type, and `update-stack` rejects `null` outright. Skipping them
      // deployed a log group with no retention on a template CloudFormation
      // refuses — the silent-drop shape this whole family exists to close.
      // Each lands in its own arm, and the create is retired like every other
      // refusal here.
      for (const value of [0, '0', false, null]) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const err = await provider
          .create('Lg', RESOURCE_TYPE, { LogGroupName: PHYSICAL_ID, RetentionInDays: value })
          .catch((e: Error) => e);
        expect(err, `RetentionInDays: ${JSON.stringify(value)} must be refused`).toBeInstanceOf(
          Error
        );
        expect((err as Error).message).toMatch(REFUSAL_PREFIX);
        expect((err as Error).message).toMatch(arm(value));
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
        expect(sent(DeleteLogGroupCommand)).toBeDefined();
      }
    });

    it('DOWNGRADES a refusal to a warn-and-skip on a state-record replay (rollback)', async () => {
      // `.claude/rules/provider-replay-and-refusals.md`: the rollback executor's
      // reverse-replacement arm re-creates the OLD log group from a state
      // record the user cannot edit from the template. A record can carry a
      // value this refusal rejects and the pre-#2699 create SKIPPED (the zero
      // family, `'abc'`), so a refusal there would leave the resource
      // unrestorable. For those the re-created group has no retention and
      // the warning says so. A spelling the pre-#2698 create FORWARDED is the
      // next case, not this one.
      for (const value of [0, '0', false, null, 'abc', '30.5']) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const result = await provider.create(
          'Lg',
          RESOURCE_TYPE,
          { LogGroupName: PHYSICAL_ID, RetentionInDays: value },
          { replayingState: true }
        );
        expect(result.physicalId).toBe(PHYSICAL_ID);
        expect(sent(CreateLogGroupCommand)).toBeDefined();
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
        expect(sent(DeleteLogGroupCommand)).toBeUndefined();
        // A skip is ANNOUNCED, never silent (`provider-property-fidelity.md`):
        // the warning carries the refusal's own arm, names the property and
        // the manual re-apply. A silent skip passed the three assertions
        // above unchanged (review probe), so the announcement is pinned here.
        const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
        expect(warnings, `RetentionInDays: ${JSON.stringify(value)} skipped silently`).toHaveLength(1);
        expect(warnings[0]).toMatch(REFUSAL_PREFIX);
        expect(warnings[0]).toMatch(arm(value));
        expect(warnings[0]).toContain('aws logs put-retention-policy');
      }
      // The control: a usable value on the same bag still issues its Put — and
      // announces nothing.
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      await provider.create(
        'Lg',
        RESOURCE_TYPE,
        { LogGroupName: PHYSICAL_ID, RetentionInDays: '30' },
        { replayingState: true }
      );
      expect(sent(PutRetentionPolicyCommand).input.retentionInDays).toBe(30);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('RESTORES on replay a spelling the record-writing cdkd forwarded as a positive integer (PR #3137 review)', async () => {
      // The binary that wrote the record read `RetentionInDays` with
      // `Number()`: `'30.0'` and `'0x1e'` went out as 30 and CloudWatch Logs
      // applied them. A rollback that re-created the old log group WITHOUT
      // that retention would silently drop a compliance bound the deploy had
      // set, so the replay forwards the same reading again and warns about
      // the spelling. Both sides are pinned: the Put carries the legacy
      // reading, and the warning names the restore rather than the skip.
      for (const [value, expected] of [
        ['30.0', 30],
        ['0x1e', 30],
        ['1e3', 1000],
      ] as const) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        await provider.create(
          'Lg',
          RESOURCE_TYPE,
          { LogGroupName: PHYSICAL_ID, RetentionInDays: value },
          { replayingState: true }
        );
        expect(
          sent(PutRetentionPolicyCommand)?.input.retentionInDays,
          `RetentionInDays: ${JSON.stringify(value)} must be restored on replay`
        ).toBe(expected);
        expect(sent(DeleteLogGroupCommand)).toBeUndefined();
        const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(REFUSAL_PREFIX);
        expect(warnings[0]).toContain(`RESTORED as ${expected} days`);
        expect(warnings[0]).not.toContain('SKIPPED');
      }
      // NEGATIVE CONTROL: the same spellings on a TEMPLATE bag (no replay
      // flag) are still refused — the restore is licensed by the flag alone.
      vi.clearAllMocks();
      mockSend.mockResolvedValue({});
      const err = await provider
        .create('Lg', RESOURCE_TYPE, { LogGroupName: PHYSICAL_ID, RetentionInDays: '30.0' })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
    });
  });

  describe('update', () => {
    it('issues NO call when the two sides differ only in SPELLING', async () => {
      // The import shape: `cdkd import --migrate-from-cloudformation` persists
      // the CFn template's `'30'`, and the next deploy's template says `30`.
      // Uncoerced those compare unequal, so every deploy re-issued the same
      // PutRetentionPolicy for a retention that had not changed.
      await provider.update(
        'Lg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { RetentionInDays: 30 },
        { RetentionInDays: '30' }
      );
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
      expect(sent(DeleteRetentionPolicyCommand)).toBeUndefined();
    });

    it('still applies a REAL change, as a number', async () => {
      // The negative control for the case above: coercing both sides must not
      // make every retention change compare equal.
      await provider.update(
        'Lg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { RetentionInDays: '90' },
        { RetentionInDays: 30 }
      );
      const cmd = sent(PutRetentionPolicyCommand);
      expect(cmd).toBeDefined();
      expect(cmd.input.retentionInDays).toBe(90);
    });

    it('removes the retention when the template drops it', async () => {
      await provider.update('Lg', PHYSICAL_ID, RESOURCE_TYPE, {}, { RetentionInDays: '30' });
      expect(sent(DeleteRetentionPolicyCommand)).toBeDefined();
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
    });

    it('REFUSES an unusable or NEGATIVE value instead of deleting the live retention', async () => {
      // The arm this refusal exists for, and the second half is the review
      // round's blocker. An unusable value coerces to `undefined`; a negative
      // one coerces to a number that fails the `> 0` send test. BOTH then
      // compare different from the recorded `30` and fall into the `else` —
      // issuing `DeleteRetentionPolicy` and silently REMOVING a retention the
      // template never asked to drop, where the pre-coercion code sent the
      // value and failed loudly at AWS.
      //
      // `false`, `null`, `0` and `'0'` joined the list with issue #2699 (the
      // measured falsy family CloudFormation rejects), and the `Number()`-only
      // spellings with #2698; a whitespace-only string LEFT it — CloudFormation
      // reads that as absent, so it takes the delete arm below.
      for (const value of [
        'abc',
        true,
        -1,
        '-1',
        NaN,
        Infinity,
        -Infinity,
        false,
        null,
        0,
        '0',
        '0x1e',
        '1e3',
        '30.5',
      ]) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const err = await provider
          .update(
            'Lg',
            PHYSICAL_ID,
            RESOURCE_TYPE,
            { RetentionInDays: value },
            { RetentionInDays: 30 }
          )
          .catch((e: Error) => e);
        expect(err, `RetentionInDays: ${JSON.stringify(value)} must be refused`).toBeInstanceOf(
          Error
        );
        expect((err as Error).message).toMatch(REFUSAL_PREFIX);
        expect((err as Error).message).toMatch(arm(value));
        expect(
          sent(DeleteRetentionPolicyCommand),
          `RetentionInDays: ${JSON.stringify(value)}: the live retention was removed instead of refused`
        ).toBeUndefined();
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
      }
    });

    it('issues NOTHING for an unusable value present IDENTICALLY in both bags', async () => {
      // The regression the review round caught in the first cut, which ran
      // the refusal ABOVE the change comparison. A
      // `cdkd import --migrate-from-cloudformation` record persists the
      // template's value without ever calling PutRetentionPolicy, so both
      // bags can hold the same unusable value — which the pre-coercion code
      // compared EQUAL and issued nothing for. Refusing there would have
      // failed an unrelated property change, and failed it AFTER the KMS
      // association above, leaving the update half-applied.
      //
      // A real KMS change is in the same call, so this also pins that the
      // update still RUNS: without it, a provider that threw before any send
      // would satisfy the two "no retention call" assertions vacuously.
      await provider.update(
        'Lg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { RetentionInDays: '  ', KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc' },
        { RetentionInDays: '  ' }
      );
      expect(sent(AssociateKmsKeyCommand)).toBeDefined();
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
      expect(sent(DeleteRetentionPolicyCommand)).toBeUndefined();
    });

    it('REFUSES an unusable value whose PREVIOUS side is absent or differently unusable', async () => {
      // The regression round 2 found INSIDE round 1's fix. Gating the refusal
      // on the COERCED comparison read these as UNCHANGED — `toFiniteNumber`
      // maps every unusable value AND an absent one to `undefined` — so the
      // refusal was skipped, no call went out, and the deploy succeeded green
      // with the property silently discarded while state recorded it. The gate
      // is on the RAW value now, so only a genuinely unchanged raw value is
      // exempt.
      //
      // `['  ', '']` was in this list until issue #2699: both are now the SAME
      // measured "absent" spelling, so that pair is a no-op, pinned in
      // `UPDATE_MATRIX` rather than here.
      for (const [value, previous] of [
        ['abc', undefined],
        ['abc', 'xyz'],
        ['0x1e', ''],
        [[], true],
      ] as Array<[unknown, unknown]>) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const err = await provider
          .update(
            'Lg',
            PHYSICAL_ID,
            RESOURCE_TYPE,
            { RetentionInDays: value },
            previous === undefined ? {} : { RetentionInDays: previous }
          )
          .catch((e: Error) => e);
        expect(
          err,
          `RetentionInDays ${JSON.stringify(value)} over ${JSON.stringify(previous)} must be refused, not silently dropped`
        ).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(REFUSAL_PREFIX);
      }
    });

    it('refuses BEFORE mutating anything else, so a rejected update leaves no half-applied change', async () => {
      // The refusal used to sit below the KMS block, so a throw landed with
      // `AssociateKmsKey` already sent and state unwritten. Asserting the
      // ABSENCE of that send is only meaningful because the sibling case
      // above proves this same KMS change DOES go out when the retention is
      // acceptable — without that pair, a provider that threw on entry would
      // satisfy this vacuously.
      const err = await provider
        .update(
          'Lg',
          PHYSICAL_ID,
          RESOURCE_TYPE,
          {
            RetentionInDays: 'abc',
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
          },
          {}
        )
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      // WHICH error: without this an unrelated earlier throw would satisfy the
      // absence assertions below and the ordering claim would be untested.
      expect((err as Error).message).toMatch(REFUSAL_PREFIX);
      expect(sent(AssociateKmsKeyCommand)).toBeUndefined();
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
      expect(sent(DeleteRetentionPolicyCommand)).toBeUndefined();
    });

    it('names the resourceType it was CALLED with, not a hardcoded one', async () => {
      // `applyUpdate` took a literal `'AWS::Logs::LogGroup'` until review;
      // every other case here passes exactly that string, so the threading is
      // invisible to them. A distinct value is the only thing that can tell
      // the parameter from the literal it replaced.
      const err = await provider
        .update('Lg', PHYSICAL_ID, 'AWS::Logs::NotReallyThisType', { RetentionInDays: 'abc' }, {})
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Lg (AWS::Logs::NotReallyThisType)');
    });

    it('deletes a console-added retention on `drift --revert` (readback `0` over live `30`)', async () => {
      // The one bag on which numeric `0` is NOT a template's rejected zero:
      // `readCurrentState` records `0` for a never-expiring log group, that is
      // the observed baseline, and `cdkd drift --revert` hands it back as the
      // DESIRED bag with `desiredFromAwsReadback` set. Reverting a
      // console-added retention is therefore exactly this call, and it must
      // reach the delete arm — refusing it would leave `--revert` unable to
      // undo the drift it just reported.
      await provider.update(
        'Lg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { RetentionInDays: 0 },
        { RetentionInDays: 30 },
        { desiredFromAwsReadback: true }
      );
      expect(sent(DeleteRetentionPolicyCommand)).toBeDefined();
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
    });

    it('REFUSES the same `0` over `30` on a template bag (the readback flag is the whole difference)', async () => {
      // The control for the case above, and the fence on the flag: the pair is
      // byte-identical, only the context differs, so a provider that stopped
      // reading `desiredFromAwsReadback` — or read it as "any context" — goes
      // red on one of the two.
      for (const context of [undefined, {}, { desiredFromAwsReadback: false }]) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const err = await provider
          .update(
            'Lg',
            PHYSICAL_ID,
            RESOURCE_TYPE,
            { RetentionInDays: 0 },
            { RetentionInDays: 30 },
            context
          )
          .catch((e: Error) => e);
        expect(err, `context ${JSON.stringify(context)} must refuse`).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(REFUSAL_PREFIX);
        expect((err as Error).message).toMatch(/declares zero/);
        expect(sent(DeleteRetentionPolicyCommand)).toBeUndefined();
      }
    });

    it('issues NO call for a padded or signed spelling of the recorded retention (#2698)', async () => {
      // `' 30 '` and `'+30'` are measured-accepted CloudFormation spellings of
      // 30. Read through `toCfnInteger` they compare EQUAL to the recorded 30,
      // so no redundant Put goes out — and the same reader rejects `'0x1e'`,
      // which `Number()` would also have read as 30 and then compared equal,
      // silently accepting a template CloudFormation refuses.
      for (const value of [' 30 ', '+30']) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        await provider.update(
          'Lg',
          PHYSICAL_ID,
          RESOURCE_TYPE,
          { RetentionInDays: value },
          { RetentionInDays: 30 }
        );
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
        expect(sent(DeleteRetentionPolicyCommand)).toBeUndefined();
      }
      const err = await provider
        .update('Lg', PHYSICAL_ID, RESOURCE_TYPE, { RetentionInDays: '0x1e' }, { RetentionInDays: 30 })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/a string that is not a CloudFormation Integer/);
    });
  });
});
