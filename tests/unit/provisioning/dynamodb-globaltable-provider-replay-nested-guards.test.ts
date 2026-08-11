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
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/**
 * `CreateContext.replayingState` downgrade for the two NESTED-container
 * guards in `create()` (issue #1544), completing what #1542 did for the
 * top-level `BillingMode` read:
 *
 * - the `StreamSpecification` guard (`readConfigString`, which had no options
 *   parameter at all before this fix), and
 * - the `GlobalSecondaryIndexes` non-array guard inside
 *   `toSdkGlobalSecondaryIndexes` (an inline throw with no downgrade hook).
 *
 * A state record carrying `StreamSpecification: ''` (or a non-array GSI blob)
 * previously made the rollback executor's reverse-replacement create hard-
 * throw — the resource became un-rollbackable with only a hand-edit of
 * state.json as a remedy, exactly the hazard the replay downgrade exists to
 * prevent. Downgrade semantics are well-defined, never fabricated: a
 * malformed StreamSpecification behaves as `{}` (stream enabled with the
 * NEW_AND_OLD_IMAGES default an empty block already means), and a malformed
 * GSI blob is OMITTED (zero indexes).
 */
describe('DynamoDBGlobalTableProvider nested guards on a state replay (issue #1544)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBGlobalTableProvider();
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
    Replicas: [{ Region: 'us-east-1' }],
  };

  const activeTable = () =>
    mockSend.mockResolvedValue({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });

  const createCall = () =>
    mockSend.mock.calls.find((c) => c[0].constructor.name === 'CreateTableCommand');

  // ─── StreamSpecification: replay → warn + treat as {} ──────────────────

  it('WARNS on a malformed StreamSpecification CONTAINER and proceeds as {}', async () => {
    activeTable();

    await expect(
      provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, StreamSpecification: '' },
        { replayingState: true }
      )
    ).resolves.toBeDefined();

    // `{}` means "stream enabled, default view type" — the same thing an
    // empty block already means, so nothing is fabricated.
    expect(createCall()?.[0].input.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable StreamSpecification must be an object')
    );
  });

  it('WARNS on a malformed StreamViewType FIELD and proceeds with the default', async () => {
    activeTable();

    await expect(
      provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, StreamSpecification: { StreamViewType: null } },
        { replayingState: true }
      )
    ).resolves.toBeDefined();

    expect(createCall()?.[0].input.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'AWS::DynamoDB::GlobalTable StreamSpecification.StreamViewType must be a non-empty string'
      )
    );
  });

  it('leaves a VALID StreamSpecification untouched on a state replay', async () => {
    activeTable();

    await provider.create(
      'MyTable',
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: { StreamViewType: 'KEYS_ONLY' } },
      { replayingState: true }
    );

    expect(createCall()?.[0].input.StreamSpecification).toEqual({
      StreamEnabled: true,
      StreamViewType: 'KEYS_ONLY',
    });
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('StreamSpecification')
    );
  });

  // ─── StreamSpecification: template path → refusal stands ───────────────

  it('keeps the StreamSpecification refusal on an ordinary create (no context)', async () => {
    activeTable();

    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, StreamSpecification: '' })
    ).rejects.toThrow(
      /AWS::DynamoDB::GlobalTable StreamSpecification must be an object \(got a blank string\)/
    );
    expect(createCall()).toBeUndefined();
  });

  it('keeps the StreamSpecification refusal under replayingState: false, as a ProvisioningError', async () => {
    activeTable();

    const err = await provider
      .create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, StreamSpecification: 'NEW_IMAGE' },
        { replayingState: false }
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err).toMatchObject({ resourceType: RESOURCE_TYPE, logicalId: 'MyTable' });
    expect(createCall()).toBeUndefined();
  });

  // ─── GlobalSecondaryIndexes: replay → warn + omit the block ────────────

  it('WARNS on a non-array GlobalSecondaryIndexes and proceeds with NO indexes', async () => {
    activeTable();

    await expect(
      provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, GlobalSecondaryIndexes: 'bad' },
        { replayingState: true }
      )
    ).resolves.toBeDefined();

    // OMITTED, not fabricated: the malformed block yields zero indexes.
    expect(createCall()?.[0].input.GlobalSecondaryIndexes).toBeUndefined();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array')
    );
  });

  it('leaves a VALID GlobalSecondaryIndexes blob untouched on a state replay', async () => {
    activeTable();

    await provider.create(
      'MyTable',
      RESOURCE_TYPE,
      {
        ...baseProps,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'gsiPk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      },
      { replayingState: true }
    );

    const gsis = createCall()?.[0].input.GlobalSecondaryIndexes;
    expect(gsis).toHaveLength(1);
    expect(gsis[0].IndexName).toBe('my-index');
    expect(childLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('GlobalSecondaryIndexes')
    );
  });

  // ─── GlobalSecondaryIndexes: template path → refusal stands ────────────

  it('keeps the GSI refusal on an ordinary create (no context)', async () => {
    activeTable();

    await expect(
      provider.create('MyTable', RESOURCE_TYPE, { ...baseProps, GlobalSecondaryIndexes: 'bad' })
    ).rejects.toThrow(/GlobalSecondaryIndexes must be an array/);
    expect(createCall()).toBeUndefined();
  });

  it('keeps the GSI refusal when the context is present but carries no replay flag', async () => {
    activeTable();

    // `replayWarn` tests `=== true`, so an empty context bag is an ordinary
    // create — pinned so a future `!== false` refactor cannot silently turn
    // every context-carrying create into a warn.
    const err = await provider
      .create('MyTable', RESOURCE_TYPE, { ...baseProps, GlobalSecondaryIndexes: 'bad' }, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect(err).toMatchObject({ resourceType: RESOURCE_TYPE, logicalId: 'MyTable' });
    expect(createCall()).toBeUndefined();
  });

  it('keeps the GSI refusal under replayingState: false', async () => {
    activeTable();

    await expect(
      provider.create(
        'MyTable',
        RESOURCE_TYPE,
        { ...baseProps, GlobalSecondaryIndexes: 'bad' },
        { replayingState: false }
      )
    ).rejects.toThrow(/GlobalSecondaryIndexes must be an array/);
    expect(createCall()).toBeUndefined();
  });
});

/**
 * The UPDATE-path half of the same two guards (issue #1551).
 *
 * #1544 wired the downgrade at the `create()` call site only and recorded the
 * update sites as "left strict, deliberately" — but `update()` is replayed
 * too (`rollback-executor.ts`'s revert arm and `cdkd drift --revert` both call
 * `update(..., previousState.properties, ...)`), so a state record carrying
 * either malformed shape strands the replay there as well.
 *
 * The per-site semantics DIFFER from the create side, which is why #1551 asks
 * for a decision per site rather than a blanket downgrade:
 *
 * - StreamSpecification: SKIP the block (leave the live stream alone) rather
 *   than send the NEW_AND_OLD_IMAGES default, which would re-point a live
 *   stream the template never asked to change.
 * - GlobalSecondaryIndexes: SUPPRESS the diff. The create side's "omit" means
 *   a fresh table with no indexes; on update an empty desired list means
 *   "delete every live index", so applying it would be destructive.
 */
describe('DynamoDBGlobalTableProvider nested guards on the UPDATE path (issue #1551)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableStatus: 'ACTIVE',
        TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'gsiPk', AttributeType: 'S' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    Replicas: [{ Region: 'us-east-1' }],
  };

  const liveIndex = {
    IndexName: 'my-index',
    KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
    Projection: { ProjectionType: 'ALL' },
  };

  /** Every UpdateTable input this update issued. */
  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  const gsiActions = (): unknown[] =>
    updateInputs().flatMap((i) => (i['GlobalSecondaryIndexUpdates'] as unknown[]) ?? []);

  // ─── StreamSpecification ───────────────────────────────────────────────

  it('WARNS on a malformed StreamSpecification and leaves the live stream untouched', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: '' },
      { ...baseProps, StreamSpecification: { StreamViewType: 'KEYS_ONLY' } }
    );

    // SKIPPED, never defaulted: no UpdateTable carries a StreamSpecification.
    expect(updateInputs().some((i) => 'StreamSpecification' in i)).toBe(false);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable StreamSpecification')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('left untouched for this update')
    );
  });

  it('still applies a VALID StreamSpecification change', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, StreamSpecification: { StreamViewType: 'NEW_IMAGE' } },
      { ...baseProps, StreamSpecification: { StreamViewType: 'KEYS_ONLY' } }
    );

    const streamUpdate = updateInputs().find((i) => 'StreamSpecification' in i);
    expect(streamUpdate?.['StreamSpecification']).toEqual({
      StreamEnabled: true,
      StreamViewType: 'NEW_IMAGE',
    });
  });

  // ─── GlobalSecondaryIndexes ────────────────────────────────────────────

  it('WARNS on a malformed DESIRED GSI blob and emits NO GSI action', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: 'bad' },
      { ...baseProps, GlobalSecondaryIndexes: [liveIndex] }
    );

    // The destructive reading — "the template declares no indexes, so delete
    // the live one" — must NOT happen.
    expect(gsiActions()).toEqual([]);
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AWS::DynamoDB::GlobalTable GlobalSecondaryIndexes must be an array')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('existing indexes are left untouched')
    );
  });

  it('a malformed PREVIOUS (state-recorded) blob falls back to the LIVE indexes as baseline', async () => {
    // The previous side comes from cdkd state, never from the template, so a
    // refusal there is unrecoverable by editing the CDK code. Before #1551
    // this call site had no hook at all and threw.
    //
    // Suppressing the diff here would be the #1552 class one property over:
    // the warn path records the junk block as state, so THIS deploy is the one
    // carrying the user's corrected template. Dropping its GSI add would lose
    // the index permanently — the next deploy sees previous == desired. So the
    // baseline comes from the live table, and the add still goes out.
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableStatus: 'ACTIVE',
        TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
        // No live indexes: the corrected template's index is a genuine ADD.
        GlobalSecondaryIndexes: [],
      },
    });

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: [liveIndex] },
      { ...baseProps, GlobalSecondaryIndexes: 'bad' }
    );

    expect(gsiActions()).toHaveLength(1);
    expect(gsiActions()[0]).toMatchObject({ Create: { IndexName: 'my-index' } });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('recorded in cdkd state, not in the template')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("using the table's LIVE indexes as the comparison baseline")
    );
  });

  it('the LIVE baseline suppresses a re-create of an index that already exists', async () => {
    // The other direction of the same fallback: with the index already live,
    // the corrected template is a no-op — an empty baseline would have tried
    // to CreateGlobalSecondaryIndex on an existing index and failed.
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableStatus: 'ACTIVE',
        TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            // Bookkeeping fields the mapping must NOT carry into the diff.
            IndexStatus: 'ACTIVE',
            ItemCount: 42,
          },
        ],
      },
    });

    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: [liveIndex] },
      { ...baseProps, GlobalSecondaryIndexes: 'bad' }
    );

    expect(gsiActions()).toEqual([]);
  });

  it('still emits the GSI diff when both sides are well-formed', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, GlobalSecondaryIndexes: [liveIndex] },
      { ...baseProps }
    );

    expect(gsiActions()).toHaveLength(1);
    expect(gsiActions()[0]).toMatchObject({ Create: { IndexName: 'my-index' } });
  });

  // ─── The BillingMode-flip branch reaches the helper twice more ─────────
  //
  // Step 4's PAY_PER_REQUEST -> PROVISIONED flip translates BOTH bags again
  // (AWS requires per-index capacity in the same UpdateTable), so those two
  // call sites need the downgrade as much as the step-2 / step-6 ones — a
  // spec review caught them unwired, several hundred lines from the guard
  // that had already warned. With the block untrustworthy the per-index
  // capacity cannot be derived, so the flip itself is SUPPRESSED rather than
  // sent for AWS to reject.
  describe('BillingMode flip with an unusable GSI block', () => {
    const provisionedDesired = {
      ...baseProps,
      BillingMode: 'PROVISIONED',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
    };

    const billingFlipInputs = (): Array<Record<string, unknown>> =>
      updateInputs().filter((i) => i['BillingMode'] !== undefined);

    it('SUPPRESSES the flip to PROVISIONED when the DESIRED block is unusable', async () => {
      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...provisionedDesired, GlobalSecondaryIndexes: 'bad' },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [liveIndex] }
      );

      expect(billingFlipInputs()).toEqual([]);
      expect(gsiActions()).toEqual([]);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('skipping the PAY_PER_REQUEST -> PROVISIONED BillingMode flip')
      );
    });

    it('still APPLIES the flip when only the PREVIOUS (state-recorded) block is unusable', async () => {
      // The previous side is only translated inside the flip branch and again
      // in step 6, so before the fix this threw AFTER step 3 had already sent
      // its UpdateTable — a half-applied update on a value the user cannot
      // edit from the template.
      //
      // It is NOT suppressed, unlike the desired-side case: the previous side
      // is recoverable from the live table, so the flip has a trustworthy
      // source for the per-index capacity AWS requires in this call — and the
      // desired side (the user's template) is fine.
      mockSend.mockResolvedValue({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'my-index',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
        },
      });

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...provisionedDesired, GlobalSecondaryIndexes: [liveIndex] },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: 'bad' }
      );

      expect(billingFlipInputs()).toHaveLength(1);
      expect(billingFlipInputs()[0]).toMatchObject({ BillingMode: 'PROVISIONED' });
      // The live index still gets capacity in the SAME call — an empty
      // baseline would have omitted it and AWS would reject the flip.
      expect(billingFlipInputs()[0]?.['GlobalSecondaryIndexUpdates']).toEqual([
        expect.objectContaining({ Update: expect.objectContaining({ IndexName: 'my-index' }) }),
      ]);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('recorded in cdkd state, not in the template')
      );
    });

    it('still APPLIES a well-formed flip to PROVISIONED (the fence)', async () => {
      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...provisionedDesired, GlobalSecondaryIndexes: [liveIndex] },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [liveIndex] }
      );

      expect(billingFlipInputs()).toHaveLength(1);
      expect(billingFlipInputs()[0]).toMatchObject({ BillingMode: 'PROVISIONED' });
      expect(childLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('skipping the')
      );
    });

    it('does NOT suppress a flip to PAY_PER_REQUEST (no per-index capacity needed)', async () => {
      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: 'bad' },
        { ...baseProps, BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [liveIndex] }
      );

      expect(billingFlipInputs()).toHaveLength(1);
      expect(billingFlipInputs()[0]).toMatchObject({ BillingMode: 'PAY_PER_REQUEST' });
      // The GSI diff is still suppressed — only the flip is unaffected.
      expect(gsiActions()).toEqual([]);
    });
  });
});
