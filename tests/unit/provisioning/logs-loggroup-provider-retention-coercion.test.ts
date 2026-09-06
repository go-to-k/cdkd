/**
 * `AWS::Logs::LogGroup` `RetentionInDays` coercion (issue #2521).
 *
 * CloudFormation is stringly typed and coerces `RetentionInDays: '30'` to the
 * number its schema declares. The AWS SDK does not — it serializes whatever it
 * is handed — so the provider used to put a JSON STRING on the wire, and its
 * update-side comparison read the state record's `'30'` as different from the
 * template's `30` and re-issued a `PutRetentionPolicy` on every deploy.
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

const mockSend = vi.fn();

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
    warn: vi.fn(),
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
 * WHICH refusal arm a value must land in. The three arms carry three distinct
 * `detail` strings, and matching only their shared prefix leaves all three
 * collapsible into one with nothing red — the failure this selector exists to
 * stop, and the one the non-finite arm shipped with until it was measured.
 */
const arm = (value: unknown): RegExp => {
  if (typeof value === 'number' && !Number.isFinite(value)) return /declares a non-finite number/;
  if (typeof value === 'number' || value === '-1') return /declares a negative number/;
  return /does not parse as a finite number/;
};

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
  { value: 0, expect: NONE, before: 'no call (falsy)' },
  { value: '0', expect: NONE, before: "Put('0') -> AWS rejects" },
  { value: '', expect: NONE, before: 'no call (falsy)' },
  { value: false, expect: NONE, before: 'no call (falsy)' },
  { value: ABSENT, expect: NONE, before: 'no call (absent)' },
  { value: 'abc', expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: '   ', expect: REFUSE, before: "Put('   ') -> AWS rejects" },
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
  // Falsy and NOT refused: `null` is how a template spells absent, and absent
  // is CloudWatch Logs' never-expire.
  { value: null, expect: NONE, before: 'no call (falsy)' },
];

/**
 * The update path, where the PREVIOUS side decides as much as the value does.
 * Its spelling is load-bearing and the rows say so: `-1` over `-1` is an
 * unchanged import record and passes, while `-1` over `'-1'` is a change and
 * is refused.
 */
const UPDATE_MATRIX: ReadonlyArray<{
  readonly value: unknown;
  readonly previous: unknown;
  readonly expect: RetentionOutcome;
  readonly before: string;
}> = [
  // --- no real change -----------------------------------------------------
  { value: 30, previous: 30, expect: NONE, before: 'no call' },
  { value: '30', previous: 30, expect: NONE, before: "Put('30') -> AWS rejects" },
  { value: 30, previous: '30', expect: NONE, before: 'Put(30) for a retention that had not changed' },
  { value: '30', previous: '30', expect: NONE, before: 'no call' },
  { value: '0', previous: 0, expect: NONE, before: "Put('0') -> AWS rejects" },
  // --- a real retention change -------------------------------------------
  { value: 90, previous: 30, expect: PUT(90), before: 'Put(90)' },
  { value: '90', previous: 30, expect: PUT(90), before: "Put('90') -> AWS rejects" },
  { value: 30, previous: ABSENT, expect: PUT(30), before: 'Put(30)' },
  { value: 30, previous: 'abc', expect: PUT(30), before: 'Put(30)' },
  { value: 30, previous: false, expect: PUT(30), before: 'Put(30)' },
  // --- never-expire: the delete arm --------------------------------------
  { value: ABSENT, previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: 0, previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: '', previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: false, previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: 0, previous: 'abc', expect: DELETE, before: 'DeleteRetentionPolicy' },
  // The one row that is a deliberate BEHAVIOUR CHANGE on this path.
  { value: '0', previous: 30, expect: DELETE, before: "Put('0') -> AWS rejects" },
  // --- refused ------------------------------------------------------------
  { value: 'abc', previous: 30, expect: REFUSE, before: "Put('abc') -> AWS rejects" },
  { value: '   ', previous: 30, expect: REFUSE, before: "Put('   ') -> AWS rejects" },
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
  // Falsy non-finite and falsy null, over a live retention. `NaN` is REFUSED
  // (round 4) while `null` still DELETES, and the pair is here so the two are
  // pinned apart rather than argued apart.
  { value: NaN, previous: 30, expect: REFUSE, before: 'DeleteRetentionPolicy' },
  { value: null, previous: 30, expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: -Infinity, previous: 30, expect: REFUSE, before: 'Put(-Infinity) -> AWS rejects' },
  // --- the previous side is PRESENT but UNUSABLE ---------------------------
  // Both sides coerce to `undefined`, so the coerced gate alone issues
  // NOTHING and cdkd records absence while AWS may still hold a retention.
  // `previousRetentionUnknown` is what keeps these on the pre-#2521 answer.
  // Reachable through an imported record, which persists the template value
  // without ever having called PutRetentionPolicy.
  { value: ABSENT, previous: 'abc', expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: '', previous: [], expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: false, previous: 'abc', expect: DELETE, before: 'DeleteRetentionPolicy' },
  { value: null, previous: '   ', expect: DELETE, before: 'DeleteRetentionPolicy' },
  // The NEGATIVE control for that clause, and the one call this change still
  // drops on purpose: a FALSY previous is not unknown. Every falsy value was
  // skipped by the pre-coercion truthiness test too, so no Put was ever issued
  // for it and AWS provably holds no retention — the pre-#2521 Delete was
  // redundant. Without this row the clause could be widened to every
  // `!sameRawRetention` with nothing red.
  { value: ABSENT, previous: '', expect: NONE, before: 'DeleteRetentionPolicy (redundant)' },
  { value: ABSENT, previous: false, expect: NONE, before: 'DeleteRetentionPolicy (redundant)' },
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
    previous: unknown | typeof ABSENT
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
        .update('Lg', PHYSICAL_ID, RESOURCE_TYPE, props, prev)
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
        /RetentionInDays must be a non-negative number/
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
      expect(tally(CREATE_MATRIX)).toEqual({ put: 2, none: 6, refuse: 10 });
      expect(tally(UPDATE_MATRIX)).toEqual({ none: 13, put: 5, delete: 11, refuse: 13 });
      expect(CREATE_MATRIX.length).toBe(18);
      expect(UPDATE_MATRIX.length).toBe(42);
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
      const has = (value: unknown, previous: unknown): boolean =>
        UPDATE_MATRIX.some((r) => Object.is(r.value, value) && Object.is(r.previous, previous));
      // The gate's `Object.is` arm: `Infinity` renders `'null'`, which the
      // stringify arm excludes, so reference identity is all that recognises
      // this pair as unchanged.
      expect(has(Infinity, Infinity), 'the Object.is arm lost its only witness').toBe(true);
      // The gate's `!== 'null'` exclusion.
      expect(has(Infinity, null), "the !== 'null' exclusion lost its only witness").toBe(true);
      // The non-finite refusal arm, and the deliberate exclusion of `null`
      // from it — one row each, and they must disagree.
      expect(has(NaN, 30), 'the non-finite arm lost its only witness').toBe(true);
      expect(has(null, 30), "null's exclusion from that arm lost its only witness").toBe(true);
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
      expect(has(ABSENT, ''), "that clause's falsy-previous control was lost").toBe(true);
    });

    for (const row of CREATE_MATRIX) {
      it(`create: ${label(row.value)} -> ${row.expect.call} (was: ${row.before})`, async () => {
        expect(await runRow(row.value, ABSENT_PREVIOUS)).toEqual(row.expect);
      });
    }

    for (const row of UPDATE_MATRIX) {
      it(`update: ${label(row.value)} over ${label(row.previous)} -> ${row.expect.call} (was: ${row.before})`, async () => {
        expect(await runRow(row.value, row.previous)).toEqual(row.expect);
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
      // Absent and `0` are CloudWatch Logs' never-expire, and the pre-coercion
      // truthiness test skipped both. The coercion must not turn either into a
      // `PutRetentionPolicy` — nor, since the create path has no delete arm,
      // into anything else.
      for (const properties of [
        { LogGroupName: PHYSICAL_ID },
        { LogGroupName: PHYSICAL_ID, RetentionInDays: 0 },
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
      for (const value of ['   ', 'abc', true, [], {}, -1, '-1', -30, NaN, Infinity, -Infinity]) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        const err = await provider
          .create('Lg', RESOURCE_TYPE, { LogGroupName: PHYSICAL_ID, RetentionInDays: value })
          .catch((e: Error) => e);
        expect(err, `RetentionInDays: ${JSON.stringify(value)} must be refused`).toBeInstanceOf(
          Error
        );
        expect((err as Error).message).toMatch(/RetentionInDays must be a non-negative number/);
        // ...and the ARM, not just the shared prefix. The refusal has two
        // branches with two `detail` strings; matching only the prefix leaves
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

    it('treats a STRING zero the way it treats a numeric zero — never-expire, no call', async () => {
      // The boundary the refusal deliberately does NOT cross. `0` is what
      // `readCurrentState` records for a group with no retention policy, so
      // cdkd already spells never-expire that way, and the pre-coercion
      // truthiness test skipped a numeric `0` too. `'0'` is TRUTHY raw, so it
      // reaches the refusal and must pass through it.
      for (const value of [0, '0']) {
        vi.clearAllMocks();
        mockSend.mockResolvedValue({});
        await provider.create('Lg', RESOURCE_TYPE, {
          LogGroupName: PHYSICAL_ID,
          RetentionInDays: value,
        });
        expect(sent(CreateLogGroupCommand)).toBeDefined();
        expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
        expect(sent(DeleteLogGroupCommand)).toBeUndefined();
      }
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
      for (const value of ['abc', '   ', true, -1, '-1', NaN, Infinity, -Infinity]) {
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
        expect((err as Error).message).toMatch(/RetentionInDays must be a non-negative number/);
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
      for (const [value, previous] of [
        ['abc', undefined],
        ['abc', 'xyz'],
        ['  ', ''],
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
        expect((err as Error).message).toMatch(/RetentionInDays must be a non-negative number/);
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
      expect((err as Error).message).toMatch(/RetentionInDays must be a non-negative number/);
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

    it('treats a STRING zero as never-expire, matching the numeric zero it compares against', async () => {
      // `'0'` is truthy raw, so it reaches the refusal and must pass through
      // it, and it must then compare EQUAL to a recorded numeric `0` — which
      // is what `readCurrentState` writes for a never-expiring group, so this
      // is the ordinary redeploy of such a record rather than a corner.
      await provider.update(
        'Lg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { RetentionInDays: '0' },
        { RetentionInDays: 0 }
      );
      expect(sent(PutRetentionPolicyCommand)).toBeUndefined();
      expect(sent(DeleteRetentionPolicyCommand)).toBeUndefined();
    });
  });
});
