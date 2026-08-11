import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

/**
 * Issue #1387 regression coverage: the CFn `AWS::DynamoDB::GlobalTable`
 * schema models per-GSI throughput completely differently from the SDK's
 * `CreateTable` / `UpdateTable` shapes, and the provider used to cast the
 * blob raw. The AWS SDK v3 serializer drops unknown members, so:
 *
 *  - a PROVISIONED GlobalTable with a GSI failed `CreateTable` outright
 *    (AWS requires `ProvisionedThroughput` on every index), and
 *  - `TableV2`'s per-GSI on-demand limits vanished silently.
 *
 * EVERY property bag below is copied verbatim from a real `cdk synth` of
 * `dynamodb.TableV2` (aws-cdk-lib 2.244.0) — not hand-invented — so the
 * tests pin the shape CDK actually emits, including the fact that per-GSI
 * READ capacity lives on the LOCAL REPLICA's index entry rather than on the
 * top-level GSI.
 */

const { mockSend, mockAutoScalingSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  DynamoDBGlobalTableProvider,
  derivePerCallProvisionedThroughput,
  deriveReadCapacityUnits,
  deriveWriteCapacityUnits,
  toSdkGlobalSecondaryIndexes,
  toSdkReplicaGlobalSecondaryIndexes,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/prov-table';

/**
 * Verbatim `cdk synth` output for:
 *
 * ```ts
 * new ddb.TableV2(stack, 'Prov', {
 *   partitionKey: { name: 'pk', type: STRING },
 *   sortKey: { name: 'sk', type: STRING },
 *   billing: Billing.provisioned({
 *     readCapacity: Capacity.fixed(5),
 *     writeCapacity: Capacity.autoscaled({ minCapacity: 1, maxCapacity: 10, targetUtilizationPercent: 70 }),
 *   }),
 *   globalSecondaryIndexes: [{
 *     indexName: 'gsi1',
 *     partitionKey: { name: 'g1pk', type: STRING },
 *     readCapacity: Capacity.fixed(7),
 *     writeCapacity: Capacity.autoscaled({ minCapacity: 2, maxCapacity: 20, seedCapacity: 3, targetUtilizationPercent: 60 }),
 *   }],
 * });
 * ```
 *
 * Note what is NOT here: the GSI carries no `ReadProvisionedThroughputSettings`
 * and no literal `WriteCapacityUnits`. That is the whole bug.
 */
const PROVISIONED_TABLE_PROPS: Record<string, unknown> = {
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
    { AttributeName: 'g1pk', AttributeType: 'S' },
  ],
  BillingMode: 'PROVISIONED',
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      WriteProvisionedThroughputSettings: {
        WriteCapacityAutoScalingSettings: {
          MaxCapacity: 20,
          MinCapacity: 2,
          SeedCapacity: 3,
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 60 },
        },
      },
    },
  ],
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  Replicas: [
    {
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } },
      ],
      ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 },
      Region: 'us-east-1',
    },
  ],
  WriteProvisionedThroughputSettings: {
    WriteCapacityAutoScalingSettings: {
      MaxCapacity: 10,
      MinCapacity: 1,
      TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
    },
  },
};

/**
 * Verbatim `cdk synth` output for the on-demand sibling:
 *
 * ```ts
 * new ddb.TableV2(stack, 'OnDemand', {
 *   partitionKey: { name: 'pk', type: STRING },
 *   billing: Billing.onDemand({ maxReadRequestUnits: 100, maxWriteRequestUnits: 200 }),
 *   globalSecondaryIndexes: [{
 *     indexName: 'gsi2',
 *     partitionKey: { name: 'g2pk', type: STRING },
 *     maxReadRequestUnits: 50,
 *     maxWriteRequestUnits: 60,
 *   }],
 * });
 * ```
 */
const ON_DEMAND_TABLE_PROPS: Record<string, unknown> = {
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'g2pk', AttributeType: 'S' },
  ],
  BillingMode: 'PAY_PER_REQUEST',
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi2',
      KeySchema: [{ AttributeName: 'g2pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 60 },
    },
  ],
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Replicas: [
    {
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi2', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } },
      ],
      ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 100 },
      Region: 'us-east-1',
    },
  ],
  WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 200 },
};

describe('DynamoDBGlobalTable GSI throughput translation (issue #1387)', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    warnSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    // Every DynamoDB call in these tests is asserted on its INPUT, so a
    // single always-ACTIVE default response covers CreateTable /
    // DescribeTable / UpdateTable / the wait pollers alike. Tests that
    // needed ordered responses would use `mockResolvedValueOnce`.
    mockSend.mockResolvedValue({
      Table: {
        TableName: 'prov-table',
        TableArn: TABLE_ARN,
        TableId: 'tid-1',
        TableStatus: 'ACTIVE',
        Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
      },
    });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('capacity derivation helpers', () => {
    // Issue #1435: the precedence is context-dependent, not a fixed chain.
    // CloudFormation creates an autoscaled PROVISIONED table at MinCapacity
    // (live-verified, stack `CdkdIssue1427Control`) and only uses SeedCapacity
    // for the PAY_PER_REQUEST -> PROVISIONED flip.
    it('takes MinCapacity over SeedCapacity by default (the create context)', () => {
      expect(
        deriveWriteCapacityUnits({
          WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20, SeedCapacity: 3 },
        })
      ).toBe(2);
    });

    it("takes SeedCapacity before MinCapacity when the source is 'seed' (the billing flip)", () => {
      expect(
        deriveWriteCapacityUnits(
          {
            WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20, SeedCapacity: 3 },
          },
          'seed'
        )
      ).toBe(3);
    });

    it("falls back to SeedCapacity under the 'min' source when MinCapacity is absent", () => {
      expect(
        deriveWriteCapacityUnits({
          WriteCapacityAutoScalingSettings: { MaxCapacity: 20, SeedCapacity: 3 },
        })
      ).toBe(3);
    });

    it("falls back to MinCapacity under the 'seed' source when SeedCapacity is absent", () => {
      expect(
        deriveWriteCapacityUnits(
          { WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20 } },
          'seed'
        )
      ).toBe(2);
    });

    it('applies the source to the TABLE-level write block, not just per-GSI', () => {
      // The table-level flip call site passes 'seed' too. Without this, every
      // fixture in the tree carries SeedCapacity only on a GSI, so flipping
      // that call site to 'min' would break nothing and the seed context
      // would be pinned per-index only.
      const props = {
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: 4, MaxCapacity: 40, SeedCapacity: 31 },
        },
        Replicas: [
          {
            Region: 'us-east-1',
            ReadProvisionedThroughputSettings: {
              ReadCapacityAutoScalingSettings: { MinCapacity: 6, MaxCapacity: 60, SeedCapacity: 22 },
            },
          },
        ],
      };
      expect(derivePerCallProvisionedThroughput(props, 'us-east-1')).toEqual({
        ReadCapacityUnits: 6,
        WriteCapacityUnits: 4,
      });
      expect(derivePerCallProvisionedThroughput(props, 'us-east-1', 'seed')).toEqual({
        ReadCapacityUnits: 22,
        WriteCapacityUnits: 31,
      });
    });

    it('takes MinCapacity over SeedCapacity on the read side too', () => {
      expect(
        deriveReadCapacityUnits({
          ReadCapacityAutoScalingSettings: { MinCapacity: 4, MaxCapacity: 40, SeedCapacity: 11 },
        })
      ).toBe(4);
      expect(
        deriveReadCapacityUnits(
          { ReadCapacityAutoScalingSettings: { MinCapacity: 4, MaxCapacity: 40, SeedCapacity: 11 } },
          'seed'
        )
      ).toBe(11);
    });

    it('falls back to MinCapacity when no SeedCapacity is present', () => {
      expect(
        deriveWriteCapacityUnits({
          WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20 },
        })
      ).toBe(2);
    });

    it('honors a literal WriteCapacityUnits over auto-scaling settings', () => {
      expect(
        deriveWriteCapacityUnits({
          WriteCapacityUnits: 42,
          WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20 },
        })
      ).toBe(42);
    });

    it('reads the per-replica flat ReadCapacityUnits shape', () => {
      expect(deriveReadCapacityUnits({ ReadCapacityUnits: 7 })).toBe(7);
      expect(
        deriveReadCapacityUnits({
          ReadCapacityAutoScalingSettings: { MinCapacity: 4, MaxCapacity: 40 },
        })
      ).toBe(4);
    });

    it('returns undefined (not NaN / 0) for absent or unusable settings', () => {
      expect(deriveWriteCapacityUnits(undefined)).toBeUndefined();
      expect(deriveWriteCapacityUnits({})).toBeUndefined();
      expect(deriveReadCapacityUnits({ ReadCapacityUnits: 'not-a-number' })).toBeUndefined();
    });
  });

  describe('toSdkGlobalSecondaryIndexes', () => {
    it('maps the PROVISIONED CDK shape to SDK ProvisionedThroughput (write from the GSI, read from the local replica)', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        PROVISIONED_TABLE_PROPS,
        'us-east-1',
        'PROVISIONED'
      );
      expect(gsi).toBeDefined();
      // The bug: pre-fix this object was the raw CFn blob, so
      // `ProvisionedThroughput` was absent and CreateTable 400'd.
      // WriteCapacityUnits is the fixture's `MinCapacity: 2`, not its
      // `SeedCapacity: 3` — issue #1435: CloudFormation creates at MinCapacity
      // and reserves SeedCapacity for the billing flip.
      expect(gsi!.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 7,
        WriteCapacityUnits: 2,
      });
      expect(gsi!.IndexName).toBe('gsi1');
      expect(gsi!.KeySchema).toEqual([{ AttributeName: 'g1pk', KeyType: 'HASH' }]);
      expect(gsi!.Projection).toEqual({ ProjectionType: 'ALL' });
      // The CFn-only spellings must not survive into the SDK input.
      expect(gsi).not.toHaveProperty('WriteProvisionedThroughputSettings');
      expect(gsi!.OnDemandThroughput).toBeUndefined();
    });

    // Issue #1452 FENCE. The CFn docs for CapacityAutoScalingSettings claim a
    // CROSS-REGION max: "if your global secondary index myGSI has a
    // SeedCapacity of 10 in us-east-1 and a fixed ReadCapacityUnits of 20 in
    // eu-west-1, CloudFormation will initially set the read capacity for myGSI
    // to 20." A live probe DISPROVED that sentence, so deriving read capacity
    // from the LOCAL replica alone is CORRECT and must stay that way.
    //
    // Probe (stack Cdkd1452ProbeXRegionRead, us-east-1 + us-west-2, 2026-08-10):
    // an AWS::DynamoDB::GlobalTable whose local (us-east-1) replica GSI carried
    // ReadCapacityAutoScalingSettings{MinCapacity 1, MaxCapacity 100,
    // SeedCapacity 10} and whose remote (us-west-2) replica GSI carried a fixed
    // ReadCapacityUnits 20 reached CREATE_COMPLETE with:
    //   us-east-1 myGSI ProvisionedThroughput.ReadCapacityUnits = 1
    //   us-west-2 myGSI ProvisionedThroughputOverride.ReadCapacityUnits = 20
    // So CloudFormation took the LOCAL replica's MinCapacity (1) and applied
    // the remote's 20 only as that replica's own override. It took neither the
    // remote's higher value NOR the local SeedCapacity — the latter
    // independently re-confirming issue #1435's 'min'-on-create finding.
    //
    // Taking a max across replicas here would OVER-provision every such table
    // and diverge from CloudFormation. This is the same failure mode as #1427,
    // whose doc-derived premise the same probe family also disproved.
    it('does NOT raise the local read capacity to a higher REMOTE replica value (issue #1452)', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'myGSI',
              KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'KEYS_ONLY' },
              WriteProvisionedThroughputSettings: {
                WriteCapacityAutoScalingSettings: { MinCapacity: 1, MaxCapacity: 10 },
              },
            },
          ],
          Replicas: [
            {
              Region: 'us-east-1',
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'myGSI',
                  ReadProvisionedThroughputSettings: {
                    ReadCapacityAutoScalingSettings: {
                      MinCapacity: 1,
                      MaxCapacity: 100,
                      SeedCapacity: 10,
                    },
                  },
                },
              ],
            },
            {
              Region: 'us-west-2',
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'myGSI',
                  ReadProvisionedThroughputSettings: { ReadCapacityUnits: 20 },
                },
              ],
            },
          ],
        },
        'us-east-1',
        'PROVISIONED'
      );
      // 1 = the LOCAL replica's MinCapacity. NOT 20 (the remote replica's
      // fixed value) and NOT 10 (the local SeedCapacity) — both were rejected
      // by the live probe above.
      expect(gsi!.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 1,
        WriteCapacityUnits: 1,
      });
    });

    it('maps the on-demand CDK shape to SDK OnDemandThroughput (both directions)', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        ON_DEMAND_TABLE_PROPS,
        'us-east-1',
        'PAY_PER_REQUEST'
      );
      expect(gsi!.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 50,
        MaxWriteRequestUnits: 60,
      });
      expect(gsi!.ProvisionedThroughput).toBeUndefined();
      expect(gsi).not.toHaveProperty('WriteOnDemandThroughputSettings');
    });

    it('defaults PROVISIONED capacity to 5/5 when the template carries no GSI throughput at all', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'bare',
              KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'KEYS_ONLY' },
            },
          ],
        },
        'us-east-1',
        'PROVISIONED'
      );
      expect(gsi!.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      });
    });

    it('honors the GSI-level ReadProvisionedThroughputSettings fallback for hand-authored L1 templates', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'l1',
              KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ReadProvisionedThroughputSettings: { ReadCapacityUnits: 9 },
              WriteProvisionedThroughputSettings: {
                WriteCapacityAutoScalingSettings: { MinCapacity: 8, MaxCapacity: 80 },
              },
            },
          ],
        },
        'us-east-1',
        'PROVISIONED'
      );
      expect(gsi!.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 9,
        WriteCapacityUnits: 8,
      });
    });

    it('passes an already-SDK-shaped ProvisionedThroughput through untouched', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'sdk-shaped',
              KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ProvisionedThroughput: { ReadCapacityUnits: 11, WriteCapacityUnits: 12 },
            },
          ],
        },
        'us-east-1',
        'PROVISIONED'
      );
      expect(gsi!.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 11,
        WriteCapacityUnits: 12,
      });
    });

    it('forwards WarmThroughput verbatim (same spelling on both sides)', () => {
      const [gsi] = toSdkGlobalSecondaryIndexes(
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'warm',
              KeySchema: [{ AttributeName: 'g', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
            },
          ],
        },
        'us-east-1',
        'PAY_PER_REQUEST'
      );
      expect(gsi!.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
      // Load-bearing: the throughput members must be OMITTED, not emitted
      // empty. This index declares no on-demand limits, so relaxing the
      // emit-when-present guard would send `OnDemandThroughput: {}`, which
      // AWS rejects — and without this assertion that regression is
      // invisible to the whole suite.
      expect(gsi!.OnDemandThroughput).toBeUndefined();
      expect(gsi!.ProvisionedThroughput).toBeUndefined();
    });

    it('returns an empty array when the template declares no GSIs', () => {
      expect(toSdkGlobalSecondaryIndexes({}, 'us-east-1', 'PROVISIONED')).toEqual([]);
    });

    it('surfaces a non-array GlobalSecondaryIndexes from create() as a ProvisioningError', async () => {
      // create() has no wrapping catch at the translation point, so it converts
      // the helper's plain Error itself. A falsy-but-present value (null) is the
      // case a truthiness gate would have skipped entirely, deploying a
      // zero-GSI table.
      await expect(
        provider.create('Prov', RESOURCE_TYPE, {
          ...PROVISIONED_TABLE_PROPS,
          GlobalSecondaryIndexes: null,
        })
      ).rejects.toThrow(/GlobalSecondaryIndexes must be an array/);
    });

    it('throws on a non-array GlobalSecondaryIndexes instead of deploying a table with none', () => {
      // Absent is legitimately empty; present-but-not-an-array (an unresolved
      // intrinsic) previously collapsed to [] and created the table with ZERO
      // indexes while reporting success — the #1387 silent-drop class one
      // level up.
      expect(() =>
        toSdkGlobalSecondaryIndexes(
          { GlobalSecondaryIndexes: { 'Fn::If': ['UseGsi', [], []] } },
          'us-east-1',
          'PROVISIONED'
        )
      ).toThrow(/GlobalSecondaryIndexes must be an array/);
    });
  });

  describe('toSdkReplicaGlobalSecondaryIndexes', () => {
    // Split by billing mode since issue #1428 added the gate: a single call
    // can no longer produce a provisioned AND an on-demand override, because
    // AWS rejects each on the wrong billing mode. BOTH polarities are pinned
    // — asserting only the mode under test would let the gate silently invert.
    it('maps per-replica read settings to the SDK Override members (PROVISIONED)', () => {
      const result = toSdkReplicaGlobalSecondaryIndexes(
        [
          { IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } },
          { IndexName: 'gsi2', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } },
        ],
        'PROVISIONED'
      );
      expect(result).toEqual([
        { IndexName: 'gsi1', ProvisionedThroughputOverride: { ReadCapacityUnits: 7 } },
        // On-demand is not live on a provisioned table, so the ceiling is not
        // forwarded into a guaranteed 400.
        { IndexName: 'gsi2' },
      ]);
    });

    it('maps per-replica read settings to the SDK Override members (PAY_PER_REQUEST)', () => {
      const result = toSdkReplicaGlobalSecondaryIndexes(
        [
          { IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } },
          { IndexName: 'gsi2', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } },
        ],
        'PAY_PER_REQUEST'
      );
      expect(result).toEqual([
        { IndexName: 'gsi1' },
        { IndexName: 'gsi2', OnDemandThroughputOverride: { MaxReadRequestUnits: 50 } },
      ]);
    });

    it('emits IndexName only when the replica entry carries no throughput override', () => {
      expect(toSdkReplicaGlobalSecondaryIndexes([{ IndexName: 'plain' }], 'PAY_PER_REQUEST')).toEqual(
        [{ IndexName: 'plain' }]
      );
    });

    it('returns undefined for an absent / empty list so the SDK field stays unset', () => {
      expect(toSdkReplicaGlobalSecondaryIndexes(undefined, 'PAY_PER_REQUEST')).toBeUndefined();
      expect(toSdkReplicaGlobalSecondaryIndexes([], 'PAY_PER_REQUEST')).toBeUndefined();
    });
  });

  describe('create()', () => {
    it('sends per-GSI ProvisionedThroughput on CreateTable for a PROVISIONED GlobalTable', async () => {

      await provider.create('Prov', RESOURCE_TYPE, {
        ...PROVISIONED_TABLE_PROPS,
        TableName: 'prov-table',
      });

      const create = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(create).toBeInstanceOf(CreateTableCommand);
      // Without the fix this array was the raw CFn blob and AWS rejected
      // the call with "One or more parameter values were invalid: Neither
      // ProvisionedThroughput nor OnDemandThroughput was specified for
      // index: gsi1".
      expect(create.input.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: 'gsi1',
          KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          // MinCapacity (2), not SeedCapacity (3) — issue #1435.
          ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 2 },
        },
      ]);
      // Table-level capacity keeps working (min-before-seed applies here too).
      expect(create.input.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 1,
      });
    });

    it('sends per-GSI OnDemandThroughput on CreateTable for an on-demand GlobalTable', async () => {

      await provider.create('OnDemand', RESOURCE_TYPE, {
        ...ON_DEMAND_TABLE_PROPS,
        TableName: 'od-table',
      });

      const create = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(create.input.GlobalSecondaryIndexes?.[0]?.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 50,
        MaxWriteRequestUnits: 60,
      });
      expect(create.input.ProvisionedThroughput).toBeUndefined();
    });

    it('translates a cross-region replica GSI override on the replica-add UpdateTable', async () => {

      await provider.create('OnDemand', RESOURCE_TYPE, {
        ...ON_DEMAND_TABLE_PROPS,
        TableName: 'od-table',
        Replicas: [
          ...(ON_DEMAND_TABLE_PROPS['Replicas'] as unknown[]),
          {
            Region: 'eu-west-1',
            GlobalSecondaryIndexes: [
              { IndexName: 'gsi2', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 25 } },
            ],
          },
        ],
      });

      const replicaAdd = mockSend.mock.calls[2]?.[0] as UpdateTableCommand;
      expect(replicaAdd).toBeInstanceOf(UpdateTableCommand);
      expect(replicaAdd.input.ReplicaUpdates?.[0]?.Create?.GlobalSecondaryIndexes).toEqual([
        { IndexName: 'gsi2', OnDemandThroughputOverride: { MaxReadRequestUnits: 25 } },
      ]);
    });
  });

  describe('update()', () => {
    it('resets a REMOVED per-GSI on-demand limit with -1 instead of no-oping (issue #1423)', async () => {
      // Deleting `maxReadRequestUnits` / `maxWriteRequestUnits` from a template
      // used to emit nothing, so the old ceiling stayed live in AWS forever
      // while cdkd reported success — the absent-field-reset silent-drop class
      // (#1160). `-1` is the reset sentinel, LIVE-VERIFIED against real AWS:
      // UpdateTable accepted it on the per-GSI Update action and DescribeTable
      // then reported the member ABSENT.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      // Drop BOTH limits: write lives on the GSI, read on the local replica.
      delete (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ];
      delete (
        (next['Replicas'] as Record<string, unknown>[])[0]!['GlobalSecondaryIndexes'] as Record<
          string,
          unknown
        >[]
      )[0]!['ReadOnDemandThroughputSettings'];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const gsiUpdates = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Update !== undefined)
        );
      expect(gsiUpdates).toHaveLength(1);
      expect(gsiUpdates[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
        {
          Update: {
            IndexName: 'gsi2',
            OnDemandThroughput: { MaxReadRequestUnits: -1, MaxWriteRequestUnits: -1 },
          },
        },
      ]);
    });

    it('resets the DROPPED member while KEEPING the one still declared (partial removal)', async () => {
      // The likeliest user edit: read and write limits are two independent CDK
      // props (read via the local replica, write on the GSI), so removing ONE
      // is common. A branch that only reset when the new side had NO on-demand
      // block at all would silently leave the other ceiling live — the very
      // #1423 bug, shipped as fixed. Live-probed: the MIXED payload
      // {MaxReadRequestUnits: 50, MaxWriteRequestUnits: -1} is accepted and
      // reads back as {MaxReadRequestUnits: 50}.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      // Drop ONLY the write limit; the replica-side read limit (50) stays.
      delete (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const gsiUpdates = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Update !== undefined)
        );
      expect(gsiUpdates).toHaveLength(1);
      expect(
        gsiUpdates[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.OnDemandThroughput
      ).toEqual({ MaxReadRequestUnits: 50, MaxWriteRequestUnits: -1 });
    });

    it('resets ONLY the member that was actually set before', async () => {
      // A blanket {-1, -1} would clear a sibling limit the template still
      // declares.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      // Previous side has WRITE only (drop the replica-side read limit).
      delete (
        (previous['Replicas'] as Record<string, unknown>[])[0]![
          'GlobalSecondaryIndexes'
        ] as Record<string, unknown>[]
      )[0]!['ReadOnDemandThroughputSettings'];
      const next = structuredClone(previous) as Record<string, unknown>;
      delete (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const gsiUpdates = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Update !== undefined)
        );
      expect(gsiUpdates[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.OnDemandThroughput).toEqual(
        { MaxWriteRequestUnits: -1 }
      );
    });

    it('does NOT emit a reset when the index simply had no limits before', async () => {
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      delete (previous['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ];
      delete (
        (previous['Replicas'] as Record<string, unknown>[])[0]![
          'GlobalSecondaryIndexes'
        ] as Record<string, unknown>[]
      )[0]!['ReadOnDemandThroughputSettings'];
      const next = structuredClone(previous) as Record<string, unknown>;
      // Unrelated edit so the table still goes through update().
      next['TableClass'] = 'STANDARD_INFREQUENT_ACCESS';

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const resets = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some(
              (u) => u.Update?.OnDemandThroughput !== undefined
            )
        );
      expect(resets).toHaveLength(0);
    });

    it('carries ProvisionedThroughput on a GSI Create action (added index)', async () => {

      const previous = { ...PROVISIONED_TABLE_PROPS, GlobalSecondaryIndexes: [] };
      await provider.update(
        'Prov',
        'prov-table',
        RESOURCE_TYPE,
        PROVISIONED_TABLE_PROPS,
        previous
      );

      const gsiCall = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates).toEqual([
        {
          Create: {
            IndexName: 'gsi1',
            KeySchema: [{ AttributeName: 'g1pk', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            // A NEW index is a create context, so MinCapacity (2) — #1435.
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 2 },
          },
        },
      ]);
    });

    it('carries WarmThroughput on a GSI Create action, matching what create() sends', async () => {
      // create() translates WarmThroughput for a GSI declared up front. If the
      // update-add path omits it, the same template yields a different index
      // depending on whether the GSI was in the first deploy or a later one.
      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      (next['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!['WarmThroughput'] = {
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      };
      const previous = { ...PROVISIONED_TABLE_PROPS, GlobalSecondaryIndexes: [] };

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, previous);

      const gsiCall = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates?.[0]?.Create?.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('carries ProvisionedThroughput on a GSI Update action when the per-replica read capacity changes', async () => {

      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      (
        (next['Replicas'] as Array<Record<string, unknown>>)[0]![
          'GlobalSecondaryIndexes'
        ] as Array<Record<string, unknown>>
      )[0]!['ReadProvisionedThroughputSettings'] = { ReadCapacityUnits: 15 };

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, PROVISIONED_TABLE_PROPS);

      const gsiCall = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 15, WriteCapacityUnits: 2 },
          },
        },
      ]);
    });

    it('issues NO GSI UpdateTable for an auto-scaling-only edit DynamoDB cannot express', async () => {

      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      const gsi = (next['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!;
      (
        (gsi['WriteProvisionedThroughputSettings'] as Record<string, unknown>)[
          'WriteCapacityAutoScalingSettings'
        ] as Record<string, unknown>
      )['MaxCapacity'] = 30;

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, PROVISIONED_TABLE_PROPS);

      // NOTE ON WHAT THIS BINDS: under PROVISIONED billing the translated
      // GSIs are byte-identical here (MaxCapacity 20 -> 30 does not move
      // Seed=3 / read=7), so the diff reports nothing modified and the
      // warn-and-skip guard is never reached. Reverting EITHER the
      // translation or the guard alone still leaves this green — the
      // translation revert is masked by the guard, and the guard revert is
      // masked by the translation. It is a both-must-hold end-state
      // assertion, not a binding test for either mechanism on its own.
      // The translation is bound by the two Create/Update tests above; the
      // guard is bound by the PAY_PER_REQUEST case below.
      const gsiCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c) => c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCalls).toHaveLength(0);
    });

    it('warns and skips a modified GSI that yields no throughput at all, instead of sending an empty Update action', async () => {
      // Binds the warn-and-skip guard specifically. A PAY_PER_REQUEST GSI
      // carrying no on-demand limits translates to a GSI with NEITHER
      // ProvisionedThroughput nor OnDemandThroughput, so a KeySchema /
      // Projection-only edit reaches the guard with nothing to send. Without
      // the guard the provider emits `Update: { IndexName }`, which AWS
      // rejects with a ValidationException mid-deploy.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const prevGsi = (previous['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!;
      delete prevGsi['ReadOnDemandThroughputSettings'];
      delete prevGsi['WriteOnDemandThroughputSettings'];
      for (const replica of previous['Replicas'] as Array<Record<string, unknown>>) {
        for (const rGsi of (replica['GlobalSecondaryIndexes'] ?? []) as Array<
          Record<string, unknown>
        >) {
          delete rGsi['ReadOnDemandThroughputSettings'];
          delete rGsi['ReadProvisionedThroughputSettings'];
        }
      }

      // Projection is immutable on an existing index, so this is exactly the
      // shape DynamoDB's UpdateTable cannot express.
      const next = structuredClone(previous) as Record<string, unknown>;
      ((next['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]! as Record<
        string,
        unknown
      >)['Projection'] = { ProjectionType: 'KEYS_ONLY' };

      await provider.update('OnDemand', 'ondemand-table', RESOURCE_TYPE, next, previous);

      const gsiCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c) => c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCalls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UpdateTable cannot express'));
    });

    it('takes the TABLE-level SeedCapacity in the flip call, not MinCapacity (issue #1435)', async () => {
      // The per-GSI flip sites are pinned below, but the TABLE-level call site
      // was not: no fixture in the tree carried a table-level SeedCapacity, so
      // flipping that site from 'seed' to 'min' broke nothing. This is the
      // one context AWS documents SeedCapacity for, so it needs its own fence.
      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      (next['WriteProvisionedThroughputSettings'] as Record<string, unknown>)[
        'WriteCapacityAutoScalingSettings'
      ] = { MinCapacity: 1, MaxCapacity: 10, SeedCapacity: 17 };
      const previous = { ...next, BillingMode: 'PAY_PER_REQUEST' };

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, previous);

      const flip = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.BillingMode !== undefined
        );
      expect(flip?.input.ProvisionedThroughput?.WriteCapacityUnits).toBe(17);
    });

    it('includes per-GSI ProvisionedThroughput in the PAY_PER_REQUEST -> PROVISIONED flip call', async () => {

      // Previous deploy: same index, on-demand billing.
      const previous: Record<string, unknown> = {
        ...PROVISIONED_TABLE_PROPS,
        BillingMode: 'PAY_PER_REQUEST',
      };

      await provider.update(
        'Prov',
        'prov-table',
        RESOURCE_TYPE,
        PROVISIONED_TABLE_PROPS,
        previous
      );

      const flip = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.BillingMode !== undefined
        );
      // AWS requires the per-index throughput in the SAME call as the
      // BillingMode change; a bare flip 400s on a table that has GSIs.
      expect(flip?.input.GlobalSecondaryIndexUpdates).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 },
          },
        },
      ]);
      // ...and step 6 must not re-issue the same Update.
      const standaloneGsiCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c) =>
            c instanceof UpdateTableCommand &&
            c.input.GlobalSecondaryIndexUpdates !== undefined &&
            c.input.BillingMode === undefined
        );
      expect(standaloneGsiCalls).toHaveLength(0);
    });

    it('gives an index this deploy REMOVES throughput in the flip call, since its Delete is issued later', async () => {
      // The flip runs in step 4; the `Delete` for a dropped index runs in
      // step 6. So at flip time the dropped index is still a LIVE index on
      // a table becoming PROVISIONED, and AWS rejects the call unless it
      // carries capacity. Its throughput can only come from the PREVIOUS
      // template, since the new one no longer mentions it.
      const doomed = {
        IndexName: 'gsiDoomed',
        KeySchema: [{ AttributeName: 'dpk', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
        WriteProvisionedThroughputSettings: {
          WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20, SeedCapacity: 9 },
        },
      };
      const previous = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      previous['BillingMode'] = 'PAY_PER_REQUEST';
      (previous['GlobalSecondaryIndexes'] as unknown[]).push(doomed);
      (
        (previous['Replicas'] as Array<Record<string, unknown>>)[0]![
          'GlobalSecondaryIndexes'
        ] as unknown[]
      ).push({
        IndexName: 'gsiDoomed',
        ReadProvisionedThroughputSettings: { ReadCapacityUnits: 4 },
      });

      // The new template keeps only gsi1 and flips to PROVISIONED.
      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, PROVISIONED_TABLE_PROPS, previous);

      const flip = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.BillingMode !== undefined
        );
      // NOT `arrayContaining`: that passes even if the SURVIVING index is
      // dropped from the flip call, which would break the flip just as surely.
      // Sorted so the assertion pins the SET, not AWS-irrelevant ordering.
      const flipUpdates = [...(flip?.input.GlobalSecondaryIndexUpdates ?? [])].sort((a, b) =>
        (a.Update?.IndexName ?? '').localeCompare(b.Update?.IndexName ?? '')
      );
      expect(flipUpdates).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 },
          },
        },
        {
          Update: {
            IndexName: 'gsiDoomed',
            ProvisionedThroughput: { ReadCapacityUnits: 4, WriteCapacityUnits: 9 },
          },
        },
      ]);
      // The removed index must still reach step 6's Delete — being handled
      // by the flip must not suppress its deletion.
      const deletes = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Delete !== undefined)
        );
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
        { Delete: { IndexName: 'gsiDoomed' } },
      ]);
    });

    it('does not die with a bare TypeError on a non-array previous GlobalSecondaryIndexes during a flip', async () => {
      // The existing-index scan in the flip once ran BEFORE the translation, so
      // an unguarded `.map` on a plain object died with `.map is not a
      // function` — an opaque failure that names nothing.
      //
      // The named REFUSAL that replaced it was itself superseded by issue
      // #1551: this value comes from cdkd STATE, so failing the update on it
      // leaves the table un-updatable with no template-side remedy. The
      // provider now warns and falls back to the LIVE indexes as the baseline,
      // so the update completes. What this test still protects is that the
      // malformed value is NAMED rather than reaching `.map`.
      const previous = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      previous['BillingMode'] = 'PAY_PER_REQUEST';
      previous['GlobalSecondaryIndexes'] = { 'Fn::If': ['UseGsi', [], []] };

      await expect(
        provider.update('Prov', 'prov-table', RESOURCE_TYPE, PROVISIONED_TABLE_PROPS, previous)
      ).resolves.toBeDefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/GlobalSecondaryIndexes must be an array/)
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('recorded in cdkd state, not in the template')
      );
    });

    it('carries a changed WarmThroughput in the PAY_PER_REQUEST -> PROVISIONED flip call', async () => {
      // Indexes handled by the flip are skipped by the `modified` loop, so a
      // simultaneous WarmThroughput change has to ride the flip's own Update
      // or it vanishes with no warning.
      const previous = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      previous['BillingMode'] = 'PAY_PER_REQUEST';
      (previous['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!['WarmThroughput'] =
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };

      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      (next['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!['WarmThroughput'] = {
        ReadUnitsPerSecond: 24000,
        WriteUnitsPerSecond: 4000,
      };

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, previous);

      const flip = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.BillingMode !== undefined
        );
      expect(flip?.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 24000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('does not re-send an unchanged WarmThroughput on an unrelated capacity edit', async () => {
      // Warm throughput is increase-only on the AWS side, so re-asserting the
      // current value on a capacity-only edit is a needless risk.
      const previous = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      (previous['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!['WarmThroughput'] =
        { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
      const next = structuredClone(previous) as Record<string, unknown>;
      (
        (next['Replicas'] as Array<Record<string, unknown>>)[0]![
          'GlobalSecondaryIndexes'
        ] as Array<Record<string, unknown>>
      )[0]!['ReadProvisionedThroughputSettings'] = { ReadCapacityUnits: 19 };

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, previous);

      const gsiCall = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.ProvisionedThroughput).toEqual(
        { ReadCapacityUnits: 19, WriteCapacityUnits: 2 }
      );
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.WarmThroughput).toBe(
        undefined
      );
    });

    it('still applies per-GSI on-demand limits when the BillingMode flips PROVISIONED -> PAY_PER_REQUEST', async () => {
      // The flip call carries per-GSI fields only in the PAY_PER_REQUEST ->
      // PROVISIONED direction. The reverse has no such field, so the on-demand
      // limits must be issued as their own Update — a blanket "skip the
      // modified loop on a flip" silently dropped them.
      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      next['BillingMode'] = 'PAY_PER_REQUEST';
      const nextGsi = (next['GlobalSecondaryIndexes'] as Array<Record<string, unknown>>)[0]!;
      delete nextGsi['WriteProvisionedThroughputSettings'];
      nextGsi['WriteOnDemandThroughputSettings'] = { MaxWriteRequestUnits: 88 };
      for (const replica of next['Replicas'] as Array<Record<string, unknown>>) {
        for (const rGsi of (replica['GlobalSecondaryIndexes'] ?? []) as Array<
          Record<string, unknown>
        >) {
          delete rGsi['ReadProvisionedThroughputSettings'];
          rGsi['ReadOnDemandThroughputSettings'] = { MaxReadRequestUnits: 77 };
        }
      }

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, PROVISIONED_TABLE_PROPS);

      const gsiCall = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            c.input.GlobalSecondaryIndexUpdates !== undefined &&
            c.input.BillingMode === undefined
        );
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates).toEqual([
        {
          Update: {
            IndexName: 'gsi1',
            OnDemandThroughput: { MaxReadRequestUnits: 77, MaxWriteRequestUnits: 88 },
          },
        },
      ]);
      // Provisioned capacity must NOT ride along into an on-demand table.
      expect(gsiCall?.input.GlobalSecondaryIndexUpdates?.[0]?.Update?.ProvisionedThroughput).toBe(
        undefined
      );
    });

    it('does not emit the immutable-field warning when the BillingMode flipped PROVISIONED -> PAY_PER_REQUEST', async () => {
      // A flip re-shapes every index by construction: the old side is
      // translated under PROVISIONED (so it carries ProvisionedThroughput)
      // and the new side under PAY_PER_REQUEST with no on-demand limits (so
      // it carries neither field). Every GSI therefore lands in `modified`
      // with nothing to send. That is NOT a KeySchema / Projection edit, and
      // warning about immutable fields would send the user hunting a
      // non-existent template problem.
      const next = structuredClone(PROVISIONED_TABLE_PROPS) as Record<string, unknown>;
      next['BillingMode'] = 'PAY_PER_REQUEST';

      await provider.update('Prov', 'prov-table', RESOURCE_TYPE, next, PROVISIONED_TABLE_PROPS);

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('UpdateTable cannot express')
      );
    });

    it('translates the per-replica GSI override on a cross-region UpdateReplica', async () => {

      const euReplica = (override: number): Record<string, unknown> => ({
        Region: 'eu-west-1',
        GlobalSecondaryIndexes: [
          {
            IndexName: 'gsi2',
            ReadOnDemandThroughputSettings: { MaxReadRequestUnits: override },
          },
        ],
      });
      const previous: Record<string, unknown> = {
        ...ON_DEMAND_TABLE_PROPS,
        Replicas: [...(ON_DEMAND_TABLE_PROPS['Replicas'] as unknown[]), euReplica(25)],
      };
      const next: Record<string, unknown> = {
        ...ON_DEMAND_TABLE_PROPS,
        Replicas: [...(ON_DEMAND_TABLE_PROPS['Replicas'] as unknown[]), euReplica(35)],
      };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const replicaUpdate = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand && c.input.ReplicaUpdates !== undefined
        );
      expect(replicaUpdate?.input.ReplicaUpdates?.[0]?.Update?.GlobalSecondaryIndexes).toEqual([
        { IndexName: 'gsi2', OnDemandThroughputOverride: { MaxReadRequestUnits: 35 } },
      ]);
    });
  });

  /**
   * Issue #1434: the TABLE-level sibling of the per-GSI reset #1423 fixed.
   * Removing `WriteOnDemandThroughputSettings` never set `flatChanged`, so no
   * `UpdateTable` went out and the old ceiling stayed live in AWS while cdkd
   * reported success.
   *
   * The sentinel is the same `-1`, but that is NOT an assumption carried over
   * from #1423 — reset semantics are field-specific, and a live probe
   * (us-east-1, 2026-08-09) confirmed the table-level behavior separately:
   * `OnDemandThroughput: {MaxWriteRequestUnits: -1}` was accepted and
   * `DescribeTable` then returned `{MaxReadRequestUnits: 100}` — the dropped
   * member cleared, the untouched sibling preserved. The same probe found the
   * REPLICA overrides behave differently (`-1` is stored literally there), which
   * is why this change deliberately covers the table level only.
   */
  describe('table-level on-demand ceiling reset (issue #1434)', () => {
    // The comparison baseline is AWS's OBSERVED ceiling, not the state record
    // (issue #1436) — a table deployed before the read half was wired has
    // `maxReadRequestUnits` in state while AWS never received it, so a
    // state-vs-state diff reads "unchanged" and the drop is never repaired.
    // The suite's blanket DescribeTable response reports no `OnDemandThroughput`
    // at all, which no real on-demand table with ceilings would; these tests
    // deploy FROM `ON_DEMAND_TABLE_PROPS`, so AWS holds exactly its two values.
    beforeEach(() => {
      mockSend.mockResolvedValue({
        Table: {
          TableName: 'prov-table',
          TableArn: TABLE_ARN,
          TableId: 'tid-1',
          TableStatus: 'ACTIVE',
          Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
          OnDemandThroughput: { MaxReadRequestUnits: 100, MaxWriteRequestUnits: 200 },
        },
      });
    });

    /** The flat step-3 UpdateTable: no per-GSI and no per-replica actions. */
    const flatUpdate = (): UpdateTableCommand | undefined =>
      mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            c.input.GlobalSecondaryIndexUpdates === undefined &&
            c.input.ReplicaUpdates === undefined
        );

    it('resets a REMOVED table-level write ceiling with -1 instead of no-oping', async () => {
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      delete next['WriteOnDemandThroughputSettings'];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxWriteRequestUnits: -1 });
    });

    it('resets when the block survives but its member was dropped (partial removal)', async () => {
      // The shape the #1433 review caught on the per-GSI side: a branch keyed
      // on "the whole block disappeared" misses the likelier single-member
      // edit. Pinned here so the table-level path cannot regress into it.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      next['WriteOnDemandThroughputSettings'] = {};

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxWriteRequestUnits: -1 });
    });

    it('sends the NEW value (never the sentinel) when the ceiling merely changed', async () => {
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      next['WriteOnDemandThroughputSettings'] = { MaxWriteRequestUnits: 500 };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxWriteRequestUnits: 500 });
    });

    it('coerces the stringly-typed CFn number rather than passing it through', async () => {
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      next['WriteOnDemandThroughputSettings'] = { MaxWriteRequestUnits: '500' };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toEqual({ MaxWriteRequestUnits: 500 });
    });

    it('does NOT reset a PRESENT-but-unresolvable value, and says why (issue #1444 A)', async () => {
      // The destructive half is what matters and has not changed: gating the
      // reset on "did it coerce?" instead of "is the key there?" routes an
      // unresolved intrinsic into the reset branch, silently CLEARING the
      // ceiling the template was trying to SET.
      //
      // What DID change with #1444 A is the other half. The value used to be
      // forwarded raw (`Number({Ref: …})` is `NaN`) so AWS would reject the
      // call — "loud", but loud in the wrong place and with an error naming
      // nothing the user wrote. It is now suppressed and REPORTED, which is
      // what the per-GSI path (#1440) already did; having the two levels
      // disagree was the actual defect.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      next['WriteOnDemandThroughputSettings'] = {
        MaxWriteRequestUnits: { Ref: 'SomeUnresolvedParameter' },
      };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      // Nothing sent for the member: not the sentinel, and not NaN either.
      expect(flatUpdate()?.input.OnDemandThroughput?.MaxWriteRequestUnits).toBeUndefined();
      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        warned.some(
          (m) => m.includes('MaxWriteRequestUnits') && m.includes('did not resolve to a number')
        )
      ).toBe(true);
    });

    it('does NOT reset on a PROVISIONED -> PROVISIONED drop (no flip, but no live ceiling either)', async () => {
      // Reviewer catch on this PR. A "not flipping" gate is satisfied by
      // PROVISIONED -> PROVISIONED too, so a provisioned template that carried
      // the block (legal in the CFn schema, reachable from hand-authored L1)
      // and drops it would send an on-demand field on a provisioned table and
      // earn a ValidationException — a NEW failure where the pre-fix behavior
      // was a correct no-op.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      previous['BillingMode'] = 'PROVISIONED';
      const next = structuredClone(previous) as Record<string, unknown>;
      delete next['WriteOnDemandThroughputSettings'];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toBeUndefined();
    });

    it('does NOT reset while the billing mode is flipping to PROVISIONED', async () => {
      // Dropping the on-demand block on the way to PROVISIONED is the natural
      // template edit, not a request to clear a ceiling — and the flip is
      // step 4's own UpdateTable. Emitting a reset here would send a
      // meaningless on-demand field on a provisioned table.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      delete next['WriteOnDemandThroughputSettings'];
      next['BillingMode'] = 'PROVISIONED';

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toBeUndefined();
    });

    it('emits no on-demand field at all on a no-change redeploy', async () => {
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      expect(flatUpdate()?.input.OnDemandThroughput).toBeUndefined();
    });
  });

  /**
   * Issue #1440: the per-GSI reset (#1423) decided "the template dropped this
   * member" from the TRANSLATED side, which runs every value through
   * `toFiniteNumber`. A present-but-unparseable value therefore looked exactly
   * like a removal and was answered with the `-1` reset — silently CLEARING the
   * ceiling the template was trying to SET. The desired side is now read from
   * the RAW CFn keys, so such a value stays on the path that reaches AWS and
   * fails loudly. Same correction the table-level path took in #1434's PR.
   */
  describe('per-GSI on-demand reset reads RAW key presence (issue #1440)', () => {
    /** The per-GSI Update action for `gsi2`, if one was issued. */
    const gsiUpdateAction = (): Record<string, unknown> | undefined => {
      const cmd = mockSend.mock.calls
        .map((c) => c[0])
        .find(
          (c): c is UpdateTableCommand =>
            c instanceof UpdateTableCommand &&
            (c.input.GlobalSecondaryIndexUpdates ?? []).some((u) => u.Update !== undefined)
        );
      return cmd?.input.GlobalSecondaryIndexUpdates?.[0]?.Update as
        | Record<string, unknown>
        | undefined;
    };

    it('does NOT reset the WRITE limit when the template sets an unresolved intrinsic', async () => {
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ] = { MaxWriteRequestUnits: { Ref: 'SomeUnresolvedParameter' } };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxWriteRequestUnits']).not.toBe(-1);
    });

    it('does NOT reset the READ limit when the replica entry sets an unresolved intrinsic', async () => {
      // The read half lives on the LOCAL REPLICA's index entry, so the raw
      // presence walk has to look there — a write-only fix would leave this
      // half of the bug live.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      (
        (next['Replicas'] as Record<string, unknown>[])[0]!['GlobalSecondaryIndexes'] as Record<
          string,
          unknown
        >[]
      )[0]!['ReadOnDemandThroughputSettings'] = {
        MaxReadRequestUnits: { Ref: 'SomeUnresolvedParameter' },
      };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxReadRequestUnits']).not.toBe(-1);
    });

    it('honors the GSI-level read spelling as a declaration (hand-authored fallback)', async () => {
      // `toSdkGlobalSecondaryIndexes` accepts the GSI-level
      // `ReadOnDemandThroughputSettings` as a fallback for hand-authored
      // templates; the presence walk must accept it in the same place, or such
      // a template's declared value is reset out from under it.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      delete (
        (next['Replicas'] as Record<string, unknown>[])[0]!['GlobalSecondaryIndexes'] as Record<
          string,
          unknown
        >[]
      )[0]!['ReadOnDemandThroughputSettings'];
      (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'ReadOnDemandThroughputSettings'
      ] = { MaxReadRequestUnits: { Ref: 'SomeUnresolvedParameter' } };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxReadRequestUnits']).not.toBe(-1);
    });

    it('WARNS that the limit was left unchanged, naming the member (not "recreate the index")', async () => {
      // Reviewer catch: suppressing the reset leaves a NO-OP, and the only
      // output was the immutable-field warning below the reset — which tells
      // the user to RECREATE THE INDEX. That is useless and alarming advice for
      // what is really an unresolved intrinsic, so the suppression reports
      // itself accurately.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ] = { MaxWriteRequestUnits: { Ref: 'SomeUnresolvedParameter' } };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      // Wording moved with issue #1444 A: the diagnostic is now raised inside
      // the translation, where the value is actually lost, so it also fires
      // for a first-time set and across a billing flip — two cases the reset
      // gate never runs for. Same content, one source.
      expect(
        warned.some(
          (m) => m.includes('MaxWriteRequestUnits') && m.includes('left unchanged')
        )
      ).toBe(true);
      // ...and the misleading advice must NOT be the only thing the user sees.
      expect(warned.some((m) => m.includes('unresolved intrinsic'))).toBe(true);
    });

    it('does NOT also print the misleading "recreate the index" advice', async () => {
      // Re-review catch: suppressing the reset can leave the Update action with
      // no throughput field at all, which fell through to the immutable-field
      // branch — so the user got BOTH the accurate warning and advice to
      // recreate their index. The PR claims to replace that advice, so it must
      // not still fire.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      // Drop the read half entirely so the ONLY on-demand member in play is the
      // unresolvable write one — the shape that empties the Update action.
      delete (
        (next['Replicas'] as Record<string, unknown>[])[0]!['GlobalSecondaryIndexes'] as Record<
          string,
          unknown
        >[]
      )[0]!['ReadOnDemandThroughputSettings'];
      delete (
        (previous['Replicas'] as Record<string, unknown>[])[0]!['GlobalSecondaryIndexes'] as Record<
          string,
          unknown
        >[]
      )[0]!['ReadOnDemandThroughputSettings'];
      (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ] = { MaxWriteRequestUnits: { Ref: 'SomeUnresolvedParameter' } };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warned.some((m) => m.includes('left unchanged'))).toBe(true);
      expect(warned.some((m) => m.includes('Recreate the index under a new name'))).toBe(false);
    });

    it('MERGES an explicit SDK-shaped OnDemandThroughput with the derived spellings (issue #1428)', async () => {
      // This case inverted with #1428 and the inversion is the fix, not a
      // regression. The old contract was "an explicit block WINS over the
      // derived members", so a PARTIAL explicit block suppressed valid derived
      // siblings — here an explicit READ-only block discarded a perfectly good
      // `WriteOnDemandThroughputSettings: {MaxWriteRequestUnits: 60}` from the
      // SAME template, and the reset then cleared the write ceiling the user
      // had just declared. Whole-block replacement was #1428's defect 2.
      //
      // Under the merge each member resolves independently: explicit read 50,
      // derived write 60, and NO reset — nothing was dropped.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const gsi = (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]!;
      gsi['OnDemandThroughput'] = { MaxReadRequestUnits: 41 };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxReadRequestUnits']).toBe(41);
      expect(onDemand?.['MaxWriteRequestUnits']).toBe(60);
    });

    it('treats a BLOCK-level unresolved intrinsic as declared, not as a removal', async () => {
      // Third-review catch (#1444 item D, folded in): presence was tested on
      // the MEMBER key, so `WriteOnDemandThroughputSettings: {"Fn::If": [...]}`
      // — a record with no MaxWriteRequestUnits — reported "not declared" and
      // fired the destructive -1 on a ceiling the template was trying to set.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ] = { 'Fn::If': ['SomeCondition', { MaxWriteRequestUnits: 60 }, { Ref: 'AWS::NoValue' }] };

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxWriteRequestUnits']).not.toBe(-1);
    });

    it('does not treat a REAL block that merely lacks the member as an intrinsic', async () => {
      // The intrinsic test must not become a blanket "any block counts" —
      // a genuine `{}` / sibling-only block IS a removal of the member.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ] = {};

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxWriteRequestUnits']).toBe(-1);
    });

    it('STILL resets a genuinely removed member (the #1423 behavior is intact)', async () => {
      // The guard must narrow the reset to real removals only — not disable it.
      const previous = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      const next = structuredClone(ON_DEMAND_TABLE_PROPS) as Record<string, unknown>;
      delete (next['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0]![
        'WriteOnDemandThroughputSettings'
      ];

      await provider.update('OnDemand', 'od-table', RESOURCE_TYPE, next, previous);

      const onDemand = gsiUpdateAction()?.['OnDemandThroughput'] as
        | Record<string, unknown>
        | undefined;
      expect(onDemand?.['MaxWriteRequestUnits']).toBe(-1);
    });
  });
});
