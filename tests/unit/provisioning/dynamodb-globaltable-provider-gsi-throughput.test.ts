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
    it('takes SeedCapacity before MinCapacity on the write side', () => {
      expect(
        deriveWriteCapacityUnits({
          WriteCapacityAutoScalingSettings: { MinCapacity: 2, MaxCapacity: 20, SeedCapacity: 3 },
        })
      ).toBe(3);
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
      expect(gsi!.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 7,
        WriteCapacityUnits: 3,
      });
      expect(gsi!.IndexName).toBe('gsi1');
      expect(gsi!.KeySchema).toEqual([{ AttributeName: 'g1pk', KeyType: 'HASH' }]);
      expect(gsi!.Projection).toEqual({ ProjectionType: 'ALL' });
      // The CFn-only spellings must not survive into the SDK input.
      expect(gsi).not.toHaveProperty('WriteProvisionedThroughputSettings');
      expect(gsi!.OnDemandThroughput).toBeUndefined();
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
    });

    it('returns an empty array when the template declares no GSIs', () => {
      expect(toSdkGlobalSecondaryIndexes({}, 'us-east-1', 'PROVISIONED')).toEqual([]);
    });
  });

  describe('toSdkReplicaGlobalSecondaryIndexes', () => {
    it('maps per-replica read settings to the SDK Override members', () => {
      const result = toSdkReplicaGlobalSecondaryIndexes([
        { IndexName: 'gsi1', ReadProvisionedThroughputSettings: { ReadCapacityUnits: 7 } },
        { IndexName: 'gsi2', ReadOnDemandThroughputSettings: { MaxReadRequestUnits: 50 } },
      ]);
      expect(result).toEqual([
        { IndexName: 'gsi1', ProvisionedThroughputOverride: { ReadCapacityUnits: 7 } },
        { IndexName: 'gsi2', OnDemandThroughputOverride: { MaxReadRequestUnits: 50 } },
      ]);
    });

    it('emits IndexName only when the replica entry carries no throughput override', () => {
      expect(toSdkReplicaGlobalSecondaryIndexes([{ IndexName: 'plain' }])).toEqual([
        { IndexName: 'plain' },
      ]);
    });

    it('returns undefined for an absent / empty list so the SDK field stays unset', () => {
      expect(toSdkReplicaGlobalSecondaryIndexes(undefined)).toBeUndefined();
      expect(toSdkReplicaGlobalSecondaryIndexes([])).toBeUndefined();
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
          ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 },
        },
      ]);
      // Table-level capacity keeps working (seed-before-min applies here too).
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
            ProvisionedThroughput: { ReadCapacityUnits: 7, WriteCapacityUnits: 3 },
          },
        },
      ]);
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
            ProvisionedThroughput: { ReadCapacityUnits: 15, WriteCapacityUnits: 3 },
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

      // Pre-fix the raw-CFn diff saw a "modified" GSI and sent
      // `Update: { IndexName }` with no throughput — a ValidationException.
      const gsiCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c) => c instanceof UpdateTableCommand && c.input.GlobalSecondaryIndexUpdates !== undefined
        );
      expect(gsiCalls).toHaveLength(0);
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
});
