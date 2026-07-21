import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';

const {
  mockSend,
  mockAutoScalingSend,
  regionalClientSpy,
  regionalAutoScalingClientSpy,
  warnSpy,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  regionalClientSpy: vi.fn(),
  // Captures the `region` arg passed to every
  // `new ApplicationAutoScalingClient({region})` instantiation.
  // PR #403 review minor #2: cross-region tests must verify the
  // per-replica autoscaling SDK calls were routed through the
  // regional client (not the local-region client) — otherwise a
  // regression could silently create scalable targets in the wrong
  // region.
  regionalAutoScalingClientSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Intercept `new DynamoDBClient({region})` calls inside the provider's
// `getRegionalClient` helper so cross-region paths route through the
// same `mockSend` queue instead of making real network calls. Command
// classes (`DescribeTableCommand` etc.) keep the actual SDK shape.
vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => {
      regionalClientSpy(cfg?.region);
      return {
        send: mockSend,
        config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
      };
    }),
  };
});

// Same for application-autoscaling — the provider instantiates a fresh
// client inside `readAutoScalingSettings` (and a per-region cached
// client inside `getRegionalAutoScalingClient`). Default the mock to
// "no scalable target" so tests that don't queue an autoscaling response
// see the flat `WriteProvisionedThroughputSettings: {WriteCapacityUnits}`
// fallback (or `{}` on PAY_PER_REQUEST tables).
vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi
      .fn()
      .mockImplementation((cfg: { region?: string } | undefined) => {
        regionalAutoScalingClientSpy(cfg?.region);
        return { send: mockAutoScalingSend };
      }),
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
  diffReplicas,
  diffGlobalSecondaryIndexes,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';

function newRnf(message = 'not found'): ResourceNotFoundException {
  return new ResourceNotFoundException({
    message,
    $metadata: {},
  });
}

describe('DynamoDBGlobalTableProvider round-trip', () => {
  let provider: DynamoDBGlobalTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    regionalClientSpy.mockReset();
    regionalAutoScalingClientSpy.mockReset();
    warnSpy.mockReset();
    // Default: no application-autoscaling target / policy attached.
    // `readAutoScalingSettings` calls DescribeScalableTargets first and
    // returns null immediately when `ScalableTargets: []`, so a single
    // empty default covers both probe steps.
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('handledProperties', () => {
    it('lists the 14 CFn properties cdkd manages (Tags is per-replica, not top-level)', () => {
      const set = provider.handledProperties!.get('AWS::DynamoDB::GlobalTable')!;
      expect(set).toBeDefined();
      // Must include the full MVP property surface so the deploy engine
      // does not redirect to CC API (silently dropping per-replica config).
      const expected = [
        'TableName',
        'KeySchema',
        'AttributeDefinitions',
        'BillingMode',
        'StreamSpecification',
        'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes',
        'SSESpecification',
        'Replicas',
        'TableClass',
        'TimeToLiveSpecification',
        'WriteProvisionedThroughputSettings',
        'WriteOnDemandThroughputSettings',
        'DeletionProtectionEnabled',
        // Tags is intentionally NOT a top-level CFn property for
        // `AWS::DynamoDB::GlobalTable` — it lives inside
        // `Replicas[].Tags` and is covered by the `Replicas` entry.
      ];
      for (const k of expected) {
        expect(set.has(k)).toBe(true);
      }
      expect(set.has('Tags')).toBe(false);
    });
  });

  describe('create', () => {
    it('creates a single-region table with auto-generated name via generateResourceName fallback', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: 'MyTable',
          TableArn: TABLE_ARN,
          TableId: 'tid-123',
          TableStatus: 'ACTIVE',
        },
      }); // waitForTableActive

      const result = await provider.create('MyTable', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        Replicas: [{ Region: 'us-east-1' }],
      });

      expect(result.physicalId).toBe('MyTable');
      expect(result.attributes?.['Arn']).toBe(TABLE_ARN);
      expect(result.attributes?.['TableId']).toBe('tid-123');
      const ctr = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(ctr).toBeInstanceOf(CreateTableCommand);
      expect(ctr.input.BillingMode).toBe('PAY_PER_REQUEST');
      // Single local replica → no auto stream enable.
      expect(ctr.input.StreamSpecification).toBeUndefined();
    });

    it('uses explicit TableName from properties when set', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'explicit-name', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      const result = await provider.create('Logical', RESOURCE_TYPE, {
        TableName: 'explicit-name',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      });

      expect(result.physicalId).toBe('explicit-name');
      const ctr = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(ctr.input.TableName).toBe('explicit-name');
    });

    it('auto-enables streams (NEW_AND_OLD_IMAGES) when template has non-local replica', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive
      mockSend.mockResolvedValueOnce({}); // UpdateTable (add replica)
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: 'X',
          Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }],
        },
      }); // waitForReplicaActive

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
      });

      const ctr = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(ctr.input.StreamSpecification).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
    });

    it('issues UpdateTable with Create replica action per non-local region', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTable for eu-west-1
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
      });

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          { Region: 'us-east-1' },
          { Region: 'eu-west-1', KMSMasterKeyId: 'alias/foo' },
        ],
      });

      const replicaUpdate = mockSend.mock.calls[2]?.[0] as UpdateTableCommand;
      expect(replicaUpdate).toBeInstanceOf(UpdateTableCommand);
      expect(replicaUpdate.input.ReplicaUpdates).toEqual([
        { Create: { RegionName: 'eu-west-1', KMSMasterKeyId: 'alias/foo' } },
      ]);
    });

    it('applies TimeToLiveSpecification via UpdateTimeToLive post-create', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        Replicas: [{ Region: 'us-east-1' }],
      });

      const ttlCall = mockSend.mock.calls[2]?.[0] as UpdateTimeToLiveCommand;
      expect(ttlCall).toBeInstanceOf(UpdateTimeToLiveCommand);
      expect(ttlCall.input.TimeToLiveSpecification).toEqual({
        Enabled: true,
        AttributeName: 'expiresAt',
      });
    });

    it('forwards per-replica Tags to CreateTableCommand.Tags for the local region (post-fix regression)', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        Replicas: [
          {
            Region: 'us-east-1',
            Tags: [
              { Key: 'Env', Value: 'Prod' },
              { Key: 'Owner', Value: 'team-x' },
            ],
          },
        ],
      });

      const createCall = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(createCall).toBeInstanceOf(CreateTableCommand);
      // CFn `AWS::DynamoDB::GlobalTable` has no top-level Tags — they
      // live inside the local replica entry. cdkd extracts them and
      // passes via the SDK's `CreateTableCommand.Tags` field for the
      // local region (no separate TagResource round-trip).
      expect(createCall.input.Tags).toEqual([
        { Key: 'Env', Value: 'Prod' },
        { Key: 'Owner', Value: 'team-x' },
      ]);
    });

    it('skips Tags wire-up when the local replica entry has no Tags', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        Replicas: [{ Region: 'us-east-1' }],
      });

      const createCall = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(createCall.input.Tags).toBeUndefined();
    });

    // Issue #441: cross-region replica Tags propagation on create.
    // Pre-fix `CreateTable.Tags` only covered the LOCAL replica, so
    // every non-local replica's Tags silently dropped and the first
    // `cdkd drift` against a freshly-created multi-region table
    // reported Tags drift on each cross-region replica.
    it('propagates Tags to cross-region replicas via regional TagResource after replica becomes ACTIVE (Issue #441)', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive
      mockSend.mockResolvedValueOnce({}); // UpdateTable (add replica eu-west-1)
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
      }); // waitForReplicaActive
      mockSend.mockResolvedValueOnce({}); // regional TagResource

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          {
            Region: 'us-east-1',
            Tags: [{ Key: 'Owner', Value: 'team-x' }],
          },
          {
            Region: 'eu-west-1',
            Tags: [
              { Key: 'Env', Value: 'Prod' },
              { Key: 'Region', Value: 'eu' },
            ],
          },
        ],
      });

      // The LOCAL replica's Tags still go through CreateTable.Tags
      // (preserve existing fast path — no separate TagResource for
      // the local region).
      const createCall = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(createCall.input.Tags).toEqual([{ Key: 'Owner', Value: 'team-x' }]);

      // The cross-region client must have been spawned for eu-west-1.
      expect(regionalClientSpy).toHaveBeenCalledWith('eu-west-1');

      // The TagResource call must target the eu-west-1 replica ARN
      // (region segment swapped), with all eu-west-1 Tags as adds
      // (oldTags=undefined on create — every tag is new). NO
      // UntagResource issued (no prior state).
      const tagCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof TagResourceCommand) as TagResourceCommand[];
      expect(tagCalls).toHaveLength(1);
      expect(tagCalls[0]!.input.ResourceArn).toBe(
        'arn:aws:dynamodb:eu-west-1:123:table/my-table'
      );
      expect(tagCalls[0]!.input.Tags).toEqual([
        { Key: 'Env', Value: 'Prod' },
        { Key: 'Region', Value: 'eu' },
      ]);
      const untagCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UntagResourceCommand);
      expect(untagCalls).toHaveLength(0);
    });

    // Issue #441: when only the local replica has Tags and the
    // cross-region replicas have none, no regional TagResource should
    // fire (the loop short-circuits on empty Tags). Defense against a
    // regression that would propagate an empty Tags array (AWS rejects
    // TagResource with an empty Tags input).
    it('skips cross-region Tag propagation when a non-local replica has no Tags (Issue #441)', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTable (add replica)
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
      });

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          { Region: 'us-east-1', Tags: [{ Key: 'Owner', Value: 'team-x' }] },
          { Region: 'eu-west-1' }, // no Tags
        ],
      });

      // No regional TagResource issued — the cross-region replica had
      // no Tags so the loop short-circuited before the regional client
      // was even spawned.
      const tagCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof TagResourceCommand);
      expect(tagCalls).toHaveLength(0);
      expect(regionalClientSpy).not.toHaveBeenCalled();
    });

    // Issue #441: cross-region Tags propagation failure on create logs
    // a WARN and the deploy still succeeds (mirrors update() path's
    // precedent). The user's next `cdkd deploy` or `cdkd drift
    // --revert` recovers — the alternative (aborting create after the
    // table is already ACTIVE) would orphan AWS resources.
    it('cross-region Tag propagation failure logs WARN and does NOT abort the create (Issue #441)', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'X', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTable (add replica)
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
      });
      // Regional TagResource throws (permissions / throttle / region
      // down). Best-effort: the deploy still succeeds.
      mockSend.mockRejectedValueOnce(
        new Error('AccessDenied: TagResource (eu-west-1)')
      );

      const result = await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
        Replicas: [
          { Region: 'us-east-1' },
          { Region: 'eu-west-1', Tags: [{ Key: 'Env', Value: 'Prod' }] },
        ],
      });

      // Create returned successfully — no abort despite the regional
      // failure.
      expect(result.physicalId).toBe('X');

      // WARN was logged for the failing region.
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).toMatch(/eu-west-1/);
    });

    it('rejects when KeySchema is missing', async () => {
      await expect(
        provider.create('X', RESOURCE_TYPE, {
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        })
      ).rejects.toThrow('KeySchema is required');
    });

    it('rejects when AttributeDefinitions is missing', async () => {
      await expect(
        provider.create('X', RESOURCE_TYPE, {
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        })
      ).rejects.toThrow('AttributeDefinitions is required');
    });
  });

  describe('update', () => {
    it('issues TagResource / UntagResource on per-replica Tags diff for the local region (no UpdateTable round-trip)', async () => {
      // CFn `AWS::DynamoDB::GlobalTable` has NO top-level `Tags` field
      // — tags live inside `Replicas[?Region==<region>].Tags`. The
      // update path extracts Tags from the local replica entry.
      // Wait-for-ACTIVE -> DescribeTable returns ARN -> Untag + Tag -> final DescribeTable.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // waitForTableActiveAfterUpdate
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UntagResource
      mockSend.mockResolvedValueOnce({}); // TagResource
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, TableId: 'tid', LatestStreamArn: undefined },
      }); // final DescribeTable for return attributes

      const result = await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [
            { Region: 'us-east-1', Tags: [{ Key: 'Env', Value: 'Prod' }] },
          ],
        },
        {
          Replicas: [
            {
              Region: 'us-east-1',
              Tags: [
                { Key: 'Env', Value: 'Dev' },
                { Key: 'Old', Value: 'Drop' },
              ],
            },
          ],
        }
      );
      expect(result.physicalId).toBe(TABLE_NAME);
      expect(result.wasReplaced).toBe(false);
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).toContain('UntagResourceCommand');
      expect(names).toContain('TagResourceCommand');
      // No UpdateTable issued — flat fields were all undefined and the
      // local-replica modify path skips UpdateReplica.
      expect(names.filter((n) => n === 'UpdateTableCommand')).toEqual([]);
      const untag = mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand)![0];
      expect(untag.input.TagKeys).toEqual(['Old']);
      const tag = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand)![0];
      expect(tag.input.Tags).toEqual([{ Key: 'Env', Value: 'Prod' }]);
    });

    it('issues one combined UpdateTable for non-conflicting flat fields (DeletionProtection / TableClass / SSE / Stream / OnDemand)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (flat fields)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          DeletionProtectionEnabled: true,
          TableClass: 'STANDARD_INFREQUENT_ACCESS',
          SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
          StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
          WriteOnDemandThroughputSettings: { MaxWriteRequestUnits: 100 },
        },
        {
          DeletionProtectionEnabled: false,
          TableClass: 'STANDARD',
        }
      );

      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      const u = updateCalls[0]!.input;
      expect(u.DeletionProtectionEnabled).toBe(true);
      expect(u.TableClass).toBe('STANDARD_INFREQUENT_ACCESS');
      expect(u.SSESpecification?.Enabled).toBe(true);
      expect(u.StreamSpecification?.StreamEnabled).toBe(true);
      expect(u.OnDemandThroughput?.MaxWriteRequestUnits).toBe(100);
    });

    it('extracts DeletionProtectionEnabled from Replicas[?Region==local].DPE on update (regression: PR #410)', async () => {
      // CDK 2.x synthesizes `deletionProtection: true` as
      // `Replicas[].DeletionProtectionEnabled`, not top-level. Real-AWS
      // integ on 2026-05-16 caught cdkd reading top-level (which is
      // undefined → no UpdateTable). Fix: extract from local replica.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] },
        { Replicas: [{ Region: 'us-east-1' }] }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.DeletionProtectionEnabled).toBe(true);
    });

    it('per-replica DeletionProtectionEnabled wins over top-level when both are set (regression: PR #410)', async () => {
      // Defensive: if a template carries BOTH per-replica (CDK 2.x) and
      // top-level (legacy hand-authored), the per-replica value wins
      // because it matches the CFn schema's source-of-truth field.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } });
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } });
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } });
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } });

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          DeletionProtectionEnabled: false,
          Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }],
        },
        { Replicas: [{ Region: 'us-east-1' }] }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls[0]!.input.DeletionProtectionEnabled).toBe(true);
    });

    it('no UpdateTable when per-replica DeletionProtectionEnabled is unchanged on both sides (regression: PR #410)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] },
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] }
      );
      // No UpdateTable fires because the per-replica DPE is identical.
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand);
      expect(updateCalls).toHaveLength(0);
    });

    it('extracts DeletionProtectionEnabled from Replicas[?Region==local].DPE on create (regression: PR #410)', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          TableArn: TABLE_ARN,
        },
      });

      await provider.create('X', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }],
      });
      const createCall = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof CreateTableCommand) as
        | CreateTableCommand
        | undefined;
      expect(createCall).toBeDefined();
      expect(createCall!.input.DeletionProtectionEnabled).toBe(true);
    });

    it('AWS-aware DPE re-converge: fires UpdateTable when state and template both say true but AWS reports false (migration fix)', async () => {
      // Migration scenario from pre-PR #410:
      // - Pre-fix cdkd recorded state.properties.Replicas[0].DPE = true
      //   (template intent), but never actually called UpdateTable
      //   (it was reading top-level which was undefined).
      // - AWS-side DPE is still false.
      // - Post-fix update() must force the UpdateTable against AWS
      //   when state-recorded oldDpe equals newDpe but AWS-current
      //   differs. Same logic also covers console-side drift.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: false },
      }); // DescribeTable for ARN + AWS DPE
      mockSend.mockResolvedValueOnce({}); // UpdateTable (forced by AWS-aware diff)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] },
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.DeletionProtectionEnabled).toBe(true);
    });

    it('AWS-aware DPE: no UpdateTable when state, template, AND AWS all agree on DPE', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: true },
      }); // DescribeTable: AWS DPE matches template
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] },
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand);
      expect(updateCalls).toHaveLength(0);
    });

    it('AWS-aware DPE: skips re-converge when template does NOT set DPE (no opinion → trust state/AWS)', async () => {
      // When template doesn't carry DPE, cdkd should NOT force the
      // field to false via the AWS-aware diff. The user hasn't
      // opted in to manage DPE — drift detection handles surfacing
      // any AWS-side console change.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: true },
      }); // AWS has DPE=true
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1' }] }, // no DPE in template
        { Replicas: [{ Region: 'us-east-1' }] }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand);
      expect(updateCalls).toHaveLength(0);
    });

    it('Auto-disable WARN: surfaces a WARN when DPE flips true→false because the template property was removed', async () => {
      // Refactoring footgun: user removes `deletionProtection: true`
      // from CDK code (e.g. moving it into a config helper but
      // mistyping). cdkd's CFn-parity semantics flip AWS-side DPE
      // off — which is correct per CDK / CFn behavior but is a
      // data-loss risk. WARN gives the user visibility before the
      // next destroy.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: true },
      }); // DescribeTable for ARN + AWS DPE
      mockSend.mockResolvedValueOnce({}); // UpdateTable (DPE flip off)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1' }] }, // DPE absent in new
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] }
      );
      // The UpdateTable was still issued (no behavior change).
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.DeletionProtectionEnabled).toBe(false);
      // The WARN was emitted naming the table + the recovery hint.
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).toMatch(/Auto-disabling DeletionProtectionEnabled/);
      expect(warnMessages).toMatch(new RegExp(TABLE_NAME));
      expect(warnMessages).toMatch(/CDK code does not set 'deletionProtection: true'/);
      expect(warnMessages).toMatch(/set 'deletionProtection: true' in your CDK code/);
    });

    it('Auto-disable WARN: NOT emitted when DPE is explicitly set to false (user opted in)', async () => {
      // The WARN is for the "property removed" case only. An explicit
      // `deletionProtection: false` is a user-opted-in disable — no
      // surprise, no need to warn.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } });
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: true },
      });
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } });
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } });

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: false }] },
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: true }] }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.DeletionProtectionEnabled).toBe(false);
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).not.toMatch(/Auto-disabling DeletionProtectionEnabled/);
    });

    it('Auto-disable WARN: ALSO fires when state DPE=false but AWS console-enabled (drift recovery flip)', async () => {
      // Edge case: at a past deploy state recorded DPE=false (explicit
      // or AWS-default). An admin then enabled DeletionProtection via
      // the AWS console. Template still omits DPE. The diff-from-state
      // (false !== undefined) drives entry into the diff branch; the
      // flip predicate fires because awsDpe===true. The neutral wording
      // covers this case — "removed from CDK code" would be misleading
      // (it was false, not true, in state).
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: true },
      }); // AWS-current is true (console enabled)
      mockSend.mockResolvedValueOnce({}); // UpdateTable (DPE flip off)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1' }] }, // no DPE in new
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: false }] } // state=false
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.DeletionProtectionEnabled).toBe(false);
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).toMatch(/Auto-disabling DeletionProtectionEnabled/);
      expect(warnMessages).toMatch(/CDK code does not set 'deletionProtection: true'/);
    });

    it('Auto-disable WARN: NOT emitted when DPE was never on (no flip from true)', async () => {
      // Sanity: state DPE=false, template removes the prop (still
      // undefined → defaults to false). The diff dpeDiffersFromState
      // fires (false !== undefined) so an UpdateTable IS issued —
      // but the value is false→false (no actual flip on AWS), so
      // no WARN should fire because the user never had protection on.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: false },
      }); // DescribeTable for ARN + AWS DPE
      mockSend.mockResolvedValueOnce({}); // UpdateTable (no-op flip)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait post-update
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1' }] },
        { Replicas: [{ Region: 'us-east-1', DeletionProtectionEnabled: false }] }
      );
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).not.toMatch(/Auto-disabling DeletionProtectionEnabled/);
    });

    it('TTL rate limit error: rewraps AWS "Time to live has been modified multiple times" with a friendly hint', async () => {
      // AWS enforces a ~4-hour TTL change rate limit per table. The
      // raw error message is correct but not actionable. cdkd
      // rewraps with a ProvisioningError that names the rate limit
      // and points at the workaround.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockRejectedValueOnce(
        new Error('Time to live has been modified multiple times within a fixed interval')
      );

      await expect(
        provider.update(
          'X',
          TABLE_NAME,
          RESOURCE_TYPE,
          {
            TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
          },
          {}
        )
      ).rejects.toThrow(/4-hour rate limit on TTL changes/);
    });

    it('issues a separate UpdateTable for BillingMode flip (PAY_PER_REQUEST -> PROVISIONED with capacity)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (billing flip)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 7 },
        },
        { BillingMode: 'PAY_PER_REQUEST' }
      );

      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.BillingMode).toBe('PROVISIONED');
      expect(updateCalls[0]!.input.ProvisionedThroughput?.WriteCapacityUnits).toBe(7);
    });

    it('serializes Replica add via ReplicaUpdates: [{Create}] + waits for ACTIVE', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (replica Create)
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
      }); // waitForReplicaActive
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1', KMSMasterKeyId: 'alias/x' }],
        },
        { Replicas: [{ Region: 'us-east-1' }] }
      );

      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.ReplicaUpdates).toEqual([
        { Create: { RegionName: 'eu-west-1', KMSMasterKeyId: 'alias/x' } },
      ]);
    });

    it('serializes Replica remove via ReplicaUpdates: [{Delete}] + waits for gone', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (replica Delete)
      mockSend.mockResolvedValueOnce({ Table: { Replicas: [{ RegionName: 'us-east-1' }] } }); // waitForReplicaGone
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { Replicas: [{ Region: 'us-east-1' }] },
        { Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }] }
      );

      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.ReplicaUpdates).toEqual([
        { Delete: { RegionName: 'eu-west-1' } },
      ]);
    });

    it('issues UpdateTimeToLive when TTL changes', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } },
        {}
      );

      const ttlCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTimeToLiveCommand) as UpdateTimeToLiveCommand[];
      expect(ttlCalls).toHaveLength(1);
      expect(ttlCalls[0]!.input.TimeToLiveSpecification).toEqual({
        Enabled: true,
        AttributeName: 'expiresAt',
      });
    });

    it('throws ProvisioningError on immutable TableName change', async () => {
      await expect(
        provider.update(
          'X',
          TABLE_NAME,
          RESOURCE_TYPE,
          { TableName: 'new-name' },
          { TableName: 'old-name' }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('throws ProvisioningError on immutable KeySchema change', async () => {
      await expect(
        provider.update(
          'X',
          TABLE_NAME,
          RESOURCE_TYPE,
          { KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }] },
          { KeySchema: [{ AttributeName: 'other', KeyType: 'HASH' }] }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('throws ProvisioningError on AttributeDefinitions removal (additions allowed)', async () => {
      await expect(
        provider.update(
          'X',
          TABLE_NAME,
          RESOURCE_TYPE,
          { AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }] },
          {
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'sk', AttributeType: 'S' },
            ],
          }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('throws ProvisioningError on LocalSecondaryIndexes change', async () => {
      await expect(
        provider.update(
          'X',
          TABLE_NAME,
          RESOURCE_TYPE,
          { LocalSecondaryIndexes: [{ IndexName: 'idx2' } as never] },
          { LocalSecondaryIndexes: [{ IndexName: 'idx1' } as never] }
        )
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('issues GSI Create with AttributeDefinitions overlay', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (GSI Create)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      const newGsi = {
        IndexName: 'gsi-new',
        KeySchema: [{ AttributeName: 'gsiKey', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      };
      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'gsiKey', AttributeType: 'S' },
          ],
          GlobalSecondaryIndexes: [newGsi],
        },
        {
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        }
      );

      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      const u = updateCalls[0]!.input;
      expect(u.AttributeDefinitions).toHaveLength(2);
      expect(u.GlobalSecondaryIndexUpdates).toEqual([
        {
          Create: {
            IndexName: 'gsi-new',
            KeySchema: [{ AttributeName: 'gsiKey', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        },
      ]);
    });

    it('no-op when nothing differs — strictly no UpdateTable / TagResource / UntagResource / UpdateTimeToLive issued', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN (tag diff)
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update('X', TABLE_NAME, RESOURCE_TYPE, {}, {});
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      // Stronger assertion (per PR #388 review): pin down the no-op
      // contract by asserting no mutating SDK call was issued, not
      // just that the queued mocks happened to match.
      expect(names.filter((n) => n === 'UpdateTableCommand')).toEqual([]);
      expect(names.filter((n) => n === 'TagResourceCommand')).toEqual([]);
      expect(names.filter((n) => n === 'UntagResourceCommand')).toEqual([]);
      expect(names.filter((n) => n === 'UpdateTimeToLiveCommand')).toEqual([]);
      // Sanity: only the 3 DescribeTable reads.
      expect(names).toEqual([
        'DescribeTableCommand',
        'DescribeTableCommand',
        'DescribeTableCommand',
      ]);
    });

    it('BillingMode default matches create() — no false-fire flip when both sides omit BillingMode (regression for PR #388 blocker)', async () => {
      // Pre-fix: update() defaulted missing BillingMode to PROVISIONED
      // while create() defaulted to PAY_PER_REQUEST, so a redeploy of
      // a table with no explicit BillingMode in the template would
      // fire a phantom PROVISIONED -> PAY_PER_REQUEST flip every time.
      // Both sides should now default to PAY_PER_REQUEST and skip the
      // BillingMode UpdateTable when neither old nor new sets it.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        // No BillingMode on either side -> both default to PAY_PER_REQUEST.
        { Replicas: [{ Region: 'us-east-1' }] },
        { Replicas: [{ Region: 'us-east-1' }] }
      );
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names.filter((n) => n === 'UpdateTableCommand')).toEqual([]);
    });

    it('issues GSI Delete via GlobalSecondaryIndexUpdates: [{Delete}]', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({}); // UpdateTable GSI Delete
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // waitForTableActiveAfterUpdate
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { GlobalSecondaryIndexes: [] },
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'OldGsi',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
        }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
        { Delete: { IndexName: 'OldGsi' } },
      ]);
    });

    it('issues GSI Update via GlobalSecondaryIndexUpdates: [{Update}] when ProvisionedThroughput differs', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({}); // UpdateTable GSI Modify
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // waitForTableActiveAfterUpdate
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'G1',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ProvisionedThroughput: { ReadCapacityUnits: 20, WriteCapacityUnits: 20 },
            },
          ],
        },
        {
          GlobalSecondaryIndexes: [
            {
              IndexName: 'G1',
              KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            },
          ],
        }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      const gsiUpdate = updateCalls[0]!.input.GlobalSecondaryIndexUpdates?.[0];
      expect(gsiUpdate?.Update?.IndexName).toBe('G1');
      expect(gsiUpdate?.Update?.ProvisionedThroughput).toEqual({
        ReadCapacityUnits: 20,
        WriteCapacityUnits: 20,
      });
    });

    it('issues UpdateReplica for cross-region replica with KMSMasterKeyId change (non-Tags modify path)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({}); // UpdateTable Replica Update
      mockSend.mockResolvedValueOnce({
        Table: {
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
          ],
        },
      }); // waitForReplicaActive
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', KMSMasterKeyId: 'alias/new' },
          ],
        },
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', KMSMasterKeyId: 'alias/old' },
          ],
        }
      );
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(1);
      const ru = updateCalls[0]!.input.ReplicaUpdates?.[0];
      expect(ru?.Update?.RegionName).toBe('eu-west-1');
      expect(ru?.Update?.KMSMasterKeyId).toBe('alias/new');
    });

    it('propagates Tags to cross-region replica via regional UntagResource + TagResource (Issue #389)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for local tag diff
      mockSend.mockResolvedValueOnce({}); // Untag (regional)
      mockSend.mockResolvedValueOnce({}); // Tag (regional)
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', Tags: [{ Key: 'New', Value: 'A' }] },
          ],
        },
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', Tags: [{ Key: 'Old', Value: 'B' }] },
          ],
        }
      );

      // No UpdateTable should be issued for the cross-region replica
      // (only Tags changed; UpdateReplica skipped to avoid AWS's
      // ValidationException on empty Update).
      const updateCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTableCommand) as UpdateTableCommand[];
      expect(updateCalls).toHaveLength(0);

      // The cross-region client must have been spawned for eu-west-1.
      expect(regionalClientSpy).toHaveBeenCalledWith('eu-west-1');

      // The Untag + Tag SDK calls must target the eu-west-1 replica ARN,
      // not the local us-east-1 ARN.
      const untag = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof UntagResourceCommand) as
        | UntagResourceCommand
        | undefined;
      const tag = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof TagResourceCommand) as
        | TagResourceCommand
        | undefined;
      expect(untag?.input.ResourceArn).toBe(
        'arn:aws:dynamodb:eu-west-1:123:table/my-table'
      );
      expect(untag?.input.TagKeys).toEqual(['Old']);
      expect(tag?.input.ResourceArn).toBe(
        'arn:aws:dynamodb:eu-west-1:123:table/my-table'
      );
      expect(tag?.input.Tags).toEqual([{ Key: 'New', Value: 'A' }]);
    });

    it('propagates Tags to a newly-ADDED cross-region replica via regional TagResource (Issue #441 follow-up)', async () => {
      // Issue #441 follow-up review: pre-fix the `update()` added-
      // replica loop only wired up autoscaling; the new replica's
      // `Tags` silently dropped. This is the symmetric case of the
      // create-side fix — adding a NEW cross-region replica during
      // `cdkd deploy` must propagate Tags the same way the create
      // path does.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({}); // UpdateTable: addReplica Create
      mockSend.mockResolvedValueOnce({
        Table: {
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
          ],
        },
      }); // waitForReplicaActive
      mockSend.mockResolvedValueOnce({}); // TagResource (regional, new replica)
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', Tags: [{ Key: 'NewReplica', Value: 'Yes' }] },
          ],
        },
        {
          Replicas: [{ Region: 'us-east-1' }],
        }
      );

      // The regional client must have been spawned for eu-west-1 to
      // propagate Tags to the newly-added replica.
      expect(regionalClientSpy).toHaveBeenCalledWith('eu-west-1');

      // A TagResource against the eu-west-1 replica ARN must have
      // been issued (NOT against the local us-east-1 ARN).
      const tag = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof TagResourceCommand) as
        | TagResourceCommand
        | undefined;
      expect(tag).toBeDefined();
      expect(tag?.input.ResourceArn).toBe(
        'arn:aws:dynamodb:eu-west-1:123:table/my-table'
      );
      expect(tag?.input.Tags).toEqual([{ Key: 'NewReplica', Value: 'Yes' }]);

      // No UntagResource — added replica has no prior Tags.
      const untag = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof UntagResourceCommand);
      expect(untag).toBeUndefined();
    });

    it('skips cross-region Tag propagation gracefully when local DescribeTable returns no TableArn', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: {} }); // DescribeTable returns no ARN
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', Tags: [{ Key: 'New', Value: 'A' }] },
          ],
        },
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1' },
          ],
        }
      );

      const tagCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter(
          (c) => c instanceof UntagResourceCommand || c instanceof TagResourceCommand
        );
      expect(tagCalls).toHaveLength(0);
    });

    it('cross-region Tag propagation failure logs WARN and does not abort the deploy (Issue #389 / PR #393 review G1)', async () => {
      // Pre-fix the WARN-on-failure path was uncovered. Production
      // contract: when the regional TagResource or UntagResource throws
      // (permissions, throttle, region down, etc.), cdkd surfaces a
      // WARN naming the region + the "will surface as drift" hint and
      // continues. The deploy must not abort and downstream replicas
      // must still process.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for local tag diff
      mockSend.mockRejectedValueOnce(new Error('AccessDenied: TagResource (eu-west-1)')); // regional Tag/Untag throws
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      const result = await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', Tags: [{ Key: 'New', Value: 'A' }] },
          ],
        },
        {
          Replicas: [
            { Region: 'us-east-1' },
            { Region: 'eu-west-1', Tags: [{ Key: 'Old', Value: 'B' }] },
          ],
        }
      );

      // Deploy did NOT abort.
      expect(result.physicalId).toBe(TABLE_NAME);
      expect(result.wasReplaced).toBe(false);

      // WARN was logged for the failing region.
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).toMatch(/eu-west-1/);
    });

    it('issues UpdateTimeToLive with Enabled=false when template removes TimeToLiveSpecification', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive disable
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }
      );
      const ttlCalls = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof UpdateTimeToLiveCommand) as UpdateTimeToLiveCommand[];
      expect(ttlCalls).toHaveLength(1);
      expect(ttlCalls[0]!.input.TimeToLiveSpecification).toEqual({
        Enabled: false,
        AttributeName: 'expiresAt',
      });
    });
  });

  describe('diff helpers', () => {
    it('diffReplicas distinguishes added / removed / modified by Region key', () => {
      const oldR = [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }];
      const newR = [
        { Region: 'us-east-1' },
        { Region: 'eu-west-1', KMSMasterKeyId: 'alias/x' },
        { Region: 'ap-south-1' },
      ];
      const d = diffReplicas(oldR, newR);
      expect(d.added).toEqual([{ Region: 'ap-south-1' }]);
      expect(d.removed).toEqual([]);
      expect(d.modified).toEqual([{ Region: 'eu-west-1', KMSMasterKeyId: 'alias/x' }]);
    });

    it('diffGlobalSecondaryIndexes distinguishes added / removed / modified by IndexName', () => {
      const oldGsi = [
        { IndexName: 'a', KeySchema: [], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'b', KeySchema: [], Projection: { ProjectionType: 'ALL' } },
      ] as never;
      const newGsi = [
        { IndexName: 'a', KeySchema: [], Projection: { ProjectionType: 'KEYS_ONLY' } },
        { IndexName: 'c', KeySchema: [], Projection: { ProjectionType: 'ALL' } },
      ] as never;
      const d = diffGlobalSecondaryIndexes(oldGsi, newGsi);
      expect(d.added.map((g) => g.IndexName)).toEqual(['c']);
      expect(d.removed.map((g) => g.IndexName)).toEqual(['b']);
      expect(d.modified.map((g) => g.IndexName)).toEqual(['a']);
    });
  });

  describe('delete', () => {
    it('deletes a single-region table with no replicas via DeleteTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, Replicas: [{ RegionName: 'us-east-1' }] },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({}); // DeleteTable
      mockSend.mockRejectedValueOnce(newRnf()); // waitForTableGone -> RNF

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).toEqual([
        'DescribeTableCommand',
        'DeleteTableCommand',
        'DescribeTableCommand',
      ]);
    });

    it('tears down autoscaling targets BEFORE DeleteTable (regression PR #403 blocker — orphan leak)', async () => {
      // Pre-fix: delete() didn't call applyAutoScalingDiff, leaving
      // RegisterScalableTarget + PutScalingPolicy alive in AWS's
      // application-autoscaling control plane after destroy. A future
      // create of the same tableName would inherit the orphan target.
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, Replicas: [{ RegionName: 'us-east-1' }] },
      }); // DescribeTable (pre-delete replica scan)
      // Autoscaling teardown calls fire BEFORE DeleteTable. The default
      // mockAutoScalingSend in beforeEach resolves to { ScalingPolicies: [] }
      // / { ScalableTargets: [] } so the helper's DescribeScalingPolicies
      // + DescribeScalableTargets path treats them as "nothing to do"
      // when probing for existence — which is fine for this test (we
      // only need the helper to be CALLED for both Read + Write dims).
      mockSend.mockResolvedValueOnce({}); // DeleteTable
      mockSend.mockRejectedValueOnce(newRnf()); // waitForTableGone -> RNF

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      // The autoscaling client was invoked for the teardown — we don't
      // care exactly how many times (varies by lookup-first-then-act
      // vs always-act semantics in the helper) but at least once for
      // each of Read + Write dims (= at least 2 invocations).
      expect(mockAutoScalingSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('waitForTableGone polls DescribeTable until ResourceNotFoundException (regression: PR #384 / commit c512f24)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, Replicas: [{ RegionName: 'us-east-1' }] },
      }); // DescribeTable (pre-delete replica scan)
      mockSend.mockResolvedValueOnce({}); // DeleteTable
      // waitForTableGone loop: still DELETING for two polls, then RNF.
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableStatus: 'DELETING' },
      });
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableStatus: 'DELETING' },
      });
      mockSend.mockRejectedValueOnce(newRnf());

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      // Verify waitForTableGone made multiple DescribeTable calls (loop, not single-shot).
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).toEqual([
        'DescribeTableCommand', // pre-delete scan
        'DeleteTableCommand',
        'DescribeTableCommand', // wait poll #1 (still DELETING)
        'DescribeTableCommand', // wait poll #2 (still DELETING)
        'DescribeTableCommand', // wait poll #3 (RNF -> return)
      ]);
    });

    it('drops non-local replicas via UpdateTable Delete before DeleteTable', async () => {
      // DescribeTable: 2 replicas
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          Replicas: [{ RegionName: 'us-east-1' }, { RegionName: 'eu-west-1' }],
        },
      });
      // UpdateTable Delete eu-west-1
      mockSend.mockResolvedValueOnce({});
      // waitForReplicaGone — eu-west-1 not in replicas anymore
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'us-east-1' }] },
      });
      // DeleteTable
      mockSend.mockResolvedValueOnce({});
      // waitForTableGone — table now gone
      mockSend.mockRejectedValueOnce(newRnf());

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(UpdateTableCommand);
      const updateInput = (mockSend.mock.calls[1]?.[0] as UpdateTableCommand).input;
      expect(updateInput.ReplicaUpdates).toEqual([{ Delete: { RegionName: 'eu-west-1' } }]);
      const deleteCall = mockSend.mock.calls[3]?.[0];
      expect(deleteCall).toBeInstanceOf(DeleteTableCommand);
    });

    it('treats ResourceNotFoundException as idempotent success when region matches state', async () => {
      mockSend.mockRejectedValueOnce(newRnf()); // DescribeTable -> RNF
      mockSend.mockRejectedValueOnce(newRnf()); // DeleteTable -> RNF

      await expect(
        provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.toBeUndefined();
    });

    it('refuses NotFound idempotency when client region does not match state region', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, Replicas: [] },
      });
      mockSend.mockRejectedValueOnce(newRnf());

      await expect(
        provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow(/region/);
    });

    it('waitForReplicaGone polls until the replica disappears from Replicas[] (Item B follow-up)', async () => {
      // 1. DescribeTable returns 2 replicas (one to drop).
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          Replicas: [{ RegionName: 'us-east-1' }, { RegionName: 'eu-west-1' }],
        },
      });
      // 2. UpdateTable Delete eu-west-1
      mockSend.mockResolvedValueOnce({});
      // 3 + 4. waitForReplicaGone — replica still DELETING for two polls.
      mockSend.mockResolvedValueOnce({
        Table: {
          Replicas: [
            { RegionName: 'us-east-1' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'DELETING' },
          ],
        },
      });
      mockSend.mockResolvedValueOnce({
        Table: {
          Replicas: [
            { RegionName: 'us-east-1' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'DELETING' },
          ],
        },
      });
      // 5. waitForReplicaGone — replica now gone.
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'us-east-1' }] },
      });
      // 6. DeleteTable
      mockSend.mockResolvedValueOnce({});
      // 7. waitForTableGone → RNF.
      mockSend.mockRejectedValueOnce(newRnf());

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      // Pre-delete describe + UpdateTable + 3 DescribeTable polls + DeleteTable + final RNF poll.
      expect(names).toEqual([
        'DescribeTableCommand', // pre-delete scan
        'UpdateTableCommand', // Delete eu-west-1
        'DescribeTableCommand', // waitForReplicaGone poll #1 (still DELETING)
        'DescribeTableCommand', // waitForReplicaGone poll #2 (still DELETING)
        'DescribeTableCommand', // waitForReplicaGone poll #3 (gone)
        'DeleteTableCommand',
        'DescribeTableCommand', // waitForTableGone -> RNF
      ]);
    });

    it('rejects with ProvisioningError when pre-delete DescribeTable hits a non-RNF error (Item B follow-up)', async () => {
      // ThrottlingException on the pre-delete DescribeTable — must NOT be
      // treated as RNF idempotency.
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));

      await expect(
        provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });

    it('--remove-protection: issues UpdateTable to clear DeletionProtectionEnabled first', async () => {
      mockSend.mockResolvedValueOnce({}); // UpdateTable (flip-off)
      mockSend.mockResolvedValueOnce({
        Table: { TableStatus: 'ACTIVE' },
      }); // waitForTableActiveAfterUpdate
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, Replicas: [{ RegionName: 'us-east-1' }] },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({}); // DeleteTable
      mockSend.mockRejectedValueOnce(newRnf()); // waitForTableGone -> RNF

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
        removeProtection: true,
      });

      const flipCall = mockSend.mock.calls[0]?.[0] as UpdateTableCommand;
      expect(flipCall).toBeInstanceOf(UpdateTableCommand);
      expect(flipCall.input.DeletionProtectionEnabled).toBe(false);
    });

    it('--remove-protection: RNF on the flip-off UpdateTable is swallowed and delete continues (Issue #389)', async () => {
      // The pre-delete `UpdateTable(DeletionProtectionEnabled: false)`
      // can return RNF when the table is concurrently destroyed; cdkd
      // swallows the RNF and continues to the per-region drop loop +
      // DeleteTable, which fall through to the standard region-match-
      // gated RNF idempotency path.
      mockSend.mockRejectedValueOnce(newRnf()); // UpdateTable (flip-off) -> RNF
      mockSend.mockRejectedValueOnce(newRnf()); // DescribeTable -> RNF (table gone)
      mockSend.mockRejectedValueOnce(newRnf()); // DeleteTable -> RNF

      await provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
        removeProtection: true,
      });

      // Walked through the flip-off + DescribeTable + DeleteTable; no
      // ProvisioningError because the region matched.
      expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('--remove-protection: RNF on flip-off does NOT bypass the region-match gate downstream', async () => {
      // Same as above but with a region mismatch — the downstream RNF
      // on DeleteTable must still throw because the destroy could be
      // silently stripping a still-existing resource from state.
      mockSend.mockRejectedValueOnce(newRnf()); // UpdateTable (flip-off) -> RNF
      mockSend.mockRejectedValueOnce(newRnf()); // DescribeTable -> RNF
      mockSend.mockRejectedValueOnce(newRnf()); // DeleteTable -> RNF

      await expect(
        provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'eu-west-1', // mismatch — local client is us-east-1
          removeProtection: true,
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });

  describe('getAttribute', () => {
    it('returns Arn from DescribeTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, TableId: 'tid-x', LatestStreamArn: 'stream-arn-x' },
      });
      const arn = await provider.getAttribute(TABLE_NAME, RESOURCE_TYPE, 'Arn');
      expect(arn).toBe(TABLE_ARN);
    });

    it('returns StreamArn from DescribeTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, LatestStreamArn: 'stream-arn-x' },
      });
      const streamArn = await provider.getAttribute(TABLE_NAME, RESOURCE_TYPE, 'StreamArn');
      expect(streamArn).toBe('stream-arn-x');
    });

    it('returns TableId from DescribeTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, TableId: 'tid-9' },
      });
      const tid = await provider.getAttribute(TABLE_NAME, RESOURCE_TYPE, 'TableId');
      expect(tid).toBe('tid-9');
    });

    it('caches repeated lookups per (physicalId, attribute)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN },
      });
      const a = await provider.getAttribute(TABLE_NAME, RESOURCE_TYPE, 'Arn');
      const b = await provider.getAttribute(TABLE_NAME, RESOURCE_TYPE, 'Arn');
      expect(a).toBe(TABLE_ARN);
      expect(b).toBe(TABLE_ARN);
      // Only one DescribeTable call.
      const describeCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DescribeTableCommand
      );
      expect(describeCalls).toHaveLength(1);
    });

    it('returns undefined for unknown attributes', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } });
      const v = await provider.getAttribute(TABLE_NAME, RESOURCE_TYPE, 'SomeUnknown');
      expect(v).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    /**
     * Helper to queue the per-replica sub-spec calls + DescribeTimeToLive
     * + ListTagsOfResource that readCurrentState now issues after the
     * initial DescribeTable. Local-region replicas trigger 3 sub-spec
     * calls (DescribeContributorInsights / DescribeContinuousBackups /
     * DescribeKinesisStreamingDestination); cross-region replicas don't.
     */
    function queueReadCurrentStateTail(
      opts: {
        localReplica?: boolean;
        contributorInsightsStatus?: 'ENABLED' | 'DISABLED';
        pitrStatus?: 'ENABLED' | 'DISABLED';
        kinesisStreamArn?: string;
        ttl?: { Status: 'ENABLED' | 'DISABLED'; AttributeName?: string };
        tags?: Array<{ Key: string; Value: string }>;
      } = {}
    ): void {
      if (opts.localReplica !== false) {
        // DescribeContributorInsights
        mockSend.mockResolvedValueOnce({
          ContributorInsightsStatus: opts.contributorInsightsStatus ?? 'DISABLED',
        });
        // DescribeContinuousBackups
        mockSend.mockResolvedValueOnce({
          ContinuousBackupsDescription: {
            ContinuousBackupsStatus: 'ENABLED',
            PointInTimeRecoveryDescription: {
              PointInTimeRecoveryStatus: opts.pitrStatus ?? 'DISABLED',
            },
          },
        });
        // DescribeKinesisStreamingDestination
        mockSend.mockResolvedValueOnce({
          KinesisDataStreamDestinations: opts.kinesisStreamArn
            ? [{ StreamArn: opts.kinesisStreamArn, DestinationStatus: 'ACTIVE' }]
            : [],
        });
      }
      // DescribeTimeToLive
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: opts.ttl
          ? {
              TimeToLiveStatus: opts.ttl.Status,
              AttributeName: opts.ttl.AttributeName,
            }
          : { TimeToLiveStatus: 'DISABLED' },
      });
      // ListTagsOfResource
      mockSend.mockResolvedValueOnce({ Tags: opts.tags ?? [] });
    }

    it('reverse-maps DescribeTable for a single-region PAY_PER_REQUEST table', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          Replicas: [{ RegionName: 'us-east-1' }],
        },
      });
      queueReadCurrentStateTail();

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);

      expect(observed).toBeDefined();
      expect(observed!['BillingMode']).toBe('PAY_PER_REQUEST');
      // Local-region replica now carries default-disabled sub-specs +
      // Tags placeholder (Tags are per-replica in the CFn schema).
      expect(observed!['Replicas']).toEqual([
        {
          Region: 'us-east-1',
          ContributorInsightsSpecification: { Enabled: false },
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
          Tags: [],
        },
      ]);
      // No top-level Tags — Tags live inside Replicas[].
      expect(observed).not.toHaveProperty('Tags');
      // Class 1 / Class 2 guards: never emit empty placeholders for these.
      expect(observed).not.toHaveProperty('GlobalSecondaryIndexes');
      expect(observed).not.toHaveProperty('LocalSecondaryIndexes');
      expect(observed).not.toHaveProperty('SSESpecification');
      expect(observed).not.toHaveProperty('StreamSpecification');
      // TTL not surfaced because the mock reported DISABLED with no AttributeName.
      expect(observed).not.toHaveProperty('TimeToLiveSpecification');
    });

    it('always-emits Tags placeholder inside the local Replicas[] entry even when AWS reports zero tags', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'us-east-1' }],
        },
      });
      queueReadCurrentStateTail();
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      // Tags live INSIDE the local replica entry per the CFn
      // `AWS::DynamoDB::GlobalTable` schema (there is no top-level
      // `Tags` property on this type).
      expect(observed).not.toHaveProperty('Tags');
      const replicas = observed!['Replicas'] as Array<Record<string, unknown>>;
      const local = replicas.find((r) => r['Region'] === 'us-east-1');
      expect(local).toBeDefined();
      expect(local!['Tags']).toEqual([]);
    });

    it('always-emits Replicas placeholder even when AWS reports no replicas', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN }, // no Replicas in response
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['Replicas']).toEqual([]);
    });

    it('surfaces enabled stream but omits disabled placeholder', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['StreamSpecification']).toEqual({
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      });
    });

    it('returns undefined when DescribeTable hits ResourceNotFoundException', async () => {
      mockSend.mockRejectedValueOnce(newRnf());
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed).toBeUndefined();
    });

    // ─── Drift coverage gaps (Item B follow-up to PR #384) ─────────────

    it('surfaces enabled SSE with SSEType from SSEDescription.Status === ENABLED', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          SSEDescription: { Status: 'ENABLED', SSEType: 'KMS' },
          Replicas: [],
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['SSESpecification']).toEqual({ SSEEnabled: true, SSEType: 'KMS' });
    });

    it('round-trips DeletionProtectionEnabled boolean from DescribeTable', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, DeletionProtectionEnabled: true, Replicas: [] },
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['DeletionProtectionEnabled']).toBe(true);
    });

    it('surfaces TimeToLiveSpecification when AWS reports ENABLED with AttributeName', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [] },
      });
      queueReadCurrentStateTail({
        localReplica: false,
        ttl: { Status: 'ENABLED', AttributeName: 'expiresAt' },
      });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['TimeToLiveSpecification']).toEqual({
        AttributeName: 'expiresAt',
        Enabled: true,
      });
    });

    it('omits TimeToLiveSpecification when AWS reports a transient UPDATING status', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [] },
      });
      // Manually queue tail with a transient TTL status — helper only
      // supports ENABLED/DISABLED, so inline-queue the TTL response.
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'UPDATING', AttributeName: 'expiresAt' },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed).not.toHaveProperty('TimeToLiveSpecification');
    });

    // ─── Per-replica drift surfacing (Item C) ─────────────────────────

    it('surfaces ContributorInsightsSpecification.Enabled on the LOCAL replica', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'us-east-1' }],
        },
      });
      queueReadCurrentStateTail({ contributorInsightsStatus: 'ENABLED' });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['ContributorInsightsSpecification']).toEqual({ Enabled: true });
    });

    it('surfaces PointInTimeRecoverySpecification on the LOCAL replica when AWS reports ENABLED', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [{ RegionName: 'us-east-1' }] },
      });
      queueReadCurrentStateTail({ pitrStatus: 'ENABLED' });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['PointInTimeRecoverySpecification']).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
    });

    it('surfaces KinesisStreamSpecification on the LOCAL replica when an ACTIVE destination exists', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [{ RegionName: 'us-east-1' }] },
      });
      queueReadCurrentStateTail({
        kinesisStreamArn: 'arn:aws:kinesis:us-east-1:123:stream/my-stream',
      });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['KinesisStreamSpecification']).toEqual({
        StreamArn: 'arn:aws:kinesis:us-east-1:123:stream/my-stream',
      });
    });

    it('surfaces per-replica sub-specs for cross-region replicas via regional client (Issue #389)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'eu-west-1' }], // cross-region only, no local
        },
      });
      // Cross-region replica: 3 sub-spec calls + ListTagsOfResource fire
      // against the regional client (which routes through mockSend via
      // the constructor mock). Then DescribeTimeToLive runs on the
      // local client.
      mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'ENABLED' });
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: {
            PointInTimeRecoveryStatus: 'ENABLED',
          },
        },
      });
      mockSend.mockResolvedValueOnce({ KinesisDataStreamDestinations: [] });
      mockSend.mockResolvedValueOnce({ Tags: [{ Key: 'Env', Value: 'prod' }] });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['Region']).toBe('eu-west-1');
      // Pre-#389 these were undefined; post-#389 the regional client
      // surfaces them.
      expect(replica!['ContributorInsightsSpecification']).toEqual({ Enabled: true });
      expect(replica!['PointInTimeRecoverySpecification']).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
      expect(replica!['Tags']).toEqual([{ Key: 'Env', Value: 'prod' }]);
      // Regional client was spawned for the cross-region region.
      expect(regionalClientSpy).toHaveBeenCalledWith('eu-west-1');
    });

    // ─── Throughput round-trip (Issue #389 item #3) ──────────────────

    it('surfaces WriteOnDemandThroughputSettings.MaxWriteRequestUnits when AWS reports it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          OnDemandThroughput: { MaxWriteRequestUnits: 1500 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteOnDemandThroughputSettings']).toEqual({
        MaxWriteRequestUnits: 1500,
      });
    });

    it('emits empty WriteOnDemandThroughputSettings placeholder when AWS reports no override (PR #145 pattern)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [] },
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteOnDemandThroughputSettings']).toEqual({});
    });

    it('surfaces WriteProvisionedThroughputSettings.WriteCapacityUnits on PROVISIONED tables WITHOUT auto-scaling', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7, ReadCapacityUnits: 4 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      // mockAutoScalingSend defaults to ScalingPolicies: [] in beforeEach.

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityUnits: 7,
      });
    });

    it('reverse-maps WriteCapacityAutoScalingSettings when application-autoscaling owns the WriteCapacityUnits dimension (Issue #395)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      // Autoscaling-active: 1st call is DescribeScalableTargets
      // (recovers Min/Max), 2nd is DescribeScalingPolicies (recovers
      // the TargetTrackingScaling policy).
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 5, MaxCapacity: 100 }],
      });
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalingPolicies: [
          {
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingScalingPolicyConfiguration: {
              TargetValue: 70,
              ScaleInCooldown: 60,
              ScaleOutCooldown: 30,
              DisableScaleIn: false,
            },
          },
        ],
      });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityAutoScalingSettings: {
          MinCapacity: 5,
          MaxCapacity: 100,
          TargetTrackingScalingPolicyConfiguration: {
            TargetValue: 70,
            ScaleInCooldown: 60,
            ScaleOutCooldown: 30,
            DisableScaleIn: false,
          },
        },
      });
    });

    it('reverse-maps WriteCapacityAutoScalingSettings with the minimum CDK-emitted shape (TargetValue only)', async () => {
      // CDK 2.x's `Capacity.autoscaled({minCapacity, maxCapacity,
      // targetUtilizationPercent})` only emits Min/Max/TargetValue —
      // ScaleInCooldown / ScaleOutCooldown / DisableScaleIn are absent.
      // This is the canonical shape captured by the `cdk synth` probe.
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 5 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 5, MaxCapacity: 100 }],
      });
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalingPolicies: [
          {
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
          },
        ],
      });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityAutoScalingSettings: {
          MinCapacity: 5,
          MaxCapacity: 100,
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
        },
      });
    });

    it('falls back to flat WriteCapacityUnits when DescribeScalingPolicies returns only non-TargetTrackingScaling policies', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      // ScalableTarget exists but the only policy is StepScaling —
      // CFn's shape only carries TargetTrackingScaling, so fall back
      // to the flat surface.
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 5, MaxCapacity: 100 }],
      });
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalingPolicies: [
          {
            PolicyType: 'StepScaling',
            StepScalingPolicyConfiguration: { AdjustmentType: 'ChangeInCapacity' },
          },
        ],
      });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityUnits: 7,
      });
    });

    it('picks the TargetTrackingScaling policy when DescribeScalingPolicies returns multiple policy types', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 10, MaxCapacity: 200 }],
      });
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalingPolicies: [
          { PolicyType: 'StepScaling' },
          {
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 80 },
          },
        ],
      });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityAutoScalingSettings: {
          MinCapacity: 10,
          MaxCapacity: 200,
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 80 },
        },
      });
    });

    it('invokes both DescribeScalableTargets and DescribeScalingPolicies when probing for write autoscaling', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 5, MaxCapacity: 100 }],
      });
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalingPolicies: [
          {
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
          },
        ],
      });

      await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);

      const calls = mockAutoScalingSend.mock.calls.map((c) => c[0].constructor.name);
      expect(calls).toEqual(['DescribeScalableTargetsCommand', 'DescribeScalingPoliciesCommand']);
    });

    it('reverse-maps per-replica ReadCapacityAutoScalingSettings for a cross-region replica via regional autoscaling client (Issue #395)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'eu-west-1' }], // cross-region only
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      // Cross-region replica: 3 sub-spec calls + ListTagsOfResource fire
      // against the regional DynamoDB client.
      mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'DISABLED' });
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({ KinesisDataStreamDestinations: [] });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });

      // Autoscaling probes — fire in order:
      //   1. cross-region replica's read dimension (regional autoscaling client)
      //   2. local table's write dimension (default autoscaling client)
      // The regional client uses Min/Max + TargetValue = 75; the local
      // write probe has no scalable target → null → flat fallback.
      mockAutoScalingSend.mockReset();
      // Read (cross-region replica eu-west-1):
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 1, MaxCapacity: 20 }],
      });
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalingPolicies: [
          {
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingScalingPolicyConfiguration: { TargetValue: 75 },
          },
        ],
      });
      // Write (local):
      mockAutoScalingSend.mockResolvedValueOnce({ ScalableTargets: [] });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['Region']).toBe('eu-west-1');
      expect(replica!['ReadProvisionedThroughputSettings']).toEqual({
        ReadCapacityAutoScalingSettings: {
          MinCapacity: 1,
          MaxCapacity: 20,
          TargetTrackingScalingPolicyConfiguration: { TargetValue: 75 },
        },
      });
      // Write surface falls back to flat (local probe returned empty).
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityUnits: 7,
      });
    });

    it('omits per-replica ReadProvisionedThroughputSettings when no autoscaling target is registered for the replica region', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'us-east-1' }],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      queueReadCurrentStateTail(); // local replica
      // Defaults to ScalingPolicies: [] for every call → no Min/Max
      // surfaced → null → key omitted.

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['Region']).toBe('us-east-1');
      expect(replica).not.toHaveProperty('ReadProvisionedThroughputSettings');
    });

    it('omits per-replica ReadProvisionedThroughputSettings on PAY_PER_REQUEST tables (type-discriminator gate)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'us-east-1' }],
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        },
      });
      queueReadCurrentStateTail();
      // On PAY_PER_REQUEST, the replica autoscaling probe must NOT fire
      // at all — autoscaling is meaningless without ProvisionedThroughput.
      mockAutoScalingSend.mockReset();

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica).not.toHaveProperty('ReadProvisionedThroughputSettings');
      // No autoscaling probe should have fired at all (table-level write
      // probe gated on PROVISIONED, per-replica read probe gated the same).
      expect(mockAutoScalingSend).not.toHaveBeenCalled();
    });

    it('spawns a regional ApplicationAutoScalingClient for the cross-region replica probe', async () => {
      // Capture the existing mock factory's prior call count so a
      // sibling test's setup does not pollute the assertion.
      const asModule = (await import(
        '@aws-sdk/client-application-auto-scaling'
      )) as unknown as {
        ApplicationAutoScalingClient: { mock: { calls: Array<unknown[]> } };
      };
      const before = asModule.ApplicationAutoScalingClient.mock.calls.length;
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'eu-west-1' }],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'DISABLED' });
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({ KinesisDataStreamDestinations: [] });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });
      // All autoscaling probes return no target → null → flat fallback.
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [] });

      await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);

      // A regional autoscaling client must have been constructed for
      // eu-west-1 (per-replica read dimension lives in the replica's
      // region). The local write probe uses the default-region client
      // (constructed inline by `readAutoScalingSettings` when no
      // `client` argument is passed) and therefore also constructs a
      // client, but only the regional cache fixes the region.
      const newCalls = asModule.ApplicationAutoScalingClient.mock.calls.slice(before);
      const regionsConstructed = newCalls
        .map((c) => (c[0] as { region?: string } | undefined)?.region)
        .filter((r): r is string => typeof r === 'string');
      expect(regionsConstructed).toContain('eu-west-1');
    });

    it('emits empty WriteProvisionedThroughputSettings placeholder on PAY_PER_REQUEST tables', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({});
    });

    it('falls back to flat WriteCapacityUnits when DescribeScalableTargets fails (best-effort, regression PR #393)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 4 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockRejectedValueOnce(new Error('permission denied on DescribeScalableTargets'));

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      // Lookup failure is treated as "no policy" — the flat-value
      // surface IS emitted (false-positive risk on scale is the
      // tradeoff vs hiding the actual capacity).
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityUnits: 4,
      });
    });

    it('falls back to flat WriteCapacityUnits when DescribeScalingPolicies fails after DescribeScalableTargets succeeded (PR #397 review minor)', async () => {
      // Covers the second-call failure path: DescribeScalableTargets
      // succeeds (returns Min/Max) → DescribeScalingPolicies throws.
      // Same outer try/catch wraps both; symmetric behavior.
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [],
          BillingModeSummary: { BillingMode: 'PROVISIONED' },
          ProvisionedThroughput: { WriteCapacityUnits: 7 },
        },
      });
      queueReadCurrentStateTail({ localReplica: false });
      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({
        ScalableTargets: [{ MinCapacity: 5, MaxCapacity: 100 }],
      });
      mockAutoScalingSend.mockRejectedValueOnce(new Error('throttle on DescribeScalingPolicies'));

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['WriteProvisionedThroughputSettings']).toEqual({
        WriteCapacityUnits: 7,
      });
    });

    it('caches getRegionalAutoScalingClient per region (no duplicate construction on repeated cross-region reads)', async () => {
      // Mirror the existing getRegionalClient cache test pattern.
      // Two readCurrentState invocations against a stack with a single
      // cross-region replica should construct the regional autoscaling
      // client at most once for that region.
      const { ApplicationAutoScalingClient } = await import(
        '@aws-sdk/client-application-auto-scaling'
      );
      const ctorSpy = ApplicationAutoScalingClient as unknown as { mock: { calls: unknown[][] } };
      const beforeCalls = ctorSpy.mock.calls.length;

      const queueOne = () => {
        mockSend.mockResolvedValueOnce({
          Table: {
            TableArn: TABLE_ARN,
            Replicas: [{ RegionName: 'eu-west-1' }],
            BillingModeSummary: { BillingMode: 'PROVISIONED' },
            ProvisionedThroughput: { WriteCapacityUnits: 5 },
          },
        });
        // Skip the local replica's sub-spec queue tail (4 calls) — we
        // only care that the regional client is reused; the regional
        // sub-spec calls just need send-able mocks.
        queueReadCurrentStateTail({ localReplica: false });
        // Cross-region sub-spec calls (4): CI / PITR / Kinesis / Tags
        mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'DISABLED' });
        mockSend.mockResolvedValueOnce({
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
          },
        });
        mockSend.mockResolvedValueOnce({ KinesisDataStreamDestinations: [] });
        mockSend.mockResolvedValueOnce({ Tags: [] });
      };

      mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });

      queueOne();
      await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      queueOne();
      await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);

      const newCalls = ctorSpy.mock.calls.length - beforeCalls;
      // Regional client constructed at most ONCE for eu-west-1 across
      // both reads (the cache hit on the second read short-circuits
      // before the constructor fires).
      const euWestCalls = ctorSpy.mock.calls
        .slice(beforeCalls)
        .filter((args) => (args[0] as { region?: string } | undefined)?.region === 'eu-west-1');
      expect(euWestCalls.length).toBeLessThanOrEqual(1);
      // Sanity: at least one autoscaling client was built (for the
      // default global client or the eu-west-1 client).
      expect(newCalls).toBeGreaterThan(0);
    });

    it('omits the offending sub-spec key when the per-region call fails (best-effort)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'eu-west-1' }],
        },
      });
      // ContributorInsights succeeds, PITR throws, Kinesis succeeds,
      // ListTagsOfResource throws. The whole drift read must continue
      // and surface only the keys that worked.
      mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'DISABLED' });
      mockSend.mockRejectedValueOnce(new Error('access denied in eu-west-1'));
      mockSend.mockResolvedValueOnce({ KinesisDataStreamDestinations: [] });
      mockSend.mockRejectedValueOnce(new Error('tag api boom'));
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['ContributorInsightsSpecification']).toEqual({ Enabled: false });
      expect(replica!['PointInTimeRecoverySpecification']).toBeUndefined();
      expect(replica!['Tags']).toEqual([]); // best-effort fallback
    });

    // ─── create path: PROVISIONED BillingMode (Item B follow-up) ─────

    // (PROVISIONED create test placed near other create paths; see below.)
  });

  describe('create (BillingMode === PROVISIONED, Item B follow-up)', () => {
    it("derives ProvisionedThroughput from WriteProvisionedThroughputSettings + per-replica read settings", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: 'PT', TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive

      await provider.create('PT', RESOURCE_TYPE, {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PROVISIONED',
        WriteProvisionedThroughputSettings: { WriteCapacityUnits: 10 },
        Replicas: [
          {
            Region: 'us-east-1',
            ReadProvisionedThroughputSettings: { ReadCapacityUnits: 5 },
          },
        ],
      });

      const ctr = mockSend.mock.calls[0]?.[0] as CreateTableCommand;
      expect(ctr.input.ProvisionedThroughput).toEqual({
        WriteCapacityUnits: 10,
        ReadCapacityUnits: 5,
      });
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('is empty: throughput settings now round-trip; the deny list is empty (Issue #389)', () => {
      const paths = provider.getDriftUnknownPaths(RESOURCE_TYPE);
      // Pre-#389: ['WriteProvisionedThroughputSettings',
      // 'WriteOnDemandThroughputSettings']. Post-#389: empty — both
      // surfaces are reverse-mapped in `readCurrentState` (the auto-
      // scaling case emits an empty `{}` placeholder so the literal
      // `WriteCapacityUnits` subtree doesn't false-fire).
      expect(paths).toEqual([]);
      expect(paths).not.toContain('TimeToLiveSpecification');
    });
  });

  describe('import', () => {
    it('resolves via explicit TableName override → DescribeTable verify', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } });
      const result = await provider.import({
        logicalId: 'L',
        resourceType: RESOURCE_TYPE,
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'explicit-table',
      });
      expect(result).toEqual({ physicalId: 'explicit-table', attributes: {} });
    });

    it('returns null when explicit override does not exist on AWS', async () => {
      mockSend.mockRejectedValueOnce(newRnf());
      const result = await provider.import({
        logicalId: 'L',
        resourceType: RESOURCE_TYPE,
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'missing-table',
      });
      expect(result).toBeNull();
    });

    it('returns null without any AWS call when no override is supplied (no aws:cdk:path tag walk)', async () => {
      // The aws:cdk:path tag walk is gone (issue #1134): AWS rejects
      // aws:-prefixed tag writes, so the tag never exists on a real resource.
      // With no explicit override the provider resolves nothing and returns
      // null immediately — the import flow relies on --resource / CFn lookup.
      const result = await provider.import({
        logicalId: 'L',
        resourceType: RESOURCE_TYPE,
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // ─── Item A: write path autoscaling — RegisterScalableTarget +
  //     PutScalingPolicy on update (Issue #402) ────────────────────────
  describe('update path: applyAutoScalingDiff (Issue #402)', () => {
    it('issues RegisterScalableTarget + PutScalingPolicy on write dimension when template adds WriteCapacityAutoScalingSettings', async () => {
      // Sequence: wait ACTIVE → DescribeTable for ARN → BillingMode flip
      // (PAY_PER_REQUEST -> PROVISIONED) → wait ACTIVE → applyAutoScalingDiff
      // → final DescribeTable.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (BillingMode flip)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // RegisterScalableTarget
      mockAutoScalingSend.mockResolvedValueOnce({}); // PutScalingPolicy

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        },
        { BillingMode: 'PAY_PER_REQUEST' }
      );

      const asCalls = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      expect(asCalls.length).toBe(2);
      expect(asCalls[0]).toBeInstanceOf(RegisterScalableTargetCommand);
      const regInput = (asCalls[0] as RegisterScalableTargetCommand).input;
      expect(regInput.ServiceNamespace).toBe('dynamodb');
      expect(regInput.ResourceId).toBe(`table/${TABLE_NAME}`);
      expect(regInput.ScalableDimension).toBe('dynamodb:table:WriteCapacityUnits');
      expect(regInput.MinCapacity).toBe(5);
      expect(regInput.MaxCapacity).toBe(100);

      expect(asCalls[1]).toBeInstanceOf(PutScalingPolicyCommand);
      const polInput = (asCalls[1] as PutScalingPolicyCommand).input;
      expect(polInput.PolicyName).toBe(
        `DynamoDBWriteCapacityUtilization:table/${TABLE_NAME}`
      );
      expect(polInput.PolicyType).toBe('TargetTrackingScaling');
      const cfg = polInput.TargetTrackingScalingPolicyConfiguration as
        | Record<string, unknown>
        | undefined;
      expect(cfg?.['TargetValue']).toBe(70);
      expect(cfg?.['PredefinedMetricSpecification']).toEqual({
        PredefinedMetricType: 'DynamoDBWriteCapacityUtilization',
      });
    });

    it('issues DeleteScalingPolicy + DeregisterScalableTarget on write dimension when template removes WriteCapacityAutoScalingSettings', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // DeleteScalingPolicy
      mockAutoScalingSend.mockResolvedValueOnce({}); // DeregisterScalableTarget

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
        },
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        }
      );

      const asCalls = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      expect(asCalls.length).toBe(2);
      expect(asCalls[0]).toBeInstanceOf(DeleteScalingPolicyCommand);
      expect(asCalls[1]).toBeInstanceOf(DeregisterScalableTargetCommand);
      const polInput = (asCalls[0] as DeleteScalingPolicyCommand).input;
      expect(polInput.PolicyName).toBe(
        `DynamoDBWriteCapacityUtilization:table/${TABLE_NAME}`
      );
    });

    it('forces autoscaling teardown on PROVISIONED -> PAY_PER_REQUEST flip even if template still carries WriteCapacityAutoScalingSettings', async () => {
      // AWS rejects autoscaling targets on PAY_PER_REQUEST tables; cdkd
      // must Delete + Deregister regardless of what the new template
      // says, otherwise the BillingMode flip strands the now-invalid target.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (BillingMode flip back to PAY_PER_REQUEST)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // DeleteScalingPolicy
      mockAutoScalingSend.mockResolvedValueOnce({}); // DeregisterScalableTarget

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PAY_PER_REQUEST',
          WriteProvisionedThroughputSettings: {
            // Stale autoscaling settings in the template — cdkd must
            // ignore them and tear the target down because the table is
            // flipping to PAY_PER_REQUEST.
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        },
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        }
      );

      const asCalls = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      expect(asCalls.length).toBe(2);
      expect(asCalls[0]).toBeInstanceOf(DeleteScalingPolicyCommand);
      expect(asCalls[1]).toBeInstanceOf(DeregisterScalableTargetCommand);
    });

    it('issues per-replica RegisterScalableTarget + PutScalingPolicy on read dimension when a new replica adds ReadCapacityAutoScalingSettings', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      // BillingMode unchanged on both sides — no flip UpdateTable.
      mockSend.mockResolvedValueOnce({}); // UpdateTable (replica Create)
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' }] },
      }); // waitForReplicaActive
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // RegisterScalableTarget
      mockAutoScalingSend.mockResolvedValueOnce({}); // PutScalingPolicy

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
          Replicas: [
            { Region: 'us-east-1' },
            {
              Region: 'eu-west-1',
              ReadProvisionedThroughputSettings: {
                ReadCapacityAutoScalingSettings: {
                  MinCapacity: 5,
                  MaxCapacity: 50,
                  TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
                },
              },
            },
          ],
        },
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
          Replicas: [{ Region: 'us-east-1' }],
        }
      );

      const asCalls = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      expect(asCalls.length).toBe(2);
      expect(asCalls[0]).toBeInstanceOf(RegisterScalableTargetCommand);
      const regInput = (asCalls[0] as RegisterScalableTargetCommand).input;
      expect(regInput.ScalableDimension).toBe('dynamodb:table:ReadCapacityUnits');
      expect(regInput.MinCapacity).toBe(5);
      expect(regInput.MaxCapacity).toBe(50);

      expect(asCalls[1]).toBeInstanceOf(PutScalingPolicyCommand);
      const polInput = (asCalls[1] as PutScalingPolicyCommand).input;
      expect(polInput.PolicyName).toBe(
        `DynamoDBReadCapacityUtilization:table/${TABLE_NAME}`
      );
      const cfg = polInput.TargetTrackingScalingPolicyConfiguration as
        | Record<string, unknown>
        | undefined;
      expect(cfg?.['PredefinedMetricSpecification']).toEqual({
        PredefinedMetricType: 'DynamoDBReadCapacityUtilization',
      });
      // PR #403 review minor #2: the per-replica autoscaling SDK calls
      // must be routed through the regional client for the new replica's
      // region.
      expect(regionalAutoScalingClientSpy).toHaveBeenCalledWith('eu-west-1');
    });

    it('issues per-replica read autoscaling diff on modified cross-region replica via the regional autoscaling client', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for tag diff
      mockSend.mockResolvedValueOnce({}); // UpdateTable (replica Update)
      mockSend.mockResolvedValueOnce({
        Table: {
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
          ],
        },
      });
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // RegisterScalableTarget
      mockAutoScalingSend.mockResolvedValueOnce({}); // PutScalingPolicy

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
          Replicas: [
            { Region: 'us-east-1' },
            {
              Region: 'eu-west-1',
              KMSMasterKeyId: 'alias/new',
              ReadProvisionedThroughputSettings: {
                ReadCapacityAutoScalingSettings: {
                  MinCapacity: 10,
                  MaxCapacity: 200,
                  TargetTrackingScalingPolicyConfiguration: { TargetValue: 80 },
                },
              },
            },
          ],
        },
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
          Replicas: [
            { Region: 'us-east-1' },
            {
              Region: 'eu-west-1',
              KMSMasterKeyId: 'alias/old',
              ReadProvisionedThroughputSettings: {
                ReadCapacityAutoScalingSettings: {
                  MinCapacity: 5,
                  MaxCapacity: 100,
                  TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
                },
              },
            },
          ],
        }
      );

      const asCalls = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      expect(asCalls.length).toBe(2);
      expect(asCalls[0]).toBeInstanceOf(RegisterScalableTargetCommand);
      const regInput = (asCalls[0] as RegisterScalableTargetCommand).input;
      expect(regInput.ScalableDimension).toBe('dynamodb:table:ReadCapacityUnits');
      expect(regInput.MinCapacity).toBe(10);
      expect(regInput.MaxCapacity).toBe(200);
      // PR #403 review minor #2: verify the SDK calls were routed
      // through the regional client constructed for eu-west-1, not
      // the local-region client. A regression that accidentally
      // used `this.localAutoScalingClient` would silently create the
      // scalable target in us-east-1 (the deploy region) — AWS would
      // accept it (the target resource doesn't carry the replica
      // region in its ResourceId, just `table/<name>`), but the
      // policy + target would live in the wrong region's autoscaling
      // control plane.
      expect(regionalAutoScalingClientSpy).toHaveBeenCalledWith('eu-west-1');
    });

    it('tears down per-replica read autoscaling via the regional client when a cross-region replica is removed (Issue #407)', async () => {
      // Setup: previous deploy had eu-west-1 replica with read
      // autoscaling; new template drops the replica. cdkd must
      // DeleteScalingPolicy + DeregisterScalableTarget on the regional
      // autoscaling client BEFORE issuing `UpdateTable: ReplicaUpdates`
      // (Delete) — same orphan-leak concern as the delete() path.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (replica Delete)
      mockSend.mockResolvedValueOnce({
        Table: { Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }] },
      }); // waitForReplicaGone
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // DeleteScalingPolicy
      mockAutoScalingSend.mockResolvedValueOnce({}); // DeregisterScalableTarget

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
          Replicas: [{ Region: 'us-east-1' }],
        },
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: { WriteCapacityUnits: 5 },
          Replicas: [
            { Region: 'us-east-1' },
            {
              Region: 'eu-west-1',
              ReadProvisionedThroughputSettings: {
                ReadCapacityAutoScalingSettings: {
                  MinCapacity: 5,
                  MaxCapacity: 50,
                  TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
                },
              },
            },
          ],
        }
      );

      const asCalls = mockAutoScalingSend.mock.calls.map((c) => c[0]);
      expect(asCalls.length).toBe(2);
      expect(asCalls[0]).toBeInstanceOf(DeleteScalingPolicyCommand);
      expect(asCalls[1]).toBeInstanceOf(DeregisterScalableTargetCommand);
      const delInput = (asCalls[0] as DeleteScalingPolicyCommand).input;
      expect(delInput.PolicyName).toBe(
        `DynamoDBReadCapacityUtilization:table/${TABLE_NAME}`
      );
      expect(delInput.ScalableDimension).toBe('dynamodb:table:ReadCapacityUnits');
      // PR #403 review minor #2: the teardown SDK calls must be routed
      // through the regional autoscaling client constructed for
      // eu-west-1, not the local-region client. Otherwise cdkd would
      // DeleteScalingPolicy against the WRONG region's control plane
      // and the eu-west-1 target would silently survive as an orphan.
      expect(regionalAutoScalingClientSpy).toHaveBeenCalledWith('eu-west-1');
    });

    it('best-effort: RegisterScalableTarget failure logs WARN and does NOT abort the update', async () => {
      // The autoscaling apply mirrors the cross-region Tags propagation
      // contract (PR #393): a failure logs at warn and the deploy
      // continues. State surfaces as drift on the next run.
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (BillingMode flip)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockRejectedValueOnce(
        new Error('AccessDenied: RegisterScalableTarget')
      );

      const result = await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        },
        { BillingMode: 'PAY_PER_REQUEST' }
      );

      expect(result.physicalId).toBe(TABLE_NAME);
      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMessages).toMatch(
        /Could not register auto-scaling target.*WriteCapacityUnits/
      );
    });

    it('no-op when WriteCapacityAutoScalingSettings is identical on both sides', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        },
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: { TargetValue: 70 },
            },
          },
        }
      );

      expect(mockAutoScalingSend).not.toHaveBeenCalled();
    });

    it('skips autoscaling when both sides are PAY_PER_REQUEST (no provisioned throughput → no autoscaling possible)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        { BillingMode: 'PAY_PER_REQUEST' },
        { BillingMode: 'PAY_PER_REQUEST' }
      );

      expect(mockAutoScalingSend).not.toHaveBeenCalled();
    });

    it('forwards optional cooldown / disableScaleIn fields to PutScalingPolicy when present', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN
      mockSend.mockResolvedValueOnce({}); // UpdateTable (BillingMode flip)
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      mockAutoScalingSend.mockReset();
      mockAutoScalingSend.mockResolvedValueOnce({}); // RegisterScalableTarget
      mockAutoScalingSend.mockResolvedValueOnce({}); // PutScalingPolicy

      await provider.update(
        'X',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          WriteProvisionedThroughputSettings: {
            WriteCapacityAutoScalingSettings: {
              MinCapacity: 5,
              MaxCapacity: 100,
              TargetTrackingScalingPolicyConfiguration: {
                TargetValue: 70,
                ScaleInCooldown: 60,
                ScaleOutCooldown: 30,
                DisableScaleIn: true,
              },
            },
          },
        },
        { BillingMode: 'PAY_PER_REQUEST' }
      );

      const polCall = mockAutoScalingSend.mock.calls.find(
        (c) => c[0] instanceof PutScalingPolicyCommand
      )?.[0] as PutScalingPolicyCommand;
      const cfg = polCall.input.TargetTrackingScalingPolicyConfiguration as
        | Record<string, unknown>
        | undefined;
      expect(cfg?.['ScaleInCooldown']).toBe(60);
      expect(cfg?.['ScaleOutCooldown']).toBe(30);
      expect(cfg?.['DisableScaleIn']).toBe(true);
    });
  });

  // ─── Item E: Kinesis ENABLING status filter (Issue #402) ─────────
  describe('readReplicaSubSpecs: Kinesis destination status filter (Item E)', () => {
    it('surfaces a Kinesis destination with DestinationStatus === ENABLING (not just ACTIVE)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [{ RegionName: 'us-east-1' }] },
      });
      // Local replica sub-spec calls: CI / PITR / Kinesis (ENABLING).
      mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'DISABLED' });
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({
        KinesisDataStreamDestinations: [
          {
            StreamArn: 'arn:aws:kinesis:us-east-1:123:stream/enabling-stream',
            DestinationStatus: 'ENABLING',
          },
        ],
      });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      // Pre-#402 the filter accepted only ACTIVE; an ENABLING destination
      // was dropped, surfacing as false-positive drift on a stack that
      // just enabled Kinesis streaming. Issue #402 widened the filter
      // to ACTIVE OR ENABLING.
      expect(replica!['KinesisStreamSpecification']).toEqual({
        StreamArn: 'arn:aws:kinesis:us-east-1:123:stream/enabling-stream',
      });
    });
  });

  // ─── Item F: Multi-destination ACTIVE disambiguation (Issue #402) ────
  describe('readReplicaSubSpecs: multi-destination ACTIVE disambiguation (Item F)', () => {
    it('picks the FIRST ACTIVE destination when AWS reports multiple ACTIVE entries', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [{ RegionName: 'us-east-1' }] },
      });
      mockSend.mockResolvedValueOnce({ ContributorInsightsStatus: 'DISABLED' });
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({
        KinesisDataStreamDestinations: [
          { StreamArn: 'arn:aws:kinesis:us-east-1:123:stream/first', DestinationStatus: 'ACTIVE' },
          { StreamArn: 'arn:aws:kinesis:us-east-1:123:stream/second', DestinationStatus: 'ACTIVE' },
        ],
      });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      // Production docstring: "pick the first ACTIVE destination" (CFn's
      // per-replica shape only carries one StreamArn).
      expect(replica!['KinesisStreamSpecification']).toEqual({
        StreamArn: 'arn:aws:kinesis:us-east-1:123:stream/first',
      });
    });
  });

  // ─── Item G: Malformed local ARN defensive return (Issue #402) ───
  describe('replicaArnForRegion: defensive return on malformed ARN (Item G)', () => {
    it('returns undefined when fed an ARN with fewer than 6 colon-separated segments', () => {
      // Access the private helper via cast; mirrors `as unknown as`
      // patterns already used elsewhere in this file.
      const p = provider as unknown as {
        replicaArnForRegion(arn: string, region: string): string | undefined;
      };
      // 5-segment ARN — missing the resource segment.
      const malformed = 'arn:aws:dynamodb:us-east-1:123';
      expect(p.replicaArnForRegion(malformed, 'eu-west-1')).toBeUndefined();
    });

    it('returns the swapped-region ARN on a well-formed input (regression baseline)', () => {
      const p = provider as unknown as {
        replicaArnForRegion(arn: string, region: string): string | undefined;
      };
      expect(p.replicaArnForRegion(TABLE_ARN, 'eu-west-1')).toBe(
        'arn:aws:dynamodb:eu-west-1:123:table/my-table'
      );
    });
  });

  // ─── Item H: flip-off-success → DeleteTable-RNF region-mismatch
  //     theoretical path (Issue #402) ─────────────────────────────────
  describe('delete: --remove-protection flip-off SUCCESS then DeleteTable RNF + region mismatch (Item H)', () => {
    it('refuses NotFound idempotency on DeleteTable when client region != state region, even after the flip-off succeeded', async () => {
      // Sequence: flip-off UpdateTable succeeds → waitForTableActiveAfterUpdate
      // succeeds → DescribeTable returns RNF (table concurrently deleted)
      // → DeleteTable returns RNF → region-match check refuses idempotency.
      mockSend.mockResolvedValueOnce({}); // UpdateTable (flip-off) — SUCCESS
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait ACTIVE — SUCCESS
      mockSend.mockRejectedValueOnce(newRnf()); // DescribeTable -> RNF
      mockSend.mockRejectedValueOnce(newRnf()); // DeleteTable -> RNF

      await expect(
        provider.delete('X', TABLE_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'eu-west-1', // mismatch — local client is us-east-1
          removeProtection: true,
        })
      ).rejects.toBeInstanceOf(ProvisioningError);
    });
  });
});
