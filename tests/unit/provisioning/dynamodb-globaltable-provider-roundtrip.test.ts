import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
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

import { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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
        'Tags',
      ];
      for (const k of expected) {
        expect(set.has(k)).toBe(true);
      }
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
    it('throws ResourceUpdateNotSupportedError (MVP)', async () => {
      await expect(
        provider.update('X', TABLE_NAME, RESOURCE_TYPE, {}, {})
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
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
      mockSend.mockResolvedValueOnce({ Tags: [] }); // ListTagsOfResource

      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);

      expect(observed).toBeDefined();
      expect(observed!['BillingMode']).toBe('PAY_PER_REQUEST');
      expect(observed!['Replicas']).toEqual([{ Region: 'us-east-1' }]);
      expect(observed!['Tags']).toEqual([]);
      // Class 1 / Class 2 guards: never emit empty placeholders for these.
      expect(observed).not.toHaveProperty('GlobalSecondaryIndexes');
      expect(observed).not.toHaveProperty('LocalSecondaryIndexes');
      expect(observed).not.toHaveProperty('SSESpecification');
      expect(observed).not.toHaveProperty('StreamSpecification');
    });

    it('always-emits Tags placeholder even when AWS reports zero tags', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN, Replicas: [] },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      const observed = await provider.readCurrentState(TABLE_NAME, 'X', RESOURCE_TYPE);
      expect(observed!['Tags']).toEqual([]);
    });

    it('always-emits Replicas placeholder even when AWS reports no replicas', async () => {
      mockSend.mockResolvedValueOnce({
        Table: { TableArn: TABLE_ARN }, // no Replicas in response
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
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
      mockSend.mockResolvedValueOnce({ Tags: [] });
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
  });

  describe('getDriftUnknownPaths', () => {
    it('declares TTL + throughput-settings as drift-unknown (v1)', () => {
      const paths = provider.getDriftUnknownPaths(RESOURCE_TYPE);
      expect(paths).toEqual(
        expect.arrayContaining([
          'TimeToLiveSpecification',
          'WriteProvisionedThroughputSettings',
          'WriteOnDemandThroughputSettings',
        ])
      );
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
