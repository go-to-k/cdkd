import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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
    provider = new DynamoDBGlobalTableProvider();
  });

  describe('handledProperties', () => {
    it('lists the 15 CFn properties cdkd manages', () => {
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

    it('no-op when nothing differs (wait + describe + describe only)', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE' } }); // wait
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // DescribeTable for ARN (tag diff)
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } }); // final describe

      await provider.update('X', TABLE_NAME, RESOURCE_TYPE, {}, {});
      const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
      expect(names).toEqual([
        'DescribeTableCommand', // wait
        'DescribeTableCommand', // tag diff
        'DescribeTableCommand', // final describe
      ]);
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

    it('does NOT surface per-replica sub-specs for cross-region replicas (v1 limitation)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableArn: TABLE_ARN,
          Replicas: [{ RegionName: 'eu-west-1' }], // cross-region only, no local
        },
      });
      // No local replica → no sub-spec calls fire; just TTL + Tags.
      queueReadCurrentStateTail({ localReplica: false });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      const replica = (observed!['Replicas'] as Array<Record<string, unknown>>)[0];
      expect(replica!['ContributorInsightsSpecification']).toBeUndefined();
      expect(replica!['PointInTimeRecoverySpecification']).toBeUndefined();
      expect(replica!['KinesisStreamSpecification']).toBeUndefined();
      expect(replica!['Region']).toBe('eu-west-1');
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
    it('declares throughput-settings as drift-unknown (TTL now round-trips)', () => {
      const paths = provider.getDriftUnknownPaths(RESOURCE_TYPE);
      expect(paths).toEqual(
        expect.arrayContaining([
          'WriteProvisionedThroughputSettings',
          'WriteOnDemandThroughputSettings',
        ])
      );
      // TTL was previously here; the readCurrentState now reverse-maps
      // it via DescribeTimeToLive, so it must NOT be in the deny list.
      expect(paths).not.toContain('TimeToLiveSpecification');
    });
  });

  describe('import', () => {
    it('resolves via explicit TableName override → DescribeTable verify', async () => {
      mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN } });
      const result = await provider.import({
        logicalId: 'L',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'Stack/L/Resource',
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
        cdkPath: 'Stack/L/Resource',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: 'missing-table',
      });
      expect(result).toBeNull();
    });

    it('auto-mode: paginates ListTables, matches aws:cdk:path tag', async () => {
      // ListTables (page 1)
      mockSend.mockResolvedValueOnce({
        TableNames: ['tbl-1', 'tbl-2'],
      });
      // DescribeTable tbl-1
      mockSend.mockResolvedValueOnce({ Table: { TableArn: 'arn:tbl-1' } });
      // ListTagsOfResource tbl-1: wrong path
      mockSend.mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack/L/Resource' }],
      });
      // DescribeTable tbl-2
      mockSend.mockResolvedValueOnce({ Table: { TableArn: 'arn:tbl-2' } });
      // ListTagsOfResource tbl-2: matching path
      mockSend.mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'Stack/L/Resource' }],
      });

      const result = await provider.import({
        logicalId: 'L',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'Stack/L/Resource',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });
      expect(result).toEqual({ physicalId: 'tbl-2', attributes: {} });
      // Walked through ListTables -> DescribeTable -> ListTagsOfResource.
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListTablesCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(DescribeTableCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
    });

    it('auto-mode: returns null when no table matches cdkPath', async () => {
      mockSend.mockResolvedValueOnce({ TableNames: ['tbl-1'] });
      mockSend.mockResolvedValueOnce({ Table: { TableArn: 'arn:tbl-1' } });
      mockSend.mockResolvedValueOnce({
        Tags: [{ Key: 'aws:cdk:path', Value: 'OtherStack' }],
      });

      const result = await provider.import({
        logicalId: 'L',
        resourceType: RESOURCE_TYPE,
        cdkPath: 'Stack/L/Resource',
        stackName: 'Stack',
        region: 'us-east-1',
        properties: {},
      });
      expect(result).toBeNull();
    });
  });
});
