/**
 * go-to-k/cdkd#4583: a post-CreateTable wiring failure whose cleanup DeleteTable
 * also failed leaves the table in AWS with no state record, so `create()`
 * marks the thrown error with the table name `delete()` takes. A rollback
 * that succeeded, CreateTable's own failure and a pre-flight refusal leave
 * nothing behind and carry no mark.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const LOGICAL_ID = 'MyTable';

const PROPS = {
  TableName: TABLE_NAME,
  KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  Replicas: [{ Region: 'us-east-1' }],
  TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
};

function accessDenied(op: string): Error {
  const e = new Error(`User is not authorized to perform: dynamodb:${op}`);
  e.name = 'AccessDeniedException';
  return e;
}

/** Route by command name; `fail` names the commands that reject. */
function route(fail: Record<string, Error>): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (fail[name]) throw fail[name];
    if (name === 'DescribeTableCommand') {
      return { Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } };
    }
    return {};
  });
}

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  const provider = new DynamoDBGlobalTableProvider();
  try {
    await provider.create(LOGICAL_ID, RESOURCE_TYPE, props);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
}

describe('DynamoDBGlobalTableProvider create() created-before-failure mark (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the table name when a post-create step fails and the cleanup DeleteTable fails', async () => {
    route({
      UpdateTimeToLiveCommand: accessDenied('UpdateTimeToLive'),
      DeleteTableCommand: accessDenied('DeleteTable'),
    });
    const error = await createError();
    expect(sentNames()).toContain('DeleteTableCommand');
    expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBe(TABLE_NAME);
  });

  it('does not mark when the cleanup DeleteTable succeeded', async () => {
    route({ UpdateTimeToLiveCommand: accessDenied('UpdateTimeToLive') });
    const error = await createError();
    expect(sentNames()).toContain('DeleteTableCommand');
    expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBeUndefined();
  });

  it("does not mark CreateTable's own failure", async () => {
    const exists = new Error('Table already exists: my-table');
    exists.name = 'ResourceInUseException';
    route({ CreateTableCommand: exists });
    const error = await createError();
    expect(sentNames()).not.toContain('DeleteTableCommand');
    expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal', async () => {
    route({});
    const { KeySchema: _omitted, ...noKeySchema } = PROPS;
    const error = await createError(noKeySchema);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, LOGICAL_ID, RESOURCE_TYPE)).toBeUndefined();
  });
});
