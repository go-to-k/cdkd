import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
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

function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

/**
 * BillingMode / ProvisionedThroughput in-place UPDATE wiring.
 *
 * Both properties are mutable (CFn createOnly = only TableName +
 * ImportSourceSpecification) yet update() used to issue NO UpdateTable for
 * either — a pure capacity bump or a pure billing-mode switch was silently
 * dropped (state recorded the new value as applied, so the next deploy saw no
 * diff and AWS stayed stale forever). These tests pin the fix: the change now
 * reaches AWS via a single UpdateTable, sent BEFORE the OnDemand/Warm
 * throughput branches.
 */
describe('DynamoDBTableProvider BillingMode/ProvisionedThroughput update wiring', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  // The initial DescribeTable at the top of update().
  function primeDescribeTable(): void {
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
    });
  }

  // The DescribeTable that waitForTableActiveAfterUpdate polls; one ACTIVE
  // response is enough for it to return immediately.
  function primeWaitActive(): void {
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
    });
  }

  it('issues UpdateTable with the new ProvisionedThroughput on a pure capacity change (PROVISIONED->PROVISIONED)', async () => {
    primeDescribeTable();
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 100, WriteCapacityUnits: 50 },
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      }
    );

    const updateCalls = findCalls(UpdateTableCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.input.TableName).toBe(TABLE_NAME);
    expect(updateCalls[0]!.input.BillingMode).toBe('PROVISIONED');
    expect(updateCalls[0]!.input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 100,
      WriteCapacityUnits: 50,
    });
  });

  it('coerces string-typed capacity values to numbers (CFn emits numerics as strings)', async () => {
    primeDescribeTable();
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: '100', WriteCapacityUnits: '50' },
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: '5', WriteCapacityUnits: '5' },
      }
    );

    const updateCalls = findCalls(UpdateTableCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 100,
      WriteCapacityUnits: 50,
    });
  });

  it('issues UpdateTable with BillingMode=PAY_PER_REQUEST and NO ProvisionedThroughput on a switch to on-demand', async () => {
    primeDescribeTable();
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PAY_PER_REQUEST' },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      }
    );

    const updateCalls = findCalls(UpdateTableCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(updateCalls[0]!.input).not.toHaveProperty('ProvisionedThroughput');
  });

  it('does NOT carry ProvisionedThroughput even if the template still has caps when switching to PAY_PER_REQUEST', async () => {
    primeDescribeTable();
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PAY_PER_REQUEST',
        // Stale caps that should be ignored on a PAY_PER_REQUEST switch.
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      }
    );

    const updateCalls = findCalls(UpdateTableCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(updateCalls[0]!.input).not.toHaveProperty('ProvisionedThroughput');
  });

  it('sends BillingMode and ProvisionedThroughput together in one UpdateTable on a switch to PROVISIONED with caps', async () => {
    primeDescribeTable();
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
      },
      { BillingMode: 'PAY_PER_REQUEST' }
    );

    const updateCalls = findCalls(UpdateTableCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.input.BillingMode).toBe('PROVISIONED');
    expect(updateCalls[0]!.input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 10,
      WriteCapacityUnits: 10,
    });
    // The combined call must be sent before any OnDemand/Warm throughput call;
    // there is only one UpdateTable here, so order is trivially satisfied.
  });

  it('makes no billing UpdateTable call when neither BillingMode nor ProvisionedThroughput changes', async () => {
    primeDescribeTable();

    const props = {
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    };
    await provider.update('L', TABLE_NAME, RESOURCE_TYPE, { ...props }, { ...props });

    expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    // The only AWS call is the initial DescribeTable.
    expect(findCalls(DescribeTableCommand)).toHaveLength(1);
  });
});
