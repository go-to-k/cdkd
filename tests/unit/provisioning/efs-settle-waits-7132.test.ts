import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vite-plus/test';
import {
  AccessPointAlreadyExists,
  AccessPointNotFound,
  DescribeAccessPointsCommand,
  DescribeBackupPolicyCommand,
  type EFSClient,
} from '@aws-sdk/client-efs';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-efs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-efs')>()),
  EFSClient: vi.fn(() => ({
    send: (command: unknown) => mockSend(command),
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import {
  waitForAccessPointAvailable,
  waitForBackupPolicySettled,
  EFS_STALE_READ_GRACE_POLLS,
} from '../../../src/provisioning/providers/efs/settle-waits.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: an access point reads `creating` and a backup policy
 * `ENABLING` / `DISABLING` right after the write; CloudFormation completes
 * only once they read `available` / the requested status, and cdkd returned
 * at once.
 */

const AP_TYPE = 'AWS::EFS::AccessPoint';
const FS_TYPE = 'AWS::EFS::FileSystem';
const AP_ID = 'fsap-0123456789abcdef0';
const AP_ARN = `arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/${AP_ID}`;
const FS_ID = 'fs-0123456789abcdef0';

const sentNames = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

/** Route the calls; `states` answers the successive reads of `readName`. */
function route(readName: string, states: unknown[], answers: Record<string, unknown> = {}): void {
  const queue = [...states];
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === readName) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return next;
    }
    return answers[name] ?? {};
  });
}

const ap = (LifeCycleState: string) => ({
  AccessPoints: [{ AccessPointId: AP_ID, LifeCycleState }],
});
const backup = (Status: string) => ({ BackupPolicy: { Status } });

beforeAll(() => {
  allowUnscopedCreateTokensForTests(true);
});
afterAll(() => {
  allowUnscopedCreateTokensForTests(false);
});

describe('EFS settle waits through the provider (#7132)', () => {
  let provider: EFSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    resetIdempotencyTokensForTests();
    provider = new EFSProvider();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('create() AccessPoint returns only after it reads available', async () => {
    route('DescribeAccessPointsCommand', [ap('creating'), ap('available')], {
      CreateAccessPointCommand: { AccessPointId: AP_ID, AccessPointArn: AP_ARN },
    });
    const result = await provider.create('Ap', AP_TYPE, { FileSystemId: FS_ID });
    expect(result.physicalId).toBe(AP_ID);
    expect(sentNames()).toEqual([
      'CreateAccessPointCommand',
      'DescribeAccessPointsCommand',
      'DescribeAccessPointsCommand',
    ]);
    expect((mockSend.mock.calls[1]![0] as DescribeAccessPointsCommand).input).toEqual({
      AccessPointId: AP_ID,
    });
  });

  it('create() AccessPoint that reads error fails non-retryable and names the access point it created', async () => {
    route('DescribeAccessPointsCommand', [ap('error')], {
      CreateAccessPointCommand: { AccessPointId: AP_ID, AccessPointArn: AP_ARN },
    });
    const error = await provider.create('Ap', AP_TYPE, { FileSystemId: FS_ID }).then(
      () => new Error('expected the create to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/settled as error, expected available/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(createdBeforeFailure(error, 'Ap', AP_TYPE)).toBe(AP_ID);
  });

  it('create() AccessPoint reports the access point to the created-resource sink before the wait fails', async () => {
    route('DescribeAccessPointsCommand', [ap('error')], {
      CreateAccessPointCommand: { AccessPointId: AP_ID, AccessPointArn: AP_ARN },
    });
    const sink = new CreatedResourceSink('Ap', AP_TYPE);
    await collectCreatedResources(sink, () =>
      provider.create('Ap', AP_TYPE, { FileSystemId: FS_ID })
    ).catch(() => undefined);
    expect(sink.report?.physicalId).toBe(AP_ID);
  });

  it.each([
    ['ENABLED', 'ENABLING', { BackupPolicy: { Status: 'DISABLED' } }],
    ['DISABLED', 'DISABLING', { BackupPolicy: { Status: 'ENABLED' } }],
  ])(
    'update() BackupPolicy to %s: Put answering %s makes a first settled read stale for the grace polls',
    async (target, answered, previous) => {
      // The real PutBackupPolicy answers the transitional status; a read of
      // the target before any transitional read can predate the call.
      route('DescribeBackupPolicyCommand', [backup(target)], {
        PutBackupPolicyCommand: backup(answered),
      });
      vi.useFakeTimers();
      try {
        const p = provider.update('Fs', FS_ID, FS_TYPE, { BackupPolicy: { Status: target } }, previous);
        await vi.runAllTimersAsync();
        await p;
      } finally {
        vi.useRealTimers();
      }
      expect(sentNames().filter((n) => n === 'DescribeBackupPolicyCommand')).toHaveLength(
        EFS_STALE_READ_GRACE_POLLS + 1
      );
    }
  );

  it('create() AccessPoint that ADOPTS a creating access point waits for it too', async () => {
    let token = '';
    mockSend.mockImplementation(
      async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (cmd.constructor.name === 'CreateAccessPointCommand') {
          token = String(cmd.input['ClientToken']);
          throw new AccessPointAlreadyExists({
            message: 'exists',
            $metadata: {},
            ErrorCode: 'AccessPointAlreadyExists',
            AccessPointId: AP_ID,
          });
        }
        const reads = mockSend.mock.calls.filter(
          (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'DescribeAccessPointsCommand'
        ).length;
        return {
          AccessPoints: [
            {
              AccessPointId: AP_ID,
              AccessPointArn: AP_ARN,
              FileSystemId: FS_ID,
              ClientToken: token,
              RootDirectory: { Path: '/' },
              LifeCycleState: reads <= 2 ? 'creating' : 'available',
            },
          ],
        };
      }
    );
    const result = await provider.create('Ap', AP_TYPE, { FileSystemId: FS_ID });
    expect(result.physicalId).toBe(AP_ID);
    // One adoption read-back, then the settle reads until available.
    expect(sentNames().filter((n) => n === 'DescribeAccessPointsCommand')).toHaveLength(3);
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips the access-point and backup-policy waits', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    route('DescribeAccessPointsCommand', [ap('creating')], {
      CreateAccessPointCommand: { AccessPointId: AP_ID, AccessPointArn: AP_ARN },
      PutBackupPolicyCommand: backup('ENABLING'),
    });
    await provider.create('Ap', AP_TYPE, { FileSystemId: FS_ID });
    await provider.update(
      'Fs',
      FS_ID,
      FS_TYPE,
      { BackupPolicy: { Status: 'ENABLED' } },
      { BackupPolicy: { Status: 'DISABLED' } }
    );
    expect(sentNames()).toEqual(['CreateAccessPointCommand', 'PutBackupPolicyCommand']);
  });

  it('update() FileSystem BackupPolicy returns only after the policy reads the requested status', async () => {
    route('DescribeBackupPolicyCommand', [backup('ENABLING'), backup('ENABLED')], {
      PutBackupPolicyCommand: backup('ENABLING'),
    });
    await provider.update(
      'Fs',
      FS_ID,
      FS_TYPE,
      { BackupPolicy: { Status: 'ENABLED' } },
      { BackupPolicy: { Status: 'DISABLED' } }
    );
    expect(sentNames()).toEqual([
      'PutBackupPolicyCommand',
      'DescribeBackupPolicyCommand',
      'DescribeBackupPolicyCommand',
    ]);
    expect((mockSend.mock.calls[1]![0] as DescribeBackupPolicyCommand).input).toEqual({
      FileSystemId: FS_ID,
    });
  });

  it('update() FileSystem BackupPolicy removal waits for DISABLED', async () => {
    route('DescribeBackupPolicyCommand', [backup('DISABLING'), backup('DISABLED')], {
      PutBackupPolicyCommand: backup('DISABLING'),
    });
    await provider.update('Fs', FS_ID, FS_TYPE, {}, { BackupPolicy: { Status: 'ENABLED' } });
    expect(sentNames().filter((n) => n === 'DescribeBackupPolicyCommand')).toHaveLength(2);
  });
});

describe('waitForAccessPointAvailable / waitForBackupPolicySettled (#7132)', () => {
  const send = vi.fn();
  const client = { send } as unknown as EFSClient;
  const log = createMaskedLogSinks({ debug: vi.fn(), warn: vi.fn() }, undefined);
  const opts = { pollMs: 0 };

  beforeEach(() => send.mockReset());

  it('reads an access point not yet visible again within the grace', async () => {
    send
      .mockRejectedValueOnce(new AccessPointNotFound({ message: 'nf', $metadata: {}, ErrorCode: 'AccessPointNotFound' }))
      .mockResolvedValueOnce(ap('available'));
    await waitForAccessPointAvailable(client, 'Ap', AP_ID, log, opts);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails on an access point not found past the grace, unchanged', async () => {
    const nf = Object.assign(new Error('nf'), { name: 'AccessPointNotFound' });
    for (let i = 0; i <= EFS_STALE_READ_GRACE_POLLS; i++) send.mockRejectedValueOnce(nf);
    let caught: unknown;
    try {
      await waitForAccessPointAvailable(client, 'Ap', AP_ID, log, opts);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(nf);
    expect(send).toHaveBeenCalledTimes(EFS_STALE_READ_GRACE_POLLS + 1);
  });

  it('fails at once on deleting', async () => {
    send.mockResolvedValue(ap('deleting'));
    await expect(waitForAccessPointAvailable(client, 'Ap', AP_ID, log, opts)).rejects.toThrow(
      /settled as deleting/
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads again after a throttled read', async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockResolvedValueOnce(backup('ENABLED'));
    await waitForBackupPolicySettled(client, FS_ID, 'ENABLED', undefined, log, opts);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ends the wait unchanged on any other read failure', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    send.mockRejectedValueOnce(denied);
    await expect(
      waitForBackupPolicySettled(client, FS_ID, 'ENABLED', 'ENABLING', log, opts)
    ).rejects.toBe(denied);
  });

  it('reads the status from before the call as stale through the grace, then returns once it lands', async () => {
    send
      .mockResolvedValueOnce(backup('DISABLED'))
      .mockResolvedValueOnce(backup('ENABLING'))
      .mockResolvedValueOnce(backup('ENABLED'));
    await waitForBackupPolicySettled(client, FS_ID, 'ENABLED', 'ENABLING', log, opts);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('a settled read before any ENABLING counts only after the grace when the call answered ENABLING', async () => {
    send.mockResolvedValue(backup('ENABLED'));
    await waitForBackupPolicySettled(client, FS_ID, 'ENABLED', 'ENABLING', log, opts);
    expect(send).toHaveBeenCalledTimes(EFS_STALE_READ_GRACE_POLLS + 1);
  });

  it('returns on the first settled read when the call answered settled', async () => {
    send.mockResolvedValue(backup('ENABLED'));
    await waitForBackupPolicySettled(client, FS_ID, 'ENABLED', 'ENABLED', log, opts);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails non-retryable on the opposite status past the grace', async () => {
    send.mockResolvedValue(backup('DISABLED'));
    const error = await waitForBackupPolicySettled(
      client,
      FS_ID,
      'ENABLED',
      'ENABLING',
      log,
      opts
    ).then(
      () => new Error('expected the wait to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/settled as DISABLED, expected ENABLED/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(send).toHaveBeenCalledTimes(EFS_STALE_READ_GRACE_POLLS + 1);
  });

  it('throws a non-retryable not-confirmed error when its poll cap runs out', async () => {
    send.mockResolvedValue(ap('creating'));
    const error = await waitForAccessPointAvailable(client, 'Ap', AP_ID, log, {
      pollMs: 0,
      maxPolls: 3,
    }).then(
      () => new Error('expected the wait to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/Timed out .* not confirmed/);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('throws its own not-confirmed error once the resource deadline has expired', async () => {
    send.mockResolvedValue(backup('ENABLING'));
    const error = await withResourceDeadline(
      () =>
        waitForBackupPolicySettled(client, FS_ID, 'ENABLED', 'ENABLING', log, { pollMs: 60_000 }),
      { warnAfterMs: 20, timeoutMs: 40, onTimeout: () => new Error('resource deadline fired') }
    ).then(
      () => new Error('expected the wait to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/resource deadline fired|not confirmed/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops on Ctrl-C with the interrupt error, without another read', async () => {
    const baseline = process.listeners('SIGINT');
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
    try {
      send.mockImplementation(async () => {
        for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
          (l as unknown as () => void)();
        }
        return ap('creating');
      });
      const error = await waitForAccessPointAvailable(client, 'Ap', AP_ID, log, opts).then(
        () => new Error('expected the wait to fail'),
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
      delete interruptWatchTestSeam.forceQuit;
    }
  });
});
