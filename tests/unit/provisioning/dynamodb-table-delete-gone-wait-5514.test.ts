import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * go-to-k/cdkd#5514: `DeleteTable` returns with the table `DELETING`, and
 * CloudFormation reports DELETE_COMPLETE only once the table is gone. A
 * `delete()` that returned at once let a same-name re-create hit
 * `ResourceInUseException`, a dependent be deleted under a live table, and a
 * gone-probe right after `cdkd destroy` see the table. `delete()` now polls
 * `DescribeTable` until `ResourceNotFoundException`; the delete was ACCEPTED,
 * so a wait that does not see it gone warns and returns rather than failing.
 */

const { mockSend, log } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...log, child: () => log }),
}));

import {
  DynamoDBTableProvider,
  tableDeleteGoneWait,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { dynamoDbDeleteBudgetOverride } from '../../../src/provisioning/providers/dynamodb-delete-budget.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

const TYPE = 'AWS::DynamoDB::Table';
const NAME = 'orders-table';
const gone = () =>
  new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} });
const deleting = () => ({ Table: { TableName: NAME, TableStatus: 'DELETING' } });

/**
 * A table that AWS removes `pollsUntilGone` DescribeTable reads after it
 * accepted `DeleteTable`; before the delete it is ACTIVE. `onPoll` can replace
 * a post-delete read (an error, a side effect).
 */
function fakeTable(
  pollsUntilGone: number,
  onPoll?: (n: number) => unknown
): { postDeleteDescribes: () => number; nameHeld: () => boolean } {
  let deleted = false;
  let polls = 0;
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof DeleteTableCommand) {
      deleted = true;
      return {};
    }
    if (command instanceof DescribeTableCommand) {
      if (!deleted) return { Table: { TableName: NAME, TableStatus: 'ACTIVE' } };
      polls += 1;
      const override = onPoll?.(polls);
      if (override instanceof Error) throw override;
      if (polls > pollsUntilGone) throw gone();
      return deleting();
    }
    return {};
  });
  return {
    postDeleteDescribes: () => polls,
    nameHeld: () => !deleted || polls <= pollsUntilGone,
  };
}

const warnings = (): string[] => log.warn.mock.calls.map((c) => String(c[0]));

describe('DynamoDBTableProvider.delete waits for the table to be gone (go-to-k/cdkd#5514)', () => {
  const defaults = { ...tableDeleteGoneWait };
  beforeEach(() => {
    mockSend.mockReset();
    for (const fn of Object.values(log)) fn.mockReset();
    tableDeleteGoneWait.pollIntervalMs = 1;
    tableDeleteGoneWait.maxWaitMs = 60_000;
  });
  afterEach(() => {
    Object.assign(tableDeleteGoneWait, defaults);
    delete dynamoDbDeleteBudgetOverride.totalMs;
    delete dynamoDbDeleteBudgetOverride.clock;
  });

  it('resolves only once DescribeTable reports the table gone, so a same-name create finds the name free', async () => {
    const table = fakeTable(3);
    await expect(new DynamoDBTableProvider().delete('Orders', NAME, TYPE)).resolves.toBeUndefined();
    // Three DELETING reads, then the ResourceNotFoundException that ends it.
    expect(table.postDeleteDescribes()).toBe(4);
    // The replacement / destroy-then-deploy's CreateTable comes after this
    // resolve: the name is no longer held.
    expect(table.nameHeld()).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('is bounded: a table that never disappears ends the wait with a warning, not a delete failure', async () => {
    tableDeleteGoneWait.pollIntervalMs = 5;
    tableDeleteGoneWait.maxWaitMs = 40;
    const table = fakeTable(Number.POSITIVE_INFINITY);
    await expect(new DynamoDBTableProvider().delete('Orders', NAME, TYPE)).resolves.toBeUndefined();
    expect(table.postDeleteDescribes()).toBeGreaterThan(1);
    expect(table.postDeleteDescribes()).toBeLessThan(40);
    const stopped = warnings().filter((w) => w.includes('stopped waiting for it to disappear'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain('last status: DELETING');
  });

  it('is clamped by the shared delete budget (issue #1955)', async () => {
    // A spent allowance leaves the wait its one look, then the warning.
    // Every clock read is a minute later: the 1-minute allowance is spent by
    // the time the gone-wait asks what is left.
    let t = 0;
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    dynamoDbDeleteBudgetOverride.clock = () => (t += 60_000);
    const table = fakeTable(Number.POSITIVE_INFINITY);
    await expect(new DynamoDBTableProvider().delete('Orders', NAME, TYPE)).resolves.toBeUndefined();
    expect(table.postDeleteDescribes()).toBe(1);
    expect(warnings().filter((w) => w.includes('stopped waiting'))).toHaveLength(1);
  });

  it('a DescribeTable error other than ResourceNotFound is NOT read as gone', async () => {
    const denied = Object.assign(new Error('not authorized to perform dynamodb:DescribeTable'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 400 },
    });
    const table = fakeTable(Number.POSITIVE_INFINITY, () => denied);
    await expect(new DynamoDBTableProvider().delete('Orders', NAME, TYPE)).resolves.toBeUndefined();
    expect(table.postDeleteDescribes()).toBe(1);
    // It says the status could not be read -- never that the table is gone.
    const stopped = warnings().filter((w) => w.includes('its status could not be read'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain('AccessDeniedException');
    const debugs = log.debug.mock.calls.map((c) => String(c[0]));
    expect(debugs.some((d) => d.includes(`DynamoDB table ${NAME} is gone`))).toBe(false);
  });

  it('a throttled DescribeTable keeps polling until the table is gone', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    const table = fakeTable(1, (n) => (n === 1 ? throttle : undefined));
    await new DynamoDBTableProvider().delete('Orders', NAME, TYPE);
    expect(table.postDeleteDescribes()).toBe(2);
    expect(warnings()).toEqual([]);
  });
});

describe('DynamoDBTableProvider.delete gone-wait on Ctrl-C (go-to-k/cdkd#5514)', () => {
  const defaults = { ...tableDeleteGoneWait };
  let baseline: readonly unknown[] = [];
  beforeEach(() => {
    mockSend.mockReset();
    for (const fn of Object.values(log)) fn.mockReset();
    tableDeleteGoneWait.pollIntervalMs = 1;
    tableDeleteGoneWait.maxWaitMs = 60_000;
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    baseline = process.listeners('SIGINT');
  });
  afterEach(() => {
    Object.assign(tableDeleteGoneWait, defaults);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('stops watching with a warning, without failing the accepted delete', async () => {
    const table = fakeTable(Number.POSITIVE_INFINITY, (n) => {
      if (n === 2) {
        const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
        for (const listener of ours) (listener as unknown as () => void)();
      }
      return undefined;
    });
    await expect(new DynamoDBTableProvider().delete('Orders', NAME, TYPE)).resolves.toBeUndefined();
    expect(table.postDeleteDescribes()).toBe(2);
    const stopped = warnings().filter((w) => w.includes('interrupted'));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain(NAME);
  });
});
