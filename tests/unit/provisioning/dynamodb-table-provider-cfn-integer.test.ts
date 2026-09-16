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
  });
});
