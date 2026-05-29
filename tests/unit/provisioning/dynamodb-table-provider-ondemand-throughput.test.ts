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
 * OnDemandThroughput (issue #609 backfill) — capacity caps for
 * PAY_PER_REQUEST (on-demand) tables, shape
 * `{ MaxReadRequestUnits, MaxWriteRequestUnits }`. Unlike PITR / TTL it
 * rides DIRECTLY on CreateTable / UpdateTable (not a separate
 * post-ACTIVE control-plane API).
 */
describe('DynamoDBTableProvider OnDemandThroughput wiring', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  describe('handledProperties', () => {
    it('declares OnDemandThroughput', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled?.has('OnDemandThroughput')).toBe(true);
    });
  });

  describe('create', () => {
    it('passes OnDemandThroughput through to CreateTable when present', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateTable
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      }); // waitForTableActive -> DescribeTable

      await provider.create('L', RESOURCE_TYPE, {
        TableName: TABLE_NAME,
        KeySchema: KEY_SCHEMA,
        AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
        BillingMode: 'PAY_PER_REQUEST',
        OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
      });

      const createCalls = findCalls(CreateTableCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: 5,
      });
    });

    it('omits OnDemandThroughput from CreateTable when not specified', async () => {
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
      expect(createCall.input).not.toHaveProperty('OnDemandThroughput');
    });
  });

  describe('update', () => {
    function primeDescribeTable(): void {
      mockSend.mockResolvedValueOnce({
        Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
      });
    }

    it('issues UpdateTable with the new OnDemandThroughput when it changes', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { OnDemandThroughput: { MaxReadRequestUnits: 20, MaxWriteRequestUnits: 10 } },
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } }
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.TableName).toBe(TABLE_NAME);
      expect(updateCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 20,
        MaxWriteRequestUnits: 10,
      });
    });

    it('issues UpdateTable when OnDemandThroughput is newly added', async () => {
      primeDescribeTable();
      mockSend.mockResolvedValueOnce({}); // UpdateTable

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } },
        {}
      );

      const updateCalls = findCalls(UpdateTableCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.input.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: 5,
      });
    });

    it('makes no UpdateTable call when OnDemandThroughput is unchanged', async () => {
      primeDescribeTable();

      const props = { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } };
      await provider.update('L', TABLE_NAME, RESOURCE_TYPE, props, props);

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });

    it('makes no UpdateTable call on the removal path (no spec to apply)', async () => {
      // Dropping OnDemandThroughput from the template: a removal carries no
      // new spec to send, so update() must not issue a malformed UpdateTable.
      primeDescribeTable();

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {},
        { OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 } }
      );

      expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    });
  });

  describe('readCurrentState', () => {
    function primeTtlPitrEmpty(): void {
      mockSend.mockResolvedValueOnce({}); // DescribeContinuousBackups (empty)
      mockSend.mockResolvedValueOnce({}); // DescribeTimeToLive (empty)
    }

    it('emits OnDemandThroughput when DescribeTable returns it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: {
            MaxReadRequestUnits: 10,
            MaxWriteRequestUnits: 5,
          },
        },
      }); // DescribeTable
      mockSend.mockResolvedValueOnce({ Tags: [] }); // ListTagsOfResource
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
      expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
      expect(result?.OnDemandThroughput).toEqual({
        MaxReadRequestUnits: 10,
        MaxWriteRequestUnits: 5,
      });
    });

    it('omits OnDemandThroughput when DescribeTable does not return it', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          // OnDemandThroughput absent.
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('OnDemandThroughput');
    });

    it('emits only the caps AWS actually reports (partial OnDemandThroughput)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
          OnDemandThroughput: { MaxReadRequestUnits: 10 },
        },
      });
      mockSend.mockResolvedValueOnce({ Tags: [] });
      primeTtlPitrEmpty();

      const result = await provider.readCurrentState(TABLE_NAME, 'L', RESOURCE_TYPE);

      expect(result?.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 10 });
    });
  });
});
