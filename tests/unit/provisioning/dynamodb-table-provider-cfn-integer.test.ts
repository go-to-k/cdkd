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
 * table for what each spelling now does at each forwarder, driven
 * through the real `create()` / `update()` rather than through the helpers, so
 * a site that stops calling the shared reader reds a row rather than passing on
 * a helper nothing wires. The per-SITE counts are asserted in the blocks
 * below rather than stated here, so a site added or removed moves an assertion
 * instead of a sentence — `OnDemandThroughput` went from four sites to six
 * when issue [#3287](https://github.com/go-to-k/cdkd/issues/3287) wired the two
 * `UpdateGlobalSecondaryIndexAction` arms that had never set it.
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

  describe('the per-GSI ProvisionedThroughput on the CREATE path (#3255)', () => {
    /**
     * The SIXTH send site of a DynamoDB capacity value, and the one neither
     * issue #3147's enumeration nor its PR's sweep could see, because
     * `create()` reaches it through a CAST rather than a call. Until this fix
     * the whole `GlobalSecondaryIndexes` array was forwarded verbatim except
     * for each entry's `WarmThroughput`, so a CFn-legal `ReadCapacityUnits:
     * '7'` reached `CreateTable` as a STRING in a `number` field, and a `' 7 '`
     * CloudFormation refuses the template for was forwarded too — while the
     * BillingMode FLIP's per-index reader had been on the grammar since #3147.
     *
     * Every row asserts the SENT value with `toBe`, which discriminates `7`
     * from `'7'`: a test reading it with `Number(...)` or `toEqual` on a
     * stringly object would pass against the unfixed provider.
     */
    const runCreate = async (indexes: unknown[]): Promise<CreateTableCommand | undefined> => {
      primeGeneric();
      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: indexes,
      });
      return findCalls(CreateTableCommand)[0];
    };

    /** The `ProvisionedThroughput` block `CreateTable` received for `name`. */
    const sentCapacity = (
      create: CreateTableCommand | undefined,
      name: string
    ): Record<string, unknown> | undefined =>
      (create?.input.GlobalSecondaryIndexes ?? []).find((g) => g.IndexName === name)
        ?.ProvisionedThroughput as Record<string, unknown> | undefined;

    /**
     * One row per template spelling for a per-INDEX capacity member. `sent` is
     * what must reach the wire; `ABSENT` there means the member is DROPPED from
     * the block (DynamoDB then rejects the request naming it, which is what
     * CloudFormation does with the same template at properties validation).
     *
     * `before` records what the pre-#3255 verbatim forward put on the wire, so
     * a row also says what the fix changed — and the first four rows are why
     * `toBe` matters: every one of them shipped a STRING into a `number` field.
     */
    const INDEX_CAPACITY_MATRIX: ReadonlyArray<{
      readonly value: unknown;
      readonly sent: unknown;
      readonly warned: boolean;
      readonly before: string;
    }> = [
      // --- CloudFormation ACCEPTS: now COERCED, previously forwarded raw -----
      { value: '6', sent: 6, warned: false, before: "the string '6'" },
      { value: '+8', sent: 8, warned: false, before: "the string '+8'" },
      // Decimal, not octal — CloudFormation reads `"010"` as 10 and so does this.
      { value: '010', sent: 10, warned: false, before: "the string '010'" },
      { value: 7, sent: 7, warned: false, before: '7' },
      // --- ABSENT stays ABSENT: the per-index reader has NO default ---------
      // This is the row that separates the per-INDEX rule from the TABLE-level
      // one, which substitutes 5 for an absent member. A defaulted per-index
      // capacity would land in state as if the template had declared it, with
      // no later call to correct it (issue #1588).
      { value: ABSENT, sent: ABSENT, warned: false, before: 'absent' },
      // --- CloudFormation REJECTS: dropped and named -----------------------
      { value: ' 7 ', sent: ABSENT, warned: true, before: "the string ' 7 '" },
      { value: '7 ', sent: ABSENT, warned: true, before: "the string '7 '" },
      { value: '', sent: ABSENT, warned: true, before: "the string ''" },
      { value: '0x9', sent: ABSENT, warned: true, before: "the string '0x9'" },
      { value: '1e1', sent: ABSENT, warned: true, before: "the string '1e1'" },
      { value: '6.5', sent: ABSENT, warned: true, before: "the string '6.5'" },
      { value: 'abc', sent: ABSENT, warned: true, before: "the string 'abc'" },
      { value: 6.5, sent: ABSENT, warned: true, before: '6.5' },
      { value: true, sent: ABSENT, warned: true, before: 'true' },
      // A DECLARED null: the flip's reader calls this unusable, so create now
      // agrees with it. (The TABLE-level forwarder reads null as ABSENT and
      // substitutes 5 — a deliberate difference, pinned on both sides.)
      { value: null, sent: ABSENT, warned: true, before: 'null' },
      // An unresolved intrinsic, the shape the diagnostics exist for.
      { value: { Ref: 'Unset' }, sent: ABSENT, warned: true, before: '{"Ref":"Unset"}' },
    ];

    it('keeps its per-outcome row counts', () => {
      // The floor, as LITERALS and per OUTCOME: re-classifying a row is the
      // cheapest way to neutralise the table below, and it moves a number here.
      const dropped = INDEX_CAPACITY_MATRIX.filter((r) => r.sent === ABSENT && r.warned);
      const forwarded = INDEX_CAPACITY_MATRIX.filter((r) => r.sent !== ABSENT);
      expect(INDEX_CAPACITY_MATRIX.length).toBe(16);
      expect(dropped.length).toBe(11);
      expect(forwarded.length).toBe(4);
      // Every dropped row warns and no forwarded row does — the announcement is
      // the whole licence for dropping, so the two must not come apart.
      expect(forwarded.every((r) => !r.warned)).toBe(true);
      // Exactly ONE row is absent-and-silent: the template that declares no
      // member. Without it the table could not tell "dropped" from "never
      // declared", which is the difference the no-default rule turns on.
      expect(INDEX_CAPACITY_MATRIX.filter((r) => r.sent === ABSENT && !r.warned).length).toBe(1);
      // At least three ACCEPTED rows are STRINGS: the fix is a coercion, so a
      // table of numbers alone would stay green against the unfixed forwarder.
      expect(forwarded.filter((r) => typeof r.value === 'string').length).toBe(3);
    });

    for (const row of INDEX_CAPACITY_MATRIX) {
      it(`create: gsi ReadCapacityUnits ${label(row.value)} -> ${label(row.sent)} (was: ${row.before})`, async () => {
        const create = await runCreate([
          {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            ProvisionedThroughput: {
              ...(row.value === ABSENT ? {} : { ReadCapacityUnits: row.value }),
              WriteCapacityUnits: 3,
            },
          },
        ]);

        const capacity = sentCapacity(create, 'gsi1');
        if (row.sent === ABSENT) {
          expect(capacity && 'ReadCapacityUnits' in capacity).toBe(false);
        } else {
          expect(capacity?.['ReadCapacityUnits']).toBe(row.sent);
        }
        // The WRITE member is the control in every row: a change that dropped
        // or rewrote BOTH members would otherwise look identical, and a fix
        // that dropped the whole block would pass a member-only assertion.
        expect(capacity?.['WriteCapacityUnits']).toBe(3);
        expect(warnings().includes('ProvisionedThroughput.ReadCapacityUnits')).toBe(row.warned);
      });
    }

    it('drops the MEMBER and keeps its legal sibling, rather than the whole block', async () => {
      // The decision this fix had to make. Dropping the block would discard a
      // member the template spelled LEGALLY and would make DynamoDB answer with
      // `ProvisionedThroughput must be specified for index: gsi1`, which names
      // neither the member nor why; dropping the member makes AWS name the
      // exact position. Both fail the deploy, so this pins the error TEXT half.
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: '0x9', WriteCapacityUnits: '11' },
        },
      ]);

      expect(sentCapacity(create, 'gsi1')).toEqual({ WriteCapacityUnits: 11 });
      expect(warnings()).toContain('ProvisionedThroughput.ReadCapacityUnits');
      expect(warnings()).not.toContain('ProvisionedThroughput.WriteCapacityUnits');
    });

    it('names the INDEX in the warning, and leaves a sibling index untouched', async () => {
      // `scope` is threaded, not hardcoded: with one literal a table carrying
      // several GSIs would not say which one to fix, and a per-entry rebuild
      // that leaked across entries would be invisible to a one-index case.
      const create = await runCreate([
        {
          IndexName: 'bad-index',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: ' 7 ', WriteCapacityUnits: 3 },
        },
        {
          IndexName: 'good-index',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: '9', WriteCapacityUnits: 4 },
        },
      ]);

      expect(warnings()).toContain('GSI bad-index on AWS::DynamoDB::Table L');
      expect(warnings()).not.toContain('GSI good-index');
      expect(sentCapacity(create, 'bad-index')).toEqual({ WriteCapacityUnits: 3 });
      expect(sentCapacity(create, 'good-index')).toEqual({
        ReadCapacityUnits: 9,
        WriteCapacityUnits: 4,
      });
    });

    it('says NO capacity was substituted, the same sentence the table level says', async () => {
      // The GlobalTable sibling announces a 5/5 FALLBACK; this type omits. One
      // wording for both levels of this type, so a user reading one log line
      // does not have to know which forwarder produced it.
      await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: ' 7 ', WriteCapacityUnits: 3 },
        },
      ]);

      expect(warnings()).toContain('NO capacity was substituted');
      expect(warnings()).toContain('decimal digits');
      expect(warnings()).toContain('GlobalSecondaryIndexes[] entry');
    });

    it('forwards a NON-OBJECT ProvisionedThroughput verbatim and says nothing', async () => {
      // Fail OPEN: a mis-nested value or an unresolved intrinsic in the BLOCK
      // position is AWS's to reject by name, which is the pre-existing
      // behaviour of this forwarder and the direction this file takes
      // everywhere. Rewriting it would be inventing a block.
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: 'nonsense',
        },
      ]);

      expect(sentCapacity(create, 'gsi1')).toBe('nonsense');
      expect(warnings()).not.toContain('ProvisionedThroughput.');
    });

    it('leaves an index declaring NO ProvisionedThroughput exactly as it was', async () => {
      // A PAY_PER_REQUEST-shaped index. The mapper must not manufacture a block
      // for it, and must not lose the members it does carry.
      const entry = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        OnDemandThroughput: { MaxReadRequestUnits: 10 },
      };
      const create = await runCreate([entry]);

      expect(create?.input.GlobalSecondaryIndexes?.[0]).toEqual(entry);
      expect(warnings()).toBe('');
    });

    it('coerces the capacity and the WarmThroughput of the SAME entry', async () => {
      // The two blocks are rewritten by one pass over the entry, so a rebuild
      // that replaced rather than layered would drop whichever ran first.
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: '7', WriteCapacityUnits: '3' },
          WarmThroughput: { ReadUnitsPerSecond: '12000' },
        },
      ]);

      const gsi = create?.input.GlobalSecondaryIndexes?.[0];
      expect(gsi?.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 3 });
      expect(gsi?.WarmThroughput).toEqual({ ReadUnitsPerSecond: 12000 });
      expect(gsi?.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    });

    it("does not mutate the caller's entry, which the engine records into state", async () => {
      // The resolved template bag belongs to the caller; a provider editing it
      // in place would change what state reports cdkd sent.
      const declared = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: { ReadCapacityUnits: '7', WriteCapacityUnits: ' 3 ' },
      };
      await runCreate([declared]);

      expect(declared.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: '7',
        WriteCapacityUnits: ' 3 ',
      });
    });

    it('sends an EMPTY block, naming both, when NEITHER member is usable', async () => {
      // The arm the drop-the-MEMBER decision reaches at its limit. Pinned
      // because the obvious "tidy-up" — returning no block once everything is
      // dropped — would forward the raw strings on the very template that
      // needed naming, and because `indexDeclares` reads this block's
      // truthiness (an empty object is truthy, so the drift side still agrees
      // that cdkd SENT a block).
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 'abc', WriteCapacityUnits: ' 3 ' },
        },
      ]);

      expect(sentCapacity(create, 'gsi1')).toEqual({});
      expect(warnings()).toContain('ProvisionedThroughput.ReadCapacityUnits');
      expect(warnings()).toContain('ProvisionedThroughput.WriteCapacityUnits');
    });

    it('coerces the capacity of an entry whose WarmThroughput is DROPPED', async () => {
      // The other order of the same one-pass rebuild. The sibling case above
      // takes the WarmThroughput SUCCESS branch (`out = {...out, WarmThroughput}`);
      // this one takes the DROP branch (`out = rest`), which rebuilds `out`
      // from scratch — so a rebuild spreading `entry` rather than `out` would
      // resurrect the dropped block, and one layering the capacity first would
      // lose it.
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: '7', WriteCapacityUnits: 3 },
          WarmThroughput: {},
        },
      ]);

      const gsi = create?.input.GlobalSecondaryIndexes?.[0];
      expect(gsi?.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 3 });
      expect(gsi && 'WarmThroughput' in gsi).toBe(false);
      expect(warnings()).toContain('carries no usable');
    });

    it.each([
      ['an array', [] as unknown],
      ['null', null as unknown],
      ['a number', 42 as unknown],
    ])('forwards a %s ProvisionedThroughput verbatim and says nothing', async (_label, block) => {
      // `isPlainCapacityBlock` excludes an ARRAY deliberately (its doc says
      // why: `[]` indexes to `undefined` for both members, so treating it as a
      // block would drop nothing and report nothing while AWS rejects the list
      // by name). `null` and a scalar take the same arm.
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: block,
        },
      ]);

      expect(sentCapacity(create, 'gsi1')).toEqual(block);
      expect(warnings()).not.toContain('ProvisionedThroughput.');
    });

    it('leaves an UNKNOWN member name untouched, so AWS names it', async () => {
      // Fail open on a misspelling: the member is not in the grammar's
      // membership, so it is preserved rather than vanishing here.
      const create = await runCreate([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnit: '7' },
        },
      ]);

      expect(sentCapacity(create, 'gsi1')).toEqual({ ReadCapacityUnit: '7' });
      expect(warnings()).toBe('');
    });

    it('names an entry with no usable IndexName <unnamed>, and does not throw', async () => {
      // `IndexName` is an UNCHECKED cast off the template, and the real masker
      // is a `String.prototype.replace` that THROWS on a non-string. Before the
      // review of #3255 the scope was built only for an entry declaring
      // `WarmThroughput`, so an unquoted-YAML `IndexName: 2024` beside an
      // ordinary capacity block would have taken a diagnostic path down with
      // the whole deploy. A real (non-identity) masker is passed, because an
      // identity default cannot exhibit the crash.
      primeGeneric();
      await provider.create(
        'L',
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          GlobalSecondaryIndexes: [
            {
              IndexName: 2024,
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ProvisionedThroughput: { ReadCapacityUnits: '0x9', WriteCapacityUnits: 3 },
            },
          ],
        },
        { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
      );

      expect(warnings()).toContain('GSI <unnamed> on AWS::DynamoDB::Table L');
      expect(warnings()).toContain('ProvisionedThroughput.ReadCapacityUnits');
    });

    it('MASKS a secret-bearing index name in the warning', async () => {
      // The #1997 contract on the new sink: the scope is built from a RESOLVED
      // property value, so a `{{resolve:secretsmanager:...}}` index name is
      // plaintext here. Without this case, dropping the masker argument at any
      // of the three call sites below the scope would be silent.
      primeGeneric();
      await provider.create(
        'L',
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          GlobalSecondaryIndexes: [
            {
              IndexName: 'idx-s3cr3t',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              // The RAW declared member is stringified into the warning too,
              // so it is the second thing the masker has to reach.
              ProvisionedThroughput: { ReadCapacityUnits: 's3cr3t', WriteCapacityUnits: 3 },
            },
          ],
        },
        { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
      );

      expect(warnings()).toContain('GSI idx-<redacted> on AWS::DynamoDB::Table L');
      expect(warnings()).not.toContain('s3cr3t');
      expect(warnings()).toContain('<redacted>');
    });
  });

  describe('the per-GSI ProvisionedThroughput on the UPDATE actions (#3255 review)', () => {
    /**
     * The three `applyGsiUpdates` send sites. Coercing only `create()`'s
     * forward INVERTED the divergence this change exists to close: the same
     * entry succeeded on a fresh create and was rejected by AWS when the index
     * was added by a later update. Each case drives the real `update()`.
     *
     * The GUARDS around these sites stay on `toFiniteNumber` on purpose, so a
     * case here asserts the WIRE value only.
     */
    const runUpdate = async (
      desiredIndexes: unknown[],
      previousIndexes: unknown[],
      live?: { indexes?: unknown[] }
    ): Promise<UpdateTableCommand[]> => {
      primeGeneric({ billingMode: 'PROVISIONED', ...(live?.indexes ? { indexes: live.indexes } : {}) });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          GlobalSecondaryIndexes: desiredIndexes,
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          GlobalSecondaryIndexes: previousIndexes,
        }
      );
      return findCalls(UpdateTableCommand);
    };

    /** The `ProvisionedThroughput` of the first GSI op of the given kind. */
    const opCapacity = (
      calls: UpdateTableCommand[],
      kind: 'Create' | 'Update'
    ): Record<string, unknown> | undefined => {
      for (const call of calls) {
        for (const op of call.input.GlobalSecondaryIndexUpdates ?? []) {
          const action = kind === 'Create' ? op.Create : op.Update;
          if (action) return action.ProvisionedThroughput as Record<string, unknown> | undefined;
        }
      }
      return undefined;
    };

    it('Create action: coerces a quoted capacity, as the create path does', async () => {
      // The headline case. Pre-review this sent the STRING "7" into a `number`
      // field, so a template that now deploys cleanly from scratch failed the
      // moment the same index was added later.
      const calls = await runUpdate([cfnGsi('gsi2', '7', '3')], []);
      expect(opCapacity(calls, 'Create')).toEqual({
        ReadCapacityUnits: 7,
        WriteCapacityUnits: 3,
      });
    });

    it('Create action: drops and names a spelling CloudFormation rejects', async () => {
      const calls = await runUpdate([cfnGsi('gsi2', ' 7 ', 3)], []);
      expect(opCapacity(calls, 'Create')).toEqual({ WriteCapacityUnits: 3 });
      expect(warnings()).toContain('ProvisionedThroughput.ReadCapacityUnits');
      expect(warnings()).toContain('gsi2');
    });

    it('same-name Update action: coerces a quoted capacity', async () => {
      // The guard in front of this site compares the DECLARED block against the
      // RECORDED one, both raw, so the differing spelling is what makes the op
      // fire at all; only the wire value is coerced.
      const calls = await runUpdate(
        [cfnGsi('gsi1', '9', '4')],
        [cfnGsi('gsi1', 3, 3)],
        { indexes: [LIVE_GSI('gsi1')] }
      );
      expect(opCapacity(calls, 'Update')).toEqual({
        ReadCapacityUnits: 9,
        WriteCapacityUnits: 4,
      });
    });

    it('adopted-index repair: coerces a quoted capacity', async () => {
      // The third site: the index is LIVE but absent from the recorded previous
      // side, so its Create is skipped and the capacity repaired by an Update.
      const calls = await runUpdate(
        [cfnGsi('gsi1', '9', '4')],
        [],
        {
          indexes: [
            {
              IndexName: 'gsi1',
              IndexStatus: 'ACTIVE',
              ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
            },
          ],
        }
      );
      expect(warnings()).toContain('already exists in AWS');
      expect(opCapacity(calls, 'Update')).toEqual({
        ReadCapacityUnits: 9,
        WriteCapacityUnits: 4,
      });
    });

    it('survives a NUMERIC IndexName with a masker in play (PR #3268 review)', async () => {
      // `IndexName: 2024` (unquoted YAML) is an UNCHECKED cast off the
      // template: it is truthy, so it becomes the key of the name maps and
      // arrives at the scope builders as a NUMBER — on which the real masker's
      // `String.prototype.replace` THROWS. `create()` was guarded when
      // `indexScope` was added; this round's eager scopes on the UPDATE sites
      // were not, which newly exposed the crash on an ordinary capacity update.
      // The guard lives in `indexScopeAt`, so the whole update must complete
      // and the op must still carry the coerced capacity.
      primeGeneric({ billingMode: 'PROVISIONED' });
      await expect(
        provider.update(
          'L',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            TableName: TABLE_NAME,
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            GlobalSecondaryIndexes: [
              {
                IndexName: 2024,
                KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' },
                ProvisionedThroughput: { ReadCapacityUnits: '7', WriteCapacityUnits: '3' },
              },
            ],
          },
          {
            TableName: TABLE_NAME,
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            GlobalSecondaryIndexes: [],
          },
          // A non-empty secret bag is what makes the masker a real
          // `String.replace` call rather than the identity default.
          { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
        )
      ).resolves.not.toThrow();

      const calls = findCalls(UpdateTableCommand);
      expect(opCapacity(calls, 'Create')).toEqual({
        ReadCapacityUnits: 7,
        WriteCapacityUnits: 3,
      });
    });

    it('the ZERO-CAPACITY refusal survives a NUMERIC IndexName too (go-to-k/cdkd#3380 security m1)', async () => {
      // The THIRD site of the same class, found by the go-to-k/cdkd#3380
      // security review: `skipZeroCapacityIndexUpdate` also opened with a bare
      // `maskSecrets(indexName)`, and it is reached from the SAME-NAME update
      // arm on an ordinary PROVISIONED table whose recorded previous carries
      // AWS's `{0, 0}` on-demand placeholder -- the shape a pre-#1767 record or
      // a `cdkd drift --revert` of one produces. So with a numeric IndexName and
      // any resolved secret in the bag, a refusal PATH took the whole deploy
      // down with `text.replace is not a function`.
      //
      // The two sibling warns this round also routed through `indexScopeAt`
      // (`already exists in AWS` / `was adopted from AWS`) are DEFENSIVE rather
      // than fenced here, and derivably so: both sit inside `if (recovered)`,
      // which needs `liveIndexByName.get(name)` to hit -- and that map is built
      // with a `typeof live.IndexName === 'string'` filter, so a numeric key
      // can never match it. There is no reachable case to pin.
      primeGeneric({ billingMode: 'PROVISIONED' });
      const numericGsi = (capacity: Record<string, unknown>) => ({
        IndexName: 2024,
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: capacity,
      });
      await expect(
        provider.update(
          'L',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            TableName: TABLE_NAME,
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            GlobalSecondaryIndexes: [
              numericGsi({ ReadCapacityUnits: 0, WriteCapacityUnits: 0 }),
            ],
          },
          {
            TableName: TABLE_NAME,
            BillingMode: 'PROVISIONED',
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            GlobalSecondaryIndexes: [
              numericGsi({ ReadCapacityUnits: 3, WriteCapacityUnits: 3 }),
            ],
          },
          // A non-empty secret bag is what makes the masker a real
          // `String.replace` call rather than the identity default.
          { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
        )
      ).resolves.not.toThrow();

      // The refusal still FIRED -- a case that only proved "no throw" would
      // also pass against a build that never reached the warn at all.
      expect(warnings()).toContain('on-demand placeholder');
      expect(warnings()).toContain('<unnamed>');
      expect(
        findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
      ).toEqual([]);
    });
  });

  describe('the OnDemandThroughput ceilings at all SIX send sites (#3265, #3287)', () => {
    /**
     * `OnDemandThroughput` was forwarded VERBATIM at every site while every
     * sibling capacity property had moved onto CloudFormation's Integer
     * grammar. Both members are `Long` in the SDK model, so a CFn-legal
     * `MaxReadRequestUnits: '100'` reached AWS as the STRING `"100"` and the
     * request failed, while a `' 100 '` / `'0x64'` / `'1e2'` CloudFormation
     * refuses the template for was forwarded unchanged.
     *
     * The issue enumerated THREE sites from its own grep. There are FOUR: the
     * per-index `CreateTable` forward goes through a CAST of the whole
     * `GlobalSecondaryIndexes` array, so the value never appears as a named
     * `OnDemandThroughput` expression — the same blind spot that hid the
     * `ProvisionedThroughput` twin from #3147's enumeration and from #3255's
     * round 6. Each site is driven INDEPENDENTLY below, through the real
     * `create()` / `update()`.
     *
     * Every assertion uses `toBe` / `toEqual` on the SENT value, which
     * discriminates `100` from `'100'`: a case reading it through `Number(...)`
     * would pass against the unfixed provider.
     */
    const ON_DEMAND = 'OnDemandThroughput.MaxReadRequestUnits';

    const runOnDemandCreate = async (
      properties: Record<string, unknown>
    ): Promise<CreateTableCommand | undefined> => {
      primeGeneric();
      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        ...properties,
      });
      return findCalls(CreateTableCommand)[0];
    };

    /**
     * One row per template spelling for a TABLE-level ceiling member. `sent`
     * ABSENT means the member is DROPPED from the block — and, unlike its
     * `ProvisionedThroughput` sibling, the request then SUCCEEDS with no
     * maximum applied, which is why the announcement says something different.
     *
     * `before` records what the pre-#3265 verbatim forward put on the wire, so
     * a row also says what the fix changed. Every ACCEPTED string row is one
     * that used to reach a `Long` field as a string.
     */
    const CEILING_MATRIX: ReadonlyArray<{
      readonly value: unknown;
      readonly sent: unknown;
      readonly warned: boolean;
      readonly before: string;
    }> = [
      // --- CloudFormation ACCEPTS: now COERCED, previously forwarded raw -----
      { value: '100', sent: 100, warned: false, before: "the string '100'" },
      { value: '+8', sent: 8, warned: false, before: "the string '+8'" },
      // Decimal, not octal — CloudFormation reads `"010"` as 10 and so does this.
      { value: '010', sent: 10, warned: false, before: "the string '010'" },
      // `-1` is DynamoDB's documented "remove the existing maximum" sentinel,
      // so the grammar's optional SIGN is load-bearing here in a way it is not
      // for a capacity member, where AWS refuses anything below 1.
      { value: '-1', sent: -1, warned: false, before: "the string '-1'" },
      { value: 100, sent: 100, warned: false, before: '100' },
      // --- ABSENT stays ABSENT, SILENTLY: this block has no default at all ---
      { value: ABSENT, sent: ABSENT, warned: false, before: 'absent' },
      // --- CloudFormation REJECTS: dropped and named ------------------------
      { value: ' 100 ', sent: ABSENT, warned: true, before: "the string ' 100 '" },
      { value: '100 ', sent: ABSENT, warned: true, before: "the string '100 '" },
      { value: '', sent: ABSENT, warned: true, before: "the string ''" },
      { value: '0x64', sent: ABSENT, warned: true, before: "the string '0x64'" },
      { value: '1e2', sent: ABSENT, warned: true, before: "the string '1e2'" },
      { value: '6.5', sent: ABSENT, warned: true, before: "the string '6.5'" },
      { value: 'abc', sent: ABSENT, warned: true, before: "the string 'abc'" },
      { value: 6.5, sent: ABSENT, warned: true, before: '6.5' },
      { value: true, sent: ABSENT, warned: true, before: 'true' },
      { value: null, sent: ABSENT, warned: true, before: 'null' },
      { value: { Ref: 'Unset' }, sent: ABSENT, warned: true, before: '{"Ref":"Unset"}' },
    ];

    it('keeps its per-outcome row counts', () => {
      // The floor, as LITERALS and per OUTCOME: re-classifying a row is the
      // cheapest way to neutralise the table below, and it moves a number here.
      const dropped = CEILING_MATRIX.filter((r) => r.sent === ABSENT && r.warned);
      const forwarded = CEILING_MATRIX.filter((r) => r.sent !== ABSENT);
      expect(CEILING_MATRIX.length).toBe(17);
      expect(dropped.length).toBe(11);
      expect(forwarded.length).toBe(5);
      // Every dropped row warns and no forwarded row does — the announcement is
      // the whole licence for dropping, so the two must not come apart.
      expect(forwarded.every((r) => !r.warned)).toBe(true);
      // Both directions, not just one: `dropped` is SELECTED on `r.warned`, so
      // without this the "every dropped row warns" half is never actually
      // asserted (the sibling matrix above states it explicitly).
      expect(
        CEILING_MATRIX.filter((r) => r.sent === ABSENT && r.value !== ABSENT).every((r) => r.warned)
      ).toBe(true);
      // Exactly ONE row is absent-and-silent: the template that declares no
      // member. Without it the table could not tell "dropped" from "never
      // declared", and this block substitutes nothing for either.
      expect(CEILING_MATRIX.filter((r) => r.sent === ABSENT && !r.warned).length).toBe(1);
      // FOUR accepted rows are STRINGS, and the fix is a coercion: a table of
      // numbers alone would stay green against the unfixed verbatim forward.
      expect(forwarded.filter((r) => typeof r.value === 'string').length).toBe(4);
      // The removal sentinel is an ACCEPTED row, not a rejected one — the row
      // that keeps a "refuse anything below 1" tightening from landing here.
      expect(CEILING_MATRIX.some((r) => r.value === '-1' && r.sent === -1)).toBe(true);
    });

    for (const row of CEILING_MATRIX) {
      it(`site 1 create (table): MaxReadRequestUnits ${label(row.value)} -> ${label(row.sent)} (was: ${row.before})`, async () => {
        const create = await runOnDemandCreate({
          OnDemandThroughput: {
            ...(row.value === ABSENT ? {} : { MaxReadRequestUnits: row.value }),
            MaxWriteRequestUnits: 3,
          },
        });

        const sent = create?.input.OnDemandThroughput as Record<string, unknown> | undefined;
        if (row.sent === ABSENT) {
          expect(sent && 'MaxReadRequestUnits' in sent).toBe(false);
        } else {
          expect(sent?.['MaxReadRequestUnits']).toBe(row.sent);
        }
        // The WRITE member is the control in every row: dropping or rewriting
        // BOTH members would otherwise look identical, and dropping the whole
        // BLOCK would pass a member-only assertion.
        expect(sent?.['MaxWriteRequestUnits']).toBe(3);
        expect(warnings().includes(ON_DEMAND)).toBe(row.warned);
      });
    }

    it('site 1 create (table): drops the MEMBER and keeps its legal sibling', async () => {
      // The decision, pinned: dropping the BLOCK would discard a ceiling the
      // template spelled legally, and would make `indexDeclares`' truthiness
      // gate stop describing what cdkd sends.
      const create = await runOnDemandCreate({
        OnDemandThroughput: { MaxReadRequestUnits: '0x64', MaxWriteRequestUnits: '11' },
      });
      expect(create?.input.OnDemandThroughput).toEqual({ MaxWriteRequestUnits: 11 });
      expect(warnings()).toContain(ON_DEMAND);
      expect(warnings()).not.toContain('OnDemandThroughput.MaxWriteRequestUnits');
    });

    it('site 1 create (table): sends an EMPTY block, naming both, when NEITHER member is usable', async () => {
      const create = await runOnDemandCreate({
        OnDemandThroughput: { MaxReadRequestUnits: ' 1 ', MaxWriteRequestUnits: 'abc' },
      });
      expect(create?.input.OnDemandThroughput).toEqual({});
      expect(warnings()).toContain(ON_DEMAND);
      expect(warnings()).toContain('OnDemandThroughput.MaxWriteRequestUnits');
    });

    it('site 1 create (table): preserves an UNRESOLVED INTRINSIC, which is a plain OBJECT', async () => {
      // NOT the non-object arm, though it reads like one and was labelled that
      // way until the review of this issue: `{Ref: 'Unset'}` satisfies
      // `isPlainCapacityBlock`, so it takes the MEMBER LOOP, finds neither
      // ceiling member, and survives through the preserve-unknown-member rule.
      // Same destination, different route — and the mislabel is what left the
      // real guard below with no case at all.
      const create = await runOnDemandCreate({ OnDemandThroughput: { Ref: 'Unset' } });
      expect(create?.input.OnDemandThroughput).toEqual({ Ref: 'Unset' });
      expect(warnings()).not.toContain('OnDemandThroughput.');
    });

    for (const block of ['100', 42, [{ MaxReadRequestUnits: 1 }]] as const) {
      it(`site 1 create (table): forwards a genuinely NON-OBJECT block (${JSON.stringify(block)}) verbatim`, async () => {
        // The `!isPlainCapacityBlock(declared)` early return, which had ZERO
        // coverage until the review of this issue measured it: replacing that
        // line with a `throw` left all 124 cases green. It is not decoration —
        // sites 1/3/4 gate on TRUTHINESS alone, so a string / number / array
        // reaches the helper, and without the guard `member in block` throws a
        // TypeError and takes the whole deploy down from a coercion path.
        const create = await runOnDemandCreate({ OnDemandThroughput: block });
        expect(create?.input.OnDemandThroughput).toEqual(block);
        expect(warnings()).not.toContain('OnDemandThroughput.');
      });
    }

    it('site 1 create (table): MASKS a secret-bearing ceiling value BEFORE stringifying it', async () => {
      // The member arrives RESOLVED, so a `{{resolve:secretsmanager:...}}`
      // scalar is PLAINTEXT here, and the raw value goes through
      // `maskLeafValue` BEFORE `JSON.stringify`.
      //
      // The SECRET has to carry a character `JSON.stringify` ESCAPES, or the
      // case is vacuous — which is exactly how the first version of it shipped:
      // with a plain `s3cr3t`, swapping `maskLeafValue(raw, maskSecrets)` for a
      // bare `raw` left all 133 cases green, because the message-level mask in
      // the `warn` sink still matched the literal. A masker matches by literal
      // occurrence, so once stringify turns `s3c"r3t` into `s3c\"r3t` the
      // plaintext no longer OCCURS and only the leaf pass can reach it. That is
      // the escaping half of the #2176 rule, and every Secrets Manager JSON
      // document is in this population.
      const SECRET = 's3c"r3t';
      primeGeneric();
      await provider.create(
        'L',
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: SECRET, MaxWriteRequestUnits: 3 },
        },
        // A LITERAL replace, which is what the real `maskSecretsInText` does —
        // a regex spelled here would be a different function from the one in
        // production and could match the escaped form by accident.
        { maskSecrets: (text: string) => text.split(SECRET).join('<redacted>') }
      );

      const text = warnings();
      expect(text).toContain(ON_DEMAND);
      expect(text).toContain('<redacted>');
      // `s3c`, not the whole secret: the LEAK shape is the ESCAPED spelling
      // `s3c\"r3t`, which a `not.toContain(SECRET)` would miss entirely.
      expect(text).not.toContain('s3c');
    });

    it('the ProvisionedThroughput twin masks its leaf the same way (sibling of the case above)', async () => {
      // Same hole, one property over: `dynamodb-table-provider-cfn-integer`'s
      // #3255 masking case uses a plain `s3cr3t`, so it too survives dropping
      // `maskLeafValue` — it fences the SCOPE (an index name, masked directly
      // with no stringify) and not the stringified MEMBER. Added here rather
      // than filed because it is the same file, the same sink and the same
      // measurement that produced the case above.
      const SECRET = 'r3ad"cap';
      primeGeneric();
      await provider.create(
        'L',
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          KeySchema: KEY_SCHEMA,
          AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: SECRET, WriteCapacityUnits: 5 },
        },
        { maskSecrets: (text: string) => text.split(SECRET).join('<redacted>') }
      );

      const text = warnings();
      expect(text).toContain('ProvisionedThroughput.ReadCapacityUnits');
      expect(text).toContain('<redacted>');
      expect(text).not.toContain('r3ad');
    });

    it('site 1 create (table): leaves an already-numeric block untouched, by IDENTITY', async () => {
      // The identity-return contract `coerceIndexThroughputForCreate` reads to
      // decide whether to rebuild an entry. Unfenced until the review of this
      // issue: making the rebuild unconditional left all 124 cases green.
      const block = { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 3 };
      const create = await runOnDemandCreate({ OnDemandThroughput: block });
      expect(create?.input.OnDemandThroughput).toBe(block);
      expect(warnings()).not.toContain('OnDemandThroughput.');
    });

    it('site 1 create (table): announces the OPTIONALITY, NOT the capacity sentence', async () => {
      // The one thing this announcement may not borrow from
      // `warnUnusableProvisionedCapacity`: that sentence promises DynamoDB will
      // reject the request naming the member, which is true only because both
      // capacity members are REQUIRED.
      await runOnDemandCreate({ OnDemandThroughput: { MaxReadRequestUnits: ' 100 ' } });
      const text = warnings();
      expect(text).toContain('NO ceiling was substituted for it');
      expect(text).toContain('OPTIONAL');
      expect(text).toContain('cdkd drift');
      expect(text).not.toContain('will reject the request naming this one');
    });

    it('site 1 create (table): does NOT promise success either, and splits the outcome per PATH', async () => {
      // The review of this issue found the first revision asserting ONE
      // outcome ("the request SUCCEEDS with no maximum applied for this half")
      // for all four sites, wrong in two independent ways:
      //
      //  - on an UPDATE, omitting a member does not clear the ceiling — AWS
      //    documents `-1` as the way to REMOVE one, so the LIVE maximum stays;
      //  - when NEITHER member survives the block goes out EMPTY. AWS's model
      //    requires `MaxReadRequestUnits`, `MaxWriteRequestUnits`, or both at
      //    every one of the four send positions, which reads like a loud
      //    rejection -- and is NOT enforced.
      //
      // MEASURED us-east-1 2026-09-17 (go-to-k/cdkd#3291 review): `CreateTable`
      // with `OnDemandThroughput: {}` is ACCEPTED, the table reaches ACTIVE and
      // `DescribeTable` reports no `OnDemandThroughput` at all. An earlier
      // revision of this case pinned the OPPOSITE ("expect that request to
      // fail"), which the measurement refuted -- so the all-rejected path is
      // the SILENT one and this warning is the user's only signal for it.
      await runOnDemandCreate({ OnDemandThroughput: { MaxReadRequestUnits: ' 100 ' } });
      const text = warnings();
      expect(text).toContain('an UPDATE KEEPS whatever maximum the table already carries');
      expect(text).toContain('only an explicit -1 removes one');
      expect(text).toContain('the block is sent EMPTY, which AWS ACCEPTS');
      expect(text).toContain('the deploy SUCCEEDS with no ceiling applied');
      // The refuted claim must not come back.
      expect(text).not.toContain('expect that request to fail');
      expect(text).not.toContain('AWS documents as invalid');
    });

    it('site 2 create (per-index): coerces the ceiling of a GSI entry, and names the INDEX', async () => {
      // The site the issue's own grep could not see. A sibling index is the
      // control: a per-entry rebuild that leaked across entries, or a scope
      // built from a hardcoded literal, would be invisible to a one-index case.
      const create = await runOnDemandCreate({
        GlobalSecondaryIndexes: [
          {
            IndexName: 'bad-index',
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            OnDemandThroughput: { MaxReadRequestUnits: ' 100 ', MaxWriteRequestUnits: '7' },
          },
          {
            IndexName: 'good-index',
            KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            OnDemandThroughput: { MaxReadRequestUnits: '9', MaxWriteRequestUnits: 4 },
          },
        ],
      });

      const sentFor = (name: string): unknown =>
        (create?.input.GlobalSecondaryIndexes ?? []).find((g) => g.IndexName === name)
          ?.OnDemandThroughput;
      expect(sentFor('bad-index')).toEqual({ MaxWriteRequestUnits: 7 });
      expect(sentFor('good-index')).toEqual({ MaxReadRequestUnits: 9, MaxWriteRequestUnits: 4 });
      expect(warnings()).toContain('bad-index');
      expect(warnings()).not.toContain('good-index');
    });

    it('site 2 create (per-index): leaves an entry declaring NO throughput block untouched', async () => {
      // The identity guard: the entry bag belongs to the caller (the resolved
      // template the engine also records into state), so an entry with nothing
      // to rewrite must come back as itself.
      const entry = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      const create = await runOnDemandCreate({ GlobalSecondaryIndexes: [entry] });
      expect(create?.input.GlobalSecondaryIndexes?.[0]).toBe(entry);
    });

    it("site 2 create (per-index): does not mutate the caller's entry", async () => {
      const entry = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        OnDemandThroughput: { MaxReadRequestUnits: '100', MaxWriteRequestUnits: ' 7 ' },
      };
      const create = await runOnDemandCreate({ GlobalSecondaryIndexes: [entry] });
      expect(entry.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: '100',
        MaxWriteRequestUnits: ' 7 ',
      });
      expect(create?.input.GlobalSecondaryIndexes?.[0]?.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 100,
      });
    });

    it('site 3 update (table): coerces a quoted ceiling on the UpdateTable', async () => {
      primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: '100', MaxWriteRequestUnits: ' 7 ' },
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: 50, MaxWriteRequestUnits: 7 },
        }
      );

      const call = findCalls(UpdateTableCommand).find((c) => c.input.OnDemandThroughput);
      // The change DETECTOR compares the declared block against the recorded
      // one, both raw, which is what makes the op fire at all; only the wire
      // value is coerced.
      expect(call?.input.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 100 });
      expect(warnings()).toContain('OnDemandThroughput.MaxWriteRequestUnits');
    });

    it('site 3 update (table): sends the EMPTY block when NEITHER member is usable', async () => {
      // The riskiest shape of the drop-the-MEMBER decision, and the one AWS's
      // model calls invalid ("you must specify MaxReadRequestUnits,
      // MaxWriteRequestUnits, or both"). Pinned so the behaviour is a DECISION
      // on the record rather than an accident: cdkd still issues the call and
      // lets DynamoDB answer, exactly as the `ProvisionedThroughput` sibling
      // does, and the warning tells the user to expect that failure.
      primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: ' 1 ', MaxWriteRequestUnits: '0x64' },
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: 50, MaxWriteRequestUnits: 7 },
        }
      );

      const call = findCalls(UpdateTableCommand).find(
        (c) => c.input.OnDemandThroughput !== undefined
      );
      expect(call?.input.OnDemandThroughput).toEqual({});
      expect(warnings()).toContain(ON_DEMAND);
      expect(warnings()).toContain('OnDemandThroughput.MaxWriteRequestUnits');
    });

    it('site 3 update (table): the change DETECTOR reads RAW, so a re-spelled ceiling still fires', async () => {
      // The interaction the coercion must not disturb. `'100'` and `100` are
      // the SAME ceiling once coerced, but the detector compares the declared
      // block against the RECORDED one, both raw — so the op fires, and what
      // reaches AWS is the coerced number. Moving the detector onto the coerced
      // values would silently stop re-sending a ceiling AWS may have lost.
      primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: '100' },
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          OnDemandThroughput: { MaxReadRequestUnits: 100 },
        }
      );

      const call = findCalls(UpdateTableCommand).find(
        (c) => c.input.OnDemandThroughput !== undefined
      );
      expect(call?.input.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 100 });
      expect(warnings()).not.toContain('OnDemandThroughput.');
    });

    /**
     * The driver for every per-index CEILING case: a PAY_PER_REQUEST table.
     *
     * TWO properties of it are load-bearing, and both were bought by a review
     * round rather than chosen.
     *
     * **PAY_PER_REQUEST, not PROVISIONED.** A PROVISIONED driver has to fire
     * the action from a CAPACITY change, so the ceiling assertion rides an op
     * that exists for another reason -- and `OnDemandThroughput` is a
     * PAY_PER_REQUEST-only property, so the shape under test is one AWS would
     * reject outright. The billing-mode question those cases kept raising is
     * filed as go-to-k/cdkd#3392; the cases themselves belong on the mode the
     * property is legal in.
     *
     * **The two index arrays must DIFFER.** `update()` gates the whole GSI
     * branch on `JSON.stringify(desired) !== JSON.stringify(previous)`, so
     * byte-identical arrays never reach `applyGsiUpdates` at all and a case
     * asserting "no op" then passes over an arm that never ran. Where a case
     * needs the ceiling itself UNCHANGED, it carries a SECOND index whose
     * ceiling does change (go-to-k/cdkd#3380 round 2, A1 / A2 -- both shipped
     * vacuous before it was measured).
     *
     * The GSIs carry NO `ProvisionedThroughput`, matching what a real
     * PAY_PER_REQUEST template declares.
     */
    const gsiCeilingOps = async (
      desiredIndexes: unknown[],
      previousIndexes: unknown[],
      live?: { indexes?: unknown[] }
    ) => {
      primeGeneric({
        billingMode: 'PAY_PER_REQUEST',
        ...(live?.indexes ? { indexes: live.indexes } : {}),
      });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: desiredIndexes,
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: previousIndexes,
        }
      );
      return findCalls(UpdateTableCommand)
        .flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
        .map((op) => op.Update)
        .filter((a): a is NonNullable<typeof a> => a !== undefined);
    };

    /** A PAY_PER_REQUEST GSI: no capacity block, ceiling supplied per case. */
    const ppRequestGsi = (name: string, ceiling?: unknown) => ({
      IndexName: name,
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ...(ceiling === undefined ? {} : { OnDemandThroughput: ceiling }),
    });

    it('site 5 update (SAME-NAME GSI Update action): carries the COERCED ceiling (go-to-k/cdkd#3287, arm 1)', async () => {
      // Was pinned at "carries no ceiling" while go-to-k/cdkd#3287 was open,
      // deliberately, so the fix could not land silently. It asserts the
      // COERCED `200` rather than the declared `'200'`, which is what keeps the
      // member routed through `coerceOnDemandCeilingsForSend` like the other
      // five sites: wiring it verbatim reds this case.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: '200' })],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: 50 })]
      );
      expect(updates).toEqual([
        { IndexName: 'gsi1', OnDemandThroughput: { MaxReadRequestUnits: 200 } },
      ]);
    });

    it('site 5 update (SAME-NAME GSI Update action): an UNCHANGED ceiling adds no member', async () => {
      // The control for arm 1: without the change detector a ceiling would be
      // re-asserted on every deploy that touches this index for any other
      // reason, re-sending a value AWS already holds and paying a full
      // index-ACTIVE wait for it.
      //
      // A SECOND index carries the change, and that is load-bearing rather than
      // incidental (the go-to-k/cdkd#3380 round-2 test review, A2). `update()`
      // gates the whole GSI branch on
      // `JSON.stringify(desired) !== JSON.stringify(previous)`, so byte-identical
      // arrays never reach `applyGsiUpdates` at all -- the case would then pass
      // over an arm that never ran, which is exactly how it read when it was
      // first moved onto this driver. It also makes the assertion sharper than
      // the original: the detector must be PER INDEX, so gsi2's edit going out
      // while gsi1 stays silent is one fact rather than two.
      const updates = await gsiCeilingOps(
        [
          ppRequestGsi('gsi1', { MaxReadRequestUnits: 200 }),
          ppRequestGsi('gsi2', { MaxReadRequestUnits: 90 }),
        ],
        [
          ppRequestGsi('gsi1', { MaxReadRequestUnits: 200 }),
          ppRequestGsi('gsi2', { MaxReadRequestUnits: 50 }),
        ]
      );
      expect(updates).toEqual([
        { IndexName: 'gsi2', OnDemandThroughput: { MaxReadRequestUnits: 90 } },
      ]);
    });

    it('site 5 update (SAME-NAME GSI Update action): a LOSSLESS re-spelling adds no member', async () => {
      // This arm's detector narrows BOTH sides when NOTHING was dropped, unlike
      // the TABLE-level one two describes up: `'200'` and `200` are the same
      // ceiling, and re-asserting it costs a full index-ACTIVE wait. LOSSLESS
      // is the load-bearing word -- see the two drop cases below, where the
      // detector deliberately falls back to the RAW compare.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: '200' })],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: 200 })]
      );
      expect(updates).toEqual([]);
    });

    it('site 5 update (SAME-NAME GSI Update action): a RECORD holding the non-canonical spelling adds no member', async () => {
      // The RECORDED side of the detector, which the re-spelled case above
      // cannot reach: there the template is the non-canonical side, so
      // narrowing the desired side alone already makes the two agree. Here the
      // RECORD holds the string -- what a template spelling `'200'` put there
      // on an earlier deploy -- and only narrowing BOTH sides keeps a template
      // since corrected to `200` from re-issuing the op on every deploy.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: 200 })],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: '200' })]
      );
      expect(updates).toEqual([]);
    });

    it('site 5 update: two DIFFERENT rejected spellings still WARN, because a drop falls back to the RAW compare (go-to-k/cdkd#3380 Drift 2)', async () => {
      // The narrowed detector's one concealment, closed. `' 25 '` and `' 30 '`
      // are both refused by CloudFormation's Integer grammar, so they narrow to
      // the SAME block -- and a purely narrowed detector would return before
      // `coerceOnDemandCeilingsForSend` ever ran, so the user would stop being
      // told what to fix while the template stayed broken. That is the
      // concealment `.claude/rules/provider-diff-record-folds.md` refuses and
      // the reason the TABLE-level detector stays raw. The discriminator is
      // `narrowOnDemandCeilings`' own `dropped` report: any drop on either side
      // compares RAW instead.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: ' 30 ', MaxWriteRequestUnits: 15 })],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: ' 25 ', MaxWriteRequestUnits: 15 })]
      );
      // The warning is the point. The op itself still carries only the SURVIVING
      // member, which differs from nothing AWS holds here, so it is emitted.
      expect(warnings()).toContain(ON_DEMAND);
      expect(updates).toEqual([
        { IndexName: 'gsi1', OnDemandThroughput: { MaxWriteRequestUnits: 15 } },
      ]);
    });

    it('site 5 update: an UNEDITED malformed ceiling does NOT re-warn when another index changes', async () => {
      // The anti-nag control for the RAW-on-drop fallback, and the reason that
      // fallback is keyed on `dropped` rather than on "did anything change".
      // gsi2 carries the edit, so `applyGsiUpdates` really runs; gsi1's
      // still-broken `' 25 '` is IDENTICAL on both sides, so the raw compare is
      // equal and the arm returns before the announcing forwarder. Without
      // that, every deploy touching any OTHER index would re-warn about a
      // template nobody edited.
      //
      // It shipped once as a version handing both sides byte-identical arrays,
      // which never reached `applyGsiUpdates` at all (round 2, A1); this is the
      // same repair its sibling took, not a deletion.
      const updates = await gsiCeilingOps(
        [
          ppRequestGsi('gsi1', { MaxReadRequestUnits: ' 25 ' }),
          ppRequestGsi('gsi2', { MaxReadRequestUnits: 90 }),
        ],
        [
          ppRequestGsi('gsi1', { MaxReadRequestUnits: ' 25 ' }),
          ppRequestGsi('gsi2', { MaxReadRequestUnits: 50 }),
        ]
      );
      expect(updates).toEqual([
        { IndexName: 'gsi2', OnDemandThroughput: { MaxReadRequestUnits: 90 } },
      ]);
      expect(warnings()).not.toContain(ON_DEMAND);
    });

    it('site 5 update (SAME-NAME GSI Update action): a REMOVED ceiling sends nothing (go-to-k/cdkd#3373)', async () => {
      // The decision, pinned: omitting a member KEEPS the live maximum (only an
      // explicit `-1` removes one), and cdkd does NOT substitute the sentinel at
      // either of this property's two positions. Byte-identical to what the
      // TABLE-level arm does with the same edit; the removal direction is filed
      // for both together as go-to-k/cdkd#3373.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1')],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: 200 })],
        { indexes: [{ ...LIVE_GSI('gsi1'), OnDemandThroughput: { MaxReadRequestUnits: 200 } }] }
      );
      expect(updates).toEqual([]);
    });

    it('site 5 update: survives a NUMERIC IndexName with a masker in play', async () => {
      // `indexScopeAt`'s guard, exercised through the NEW scope this arm builds.
      // `IndexName: 2024` is an unchecked cast off the template, and the real
      // masker is a `String.prototype.replace` call that THROWS on a number —
      // which would take the whole deploy down from a diagnostic path. The
      // site-4 twin covers the `Create` action; this one covers the ceiling arm,
      // whose scope now feeds the drop warning AND both debug lines.
      primeGeneric({ billingMode: 'PAY_PER_REQUEST', indexes: [LIVE_GSI('2024')] });
      const desired = {
        IndexName: 2024,
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await expect(
        provider.update(
          'L',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            TableName: TABLE_NAME,
            BillingMode: 'PAY_PER_REQUEST',
            GlobalSecondaryIndexes: [
              { ...desired, OnDemandThroughput: { MaxReadRequestUnits: ' 200 ' } },
            ],
          },
          {
            TableName: TABLE_NAME,
            BillingMode: 'PAY_PER_REQUEST',
            GlobalSecondaryIndexes: [
              { ...desired, OnDemandThroughput: { MaxReadRequestUnits: 50 } },
            ],
          },
          // A non-empty secret bag is what makes the masker a real
          // `String.replace` call rather than the identity default.
          { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
        )
      ).resolves.not.toThrow();
      expect(warnings()).toContain('<unnamed>');
      expect(warnings()).toContain(ON_DEMAND);
    });

    it('site 5 update (SAME-NAME GSI Update action): an ALL-REJECTED ceiling emits no op at all', async () => {
      // An `UpdateGlobalSecondaryIndexAction` carrying nothing but `IndexName`
      // is rejected by AWS outright, so an EMPTY ceiling block would fire a
      // doomed call — which is why this arm withholds it where the TABLE-level
      // one sends `{}` and lets DynamoDB answer. The drop is still ANNOUNCED
      // per member, which is the whole licence for withholding it.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: ' 200 ', MaxWriteRequestUnits: 'abc' })],
        [ppRequestGsi('gsi1')]
      );
      expect(updates).toEqual([]);
      expect(warnings()).toContain(ON_DEMAND);
      expect(warnings()).toContain('OnDemandThroughput.MaxWriteRequestUnits');
      // ...and NOT the unknown-member advice (the go-to-k/cdkd#3380 round-3
      // review's C3). Both members were just named as declared-but-rejected, so
      // telling the user to "check the member names" one line later contradicts
      // the advice above it. That branch is DEBUG when anything was dropped.
      expect(warnings()).not.toContain('Check the member names');
    });

    it('site 5 update: an OnDemandThroughput whose known member is present-but-undefined is DROPPED and named (go-to-k/cdkd#3380 C5)', async () => {
      // A key PRESENT with an `undefined` value satisfies `member in block` and
      // coerces to `undefined`, so the narrowing's identity short-circuit used
      // to keep it -- leaving a member the SDK serializes away, with nothing
      // dropped and nothing warned. It now takes the drop arm like any other
      // unusable spelling, so the surviving sibling still goes out and the user
      // is told which member was lost.
      const updates = await gsiCeilingOps(
        [
          ppRequestGsi('gsi1', {
            MaxReadRequestUnits: undefined,
            MaxWriteRequestUnits: 15,
          }),
        ],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: 50, MaxWriteRequestUnits: 15 })]
      );
      expect(updates).toEqual([
        { IndexName: 'gsi1', OnDemandThroughput: { MaxWriteRequestUnits: 15 } },
      ]);
      expect(warnings()).toContain(ON_DEMAND);
    });

    it('site 5 update: a CEILING-ONLY edit under PAY_PER_REQUEST now fires its own op (go-to-k/cdkd#3287, the headline shape)', async () => {
      // THE SHAPE the two capacity-driven arms cannot see, and the one
      // go-to-k/cdkd#3287 is named for: a template editing NOTHING but a live
      // index's ceiling. Before the fix `updateHasMember` was set only by the
      // capacity and warm arms, so this produced no `GlobalSecondaryIndexUpdates`
      // entry at all, deployed GREEN, and was recorded as applied -- the edit
      // lost permanently with no warning anywhere. It was pinned at ZERO ops
      // while the issue was open, precisely so a fix GATED to the on-demand
      // shape could not land silently (the two arms above stay green under such
      // a fix, measured by the go-to-k/cdkd#3291 test re-review, probe P3).
      primeGeneric({ billingMode: 'PAY_PER_REQUEST', indexes: [LIVE_GSI('gsi1')] });
      const desired = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            { ...desired, OnDemandThroughput: { MaxReadRequestUnits: '200' } },
          ],
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            { ...desired, OnDemandThroughput: { MaxReadRequestUnits: 50 } },
          ],
        }
      );
      const ops = findCalls(UpdateTableCommand).flatMap(
        (c) => c.input.GlobalSecondaryIndexUpdates ?? []
      );
      // ONE op, carrying the ceiling and nothing else: the capacity arm is
      // correctly silent under PAY_PER_REQUEST.
      expect(ops).toEqual([
        { Update: { IndexName: 'gsi1', OnDemandThroughput: { MaxReadRequestUnits: 200 } } },
      ]);
    });

    it('site 5 update: the live ceiling is consulted, so an op AWS already applied is not re-emitted (#1630 class)', async () => {
      // cdkd writes state only after `update()` RETURNS, so a ceiling op that
      // LANDED before a later step threw is unrecorded and the next deploy
      // re-emits it. What DynamoDB does with a repeated identical ceiling is
      // unmeasured; the guard withholds only a call that would change nothing,
      // so it is right either way. The recorded previous side still says the
      // ceiling changed -- that is what makes this case discriminate the LIVE
      // read rather than the detector.
      primeGeneric({
        billingMode: 'PAY_PER_REQUEST',
        indexes: [{ ...LIVE_GSI('gsi1'), OnDemandThroughput: { MaxReadRequestUnits: 200 } }],
      });
      const desired = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 200 } }],
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 50 } }],
        }
      );
      expect(
        findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
      ).toEqual([]);
    });

    it('site 5 update: a live ceiling that DIFFERS fails the guard open and the op is emitted', async () => {
      // The other direction of the same guard: without this, hard-coding
      // `liveCeilingAlreadyMatches` to `true` would swallow every ceiling
      // change and the case above would still pass.
      primeGeneric({
        billingMode: 'PAY_PER_REQUEST',
        indexes: [{ ...LIVE_GSI('gsi1'), OnDemandThroughput: { MaxReadRequestUnits: 50 } }],
      });
      const desired = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 200 } }],
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 50 } }],
        }
      );
      expect(
        findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
      ).toEqual([
        { Update: { IndexName: 'gsi1', OnDemandThroughput: { MaxReadRequestUnits: 200 } } },
      ]);
    });

    it('site 5 update: a PLAIN-OBJECT block of UNKNOWN members is WITHHELD, because AWS would never see the name (go-to-k/cdkd#3380 m2)', async () => {
      // The fail-open "let AWS name the shape" reasoning does NOT reach this
      // shape at THIS site, and getting that wrong is what the review caught.
      // `narrowOnDemandCeilings` preserves an unknown member name by design, so
      // an unresolved intrinsic leaves a NON-EMPTY object -- which the SDK then
      // serializes to `{}`, producing exactly the action-carrying-only-
      // `IndexName` that AWS rejects outright and that would take a capacity
      // edit riding the same action down with it. AWS never sees `Ref` to name
      // it. So the gate tests SURVIVING GRAMMAR MEMBERS, not `Object.keys`.
      //
      // The NON-object arm is the opposite answer and keeps its own case below:
      // a string / number / array really does reach AWS and is rejected by
      // shape, so forwarding it verbatim is informative.
      primeGeneric({
        billingMode: 'PAY_PER_REQUEST',
        indexes: [{ ...LIVE_GSI('gsi1'), OnDemandThroughput: { MaxReadRequestUnits: 200 } }],
      });
      const desired = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { Ref: 'Unset' } }],
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 50 } }],
        }
      );
      expect(
        findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
      ).toEqual([]);
      // WARNED, not withheld in silence (round 2's C3): an unknown member is
      // never DROPPED by the narrowing -- its name is preserved -- so the
      // per-member drop announcement says nothing about it, and this arm owes
      // the user the only line they will get.
      expect(warnings()).toContain('no member DynamoDB accepts');
    });

    it('site 5 update: a NON-OBJECT ceiling is forwarded VERBATIM, so AWS rejects it by shape', async () => {
      // The other side of the gate above, and the arm the go-to-k/cdkd#3380
      // test review measured UNPINNED at this site: flipping the passthrough to
      // `return undefined` left all 147 cases green. A STRING / NUMBER / ARRAY
      // is the fail-open direction every forwarder in this file takes -- AWS
      // receives the value and names it, which an unknown MEMBER never gets.
      const updates = await gsiCeilingOps(
        [ppRequestGsi('gsi1', '100')],
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: 50 })]
      );
      expect(updates).toEqual([{ IndexName: 'gsi1', OnDemandThroughput: '100' }]);
    });

    it('site 5 update: a live ceiling covering only the OTHER member does not suppress the op', async () => {
      // Per MEMBER, over the members being SENT. A live block carrying a
      // different member says nothing about the one cdkd is about to change,
      // and a whole-block compare would read the two as unequal by accident
      // rather than by rule — which is the same answer here, so the
      // discriminating half is the case above plus this one together.
      primeGeneric({
        billingMode: 'PAY_PER_REQUEST',
        indexes: [{ ...LIVE_GSI('gsi1'), OnDemandThroughput: { MaxWriteRequestUnits: 200 } }],
      });
      const desired = {
        IndexName: 'gsi1',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 200 } }],
        },
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [{ ...desired, OnDemandThroughput: { MaxReadRequestUnits: 50 } }],
        }
      );
      expect(
        findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? [])
      ).toEqual([
        { Update: { IndexName: 'gsi1', OnDemandThroughput: { MaxReadRequestUnits: 200 } } },
      ]);
    });

    it('site 6 update (ADOPTED-REPAIR action): carries the COERCED ceiling (go-to-k/cdkd#3287, arm 2)', async () => {
      // THE SECOND ARM, which the case above cannot reach: here the index is
      // LIVE but ABSENT from the recorded previous side, so its Create is
      // skipped and the difference repaired by an Update built at a DIFFERENT
      // site. Wiring the member into arm 1 alone leaves this green, so the two
      // arms need their own cases; it is repaired here for exactly the reason
      // capacity and warm throughput are, namely that the skipped Create means
      // nothing else in this deploy would ever send it.
      const adopted = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: '200' })],
        [],
        { indexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }] }
      );
      expect(warnings()).toContain('already exists in AWS');
      expect(adopted).toEqual([
        { IndexName: 'gsi1', OnDemandThroughput: { MaxReadRequestUnits: 200 } },
      ]);
    });

    it('site 6 update (ADOPTED-REPAIR action): withholds a ceiling the LIVE index already carries', async () => {
      // There is no recorded previous side on this arm, so the live read is the
      // ONLY comparison available — the same asymmetry the warm-throughput arm
      // beside it has. Without the guard, adopting an index would re-assert
      // every ceiling it already holds.
      const adopted = await gsiCeilingOps(
        [ppRequestGsi('gsi1', { MaxReadRequestUnits: '200' })],
        [],
        {
          indexes: [
            {
              IndexName: 'gsi1',
              IndexStatus: 'ACTIVE',
              OnDemandThroughput: { MaxReadRequestUnits: 200 },
            },
          ],
        }
      );
      // No op AT ALL: the ceiling was the only member this arm had to repair,
      // so withholding it leaves `adoptedHasMember` false and no action is
      // pushed. (Under PAY_PER_REQUEST the capacity arm is correctly silent.)
      expect(adopted).toEqual([]);
    });

    it('site 4 update (GSI Create action): coerces the ceiling of a newly added index', async () => {
      // The per-index twin of site 3 — with only the create path coerced, ONE
      // template would succeed on a fresh create and be rejected by AWS when
      // the same index was added by a later update.
      primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          TableName: TABLE_NAME,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi2',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              OnDemandThroughput: { MaxReadRequestUnits: '100', MaxWriteRequestUnits: '0x7' },
            },
          ],
        },
        { TableName: TABLE_NAME, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [] }
      );

      const actions = findCalls(UpdateTableCommand).flatMap(
        (c) => c.input.GlobalSecondaryIndexUpdates ?? []
      );
      const created = actions.find((op) => op.Create)?.Create;
      expect(created?.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 100 });
      expect(warnings()).toContain('OnDemandThroughput.MaxWriteRequestUnits');
      expect(warnings()).toContain('gsi2');
    });

    it('site 4 update (GSI Create action): survives a NUMERIC IndexName with a masker in play', async () => {
      // `indexScopeAt`'s guard, exercised through the NEW eager scope this
      // change adds: `IndexName: 2024` is an unchecked cast off the template,
      // and the real masker's `String.prototype.replace` THROWS on a number.
      primeGeneric({ billingMode: 'PAY_PER_REQUEST' });
      await expect(
        provider.update(
          'L',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            TableName: TABLE_NAME,
            BillingMode: 'PAY_PER_REQUEST',
            GlobalSecondaryIndexes: [
              {
                IndexName: 2024,
                KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
                Projection: { ProjectionType: 'ALL' },
                OnDemandThroughput: { MaxReadRequestUnits: ' 100 ' },
              },
            ],
          },
          { TableName: TABLE_NAME, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [] },
          // A non-empty secret bag is what makes the masker a real
          // `String.replace` call rather than the identity default.
          { maskSecrets: (text: string) => text.replace(/s3cr3t/g, '<redacted>') }
        )
      ).resolves.not.toThrow();
      expect(warnings()).toContain('<unnamed>');
      expect(warnings()).toContain(ON_DEMAND);
    });
  });
});
