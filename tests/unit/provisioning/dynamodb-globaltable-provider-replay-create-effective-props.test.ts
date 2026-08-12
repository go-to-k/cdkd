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

import {
  DynamoDBGlobalTableProvider,
  stripProvisionedCapacityKeys,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/**
 * The two replay-CREATE `effectiveProperties` arms `DynamoDBGlobalTableProvider`
 * left unanswered after issue #1683 / PR #1722:
 *
 * - issue #1724 — the `GlobalSecondaryIndexes` downgrade OMITS the block, so
 *   `CreateTable` carries no indexes while the engine recorded the malformed
 *   desired blob. Nothing was applied, so the answer is DROP the key (the
 *   `.claude/rules/providers.md` replay-CREATE + SKIP row).
 * - issue #1726 — the `BillingMode` warn-and-SUBSTITUTE arm rewrote only
 *   `BillingMode`, although sending PAY_PER_REQUEST ALSO skips every
 *   PROVISIONED-only capacity member. Those keys stayed recorded although
 *   nothing sent them, which is the same permanent phantom drift the arm exists
 *   to remove, one key over.
 *
 * Both are only reachable through the rollback executor's reverse-replacement
 * create (`CreateContext.replayingState`), which HONOURS `effectiveProperties`
 * as of issue #1682.
 */
describe('DynamoDBGlobalTableProvider replay-CREATE effectiveProperties (issues #1724 / #1726)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBGlobalTableProvider();
    mockSend.mockResolvedValue({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    Replicas: [{ Region: 'us-east-1' }],
  };

  const replayCreate = (props: Record<string, unknown>) =>
    provider.create('MyTable', RESOURCE_TYPE, props, { replayingState: true });

  // ─── issue #1724: the GSI omit DROPS the key ──────────────────────────

  it('DROPS GlobalSecondaryIndexes from the effective bag when the block was omitted', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
    });

    // The key is REMOVED, not set to `[]` / `undefined`: a present-but-undefined
    // key survives `structuredClone` and every `Object.keys` consumer (the
    // `unionWalkObjects` drift path) still sees two different key sets.
    expect(result.effectiveProperties).toBeDefined();
    expect('GlobalSecondaryIndexes' in result.effectiveProperties!).toBe(false);
    // Every other declared key is preserved — this replaces the desired bag
    // WHOLESALE, so an incomplete answer would blank the record.
    expect(result.effectiveProperties).toMatchObject({
      TableName: TABLE_NAME,
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('keeps a Replicas[].GlobalSecondaryIndexes override when only the TOP-LEVEL block was malformed', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: 'bad',
      Replicas: [
        {
          Region: 'us-east-1',
          GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }],
        },
      ],
    });

    // The override is a SEPARATE template key the guard never read and never
    // refused. Withdrawing it because a different key was malformed would
    // record a loss that did not happen.
    expect(result.effectiveProperties?.['Replicas']).toEqual([
      { Region: 'us-east-1', GlobalSecondaryIndexes: [{ IndexName: 'gsi1' }] },
    ]);
  });

  it('reports NO effective bag when the GSI blob is VALID on a replay', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });

    // Absent means "record the desired properties" — the arm must not fire on
    // a well-formed bag.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('keeps the GSI refusal on a TEMPLATE-path create, recording nothing', async () => {
    await expect(
      provider.create('MyTable', RESOURCE_TYPE, {
        ...baseProps,
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: 'bad',
      })
    ).rejects.toThrow(/GlobalSecondaryIndexes must be an array/);
  });

  // ─── issue #1726: the BillingMode substitution strips capacity keys ────

  it('records the SUBSTITUTED BillingMode and strips the top-level provisioned block', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
    });

    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    // `createParams.ProvisionedThroughput` is skipped entirely under the
    // substituted mode, and `readCurrentState` emits `{}` here — so recording
    // `{ WriteCapacityUnits: 25 }` is a value AWS never received.
    expect('WriteProvisionedThroughputSettings' in result.effectiveProperties!).toBe(false);
  });

  it('strips the per-replica and per-index provisioned capacity blocks', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 7 },
        },
      ],
      Replicas: [
        {
          Region: 'us-east-1',
          ReadProvisionedThroughputSettings: { ReadCapacityUnits: 11 },
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              ReadProvisionedThroughputSettings: { ReadCapacityUnits: 13 },
            },
          ],
        },
      ],
    });

    const indexes = result.effectiveProperties?.['GlobalSecondaryIndexes'] as Array<
      Record<string, unknown>
    >;
    expect('WriteProvisionedThroughputSettings' in indexes[0]!).toBe(false);
    // The rest of the index entry is untouched — the strip is per MEMBER, not
    // per entry.
    expect(indexes[0]).toMatchObject({ IndexName: 'gsi1', Projection: { ProjectionType: 'ALL' } });

    const replicas = result.effectiveProperties?.['Replicas'] as Array<Record<string, unknown>>;
    expect('ReadProvisionedThroughputSettings' in replicas[0]!).toBe(false);
    const replicaIndexes = replicas[0]!['GlobalSecondaryIndexes'] as Array<
      Record<string, unknown>
    >;
    expect('ReadProvisionedThroughputSettings' in replicaIndexes[0]!).toBe(false);
    expect(replicaIndexes[0]).toMatchObject({ IndexName: 'gsi1' });
  });

  it('PRESERVES the on-demand ceilings, which the substituted mode does send', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 100 },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'sk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 50 },
        },
      ],
      Replicas: [
        {
          Region: 'us-east-1',
          ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 200 },
        },
      ],
    });

    // `OnDemandThroughput` is attached to CreateTable precisely when the mode
    // is NOT PROVISIONED, so these WERE sent. A blanket "strip every throughput
    // key" would pass every assertion above and fail here.
    expect(result.effectiveProperties?.['WriteOnDemandThroughputSettings']).toEqual({
      MaxWriteRequestUnits: 100,
    });
    const indexes = result.effectiveProperties?.['GlobalSecondaryIndexes'] as Array<
      Record<string, unknown>
    >;
    expect(indexes[0]!['WriteOnDemandThroughputSettings']).toEqual({ MaxWriteRequestUnits: 50 });
    const replicas = result.effectiveProperties?.['Replicas'] as Array<Record<string, unknown>>;
    expect(replicas[0]!['ReadOnDemandThroughputSettings']).toEqual({ MaxReadRequestUnits: 200 });
  });

  it('reports NO effective bag when BillingMode is VALID, even if capacity keys are present', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: 'PROVISIONED',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
    });

    // Nothing was substituted, so the provisioned block really was sent and
    // must stay recorded. Stripping unconditionally would erase a live value.
    expect(result.effectiveProperties).toBeUndefined();
  });

  // ─── both arms in ONE create ──────────────────────────────────────────

  it('composes the BillingMode strip and the GSI drop when a record carries both', async () => {
    const result = await replayCreate({
      ...baseProps,
      BillingMode: '',
      WriteProvisionedThroughputSettings: { WriteCapacityUnits: 25 },
      GlobalSecondaryIndexes: 'bad',
    });

    // The GSI arm runs LAST and must compose onto the BillingMode arm's bag
    // (`?? properties`) rather than overwrite it.
    expect(result.effectiveProperties?.['BillingMode']).toBe('PAY_PER_REQUEST');
    expect('WriteProvisionedThroughputSettings' in result.effectiveProperties!).toBe(false);
    expect('GlobalSecondaryIndexes' in result.effectiveProperties!).toBe(false);
  });
});

describe('stripProvisionedCapacityKeys (issue #1726)', () => {
  it('does NOT mutate the caller bag or its nested containers', () => {
    const replicaIndex = { IndexName: 'gsi1', ReadProvisionedThroughputSettings: { x: 1 } };
    const replica = {
      Region: 'us-east-1',
      ReadProvisionedThroughputSettings: { y: 2 },
      GlobalSecondaryIndexes: [replicaIndex],
    };
    const index = { IndexName: 'gsi1', WriteProvisionedThroughputSettings: { z: 3 } };
    const input = {
      WriteProvisionedThroughputSettings: { w: 4 },
      GlobalSecondaryIndexes: [index],
      Replicas: [replica],
    };

    stripProvisionedCapacityKeys(input);

    // The replay caller's bag IS `previousState.properties`, and the rollback
    // executor spreads the answer shallowly — an in-place edit would corrupt
    // the record the caller still holds.
    expect(input.WriteProvisionedThroughputSettings).toEqual({ w: 4 });
    expect(index.WriteProvisionedThroughputSettings).toEqual({ z: 3 });
    expect(replica.ReadProvisionedThroughputSettings).toEqual({ y: 2 });
    expect(replicaIndex.ReadProvisionedThroughputSettings).toEqual({ x: 1 });
  });

  it('passes non-object array entries through untouched', () => {
    const out = stripProvisionedCapacityKeys({
      GlobalSecondaryIndexes: [null, 'unresolved'],
      Replicas: [null, 42],
    });

    // An unresolved intrinsic must not be rewritten into `{}` — AWS surfaces
    // the real validation error instead.
    expect(out['GlobalSecondaryIndexes']).toEqual([null, 'unresolved']);
    expect(out['Replicas']).toEqual([null, 42]);
  });

  it('leaves a bag with no capacity keys structurally unchanged', () => {
    const input = { TableName: 't', Replicas: [{ Region: 'us-east-1' }] };
    expect(stripProvisionedCapacityKeys(input)).toEqual(input);
  });
});
