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
  collectUncomparableCapacityGsiNames,
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
  describe('collectUncomparableCapacityGsiNames', () => {
    it('finds the replica-level READ auto-scaling block (the canonical CDK spelling)', () => {
      const names = collectUncomparableCapacityGsiNames(
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
      const names = collectUncomparableCapacityGsiNames(
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
      const names = collectUncomparableCapacityGsiNames(
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
      // The local capacity IS determined, so the only thing that could flag
      // this index is the foreign-region auto-scaling block being read.
      const names = collectUncomparableCapacityGsiNames(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'idx',
              ReadProvisionedThroughputSettings: { ReadCapacityUnits: 3 },
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: 4 },
            },
          ],
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
      const names = collectUncomparableCapacityGsiNames(
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

    it('treats a whole settings BLOCK that is an unresolved intrinsic as autoscaled', () => {
      // Nothing can see inside it, and the two readings are not symmetric:
      // "not autoscaled" makes the desired capacity fall through to cdkd's 5/5
      // default, which the live baseline then reads as an edit and WRITES.
      const names = collectUncomparableCapacityGsiNames(
        {
          GlobalSecondaryIndexes: [
            { IndexName: 'idx', WriteProvisionedThroughputSettings: { 'Fn::If': ['C', {}, {}] } },
          ],
        },
        'us-east-1'
      );
      expect([...names]).toEqual(['idx']);
    });

    it('flags an index whose capacity the template never DETERMINED (issue #1511 shape)', () => {
      // The destructive arm a review caught: nothing resolves to a number, so
      // `toSdkGlobalSecondaryIndexes` substitutes 5/5 and a live baseline would
      // turn cdkd's invented default into a scale-DOWN of a live table.
      const names = collectUncomparableCapacityGsiNames(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'idx',
              WriteProvisionedThroughputSettings: { WriteCapacityUnits: { Ref: 'SomeParam' } },
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
      expect([...names]).toEqual(['idx']);
    });

    it('flags an index that declares NO throughput block at all', () => {
      expect([
        ...collectUncomparableCapacityGsiNames(
          { GlobalSecondaryIndexes: [{ IndexName: 'idx' }] },
          'us-east-1'
        ),
      ]).toEqual(['idx']);
    });

    it('accepts an explicit SDK-shaped ProvisionedThroughput as determined', () => {
      // The translation MERGES the explicit block over the derived side, so a
      // number there is a number the template chose.
      expect([
        ...collectUncomparableCapacityGsiNames(
          {
            GlobalSecondaryIndexes: [
              {
                IndexName: 'idx',
                ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 4 },
              },
            ],
          },
          'us-east-1'
        ),
      ]).toEqual([]);
    });

    it('reads the GSI-LEVEL read block when the local replica has no entry', () => {
      // The hand-authored fallback spelling; without it this index would be
      // flagged as not-determined and its capacity never compared.
      expect([
        ...collectUncomparableCapacityGsiNames(
          {
            GlobalSecondaryIndexes: [
              {
                IndexName: 'idx',
                ReadProvisionedThroughputSettings: { ReadCapacityUnits: 3 },
                WriteProvisionedThroughputSettings: { WriteCapacityUnits: 4 },
              },
            ],
          },
          'us-east-1'
        ),
      ]).toEqual([]);
    });

    it('returns empty for a non-array GlobalSecondaryIndexes rather than throwing', () => {
      expect([...collectUncomparableCapacityGsiNames({ GlobalSecondaryIndexes: 'bad' }, 'us-east-1')]).toEqual(
        []
      );
    });
  });

  describe('buildLiveRecoveryGsiBaseline', () => {
    // `ProvisionedThroughput` is deliberately NOT the last member: a
    // member-by-member rebuild appends it, so a fixture that already had it
    // last would satisfy the key-ORDER assertion either way (review catch).
    const desired = [
      {
        IndexName: 'idx',
        KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        Projection: { ProjectionType: 'ALL' as const },
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
          uncomparableCapacityIndexNames: new Set(),
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
        { carryLiveValues: true, liveBillingMode: 'PROVISIONED', uncomparableCapacityIndexNames: new Set() }
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
          uncomparableCapacityIndexNames: new Set(['idx']),
        }
      );
      expect(entry?.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
    });

    it('ignores the {0, 0} provisioned block DescribeTable reports on an on-demand table', () => {
      // The desired side CARRIES a provisioned block, so the never-INTRODUCE
      // rule cannot be what suppresses it — only the live-billing-mode gate
      // can. (With no block the first assertion held either way.)
      const onDemandDesired = [
        {
          IndexName: 'idx',
          KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
          Projection: { ProjectionType: 'ALL' as const },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
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
        { carryLiveValues: true, liveBillingMode: 'PAY_PER_REQUEST', uncomparableCapacityIndexNames: new Set() }
      );
      // Unchanged from the desired side — the live `{0, 0}` never reached it.
      expect(entry?.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 5 });
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
        { carryLiveValues: true, liveBillingMode: 'PROVISIONED', uncomparableCapacityIndexNames: new Set() }
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
        { carryLiveValues: true, liveBillingMode: 'PAY_PER_REQUEST', uncomparableCapacityIndexNames: new Set() }
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
        { carryLiveValues: false, liveBillingMode: 'PROVISIONED', uncomparableCapacityIndexNames: new Set() }
      );
      expect(entry).toEqual(desired[0]);
    });

    it('never carries live KeySchema / Projection / WarmThroughput (exclusion 3)', () => {
      // All three are copied from the desired side so they can never DIFFER:
      // KeySchema / Projection are immutable on an existing index (a
      // difference only produces a "recreate the index" warning) and AWS does
      // not guarantee `NonKeyAttributes` readback ORDER; WarmThroughput reads
      // back with a `Status` member the translated shape lacks, and DynamoDB
      // warm throughput is increase-only, so a manufactured difference is a
      // real AWS-side risk.
      const withShapes = [
        {
          IndexName: 'idx',
          KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
          Projection: { ProjectionType: 'INCLUDE' as const, NonKeyAttributes: ['a', 'b'] },
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      ];
      const [entry] = buildLiveRecoveryGsiBaseline(
        withShapes,
        [
          {
            IndexName: 'idx',
            KeySchema: [{ AttributeName: 'somethingElse', KeyType: 'HASH' }],
            // AWS returned the same members in the OTHER order.
            Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['b', 'a'] },
            WarmThroughput: { ReadUnitsPerSecond: 9000, WriteUnitsPerSecond: 1000 },
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          },
        ],
        {
          carryLiveValues: true,
          liveBillingMode: 'PROVISIONED',
          uncomparableCapacityIndexNames: new Set(),
        }
      );
      expect(entry?.KeySchema).toEqual(withShapes[0]?.KeySchema);
      expect(entry?.Projection).toEqual(withShapes[0]?.Projection);
      expect(entry?.WarmThroughput).toEqual(withShapes[0]?.WarmThroughput);
    });

    it('still carries the on-demand ceiling for an index with an UNCOMPARABLE capacity', () => {
      // The exclusion is about PROVISIONED capacity only. Suppressing the
      // whole entry took the #1160 `-1` reset down with it for an on-demand
      // table whose template carried a leftover auto-scaling block.
      const [entry] = buildLiveRecoveryGsiBaseline(
        [
          {
            IndexName: 'idx',
            KeySchema: [{ AttributeName: 'gsiPk', KeyType: 'HASH' as const }],
            Projection: { ProjectionType: 'ALL' as const },
          },
        ],
        [{ IndexName: 'idx', OnDemandThroughput: { MaxReadRequestUnits: 100 } }],
        {
          carryLiveValues: true,
          liveBillingMode: 'PAY_PER_REQUEST',
          uncomparableCapacityIndexNames: new Set(['idx']),
        }
      );
      expect(entry?.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 100 });
    });

    it('omits a desired index that does not exist live (it is an ADD)', () => {
      expect(
        buildLiveRecoveryGsiBaseline(desired, [{ IndexName: 'other' }], {
          carryLiveValues: true,
          liveBillingMode: 'PROVISIONED',
          uncomparableCapacityIndexNames: new Set(),
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
          uncomparableCapacityIndexNames: new Set(),
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

    it('drives the carryLiveValues gate: a BILLING FLIP keeps the identity baseline', async () => {
      // The gate expression itself is only reachable through `update()` —
      // every helper case passes the flag literally, so hardcoding it `true`
      // at the call site would keep those green (review catch). Across two
      // billing modes every index differs by construction, so the baseline
      // must NOT compare values; the consequence is that this deploy issues no
      // per-GSI action at all and the ceilings land on the NEXT one. That is
      // pre-existing behavior inherited from PR #1562, pinned here so a change
      // to it is deliberate rather than accidental.
      describeTable({
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        GlobalSecondaryIndexes: [
          {
            IndexName: 'my-index',
            ProvisionedThroughput: { ReadCapacityUnits: 4, WriteCapacityUnits: 4 },
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
            },
          ],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'my-index',
                  ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 90 },
                },
              ],
            },
          ],
        },
        { ...baseProps, BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: 'bad' }
      );

      expect(gsiActions().filter((a) => 'Delete' in a)).toEqual([]);
      expect(gsiActions().filter((a) => 'Create' in a)).toEqual([]);
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
      // Name the OFFENDING index and nothing else: dropping the `liveOnly`
      // filter would otherwise still satisfy a bare self-heal grep.
      const liveOnlyWarning = childLogger.warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('This does NOT self-heal'));
      expect(liveOnlyWarning).toBeDefined();
      expect(liveOnlyWarning).toContain('stale-index');
      expect(liveOnlyWarning).not.toContain('my-index');
      // The remedy must be one that WORKS. `cdkd drift --accept` is not it:
      // it writes into `observedProperties` while the deploy diff's previous
      // side is `properties`, and this provider's `readCurrentState` already
      // reverse-maps the live index list, so the drift report is empty.
      expect(liveOnlyWarning).not.toContain('drift --accept');
      expect(liveOnlyWarning).toContain('aws dynamodb update-table');
    });
  });
});
