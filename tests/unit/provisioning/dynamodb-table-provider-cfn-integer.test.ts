import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const KEY_SCHEMA = [{ AttributeName: 'id', KeyType: 'HASH' }];
const ATTRIBUTE_DEFINITIONS = [{ AttributeName: 'id', AttributeType: 'S' }];

/**
 * `AWS::DynamoDB::Table`'s Integer forwarders, issue
 * [#3147](https://github.com/go-to-k/cdkd/issues/3147).
 *
 * Issue [#3135] moved every `toFiniteNumber`-reading DynamoDB forwarder onto
 * `coerceCfnInteger` — CloudFormation's MEASURED DynamoDB Integer grammar,
 * `/^[+-]?\d+$/` with NO trim. The sweep that produced its list grepped
 * `toFiniteNumber`, and this provider's capacity reads never appeared on it:
 * they went through a bare `Number()`, which is WIDER still. This file is the
 * table for what each spelling now does at each of the FIVE sites, driven
 * through the real `create()` / `update()` rather than through the helpers, so
 * a site that stops calling the shared reader reds a row rather than passing on
 * a helper nothing wires.
 *
 * The spellings and their CloudFormation verdicts are the live A/B on issue
 * #3135 (us-east-1, 2026-09-14; the table is on `toCfnInteger` in
 * `src/provisioning/dynamodb-warm-throughput.ts`). Every REJECTED row is a
 * template CloudFormation refuses at properties validation or at the DynamoDB
 * handler — cdkd deployed each of them, at `Number()`'s reading.
 */
function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

/** Every warning this run emitted, joined — the assertions match substrings. */
function warnings(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

/**
 * Answer every command generically instead of priming a `*Once` queue: these
 * tests drive whole `create()` / `update()` flows whose call SEQUENCE is not
 * what they are about, and an over-primed queue leaks into the next test (the
 * `once-leak-detect` class).
 */
function primeGeneric(live?: { billingMode?: string; indexes?: unknown[] }): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          ...(live?.billingMode !== undefined && {
            BillingModeSummary: { BillingMode: live.billingMode },
          }),
          ...(live?.indexes !== undefined &&
            live.indexes.length > 0 && { GlobalSecondaryIndexes: live.indexes }),
        },
      });
    }
    return Promise.resolve({});
  });
}

const LIVE_GSI = (name: string) => ({
  IndexName: name,
  IndexStatus: 'ACTIVE',
  ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
});

const cfnGsi = (name: string, read: unknown, write: unknown) => ({
  IndexName: name,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
});

/** A value the test table declares no member for, distinct from `null`. */
const ABSENT = Symbol('absent');

/**
 * One row per template spelling, for the TABLE-level `ProvisionedThroughput`
 * members. `sent` is what must reach the wire — `undefined` meaning the member
 * is OMITTED, so DynamoDB rejects the request naming it, which is the arm this
 * type already takes for an absent required member.
 *
 * `before` is what the pre-#3147 `Number(pt[member] ?? 5)` put on the wire, so a
 * row also records what the fix changed.
 */
const TABLE_CAPACITY_MATRIX: ReadonlyArray<{
  readonly value: unknown;
  readonly sent: number | undefined;
  readonly warned: boolean;
  readonly before: string;
}> = [
  // --- CloudFormation ACCEPTS: unchanged behaviour ------------------------
  { value: 5, sent: 5, warned: false, before: '5' },
  { value: '6', sent: 6, warned: false, before: '6' },
  { value: '+8', sent: 8, warned: false, before: '8' },
  // Decimal, not octal — CloudFormation reads `"010"` as 10 and so does this.
  { value: '010', sent: 10, warned: false, before: '10' },
  // --- ABSENT: still the silent 5 default, which is why `??` is preserved --
  { value: ABSENT, sent: 5, warned: false, before: '5 (the ?? default)' },
  // `null` is nullish, so `??` took the default for it too; that is kept so
  // this reader and `hasUsableTableCapacity` agree about it (they did NOT
  // before #3147 — see the mirror tests below).
  { value: null, sent: 5, warned: false, before: '5 (the ?? default)' },
  // --- CloudFormation REJECTS at properties validation --------------------
  { value: ' 7 ', sent: undefined, warned: true, before: '7' },
  { value: '7 ', sent: undefined, warned: true, before: '7' },
  // `Number('')` is 0, not the `?? 5` default — `''` is not nullish. AWS
  // rejected the 0 by name, which is loud, but it is not CloudFormation's
  // refusal of the template.
  { value: '', sent: undefined, warned: true, before: '0' },
  // --- CloudFormation REJECTS at the handler ------------------------------
  { value: '0x9', sent: undefined, warned: true, before: '9' },
  { value: '1e1', sent: undefined, warned: true, before: '10' },
  { value: '6.0', sent: undefined, warned: true, before: '6' },
  { value: '6.5', sent: undefined, warned: true, before: '6.5' },
  // --- not a number in any spelling ---------------------------------------
  { value: 'abc', sent: undefined, warned: true, before: 'NaN' },
  { value: true, sent: undefined, warned: true, before: '1' },
  { value: [], sent: undefined, warned: true, before: '0' },
  { value: {}, sent: undefined, warned: true, before: 'NaN' },
  // An unresolved intrinsic, the shape the diagnostics exist for.
  { value: { Ref: 'Unset' }, sent: undefined, warned: true, before: 'NaN' },
  // A non-integer NUMBER: the grammar is Integer, not "numeric".
  { value: 6.5, sent: undefined, warned: true, before: '6.5' },
];

describe('AWS::DynamoDB::Table Integer forwarders read CloudFormation grammar (#3147)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    // `mockReset` rather than only `clearAllMocks`, per this directory's rule:
    // the latter leaves a `*Once` queue intact across tests.
    mockSend.mockReset();
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new DynamoDBTableProvider();
  });

  const label = (v: unknown): string =>
    typeof v === 'number' || typeof v === 'symbol' ? String(v) : (JSON.stringify(v) ?? 'absent');

  describe('the table-level ProvisionedThroughput matrix', () => {
    // A floor first: the matrix is what every row below reads, so a matrix that
    // lost its rejected rows would leave the table green and inert. Counts are
    // LITERALS, and they are taken per OUTCOME so a re-classified row (the
    // cheapest way to neutralise this table) moves a number.
    it('keeps its per-outcome row counts', () => {
      const dropped = TABLE_CAPACITY_MATRIX.filter((r) => r.sent === undefined);
      const forwarded = TABLE_CAPACITY_MATRIX.filter((r) => r.sent !== undefined);
      expect(TABLE_CAPACITY_MATRIX.length).toBe(19);
      expect(dropped.length).toBe(13);
      expect(forwarded.length).toBe(6);
      // Every dropped row warns and no forwarded row does: the announcement is
      // the whole licence for dropping, so the two must not come apart.
      expect(dropped.every((r) => r.warned)).toBe(true);
      expect(forwarded.every((r) => !r.warned)).toBe(true);
      // The two ABSENT spellings take the default SILENTLY — the row that stops
      // the fix from being widened into "warn about every template".
      expect(TABLE_CAPACITY_MATRIX.filter((r) => r.sent === 5 && !r.warned).length).toBe(3);
    });

    for (const row of TABLE_CAPACITY_MATRIX) {
      it(`create: ReadCapacityUnits ${label(row.value)} -> ${String(row.sent)} (was: ${row.before})`, async () => {
        primeGeneric();
        await provider.create('L', RESOURCE_TYPE, {
          TableName: TABLE_NAME,
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: {
            ...(row.value === ABSENT ? {} : { ReadCapacityUnits: row.value }),
            WriteCapacityUnits: 5,
          },
        });

        const create = findCalls(CreateTableCommand)[0];
        expect(create?.input.ProvisionedThroughput?.ReadCapacityUnits).toBe(row.sent);
        // The WRITE member is the control in every row: a change that dropped
        // BOTH members (or defaulted both) would otherwise look identical.
        expect(create?.input.ProvisionedThroughput?.WriteCapacityUnits).toBe(5);
        expect(warnings().includes('ProvisionedThroughput.ReadCapacityUnits')).toBe(row.warned);
      });

      it(`flip: ReadCapacityUnits ${label(row.value)} -> ${String(row.sent)} (was: ${row.before})`, async () => {
        // The SECOND forwarder, wired independently of `create()`'s: probing
        // one says nothing about the other, and they were two separate
        // `Number(... ?? 5)` spellings before this change.
        primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
        await provider.update(
          'L',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            TableName: TABLE_NAME,
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: {
              ...(row.value === ABSENT ? {} : { ReadCapacityUnits: row.value }),
              WriteCapacityUnits: 5,
            },
          },
          { TableName: TABLE_NAME, BillingMode: 'PAY_PER_REQUEST' }
        );

        const flip = findCalls(UpdateTableCommand).find((c) => c.input.BillingMode !== undefined);
        expect(flip?.input.ProvisionedThroughput?.ReadCapacityUnits).toBe(row.sent);
        expect(flip?.input.ProvisionedThroughput?.WriteCapacityUnits).toBe(5);
        expect(warnings().includes('ProvisionedThroughput.ReadCapacityUnits')).toBe(row.warned);
      });
    }

    it('names the WRITE member when that is the one that is unusable', async () => {
      // The `member` argument is threaded, not hardcoded: with one literal the
      // warning would name Read for a Write-side defect and send the user to
      // the wrong line of their template.
      primeGeneric();
      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: '0x9' },
      });

      expect(warnings()).toContain('ProvisionedThroughput.WriteCapacityUnits');
      expect(warnings()).not.toContain('ProvisionedThroughput.ReadCapacityUnits');
      const create = findCalls(CreateTableCommand)[0];
      expect(create?.input.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 5,
        WriteCapacityUnits: undefined,
      });
    });

    it('says NO capacity was substituted, since a fallback would be invisible afterwards', async () => {
      // The GlobalTable sibling announces a 5/5 FALLBACK; this type omits. The
      // sentence is what tells the two apart for a user reading one log, so it
      // is pinned rather than left to the wording of the day.
      primeGeneric();
      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: ' 7 ', WriteCapacityUnits: 5 },
      });

      expect(warnings()).toContain('NO capacity was substituted');
      expect(warnings()).toContain('decimal digits');
    });
  });

  describe('PointInTimeRecoverySpecification.RecoveryPeriodInDays', () => {
    // The fifth site, found by the parent review round on PR #3148. It carries
    // no `?? default`, so the announced arm is the DROP an absent member takes.
    const rows: ReadonlyArray<{ value: unknown; sent: number | undefined; before: string }> = [
      { value: 7, sent: 7, before: '7' },
      { value: '7', sent: 7, before: '7' },
      // ACCEPTED-spelling controls (PR #3246 review, gap 2): without these the
      // grammar is fenced in the rejecting direction only, so a reader
      // narrowed to `/^\d+$/` here would red nothing.
      { value: '+8', sent: 8, before: '8' },
      { value: '010', sent: 10, before: '10' },
      { value: ' 7 ', sent: undefined, before: '7' },
      { value: '0x9', sent: undefined, before: '9' },
      { value: '1e1', sent: undefined, before: '10' },
      { value: 'abc', sent: undefined, before: 'NaN' },
      { value: { Ref: 'Unset' }, sent: undefined, before: 'NaN' },
    ];

    for (const row of rows) {
      it(`create: ${label(row.value)} -> ${String(row.sent)} (was: ${row.before})`, async () => {
        primeGeneric();
        await provider.create('L', RESOURCE_TYPE, {
          TableName: TABLE_NAME,
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PAY_PER_REQUEST',
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
            RecoveryPeriodInDays: row.value,
          },
        });

        const backups = findCalls(UpdateContinuousBackupsCommand)[0];
        // PITR is still ENABLED in every row — the drop is of the period, not
        // of the feature, and a change that skipped the whole call would
        // otherwise read as a pass.
        expect(backups?.input.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled).toBe(
          true
        );
        expect(backups?.input.PointInTimeRecoverySpecification?.RecoveryPeriodInDays).toBe(
          row.sent
        );
        expect(warnings().includes('RecoveryPeriodInDays')).toBe(row.sent === undefined);
      });
    }

    it('drops the period on the UPDATE path too, and warns rather than throwing', async () => {
      // The update path is replay-reachable (the rollback executor's revert
      // arms, `drift --revert`), so the answer here must be a warning: a
      // refusal would leave the table un-rollbackable with no template-side
      // remedy.
      primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
            RecoveryPeriodInDays: '1e1',
          },
        },
        { TableName: TABLE_NAME, BillingMode: 'PAY_PER_REQUEST' }
      );

      const backups = findCalls(UpdateContinuousBackupsCommand)[0];
      expect(backups?.input.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
      expect(warnings()).toContain('RecoveryPeriodInDays');
    });
  });

  describe('the per-index forwarder and the two MIRROR predicates', () => {
    /**
     * Drive a flip to PROVISIONED against a live table, returning what went out.
     * `desiredIndexes` / `previousIndexes` decide which of the three sites the
     * case exercises.
     */
    const runFlip = async (
      tableCapacity: Record<string, unknown>,
      liveIndexes: string[],
      desiredIndexes: unknown[],
      previousIndexes: unknown[]
    ): Promise<UpdateTableCommand[]> => {
      primeGeneric({ billingMode: 'PAY_PER_REQUEST', indexes: liveIndexes.map(LIVE_GSI) });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: tableCapacity,
          GlobalSecondaryIndexes: desiredIndexes,
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: previousIndexes,
        }
      );
      return findCalls(UpdateTableCommand);
    };

    const USABLE = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };

    /**
     * Did the PRE-FLIP removal run — i.e. is there a `Delete` for `name`
     * BEFORE the UpdateTable carrying the BillingMode?
     *
     * ORDER is the discriminator, and asserting "no Delete anywhere" is not:
     * a removed index is deleted by `applyGsiUpdates` AFTER the flip either
     * way, so a presence test is TRUE in both arms and every refusal case
     * below would have read as a pass. What the look-ahead decides is whether
     * a destructive Delete runs AHEAD of a flip AWS is certain to reject.
     */
    const preFlipDeleted = (calls: UpdateTableCommand[], name: string): boolean => {
      const flipAt = calls.findIndex((c) => c.input.BillingMode !== undefined);
      const deleteAt = calls.findIndex((c) =>
        (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Delete?.IndexName === name)
      );
      return deleteAt >= 0 && (flipAt < 0 || deleteAt < flipAt);
    };

    it('omits an index whose declared capacity CloudFormation rejects, and names it', async () => {
      const calls = await runFlip(USABLE, ['gsi1'], [cfnGsi('gsi1', ' 7 ', 3)], [cfnGsi('gsi1', 3, 3)]);
      const flip = calls.find((c) => c.input.BillingMode !== undefined);
      expect(flip?.input.GlobalSecondaryIndexUpdates).toBeUndefined();
      expect(warnings()).toContain('gsi1');
      expect(warnings()).toContain('no usable ProvisionedThroughput');
    });

    it('forwards the SIGNED and LEADING-ZERO index spellings the grammar accepts', async () => {
      // ACCEPTED-spelling control (PR #3246 review, gap 2): every other
      // per-index row asserts a REJECTION, so a reader narrowed to `/^\d+$/`
      // would red nothing. `'+8'` and `'010'` are exactly what such a
      // narrowing drops and what the measured CloudFormation grammar keeps
      // (`"010"` is decimal 10, not octal).
      const calls = await runFlip(
        USABLE,
        ['gsi1'],
        [cfnGsi('gsi1', '+8', '010')],
        [cfnGsi('gsi1', 3, 3)]
      );
      const flip = calls.find((c) => c.input.BillingMode !== undefined);
      expect(flip?.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 8,
        WriteCapacityUnits: 10,
      });
    });

    it('still forwards an index whose capacity is a legal numeric STRING', async () => {
      // The negative control: the grammar accepts a quoted decimal, so
      // tightening the reader must not retract stringly-typed CFn support.
      const calls = await runFlip(USABLE, ['gsi1'], [cfnGsi('gsi1', '7', '3')], [cfnGsi('gsi1', 3, 3)]);
      const flip = calls.find((c) => c.input.BillingMode !== undefined);
      expect(flip?.input.GlobalSecondaryIndexUpdates).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 },
          },
        },
      ]);
    });

    it('refuses the pre-flip REMOVAL when a REMAINING index reads unusable (hasUsableDeclaredCapacity)', async () => {
      // The mirror moves with `readCapacityNumber` because it CALLS it: with
      // the two on different readers, `" 7 "` counted as declared here while
      // the forwarder dropped it, so the destructive pre-flip delete ran ahead
      // of a flip AWS was certain to reject.
      const calls = await runFlip(
        USABLE,
        ['gsi1', 'gsi2'],
        [cfnGsi('gsi2', ' 7 ', 3)],
        [cfnGsi('gsi1', 3, 3), cfnGsi('gsi2', 3, 3)]
      );
      expect(preFlipDeleted(calls, 'gsi1')).toBe(false);
      expect(warnings()).toContain('Nothing was removed');
      expect(warnings()).toContain('stay live and declare no usable');
    });

    it('RUNS the pre-flip removal when the remaining index reads usable', async () => {
      const calls = await runFlip(
        USABLE,
        ['gsi1', 'gsi2'],
        [cfnGsi('gsi2', 7, 3)],
        [cfnGsi('gsi1', 3, 3), cfnGsi('gsi2', 3, 3)]
      );
      expect(preFlipDeleted(calls, 'gsi1')).toBe(true);
    });

    it('refuses the pre-flip REMOVAL when the TABLE capacity reads unusable (hasUsableTableCapacity)', async () => {
      const calls = await runFlip(
        { ReadCapacityUnits: ' 7 ', WriteCapacityUnits: 5 },
        ['gsi1'],
        [],
        [cfnGsi('gsi1', 3, 3)]
      );
      expect(preFlipDeleted(calls, 'gsi1')).toBe(false);
      expect(warnings()).toContain('no usable table-level ProvisionedThroughput');
    });

    it('treats a DECLARED null table capacity as absent, agreeing with the forwarder', async () => {
      // The latent divergence #3147 closed in the OTHER direction: `Number(null)`
      // is 0, so this predicate called a `null` member unusable and refused the
      // removal while the forwarder's `?? 5` sent 5 and AWS accepted the flip —
      // a warning claiming "AWS rejects the flip either way" over a flip that
      // succeeds. Both now take the default.
      const calls = await runFlip(
        { ReadCapacityUnits: null, WriteCapacityUnits: 5 },
        ['gsi1'],
        [],
        [cfnGsi('gsi1', 3, 3)]
      );
      expect(preFlipDeleted(calls, 'gsi1')).toBe(true);
      expect(warnings()).not.toContain('no usable table-level ProvisionedThroughput');
      const flip = calls.find((c) => c.input.BillingMode !== undefined);
      expect(flip?.input.ProvisionedThroughput?.ReadCapacityUnits).toBe(5);
    });

    it('keeps a DECLARED sub-1 table capacity unusable, which the forwarder still sends', async () => {
      // The `< 1` half of the mirror, which the forwarder deliberately does NOT
      // share: `0` is a legal CFn Integer, so it goes on the wire and AWS
      // rejects it — while this predicate must still refuse to delete an index
      // ahead of that certain rejection.
      const calls = await runFlip(
        { ReadCapacityUnits: 0, WriteCapacityUnits: 5 },
        ['gsi1'],
        [],
        [cfnGsi('gsi1', 3, 3)]
      );
      expect(preFlipDeleted(calls, 'gsi1')).toBe(false);
      expect(warnings()).toContain('no usable table-level ProvisionedThroughput');
      const flip = calls.find((c) => c.input.BillingMode !== undefined);
      expect(flip?.input.ProvisionedThroughput?.ReadCapacityUnits).toBe(0);
    });
  });
});
