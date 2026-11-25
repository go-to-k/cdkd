import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn((): unknown => childLogger),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
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

const RESOURCE_TYPE = 'AWS::DynamoDB::Table';
const TABLE_NAME = 'my-test-table-xxx';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-test-table-xxx';

/**
 * DynamoDB refuses a `TableClass` change sharing an `UpdateTable` with any
 * other change: "TableClass modification must be the only operation in the
 * request" (go-to-k/cdkd#6995, measured on real AWS). CloudFormation completes
 * a template changing `TableClass` and `BillingMode` together, so the class
 * goes out in its own call after the billing / capacity one.
 */
describe('DynamoDBTableProvider sends a TableClass change in its own UpdateTable (issue #6995)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
    provider = new DynamoDBTableProvider();
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      },
    });
  });

  const baseProps = {
    TableName: TABLE_NAME,
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  };

  const updateInputs = (): Array<Record<string, unknown>> =>
    mockSend.mock.calls
      .filter((c) => c[0].constructor.name === 'UpdateTableCommand')
      .map((c) => c[0].input as Record<string, unknown>);

  it('splits a BillingMode flip and a TableClass change into two calls, billing first', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(updateInputs()).toEqual([
      {
        TableName: TABLE_NAME,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
      },
      { TableName: TABLE_NAME, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
    ]);
    // The class call waits for the billing call to settle: DynamoDB refuses an
    // UpdateTable on a table still UPDATING.
    const names = mockSend.mock.calls.map((c) => c[0].constructor.name as string);
    const firstUpdate = names.indexOf('UpdateTableCommand');
    const secondUpdate = names.indexOf('UpdateTableCommand', firstUpdate + 1);
    expect(names.slice(firstUpdate + 1, secondUpdate)).toContain('DescribeTableCommand');
  });

  it('splits a capacity change and a TableClass removal into two calls', async () => {
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
      },
    });
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 4, WriteCapacityUnits: 4 },
      },
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      }
    );

    expect(updateInputs()).toEqual([
      {
        TableName: TABLE_NAME,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 4, WriteCapacityUnits: 4 },
      },
      { TableName: TABLE_NAME, TableClass: 'STANDARD' },
    ]);
  });

  // The engine retries the whole update after the TableClass call fails (a
  // throttle, or the 30-day limit on class changes). The billing call already
  // landed, and re-sending it is refused ("The provisioned throughput for the
  // table will not change"), which replaced the real failure on real AWS.
  it('does not re-send a billing change the live table already holds (a retry)', async () => {
    const liveProvisioned = (read: number, write: number) => ({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PROVISIONED' },
        ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
      },
    });
    const desired = {
      ...baseProps,
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
      TableClass: 'STANDARD_INFREQUENT_ACCESS',
    };
    const previous = { ...baseProps, BillingMode: 'PAY_PER_REQUEST' };

    mockSend.mockResolvedValue(liveProvisioned(2, 2));
    await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);
    expect(updateInputs()).toEqual([
      { TableName: TABLE_NAME, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
    ]);

    // Live capacity differs from the desired one: the billing call goes out.
    mockSend.mockReset();
    mockSend.mockResolvedValue(liveProvisioned(1, 1));
    await provider.update('MyTable', TABLE_NAME, RESOURCE_TYPE, desired, previous);
    expect(updateInputs()).toEqual([
      {
        TableName: TABLE_NAME,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
      },
      { TableName: TABLE_NAME, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
    ]);
  });

  it('treats a live table with no BillingModeSummary as PROVISIONED on a retry', async () => {
    // DescribeTable leaves out BillingModeSummary for a table that was never
    // on demand. A capacity change already live must not be re-sent there.
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
      },
    });
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      },
      { ...baseProps, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }
    );
    expect(updateInputs()).toEqual([
      { TableName: TABLE_NAME, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
    ]);
  });

  it('does not re-send a TableClass the live table already holds (a retry)', async () => {
    mockSend.mockResolvedValue({
      Table: {
        TableName: TABLE_NAME,
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        TableClassSummary: { TableClass: 'STANDARD_INFREQUENT_ACCESS' },
      },
    });
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        ...baseProps,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
        TableClass: 'STANDARD_INFREQUENT_ACCESS',
      },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );
    expect(updateInputs()).toEqual([
      {
        TableName: TABLE_NAME,
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2 },
      },
    ]);
  });

  it('sends a TableClass-only change as one call carrying nothing else', async () => {
    await provider.update(
      'MyTable',
      TABLE_NAME,
      RESOURCE_TYPE,
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST', TableClass: 'STANDARD_INFREQUENT_ACCESS' },
      { ...baseProps, BillingMode: 'PAY_PER_REQUEST' }
    );

    expect(updateInputs()).toEqual([
      { TableName: TABLE_NAME, TableClass: 'STANDARD_INFREQUENT_ACCESS' },
    ]);
  });
});
