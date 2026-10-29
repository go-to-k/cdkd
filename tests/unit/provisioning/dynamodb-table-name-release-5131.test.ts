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
 * the table. Since go-to-k/cdkd#5514 `delete()` waits for the table to be
 * gone too (`dynamodb-table-delete-gone-wait-5514.test.ts`), so this wait
 * normally answers on its first poll.
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

  it('stops at once on a refusal that will not change (access denied)', async () => {
    const denied = Object.assign(new Error('not authorized to perform dynamodb:DescribeTable'), {
      name: 'AccessDeniedException',
    });
    mockSend.mockRejectedValue(denied);
    await new DynamoDBTableProvider().waitForNameReleased('Orders', NAME, TYPE, {
      isInterrupted: () => false,
    });
    expect(describes()).toBe(1);
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

  it('after delete() (which now waits, #5514) the name-release wait answers on its first poll', async () => {
    const provider = new DynamoDBTableProvider();
    let deleted = false;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return {};
      }
      if (command instanceof DescribeTableCommand) {
        if (deleted) throw gone();
        return { Table: { TableName: NAME, TableStatus: 'ACTIVE', DeletionProtectionEnabled: false } };
      }
      return {};
    });
    await provider.delete('Orders', NAME, TYPE);
    const afterDelete = describes();
    await provider.waitForNameReleased('Orders', NAME, TYPE, { isInterrupted: () => false });
    expect(describes() - afterDelete).toBe(1);
  });
});
