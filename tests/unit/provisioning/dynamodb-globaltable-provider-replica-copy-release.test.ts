import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger, watchLabels } = vi.hoisted(() => ({
  watchLabels: [] as string[],
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// Records every interrupt-watch LABEL, which reaches the user in
// `InterruptedWaitError`'s message on Ctrl-C; the real watch still runs.
vi.mock('../../../src/provisioning/interrupt-watch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/interrupt-watch.js')>();
  return {
    ...actual,
    startInterruptWatch: (label: string) => {
      watchLabels.push(label);
      return actual.startInterruptWatch(label);
    },
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import {
  DynamoDBGlobalTableProvider,
  REPLICA_COPY_RELEASE_ATTEMPTS,
  REPLICA_COPY_RELEASE_POLLS,
  REPLICA_COPY_RELEASE_POLL_MS,
  isReplicaCopyExistsRefusal,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const RESOURCE_TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE_NAME = 'my-test-table-xxx';

/** The refusal measured live (issue #3569), verbatim apart from the name. */
const refusal = () => {
  const error = new Error(
    `Failed to create a the new replica of table with name: '${TABLE_NAME}' because one or more ` +
      `replicas already existed as tables.`
  );
  error.name = 'ValidationException';
  return error;
};
const notFound = () =>
  new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} });

const PROPS = {
  TableName: TABLE_NAME,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  Replicas: [{ Region: 'us-east-1' }, { Region: 'eu-west-1' }],
};

/**
 * Issue #3569: re-adding a cross-region replica is refused while the replica
 * region still holds the same-named copy of a table cdkd just deleted. The
 * replica-add waits that copy out when (and only when) it is DELETING.
 */
describe('DynamoDBGlobalTableProvider addReplica waits out a deleting regional copy (issue #3569)', () => {
  let provider: DynamoDBGlobalTableProvider;
  let regionalSend: ReturnType<typeof vi.fn>;
  let replicaCreates: number;
  let refuseCreates: number;

  beforeEach(() => {
    vi.useFakeTimers();
    watchLabels.length = 0;
    mockSend.mockReset();
    childLogger.info.mockReset();
    provider = new DynamoDBGlobalTableProvider();
    regionalSend = vi.fn();
    vi.spyOn(
      provider as unknown as { getRegionalClient: (r: string) => unknown },
      'getRegionalClient'
    ).mockImplementation((region: string) => {
      // The probe must go to the REPLICA region, never the source client.
      expect(region).toBe('eu-west-1');
      return { send: regionalSend };
    });
    replicaCreates = 0;
    refuseCreates = 0;
    mockSend.mockImplementation(async (command: { constructor: { name: string }; input: any }) => {
      if (
        command.constructor.name === 'UpdateTableCommand' &&
        command.input.ReplicaUpdates?.[0]?.Create
      ) {
        replicaCreates++;
        if (replicaCreates <= refuseCreates) throw refusal();
        return {};
      }
      return {
        Table: {
          TableName: TABLE_NAME,
          TableStatus: 'ACTIVE',
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            { RegionName: 'eu-west-1', ReplicaStatus: 'ACTIVE' },
          ],
        },
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const create = async () => {
    const pending = provider.create('MyTable', RESOURCE_TYPE, PROPS);
    // Surface the rejection to the test instead of as an unhandled one while
    // the fake clock is still being advanced.
    const settled = pending.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await vi.advanceTimersByTimeAsync(
      REPLICA_COPY_RELEASE_POLL_MS * (REPLICA_COPY_RELEASE_POLLS + 5) * REPLICA_COPY_RELEASE_ATTEMPTS
    );
    return settled;
  };

  it('waits while the regional copy is DELETING, then retries the replica-add', async () => {
    refuseCreates = 1;
    regionalSend
      .mockResolvedValueOnce({ Table: { TableStatus: 'DELETING' } })
      .mockResolvedValueOnce({ Table: { TableStatus: 'DELETING' } })
      .mockRejectedValueOnce(notFound());

    const result = await create();

    expect(result.ok).toBe(true);
    expect(replicaCreates).toBe(2);
    expect(regionalSend).toHaveBeenCalledTimes(3);
    expect(childLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('eu-west-1 copy of my-test-table-xxx is still being deleted')
    );
  });

  it('waits one more interval before retrying a copy found gone on the FIRST poll', async () => {
    // The source table's view of the region can trail the region itself, so a
    // retry sent the instant the region says NotFound can be refused again.
    refuseCreates = 1;
    regionalSend.mockRejectedValueOnce(notFound());

    const pending = provider.create('MyTable', RESOURCE_TYPE, PROPS);
    const settled = pending.then(
      () => 'ok',
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(REPLICA_COPY_RELEASE_POLL_MS - 1);
    expect(regionalSend).toHaveBeenCalledTimes(1);
    expect(replicaCreates).toBe(1);
    await vi.advanceTimersByTimeAsync(REPLICA_COPY_RELEASE_POLL_MS * 10);
    expect(await settled).toBe('ok');
    expect(replicaCreates).toBe(2);
  });

  it('masks the resolved table name in the wait line', async () => {
    refuseCreates = 1;
    regionalSend
      .mockResolvedValueOnce({ Table: { TableStatus: 'DELETING' } })
      .mockRejectedValueOnce(notFound());

    const pending = provider.create('MyTable', RESOURCE_TYPE, PROPS, {
      maskSecrets: (text: string) => text.split(TABLE_NAME).join('****'),
    });
    await vi.advanceTimersByTimeAsync(REPLICA_COPY_RELEASE_POLL_MS * 10);
    await pending;

    const lines = childLogger.info.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes('is still being deleted'));
    expect(line).toBeDefined();
    expect(line).not.toContain(TABLE_NAME);
    const label = watchLabels.find((l) => l.includes('to finish deleting'));
    expect(label).toBeDefined();
    expect(label).not.toContain(TABLE_NAME);
  });

  it('re-throws the refusal untouched when the regional table is LIVE, without retrying', async () => {
    // A live table of that name is not cdkd's to wait out: nothing would ever
    // release it, and the user must see AWS's own reason.
    refuseCreates = 99;
    regionalSend.mockResolvedValue({ Table: { TableStatus: 'ACTIVE' } });

    const result = await create();

    expect(result.ok).toBe(false);
    expect(String((result as { error: unknown }).error)).toMatch(/already existed as tables/);
    expect(replicaCreates).toBe(1);
    expect(regionalSend).toHaveBeenCalledTimes(1);
  });

  it('re-throws when the regional probe itself fails', async () => {
    refuseCreates = 99;
    const denied = new Error('User is not authorized to perform: dynamodb:DescribeTable');
    denied.name = 'AccessDeniedException';
    regionalSend.mockRejectedValue(denied);

    const result = await create();

    expect(result.ok).toBe(false);
    expect(String((result as { error: unknown }).error)).toMatch(/already existed as tables/);
    expect(replicaCreates).toBe(1);
  });

  it('does not probe the region for any OTHER replica-add failure', async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string }; input: any }) => {
      if (
        command.constructor.name === 'UpdateTableCommand' &&
        command.input.ReplicaUpdates?.[0]?.Create
      ) {
        replicaCreates++;
        const error = new Error('One or more parameter values were invalid');
        error.name = 'ValidationException';
        throw error;
      }
      return { Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE', Replicas: [] } };
    });

    const result = await create();

    expect(result.ok).toBe(false);
    expect(regionalSend).not.toHaveBeenCalled();
    expect(replicaCreates).toBe(1);
  });

  it(`gives up after ${REPLICA_COPY_RELEASE_ATTEMPTS} replica-add attempts in total`, async () => {
    // A copy that keeps reappearing must not loop forever.
    refuseCreates = 99;
    regionalSend.mockRejectedValue(notFound());

    const result = await create();

    expect(result.ok).toBe(false);
    expect(replicaCreates).toBe(REPLICA_COPY_RELEASE_ATTEMPTS);
  });

  it('gives up when the copy is still DELETING after the poll cap', async () => {
    refuseCreates = 99;
    regionalSend.mockResolvedValue({ Table: { TableStatus: 'DELETING' } });

    const result = await create();

    expect(result.ok).toBe(false);
    expect(replicaCreates).toBe(1);
    expect(regionalSend).toHaveBeenCalledTimes(REPLICA_COPY_RELEASE_POLLS);
  });
});

describe('isReplicaCopyExistsRefusal (issue #3569)', () => {
  it('matches the measured refusal and nothing else', () => {
    expect(isReplicaCopyExistsRefusal(refusal())).toBe(true);
    expect(isReplicaCopyExistsRefusal(new Error('Table already exists'))).toBe(false);
    expect(isReplicaCopyExistsRefusal('one or more replicas already existed as tables')).toBe(false);
    expect(isReplicaCopyExistsRefusal(undefined)).toBe(false);
  });
});
