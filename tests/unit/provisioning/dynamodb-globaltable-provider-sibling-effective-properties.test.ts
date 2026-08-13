import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-sibling-table-xxx';

const baseProps = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  Replicas: [{ Region: 'us-east-1' }],
};

const VALID_GSI = [
  {
    IndexName: 'byThing',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' },
  },
];

/**
 * `effectiveProperties` for the three GlobalTable arms issue #1653 deliberately
 * left out of scope, filed as issue #1683.
 *
 * Each puts a value on the wire that DIFFERS from the declared one and then
 * recorded the declared one — the permanent phantom drift
 * `.claude/rules/providers.md` records for the EC2 Route warn arm (#1591),
 * reached by three different routes:
 *
 *  1. `BillingMode` warn-and-SUBSTITUTE on the replay-create path (record what
 *     was SENT — the table really is created PAY_PER_REQUEST);
 *  2. `desiredGsiUnusable` warn-and-SKIP on the update path (retain the
 *     PREVIOUS value — AWS still holds the index set it already had);
 *  3. the `needsStream` auto-enable, which sends a stream the template never
 *     declared at all — the "arms that do NOT log a refusal" case.
 *
 * The answer differs per arm because what reached AWS differs, which is why all
 * three are pinned here rather than one standing in for the others.
 */
describe('DynamoDBGlobalTableProvider sibling effectiveProperties arms (issue #1683)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    childLogger.info.mockReset();
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableStatus: 'ACTIVE',
        TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        // Both regions are reported ACTIVE so the multi-replica creates below
        // do not sit in the provider's replica-settle poll.
        Replicas: [
          { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
          { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
        ],
        GlobalSecondaryIndexes: [{ IndexName: 'byThing', IndexStatus: 'ACTIVE' }],
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  /** The single CreateTable input this create issued. */
  const createInput = (): Record<string, unknown> =>
    mockSend.mock.calls.find((c) => c[0].constructor.name === 'CreateTableCommand')?.[0]
      .input as Record<string, unknown>;

  /**
   * A live PROVISIONED table. The default mock reports PAY_PER_REQUEST, which
   * equals the create-path fallback — so a case that must distinguish "the live
   * reading" from "the default" cannot use it without passing vacuously.
   */
  const provisionedTableResponse = (): Record<string, unknown> => ({
    Table: {
      TableName: TABLE_NAME,
      TableStatus: 'ACTIVE',
      TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
      BillingModeSummary: { BillingMode: 'PROVISIONED' },
      Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
    },
  });

  /** Every UpdateTable input this update issued. */
  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  // ─── ARM 1: BillingMode warn-and-SUBSTITUTE on a replay create ──────────

  it('records the SUBSTITUTED BillingMode on a replay create', async () => {
    const desired = { ...baseProps, BillingMode: '' };

    const result = await provider.create('MyTable', RESOURCE_TYPE, desired, {
      replayingState: true,
    });

    // The wire half FIRST: the substitution is only worth recording because
    // PAY_PER_REQUEST is what CreateTable actually carried.
    expect(createInput()['BillingMode']).toBe('PAY_PER_REQUEST');
    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    // The absence announcement must NOT fire here: the record DOES declare a
    // mode, it is merely malformed, and that is what the refusal above already
    // reports. Without this, dropping the `=== undefined` half of that gate
    // leaves the whole suite green while every replay create claims the record
    // declares nothing.
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('declares no BillingMode')
    );
    // It REPLACES the desired bag wholesale, so it must be complete.
    expect(result.effectiveProperties).toEqual({ ...desired, BillingMode: 'PAY_PER_REQUEST' });
    // ...and the substitution is still ANNOUNCED.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable BillingMode')
    );
  });

  it.each([
    ['null', null],
    ['a blank string', '  '],
    ['an array', []],
    ['an unresolved intrinsic', { Ref: 'SomeParam' }],
  ])('records the substitution when BillingMode is %s', async (_label, billingMode) => {
    const result = await provider.create(
      'MyTable',
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: billingMode },
      { replayingState: true }
    );

    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
  });

  it('answers with NO effectiveProperties for a VALID BillingMode on a replay create', async () => {
    const result = await provider.create(
      'MyTable',
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { replayingState: true }
    );

    // Absent means "record the desired properties" — the normal case, and the
    // reason the engine gates on `??` rather than on truthiness.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('keeps the template-path BillingMode REFUSAL rather than substituting and recording', async () => {
    // The wrapper that tracks the substitution must not smuggle in a downgrade
    // of its own: with no replay context the read still throws, so there is
    // nothing to record and no table to create.
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, BillingMode: '' })
    ).rejects.toThrow(/AWS::DynamoDB::GlobalTable BillingMode/);
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).not.toContain(
      'CreateTableCommand'
    );
  });

  // ─── The needsStream auto-enable is deliberately NOT answered ──────────
  //
  // It sends a stream the template never declared, which IS the same class —
  // but recording it in isolation is the shape `.claude/rules/providers.md`
  // forbids without a `canonicalizeDesiredProperties` twin, and that twin
  // cannot be written here (it is pure and synchronous and does not know the
  // deploy region, while `needsStream` does). Tracked as issue #1723. Pin the
  // CURRENT answer so the arm cannot start recording by accident, and so the
  // follow-up has a test to invert.

  it('sends the auto-enabled stream but records NO effectiveProperties for it (issue #1723)', async () => {
    const desired = {
      ...baseProps,
      Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
    };

    const result = await provider.create('MyTable', RESOURCE_TYPE, desired);

    // The WIRE half still carries the stream — the arm's behavior is unchanged.
    expect(createInput()['StreamSpecification']).toEqual({
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('answers with NO effectiveProperties when the template DECLARES the stream', async () => {
    // The declared value is what is sent, so there is nothing to correct.
    const result = await provider.create('MyTable', RESOURCE_TYPE, {
      ...baseProps,
      Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('answers with NO effectiveProperties for a single LOCAL replica and no stream', async () => {
    const result = await provider.create('MyTable', RESOURCE_TYPE, baseProps);

    expect(createInput()['StreamSpecification']).toBeUndefined();
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('ANNOUNCES an ABSENT BillingMode on a replay create, but stays silent on a template create', async () => {
    // The update arm DROPS the key when the record had none, so a replay can
    // meet an absence nothing else reports — and an absence is not malformed,
    // so neither the refusal nor replayWarn fires. A drop is only honest while
    // something still says so.
    const absent: Record<string, unknown> = { ...baseProps };
    delete absent['BillingMode'];

    await provider.create('MyTable', RESOURCE_TYPE, absent, { replayingState: true });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('declares no BillingMode')
    );

    childLogger.warn.mockReset();
    await provider.create('MyTable', RESOURCE_TYPE, absent);
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('declares no BillingMode')
    );
  });

  it('STRIPS the PROVISIONED-only capacity blocks the substitution never sent (issue #1726)', async () => {
    // The answer this test used to pin was the OPPOSITE — the block was
    // recorded although the substitution skipped the provisioned-throughput
    // call — and it was pinned precisely so that changing it could not happen
    // silently. Issue #1726 settled it: `readCurrentState` emits `{}` here for
    // a PAY_PER_REQUEST table, so recording `{ WriteCapacityUnits: 5 }` was the
    // same permanent phantom drift the arm exists to remove, one key over.
    // The full per-member coverage (per-replica / per-index, and the on-demand
    // ceilings that are NOT stripped because the substituted mode does send
    // them) lives in
    // `dynamodb-globaltable-provider-replay-create-effective-props.test.ts`.
    const throughput = { WriteCapacityUnits: 5 };
    const desired = {
      ...baseProps,
      BillingMode: '',
      WriteProvisionedThroughputSettings: throughput,
    };

    const result = await provider.create('MyTable', RESOURCE_TYPE, desired, {
      replayingState: true,
    });

    expect(createInput()['ProvisionedThroughput']).toBeUndefined();
    expect('WriteProvisionedThroughputSettings' in result.effectiveProperties!).toBe(false);
    // The substituted mode itself is still recorded — the strip must not take
    // the arm's own answer with it.
    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
  });

  it('COMPOSES the two REPLAY-CREATE arms rather than letting one erase the other', async () => {
    // Unlike the update-path stream arm — whose `??` is inert because it runs
    // first — this composition is LIVE: `billingModeSubstituted` runs ahead of
    // it, so assigning `{ ...properties }` at the stream site drops the
    // recorded BillingMode and re-creates the very drift this closes. Both
    // gate on the same `replayWarn` downgrade, so ONE state record carrying
    // two malformed values reaches both (the #1544 shape).
    const desired = {
      ...baseProps,
      BillingMode: '',
      StreamSpecification: '',
      Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
    };

    const result = await provider.create('MyTable', RESOURCE_TYPE, desired, {
      replayingState: true,
    });

    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    expect(result.effectiveProperties?.['StreamSpecification']).toEqual({
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
  });

  it('COMPOSES all THREE UPDATE-path arms rather than letting one erase another', async () => {
    // Every update-path arm writes `effectiveProperties`, the stream one first
    // and the BillingMode one last. Each spreads `effectiveProperties ??
    // properties`, so a bag malformed on all three keys records all three
    // answers — assigning `{ ...properties }` at any site drops the earlier
    // ones. Mutation-probed: the GSI and BillingMode sites each fail this test,
    // while the stream site passes because it always runs first (recorded in
    // that arm's own comment rather than claimed as covered here).
    const desired = {
      ...baseProps,
      BillingMode: '',
      StreamSpecification: '',
      GlobalSecondaryIndexes: 'oops-not-an-array',
    };
    const previousStream = { StreamViewType: 'KEYS_ONLY' };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, {
      ...baseProps,
      BillingMode: 'PROVISIONED',
      StreamSpecification: previousStream,
      GlobalSecondaryIndexes: VALID_GSI,
    });

    expect(result.effectiveProperties).toEqual({
      ...desired,
      BillingMode: 'PROVISIONED',
      StreamSpecification: previousStream,
      GlobalSecondaryIndexes: VALID_GSI,
    });
  });

  // ─── ARM 1 (update side): BillingMode warn-and-KEEP-the-previous-mode ────

  it('records the PREVIOUS BillingMode when an unusable desired value suppresses the flip', async () => {
    const desired = { ...baseProps, BillingMode: '' };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, {
      ...baseProps,
      BillingMode: 'PROVISIONED',
    });

    // The WIRE half first: retaining the previous mode is only correct BECAUSE
    // the flip was suppressed. A mutation that re-priced the table to
    // PAY_PER_REQUEST and still recorded PROVISIONED would satisfy the record
    // assertion alone.
    expect(updateInputs().some((i) => i['BillingMode'] === 'PAY_PER_REQUEST')).toBe(false);
    expect(result.effectiveProperties?.['BillingMode']).toBe('PROVISIONED');
    expect(result.effectiveProperties).toEqual({ ...desired, BillingMode: 'PROVISIONED' });
    // The logicalId prefix is part of the assertion, not decoration: without it
    // a stack with several GlobalTables cannot tell which one warned, and the
    // integ's grep fence for this arm has nothing to anchor on. Removing the
    // prefix leaves the rest of this suite green, so it is fenced here.
    // ...and the phrase the integ's grep fence anchors on. Without this a
    // reword would only be caught by a 20-minute real-AWS run. Asserted on ONE
    // call rather than as two independent `toHaveBeenCalledWith`s, which two
    // different warns could satisfy between them.
    expect(childLogger.warn).toHaveBeenCalledWith(
      // The interpolated VALUE is part of it too. Here the recorded previous is
      // PROVISIONED while the default mock reports PAY_PER_REQUEST, so the two
      // candidates differ and swapping `oldBilling` for `liveBillingMode` — a
      // message that would be WRONG for exactly this drifted shape — fails.
      expect.stringMatching(
        /AWS::DynamoDB::GlobalTable MyTable: .*BillingMode.*\(PROVISIONED\) is kept for this update/s
      )
    );
  });

  it('DROPS the key when the recorded previous is ABSENT', async () => {
    // The record never carried the key, so it is left exactly as it was. Since
    // issue #1733 `oldBilling` for this shape is the LIVE reading rather than a
    // blind create-path default, which is what makes the drop safe rather than
    // a lost flip: the key stays absent, so the NEXT deploy re-reads AWS
    // instead of comparing against a snapshot this arm would have frozen in.
    mockSend.mockReset();
    mockSend.mockResolvedValue(provisionedTableResponse());
    const previous: Record<string, unknown> = { ...baseProps };
    delete previous['BillingMode'];

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: '' },
      previous
    );

    expect(result.effectiveProperties).toBeDefined();
    expect('BillingMode' in (result.effectiveProperties ?? {})).toBe(false);
  });

  it.each([
    ['blank', ''],
    // `null` is the shape an older binary most plausibly wrote, and it is the
    // one an `== null` split would silently move to the DROP branch.
    ['null', null],
    // NOT ['PROVISIONED'], which stringifies to exactly the live mode. Be
    // precise about the mutation that kills: a predicate-only coercion records
    // the raw ARRAY and fails either row; what this row adds is coverage of
    // coerce-at-the-predicate AND at the read, where ['PROVISIONED'] would
    // coincide with the live reading and survive.
    ['an array', ['PAY_PER_REQUEST']],
  ])(
    'RESTORES the live mode when the recorded previous is %s (present but UNUSABLE)',
    async (_label, previousMode) => {
      // Dropping here instead would be the tidier-looking regression review
      // caught: a dropped key reads as ABSENT next time, and the absent branch
      // does not consult AWS, so a corrected PAY_PER_REQUEST template would
      // compare equal and silently lose the flip on this live PROVISIONED table.
      mockSend.mockReset();
      mockSend.mockResolvedValue(provisionedTableResponse());

      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: '' },
        { ...baseProps, BillingMode: previousMode }
      );

      expect(result.effectiveProperties?.['BillingMode']).toBe('PROVISIONED');
    }
  );

  it('does NOT overwrite a recorded mode that AWS has drifted away from', async () => {
    // Fences the `liveBillingMode` answer specifically — NOT the `oldBilling`
    // one, which for a USABLE recorded previous is that same recorded value.
    // Recording the live mode would silently reconcile an out-of-band re-price
    // into the baseline; that is `cdkd drift`'s finding, not this arm's to
    // erase. The default mock reports PAY_PER_REQUEST against a recorded
    // PROVISIONED, so the two answers differ here.
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: '' },
      { ...baseProps, BillingMode: 'PROVISIONED' }
    );

    expect(result.effectiveProperties?.['BillingMode']).toBe('PROVISIONED');
  });

  it('answers with NO effectiveProperties for a VALID BillingMode on the update path', async () => {
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(result.effectiveProperties).toBeUndefined();
  });

  // ─── ARM 2: desiredGsiUnusable warn-and-SKIP on the update path ─────────

  it('records the PREVIOUS GlobalSecondaryIndexes when the update SUPPRESSES the diff', async () => {
    const desired = { ...baseProps, GlobalSecondaryIndexes: 'oops-not-an-array' };

    const result = await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, {
      ...baseProps,
      GlobalSecondaryIndexes: VALID_GSI,
    });

    // On UPDATE the answer is "retain the PREVIOUS value" — the create side's
    // OMIT would read as "the template declares no GSIs" and derive a delete
    // of every live index.
    expect(result.effectiveProperties?.['GlobalSecondaryIndexes']).toEqual(VALID_GSI);
    expect(result.effectiveProperties).toEqual({
      ...desired,
      GlobalSecondaryIndexes: VALID_GSI,
    });

    // The WIRE half of the same claim, in this test rather than a sibling
    // file: retaining the previous list is only correct BECAUSE the diff was
    // suppressed. A mutation that both sends a GSI update and retains the
    // previous value satisfies the record assertions above.
    expect(updateInputs().some((i) => 'GlobalSecondaryIndexUpdates' in i)).toBe(false);

    // ...and the skip is still ANNOUNCED.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GlobalSecondaryIndexes')
    );
  });

  it('COPIES the previous index list rather than aliasing the previous bag', async () => {
    // `rollback-executor.ts` spreads the returned bag shallowly, so an alias
    // would leave two state records sharing one mutable array.
    const previousIndexes = [...VALID_GSI];

    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: 'oops-not-an-array' },
      { ...baseProps, GlobalSecondaryIndexes: previousIndexes }
    );

    expect(result.effectiveProperties?.['GlobalSecondaryIndexes']).toEqual(previousIndexes);
    expect(result.effectiveProperties?.['GlobalSecondaryIndexes']).not.toBe(previousIndexes);
  });

  it.each([
    ['a bare string', 'also-not-an-array'],
    ['an object', { IndexName: 'byThing' }],
    ['a number', 7],
  ])(
    'DROPS the key when the PREVIOUS GlobalSecondaryIndexes is %s',
    async (_label, previousIndexes) => {
      // `previousProperties` is a cdkd STATE record, so a replay whose record
      // was written by an older binary can be junk too — copying it in would
      // re-create the phantom drift from the other direction.
      const result = await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, GlobalSecondaryIndexes: 'oops-not-an-array' },
        { ...baseProps, GlobalSecondaryIndexes: previousIndexes }
      );

      expect(result.effectiveProperties).toBeDefined();
      expect('GlobalSecondaryIndexes' in (result.effectiveProperties ?? {})).toBe(false);
      expect(result.effectiveProperties).toEqual(baseProps);
    }
  );

  it('DROPS the key when the previous side declares NO indexes at all', async () => {
    // Nothing to retain. An explicit `undefined` would survive the spread and
    // read differently across `JSON.stringify` on the two sides of the next
    // diff, so the key must be genuinely absent.
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: 'oops-not-an-array' },
      { ...baseProps }
    );

    expect(result.effectiveProperties).toBeDefined();
    expect('GlobalSecondaryIndexes' in (result.effectiveProperties ?? {})).toBe(false);
  });

  it('RETAINS a previous EMPTY index list, which is a legitimate recorded value', async () => {
    // `[]` is what a template declaring no indexes records once one was
    // removed; it is not malformed, so it must not be swept up by the guard.
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: 'oops-not-an-array' },
      { ...baseProps, GlobalSecondaryIndexes: [] }
    );

    expect(result.effectiveProperties?.['GlobalSecondaryIndexes']).toEqual([]);
  });

  it('answers with NO effectiveProperties when the desired index list is VALID', async () => {
    const result = await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: VALID_GSI },
      { ...baseProps, GlobalSecondaryIndexes: VALID_GSI }
    );

    expect(result.effectiveProperties).toBeUndefined();
  });
});
