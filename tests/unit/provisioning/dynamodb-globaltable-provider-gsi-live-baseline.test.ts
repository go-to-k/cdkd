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
  buildLiveRecoveryGsiBaseline,
  collectAutoScaledGsiNames,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/**
 * Issue #1571 — the residual #1551 / PR #1562 measured and left open.
 *
 * #1562 recovered from an unusable state-recorded `GlobalSecondaryIndexes` by
 * seeding the diff baseline from the LIVE table, taking only the index NAMES.
 * That stopped the permanent index loss but made every carried entry a
 * byte-copy of its desired counterpart, so the diff could only ever produce
 * ADDs: a capacity edit and a #1160-class on-demand ceiling REMOVAL both
 * silently lagged a deploy.
 *
 * This suite pins the value-carrying baseline AND the three exclusions that
 * are NOT negotiable, because each is a measured failure mode of the first
 * attempt rather than a hypothetical.
 */
describe('GlobalTable GSI live recovery baseline (issue #1571)', () => {
  describe('collectAutoScaledGsiNames', () => {
    it('finds the replica-level READ auto-scaling block (the canonical CDK spelling)', () => {
      const names = collectAutoScaledGsiNames(
        {
          GlobalSecondaryIndexes: [{ IndexName: 'idx' }],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'idx',
                  ReadProvisionedThroughputSettings: {
                    ReadCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 10 },
                  },
                },
              ],
            },
          ],
        },
        'us-east-1'
      );
      expect([...names]).toEqual(['idx']);
    });

    it('finds the GSI-level WRITE auto-scaling block', () => {
      const names = collectAutoScaledGsiNames(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'idx',
              WriteProvisionedThroughputSettings: {
                WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20 },
              },
            },
          ],
        },
        'us-east-1'
      );
      expect([...names]).toEqual(['idx']);
    });

    it('does NOT flag an index whose capacity is a literal', () => {
      const names = collectAutoScaledGsiNames(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'idx',
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: 7 },
            },
          ],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                { IndexName: 'idx', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 3 } },
              ],
            },
          ],
        },
        'us-east-1'
      );
      expect([...names]).toEqual([]);
    });

    it('ignores a replica entry for a DIFFERENT region', () => {
      const names = collectAutoScaledGsiNames(
        {
          GlobalSecondaryIndexes: [{ IndexName: 'idx' }],
          Replicas: [
            {
              Region: 'eu-west-1',
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'idx',
                  ReadProvisionedThroughputSettings: {
                    ReadCapacityAutoScalingSettings: { MinCapacity: 1 },
                  },
                },
              ],
            },
          ],
        },
        'us-east-1'
      );
      expect([...names]).toEqual([]);
    });

    it('treats a block that is itself an unresolved intrinsic as autoscaled', () => {
      // "Might be autoscaled" must read as "is": a false positive costs one
      // deploy of capacity lag, a false negative issues a scale-down nobody
      // asked for.
      const names = collectAutoScaledGsiNames(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'idx',
              WriteProvisionedThroughputSettings: {
                WriteCapacityAutoScalingSettings: { Ref: 'SomeParam' },
              },
            },
          ],
        },
        'us-east-1'
      );
      expect([...names]).toEqual(['idx']);
    });

    it('returns empty for a non-array GlobalSecondaryIndexes rather than throwing', () => {
      expect([...collectAutoScaledGsiNames({ GlobalSecondaryIndexes: 'bad' }, 'us-east-1')]).toEqual(
        []
      );
    });
  });

  describe('buildLiveRecoveryGsiBaseline', () => {
    const desired = [
      {
        IndexName: 'idx',
        KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
        Projection: { ProjectionType: 'ALL' as const },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
    ];

    it('carries LIVE provisioned capacity on a provisioned table', () => {
      const baseline = buildLiveRecoveryGsiBaseline(
        desired,
        [
          {
            IndexName: 'idx',
            // Bookkeeping members `DescribeTable` adds must not reach the diff.
            ProvisionedThroughput: {
              ReadCapacityUnits: 11,
              WriteCapacityUnits: 22,
              NumberOfDecreasesToday: 3,
            },
            IndexStatus: 'ACTIVE',
            ItemCount: 42,
          },
        ],
        {
          carryLiveValues: true,
          liveBillingMode: 'PROVISIONED',
          autoScaledIndexNames: new Set(),
        }
      );
      expect(baseline).toEqual([
        {
          IndexName: 'idx',
          KeySchema: desired[0]?.KeySchema,
          Projection: desired[0]?.Projection,
          ProvisionedThroughput: { ReadCapacityUnits: 11, WriteCapacityUnits: 22 },
        },
      ]);
    });

    it('keeps the desired-side key ORDER so the JSON.stringify diff is not fooled', () => {
      // `deepEqual` is `JSON.stringify`, so an entry rebuilt member-by-member
      // would differ from its own translated counterpart on ordering alone —
      // one of the three measured failure modes of the first attempt.
      const [entry] = buildLiveRecoveryGsiBaseline(
        desired,
        [{ IndexName: 'idx', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } }],
        { carryLiveValues: true, liveBillingMode: 'PROVISIONED', autoScaledIndexNames: new Set() }
      );
      expect(Object.keys(entry ?? {})).toEqual(Object.keys(desired[0] ?? {}));
      expect(JSON.stringify(entry)).toBe(JSON.stringify(desired[0]));
    });

    it('does NOT carry provisioned capacity for an AUTOSCALED index', () => {
      // Live 10 vs the template's MinCapacity 1 is not an edit — both numbers
      // are correct, they answer different questions. Comparing them reads as
      // a scale-down nobody asked for.
      const [entry] = buildLiveRecoveryGsiBaseline(
        desired,
        [
          {
            IndexName: 'idx',
            ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
          },
        ],
        {
          carryLiveValues: true,
          liveBillingMode: 'PROVISIONED',
          autoScaledIndexNames: new Set(['idx']),
        }
      );
      expect(entry?.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
    });

    it('ignores the {0, 0} provisioned block DescribeTable reports on an on-demand table', () => {
      const onDemandDesired = [
        {
          IndexName: 'idx',
          KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
          Projection: { ProjectionType: 'ALL' as const },
        },
      ];
      const [entry] = buildLiveRecoveryGsiBaseline(
        onDemandDesired,
        [
          {
            IndexName: 'idx',
            ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
            OnDemandThroughput: { MaxReadRequestUnits: 100 },
          },
        ],
        { carryLiveValues: true, liveBillingMode: 'PAY_PER_REQUEST', autoScaledIndexNames: new Set() }
      );
      expect(entry?.ProvisionedThroughput).toBeUndefined();
      expect(entry?.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 100 });
    });

    it('never INTRODUCES a provisioned block the desired side lacks', () => {
      // A baseline block the desired side lacks reads as "the template removed
      // provisioned capacity" — not expressible on a provisioned table, and
      // the `modified` loop would find nothing to send and print the
      // misleading "recreate the index" warning.
      const [entry] = buildLiveRecoveryGsiBaseline(
        [
          {
            IndexName: 'idx',
            KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
            Projection: { ProjectionType: 'ALL' as const },
          },
        ],
        [
          {
            IndexName: 'idx',
            ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 },
          },
        ],
        { carryLiveValues: true, liveBillingMode: 'PROVISIONED', autoScaledIndexNames: new Set() }
      );
      expect(entry?.ProvisionedThroughput).toBeUndefined();
    });

    it('DELETES the on-demand block when AWS reports no ceiling, so a first-time set applies', () => {
      const [entry] = buildLiveRecoveryGsiBaseline(
        [
          {
            IndexName: 'idx',
            KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
            Projection: { ProjectionType: 'ALL' as const },
            OnDemandThroughput: { MaxReadRequestUnits: 50 },
          },
        ],
        [{ IndexName: 'idx' }],
        { carryLiveValues: true, liveBillingMode: 'PAY_PER_REQUEST', autoScaledIndexNames: new Set() }
      );
      expect('OnDemandThroughput' in (entry ?? {})).toBe(false);
    });

    it('is IDENTITY-ONLY when carryLiveValues is false (a billing flip is in play)', () => {
      const [entry] = buildLiveRecoveryGsiBaseline(
        desired,
        [
          {
            IndexName: 'idx',
            ProvisionedThroughput: { ReadCapacityUnits: 99, WriteCapacityUnits: 99 },
          },
        ],
        { carryLiveValues: false, liveBillingMode: 'PROVISIONED', autoScaledIndexNames: new Set() }
      );
      expect(entry).toEqual(desired[0]);
    });

    it('omits a desired index that does not exist live (it is an ADD)', () => {
      expect(
        buildLiveRecoveryGsiBaseline(desired, [{ IndexName: 'other' }], {
          carryLiveValues: true,
          liveBillingMode: 'PROVISIONED',
          autoScaledIndexNames: new Set(),
        })
      ).toEqual([]);
    });

    it('never carries a LIVE-ONLY index, so no Delete can be derived from it', () => {
      const baseline = buildLiveRecoveryGsiBaseline(
        desired,
        [{ IndexName: 'idx' }, { IndexName: 'stale' }],
        {
          carryLiveValues: true,
          liveBillingMode: 'PROVISIONED',
          autoScaledIndexNames: new Set(),
        }
      );
      expect(baseline.map((g) => g.IndexName)).toEqual(['idx']);
    });
  });

  describe('update() end to end', () => {
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
      Replicas: [{ Region: 'us-east-1' }],
    };

    const describeTable = (table: Record<string, unknown>): void => {
      mockSend.mockResolvedValue({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          TableArn: `arn:aws:dynamodb:us-east-1:0:table/${TABLE_NAME}`,
          Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          ...table,
        },
      });
    };

    const gsiActions = (): Array<Record<string, Record<string, unknown>>> =>
      mockSend.mock.calls
        .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
        .flatMap(
          (c) =>
            ((c[0].input as Record<string, unknown>)['GlobalSecondaryIndexUpdates'] as Array<
              Record<string, Record<string, unknown>>
            >) ?? []
        );

    it('applies a CAPACITY edit on the recovery deploy instead of lagging one', async () => {
      describeTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          },
        ],
      });

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          ...baseProps,
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'my-index',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: 8 },
            },
          ],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                { IndexName: 'my-index', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 6 } },
              ],
            },
          ],
        },
        { ...baseProps, BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: 'bad' }
      );

      expect(gsiActions()).toHaveLength(1);
      expect(gsiActions()[0]?.['Update']).toMatchObject({
        IndexName: 'my-index',
        ProvisionedThroughput: { ReadCapacityUnits: 6, WriteCapacityUnits: 8 },
      });
    });

    it('applies the #1160 on-demand ceiling RESET on the recovery deploy', async () => {
      // The `-1` reset is derived from the PREVIOUS side. With #1562's
      // desired-copy baseline the previous side never carried the live
      // ceiling, so a template that dropped it left the ceiling live in AWS
      // forever while cdkd reported success.
      describeTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 200 },
          },
        ],
      });

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          ...baseProps,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'my-index',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              // Both ceilings dropped by the corrected template.
            },
          ],
        },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: 'bad' }
      );

      expect(gsiActions()).toHaveLength(1);
      expect(gsiActions()[0]?.['Update']).toMatchObject({
        IndexName: 'my-index',
        OnDemandThroughput: { MaxReadRequestUnits: -1, MaxWriteRequestUnits: -1 },
      });
    });

    it('issues NO capacity call when the live values already match the template', async () => {
      describeTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            ProvisionedThroughput: { ReadCapacityUnits: 6, WriteCapacityUnits: 8 },
          },
        ],
      });

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          ...baseProps,
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'my-index',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: 8 },
            },
          ],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                { IndexName: 'my-index', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 6 } },
              ],
            },
          ],
        },
        { ...baseProps, BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: 'bad' }
      );

      expect(gsiActions()).toEqual([]);
    });

    it('issues NO scale-down for an AUTOSCALED index that has scaled up past its min', async () => {
      describeTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            ProvisionedThroughput: { ReadCapacityUnits: 40, WriteCapacityUnits: 40 },
          },
        ],
      });

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          ...baseProps,
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'my-index',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WriteProvisionedThroughputSettings: {
                WriteCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 100 },
              },
            },
          ],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'my-index',
                  ReadProvisionedThroughputSettings: {
                    ReadCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 100 },
                  },
                },
              ],
            },
          ],
        },
        { ...baseProps, BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: 'bad' }
      );

      expect(gsiActions()).toEqual([]);
    });

    it('still issues no Delete for a live-only index, and says how to clear it', async () => {
      describeTable({
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        GlobalSecondaryIndexes: [{ IndexName: 'my-index' }, { IndexName: 'stale-index' }],
      });

      await provider.update(
        'MyTable',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          ...baseProps,
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'my-index',
              KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
        },
        { ...baseProps, BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: 'bad' }
      );

      expect(gsiActions().filter((a) => 'Delete' in a)).toEqual([]);
      // The old wording promised convergence on a later deploy. It cannot
      // happen: once this deploy records a valid block the live-only index is
      // in neither side of every subsequent diff.
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('This does NOT self-heal')
      );
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('cdkd drift --accept')
      );
    });
  });
});
