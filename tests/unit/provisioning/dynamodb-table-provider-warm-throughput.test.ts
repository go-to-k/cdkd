import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  UpdateTableCommand,
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

/**
 * WarmThroughput (issue #609 backfill) — pre-warmed read/write capacity, shape
 * `{ ReadUnitsPerSecond, WriteUnitsPerSecond }`. Like OnDemandThroughput it
 * rides DIRECTLY on CreateTable / UpdateTable (not a separate post-ACTIVE
 * control-plane API), and works with BOTH PROVISIONED and PAY_PER_REQUEST
 * billing modes.
 */
describe('DynamoDBTableProvider WarmThroughput wiring', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  describe('handledProperties', () => {
    it('declares WarmThroughput', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled?.has('WarmThroughput')).toBe(true);
    });
  });

  describe('create', () => {
    it('passes WarmThroughput through to CreateTable when present', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive -> DescribeTable

      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 },
      });

      const createCalls = findCalls(CreateTableCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('omits WarmThroughput from CreateTable when not specified', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });

      await provider.create('L', RESOURCE_TYPE, {
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
      });

      const createCall = findCalls(CreateTableCommand)[0]!;
      expect(createCall.input).not.toHaveProperty('WarmThroughput');
    });
  });

  describe('update', () => {
    function primeDescribeTable(): void {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
    }

    it('issues UpdateTable with the new WarmThroughput when it changes', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 } },
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.TableName).toBe(TABLE_NAME);
      expect(updateCalls[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 24000,
        WriteUnitsPerSecond: 8000,
      });
    });

    it('issues UpdateTable when WarmThroughput is newly added', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } },
        {}
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('makes no UpdateTable call when WarmThroughput is unchanged', async () => {
      primeDescribeTable();

      const props = { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } };
      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, props, props);

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });

    it('makes no UpdateTable call on the removal path (no spec to apply)', async () => {
      // Dropping WarmThroughput from the template: a removal carries no new
      // spec to send, so update() must not issue a malformed UpdateTable.
      primeDescribeTable();

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 } }
      );

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    function primeTtlPitrEmpty(): void {
      mockSend.mockResolvedValueOnce({}); // DescribeContinuousBackups (empty)
      mockSend.mockResolvedValueOnce({}); // DescribeTimeToLive (empty)
    }

    it('emits WarmThroughput when DescribeTable returns it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          WarmThroughput: {
            ReadUnitsPerSecond: 12000,
            WriteUnitsPerSecond: 4000,
            // Status is AWS-managed — must NOT be surfaced.
            Status: 'ACTIVE',
          },
        },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({ Tags: [] }); // ListTagsOfResource
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
      expect(result?.WarmThroughput).toEqual({
        ReadUnitsPerSecond: 12000,
        WriteUnitsPerSecond: 4000,
      });
    });

    it('omits WarmThroughput when DescribeTable does not return it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          // WarmThroughput absent.
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('WarmThroughput');
    });

    it('emits only the units AWS actually reports (partial WarmThroughput)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          WarmThroughput: { ReadUnitsPerSecond: 12000 },
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result?.WarmThroughput).toEqual({ ReadUnitsPerSecond: 12000 });
    });
  });
});
