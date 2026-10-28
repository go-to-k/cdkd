// Issue #5194: a cluster change in the same deploy (a removed
// VpcSecurityGroupIds, ...) moves a member instance to `modifying` a moment
// after the cluster update returns, and the member's ModifyDBInstance is then
// refused: "Database instance is not in available state." CloudFormation lets
// the cluster change settle first. The instance update now waits out that one
// refusal and resends; an accepted modify is never resent, an ordinary update
// makes no extra call, and a terminal status fails at once.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const dbSend = vi.fn();

function dbClientMock(name: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [name]: vi.fn().mockImplementation(() => ({
        send: dbSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-rds', dbClientMock('RDSClient'));
vi.mock('@aws-sdk/client-neptune', dbClientMock('NeptuneClient'));
vi.mock('@aws-sdk/client-docdb', dbClientMock('DocDBClient'));

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

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import {
  isModifyNotAvailableRefusal,
  modifyDbInstanceWhenAvailable,
} from '../../../src/provisioning/providers/db-instance-modify-retry.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { Logger } from '../../../src/types/config.js';

const awsError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name });

/** The refusal measured on the docdb-neptune integ (#5194). */
const refusal = (): Error =>
  awsError('InvalidDBInstanceStateFault', 'Database instance is not in available state.');

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

describe('isModifyNotAvailableRefusal (#5194)', () => {
  it('matches the instance and the cluster not-available refusals', () => {
    expect(isModifyNotAvailableRefusal(refusal())).toBe(true);
    expect(
      isModifyNotAvailableRefusal(
        awsError('InvalidDBClusterStateFault', "DB cluster isn't currently in the available state")
      )
    ).toBe(true);
  });

  it('does not match another message of the same class, another class, or a non-Error', () => {
    expect(
      isModifyNotAvailableRefusal(
        awsError('InvalidDBInstanceStateFault', 'The instance is a read replica')
      )
    ).toBe(false);
    expect(
      isModifyNotAvailableRefusal(
        awsError('InvalidParameterCombination', 'Database instance is not in available state.')
      )
    ).toBe(false);
    expect(isModifyNotAvailableRefusal('Database instance is not in available state.')).toBe(false);
  });
});

let now = 0;

beforeEach(() => {
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('modifyDbInstanceWhenAvailable (#5194)', () => {
  const run = (
    send: () => Promise<unknown>,
    statuses: Array<string | undefined>,
    extra: { remainingMs?: number; maxWaitMs?: number } = {}
  ) => {
    const readStatus = vi.fn(async () => statuses.shift());
    // Each sleep moves the clock the retry reads, so a regressed loop stays
    // FINITE (it reaches the cap and fails the case) instead of spinning.
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const promise = modifyDbInstanceWhenAvailable({
      send,
      readStatus,
      sleep,
      logger,
      label: 'Neptune DBInstance',
      logicalId: 'Instance',
      remainingMs: extra.remainingMs ?? Number.POSITIVE_INFINITY,
      ...(extra.maxWaitMs !== undefined && { maxWaitMs: extra.maxWaitMs }),
    });
    return { promise, readStatus, sleep };
  };

  it('sends once and neither reads nor sleeps when AWS accepts the modify', async () => {
    const send = vi.fn().mockResolvedValue({});
    const { promise, readStatus, sleep } = run(send, []);
    await promise;
    expect(send).toHaveBeenCalledTimes(1);
    expect(readStatus).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits out a refusal through modifying and resends once the instance is available', async () => {
    const send = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({});
    const { promise, readStatus, sleep } = run(send, ['modifying', 'available']);
    await promise;
    expect(send).toHaveBeenCalledTimes(2);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 10_000]);
  });

  it('retries the cluster-state wording and an empty readback', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        awsError('InvalidDBClusterStateFault', "DB cluster isn't currently in the available state")
      )
      .mockResolvedValueOnce({});
    const { promise, readStatus } = run(send, [undefined]);
    await promise;
    expect(send).toHaveBeenCalledTimes(2);
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it('fails at once on a terminal status, without resending', async () => {
    const send = vi.fn().mockRejectedValue(refusal());
    const { promise, readStatus } = run(send, ['failed', 'available']);
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error?.message).toMatch(/reads status 'failed', which does not end on its own/);
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it('waits out inaccessible-encryption-credentials-recoverable instead of failing (#5426)', async () => {
    const send = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce({});
    const { promise, readStatus } = run(send, [
      'inaccessible-encryption-credentials-recoverable',
      'available',
    ]);
    await promise;
    expect(send).toHaveBeenCalledTimes(2);
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it('still fails at once on the non-recoverable inaccessible-encryption-credentials (#5426)', async () => {
    const send = vi.fn().mockRejectedValue(refusal());
    const { promise, readStatus } = run(send, ['inaccessible-encryption-credentials', 'available']);
    await expect(promise).rejects.toThrow(
      "reads status 'inaccessible-encryption-credentials', which does not end on its own"
    );
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it('rethrows any other failure as-is, without reading or resending', async () => {
    const other = awsError('InvalidDBInstanceStateFault', 'The instance is a read replica');
    const send = vi.fn().mockRejectedValue(other);
    const { promise, readStatus, sleep } = run(send, ['available']);
    await expect(promise).rejects.toBe(other);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readStatus).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up at the cap, naming the bound', async () => {
    const send = vi.fn().mockRejectedValue(refusal());
    const { promise, sleep } = run(send, ['modifying', 'modifying'], { maxWaitMs: 6_000 });
    await expect(promise).rejects.toThrow(/did not return to 'available' within 1 minutes/);
    // 0 + 5s fits the 6s cap; the next 10s step does not.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps one budget across resends: a refusal on every resend still ends at the cap', async () => {
    // Accepted on the 6th send, so a budget reset per resend RESOLVES (and
    // fails the case) instead of looping forever.
    const send = vi.fn();
    for (let i = 0; i < 5; i++) send.mockRejectedValueOnce(refusal());
    send.mockResolvedValue({});
    const statuses = Array.from({ length: 10 }, () => 'available');
    const { promise, sleep, readStatus } = run(send, statuses, { maxWaitMs: 20_000 });
    await expect(promise).rejects.toThrow(/did not return to 'available' within 1 minutes/);
    // Sleeps 5s then 10s (15s total); the next 10s step would pass the 20s cap.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 10_000]);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('names the cluster when the refusal is the cluster-state fault', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        awsError('InvalidDBClusterStateFault', "DB cluster isn't currently in the available state")
      );
    const { promise } = run(send, ['failed']);
    await expect(promise).rejects.toThrow(
      /because the instance or its cluster is not in the 'available' state, and it reads status 'failed'/
    );
  });

  it('gives up before sleeping when the resource deadline leaves no time', async () => {
    const send = vi.fn().mockRejectedValue(refusal());
    const { promise, sleep, readStatus } = run(send, ['available'], { remainingMs: 20_000 });
    await expect(promise).rejects.toThrow(/longer --resource-timeout/);
    expect(sleep).not.toHaveBeenCalled();
    expect(readStatus).not.toHaveBeenCalled();
  });
});

/** No real sleeps: the retry polls through `sleep`, which moves the clock. */
function withoutSleep<T extends object>(provider: T): T {
  (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(
    async (ms: number) => {
      now += ms;
    }
  );
  return provider;
}

const PROVIDERS = [
  {
    label: 'Neptune',
    type: 'AWS::Neptune::DBInstance',
    make: () => withoutSleep(new NeptuneProvider()),
  },
  { label: 'DocDB', type: 'AWS::DocDB::DBInstance', make: () => withoutSleep(new DocDBProvider()) },
  { label: 'RDS', type: 'AWS::RDS::DBInstance', make: () => withoutSleep(new RDSProvider()) },
] as const;

describe.each(PROVIDERS)('$label DBInstance update (#5194)', ({ type, make }) => {
  /** Each ModifyDBInstance takes the next outcome; each describe the next status. */
  function route(modifyOutcomes: Array<Error | 'ok'>, statuses: string[]) {
    dbSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'ModifyDBInstanceCommand') {
        const outcome = modifyOutcomes.shift() ?? 'ok';
        if (outcome !== 'ok') throw outcome;
        return {};
      }
      if (name === 'DescribeDBInstancesCommand') {
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: 'inst-1',
              DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:inst-1',
              DBInstanceStatus: statuses.shift() ?? 'available',
            },
          ],
        };
      }
      if (name === 'ListTagsForResourceCommand') return { TagList: [] };
      return {};
    });
  }

  const names = (): string[] => dbSend.mock.calls.map((c) => c[0].constructor.name);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    dbSend.mockReset();
  });

  it('makes no call before the one ModifyDBInstance when AWS accepts it', async () => {
    route(['ok'], []);
    await make().update('Instance', 'inst-1', type, { DBInstanceClass: 'db.r5.large' }, {});
    expect(names().filter((n) => n === 'ModifyDBInstanceCommand')).toHaveLength(1);
    expect(names()[0]).toBe('ModifyDBInstanceCommand');
  });

  it('resends the modify once the member reads available after a not-available refusal', async () => {
    route([refusal(), 'ok'], ['modifying', 'available']);
    const result = await make().update(
      'Instance',
      'inst-1',
      type,
      { DBInstanceClass: 'db.r5.large' },
      {}
    );
    expect(result.physicalId).toBe('inst-1');
    expect(names().slice(0, 4)).toEqual([
      'ModifyDBInstanceCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBInstancesCommand',
      'ModifyDBInstanceCommand',
    ]);
  });

  it('fails fast on a terminal status, naming it', async () => {
    route([refusal(), 'ok'], ['incompatible-network']);
    const error = await make()
      .update('Instance', 'inst-1', type, { DBInstanceClass: 'db.r5.large' }, {})
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error?.message).toMatch(/reads status 'incompatible-network'/);
    expect(names().filter((n) => n === 'ModifyDBInstanceCommand')).toHaveLength(1);
  });
});
