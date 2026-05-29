import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
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

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

const KEY_SCHEMA = [{ AttributeName: 'id', KeyType: 'HASH' }];
const ATTRIBUTE_DEFINITIONS = [{ AttributeName: 'id', AttributeType: 'S' }];

function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

describe('DynamoDBTableProvider PITR / TTL wiring', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  describe('handledProperties', () => {
    it('declares PointInTimeRecoverySpecification and TimeToLiveSpecification', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled?.has('PointInTimeRecoverySpecification')).toBe(true);
      expect(handled?.has('TimeToLiveSpecification')).toBe(true);
    });
  });

  describe('create', () => {
    it('wires PITR via UpdateContinuousBackups and TTL via UpdateTimeToLive after ACTIVE', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive -> DescribeTable
      mockSend.mockResolvedValueOnce({}); // UpdateContinuousBackups
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      });

      const pitrCalls = findCalls(UpdateContinuousBackupsCommand);
      expect(pitrCalls).toHaveLength(1);
      expect(pitrCalls[0]!.input.TableName).toBe(TABLE_NAME);
      expect(pitrCalls[0]!.input.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
      });

      const ttlCalls = findCalls(UpdateTimeToLiveCommand);
      expect(ttlCalls).toHaveLength(1);
      expect(ttlCalls[0]!.input.TableName).toBe(TABLE_NAME);
      expect(ttlCalls[0]!.input.TimeToLiveSpecification).toEqual({
        Enabled: true,
        AttributeName: 'expiresAt',
      });
    });

    it('defaults TTL Enabled to true when only AttributeName is given', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'ttl' },
      });

      const ttlCalls = findCalls(UpdateTimeToLiveCommand);
      expect(ttlCalls).toHaveLength(1);
      expect(ttlCalls[0]!.input.TimeToLiveSpecification).toEqual({
        Enabled: true,
        AttributeName: 'ttl',
      });
      // PITR not specified -> no UpdateContinuousBackups call.
      expect(findCalls(UpdateContinuousBackupsCommand)).toHaveLength(0);
    });

    it('makes no PITR / TTL calls when neither is specified', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
      });

      expect(findCalls(UpdateContinuousBackupsCommand)).toHaveLength(0);
      expect(findCalls(UpdateTimeToLiveCommand)).toHaveLength(0);
      // CreateTable must NOT carry these as inline props.
      const createCall = findCalls(CreateTableCommand)[0]!;
      expect(createCall.input).not.toHaveProperty('PointInTimeRecoverySpecification');
      expect(createCall.input).not.toHaveProperty('TimeToLiveSpecification');
    });
  });

  describe('update', () => {
    function primeDescribeTable(): void {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
    }

    it('enables PITR when newly added in the template', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateContinuousBackups

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
        {}
      );

      const pitrCalls = findCalls(UpdateContinuousBackupsCommand);
      expect(pitrCalls).toHaveLength(1);
      expect(pitrCalls[0]!.input.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
    });

    it('disables PITR when removed from the template', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateContinuousBackups

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }
      );

      const pitrCalls = findCalls(UpdateContinuousBackupsCommand);
      expect(pitrCalls).toHaveLength(1);
      expect(pitrCalls[0]!.input.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: false,
      });
    });

    it('updates TTL when its value changes', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } },
        { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: false } }
      );

      const ttlCalls = findCalls(UpdateTimeToLiveCommand);
      expect(ttlCalls).toHaveLength(1);
      expect(ttlCalls[0]!.input.TimeToLiveSpecification).toEqual({
        Enabled: true,
        AttributeName: 'expiresAt',
      });
    });

    it('disables TTL using the previous AttributeName when removed', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTimeToLive

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }
      );

      const ttlCalls = findCalls(UpdateTimeToLiveCommand);
      expect(ttlCalls).toHaveLength(1);
      expect(ttlCalls[0]!.input.TimeToLiveSpecification).toEqual({
        Enabled: false,
        AttributeName: 'expiresAt',
      });
    });

    it('makes no PITR / TTL calls when neither changed', async () => {
      primeDescribeTable();

      const props = {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      };

      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, props, props);

      expect(findCalls(UpdateContinuousBackupsCommand)).toHaveLength(0);
      expect(findCalls(UpdateTimeToLiveCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    function primeBase(): void {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({ Tags: [] }); // ListTagsOfResource
    }

    it('surfaces PITR enabled and TTL enabled when AWS reports them', async () => {
      primeBase();
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
        },
      }); // DescribeContinuousBackups
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'expiresAt' },
      }); // DescribeTimeToLive

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
      expect(mockSend.mock.calls[2]?.[0]).toBeInstanceOf(DescribeContinuousBackupsCommand);
      expect(mockSend.mock.calls[3]?.[0]).toBeInstanceOf(DescribeTimeToLiveCommand);

      expect(result?.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: true,
      });
      expect(result?.TimeToLiveSpecification).toEqual({
        AttributeName: 'expiresAt',
        Enabled: true,
      });
    });

    it('surfaces PITR as disabled (false) when AWS reports DISABLED', async () => {
      primeBase();
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' },
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result?.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: false,
      });
      // DISABLED TTL has no AttributeName; CFn rejects a TTL spec without one,
      // so the key must be omitted entirely.
      expect(result).not.toHaveProperty('TimeToLiveSpecification');
    });

    it('omits TTL on a transient ENABLING / DISABLING status', async () => {
      primeBase();
      mockSend.mockResolvedValueOnce({
        ContinuousBackupsDescription: {
          PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED' },
        },
      });
      mockSend.mockResolvedValueOnce({
        TimeToLiveDescription: { TimeToLiveStatus: 'ENABLING', AttributeName: 'expiresAt' },
      });

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result).not.toHaveProperty('TimeToLiveSpecification');
    });

    it('omits both keys when AWS returns no PITR / TTL descriptions', async () => {
      primeBase();
      mockSend.mockResolvedValueOnce({}); // DescribeContinuousBackups (empty)
      mockSend.mockResolvedValueOnce({}); // DescribeTimeToLive (empty)

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result).not.toHaveProperty('PointInTimeRecoverySpecification');
      expect(result).not.toHaveProperty('TimeToLiveSpecification');
    });
  });
});
