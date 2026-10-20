import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5131: `DeleteTable` returns with the table `DELETING`, and
 * DynamoDB keeps the name until it is gone, so a same-name re-create right
 * after cdkd's own delete failed `ResourceInUseException` and left no table.
 * `waitForNameReleased` closes that window for the replacement that deleted
 * the table; `delete()` itself (a destroy) still returns at once.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getLogger: () => ({ ...child, child: () => child }),
  };
});

import {
  DynamoDBTableProvider,
  tableNameReleaseWait,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TYPE = 'AWS::DynamoDB::Table';
const NAME = 'orders-table';
const gone = () => new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} });
const deleting = () => ({ Table: { TableName: NAME, TableStatus: 'DELETING' } });
const describes = () => mockSend.mock.calls.filter(([c]) => c instanceof DescribeTableCommand).length;

describe('DynamoDBTableProvider.waitForNameReleased (go-to-k/cdkd#5131)', () => {
  const defaults = { ...tableNameReleaseWait };
  beforeEach(() => {
    mockSend.mockReset();
    tableNameReleaseWait.intervalMs = 0;
    tableNameReleaseWait.maxPolls = 5;
  });
  afterEach(() => {
    Object.assign(tableNameReleaseWait, defaults);
  });

  it('polls DescribeTable until the table is gone', async () => {
    mockSend.mockResolvedValueOnce(deleting()).mockResolvedValueOnce(deleting()).mockRejectedValueOnce(gone());
    await new DynamoDBTableProvider().waitForNameReleased('Orders', NAME, TYPE, {
      isInterrupted: () => false,
    });
    expect(describes()).toBe(3);
  });

  it('polls on past another refusal (a throttle), within the bound', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    mockSend.mockRejectedValueOnce(throttle).mockRejectedValueOnce(gone());
    await new DynamoDBTableProvider().waitForNameReleased('Orders', NAME, TYPE, {
      isInterrupted: () => false,
    });
    expect(describes()).toBe(2);
  });

  it('is bounded: a name never released ends the wait without throwing', async () => {
    mockSend.mockResolvedValue(deleting());
    await expect(
      new DynamoDBTableProvider().waitForNameReleased('Orders', NAME, TYPE, { isInterrupted: () => false })
    ).resolves.toBeUndefined();
    expect(describes()).toBe(5);
  });

  it("stops on the user's interrupt", async () => {
    let interrupted = false;
    mockSend.mockImplementation(async () => {
      interrupted = true;
      return deleting();
    });
    await new DynamoDBTableProvider().waitForNameReleased('Orders', NAME, TYPE, {
      isInterrupted: () => interrupted,
    });
    expect(describes()).toBe(1);
  });

  it('an ordinary delete (a destroy) sends no DescribeTable after DeleteTable', async () => {
    const provider = new DynamoDBTableProvider();
    const wait = vi.spyOn(provider, 'waitForNameReleased');
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return { Table: { TableName: NAME, TableStatus: 'ACTIVE', DeletionProtectionEnabled: false } };
      }
      return {};
    });
    await provider.delete('Orders', NAME, TYPE);
    const sent = mockSend.mock.calls.map(([c]) => c);
    const deleteAt = sent.findIndex((c) => c instanceof DeleteTableCommand);
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(sent.slice(deleteAt + 1).filter((c) => c instanceof DescribeTableCommand)).toEqual([]);
    expect(wait).not.toHaveBeenCalled();
  });
});
