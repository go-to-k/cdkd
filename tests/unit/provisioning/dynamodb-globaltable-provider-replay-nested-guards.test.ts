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
});
