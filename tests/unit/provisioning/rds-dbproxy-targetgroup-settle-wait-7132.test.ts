import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DescribeDBProxyTargetsCommand, type RDSClient } from '@aws-sdk/client-rds';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-rds')>()),
  RDSClient: vi.fn(() => ({
    send: (command: unknown) => mockSend(command),
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  },
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import {
  waitForProxyTargetsAvailable,
  PROXY_TARGET_FAILURE_GRACE_POLLS,
} from '../../../src/provisioning/providers/rds-dbproxy-targetgroup/settle-wait.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: `RegisterDBProxyTargets` answers `REGISTERING`, and the
 * targets read `UNAVAILABLE` (`PENDING_PROXY_CAPACITY`, then no reason)
 * before `AVAILABLE`; CloudFormation completes only once they read
 * `AVAILABLE`, and cdkd returned at once.
 */

const TYPE = 'AWS::RDS::DBProxyTargetGroup';
const PROXY = 'my-proxy';
const TG_ARN = 'arn:aws:rds:us-east-1:123456789012:target-group:prx-tg-0123456789abcdef0';
const DESCRIPTION = 'secret-laden AWS text about db.internal:5432';

const sentNames = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
const targetReads = (): number =>
  sentNames().filter((n) => n === 'DescribeDBProxyTargetsCommand').length;

type Health = { State: string; Reason?: string; Description?: string };
const instance = (id: string, TargetHealth: Health) => ({
  RdsResourceId: id,
  Type: 'RDS_INSTANCE',
  TargetHealth,
});
const member = (id: string, cluster: string, TargetHealth: Health) => ({
  RdsResourceId: id,
  Type: 'RDS_INSTANCE',
  TrackedClusterId: cluster,
  TargetHealth,
});
const tracked = (cluster: string) => ({ RdsResourceId: cluster, Type: 'TRACKED_CLUSTER' });

/** Route the calls; `reads` answers the successive DescribeDBProxyTargets reads. */
function route(reads: unknown[]): void {
  const queue = [...reads];
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DescribeDBProxyTargetsCommand') {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return { Targets: next };
    }
    if (name === 'DescribeDBProxyTargetGroupsCommand') {
      return { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'default' }] };
    }
    return {};
  });
}

/** Run `p` to completion, firing every poll timer it schedules. */
async function drive<T>(p: Promise<T>): Promise<T | unknown> {
  const settled = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e })
  );
  await vi.runAllTimersAsync();
  const r = await settled;
  return r.ok ? r.v : r.e;
}

describe('DBProxyTargetGroup target wait through the provider (#7132)', () => {
  let provider: RDSDBProxyTargetGroupProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSend.mockReset();
    childLogger.debug.mockReset();
    provider = new RDSDBProxyTargetGroupProvider();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('create() with a cluster target returns only after its member rows read AVAILABLE', async () => {
    route([
      [tracked('c1'), member('i1', 'c1', { State: 'REGISTERING' })],
      [tracked('c1'), member('i1', 'c1', { State: 'UNAVAILABLE', Reason: 'PENDING_PROXY_CAPACITY' })],
      [tracked('c1'), member('i1', 'c1', { State: 'UNAVAILABLE' })],
      [tracked('c1'), member('i1', 'c1', { State: 'AVAILABLE' })],
    ]);
    const result = await drive(
      provider.create('Tg', TYPE, { DBProxyName: PROXY, DBClusterIdentifiers: ['c1'] })
    );
    expect((result as { physicalId: string }).physicalId).toBe(TG_ARN);
    expect(targetReads()).toBe(4);
    const read = mockSend.mock.calls.find(
      (c) => c[0] instanceof DescribeDBProxyTargetsCommand
    )![0] as DescribeDBProxyTargetsCommand;
    expect(read.input).toEqual({ DBProxyName: PROXY, TargetGroupName: 'default' });
  });

  it('create() reads a cluster with no member row listed yet as pending', async () => {
    route([[tracked('c1')], [tracked('c1'), member('i1', 'c1', { State: 'AVAILABLE' })]]);
    await drive(provider.create('Tg', TYPE, { DBProxyName: PROXY, DBClusterIdentifiers: ['c1'] }));
    expect(targetReads()).toBe(2);
  });

  it('create() whose target reads CONNECTION_FAILED fails non-retryable and deregisters it', async () => {
    route([
      [instance('db1', { State: 'UNAVAILABLE', Reason: 'CONNECTION_FAILED', Description: DESCRIPTION })],
    ]);
    const error = await drive(
      provider.create('Tg', TYPE, { DBProxyName: PROXY, DBInstanceIdentifiers: ['db1'] })
    );
    expect(String(error)).toMatch(/reads UNAVAILABLE \(CONNECTION_FAILED\), expected AVAILABLE/);
    expect(String(error)).not.toContain(DESCRIPTION);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(targetReads()).toBe(PROXY_TARGET_FAILURE_GRACE_POLLS);
    expect(sentNames().at(-1)).toBe('DeregisterDBProxyTargetsCommand');
    expect(childLogger.debug.mock.calls.flat().join('\n')).toContain(DESCRIPTION);
  });

  it('create() reads a failure reason that clears within the grace as pending', async () => {
    route([
      [instance('db1', { State: 'UNAVAILABLE', Reason: 'AUTH_FAILURE' })],
      [instance('db1', { State: 'UNAVAILABLE' })],
      [instance('db1', { State: 'AVAILABLE' })],
    ]);
    await drive(provider.create('Tg', TYPE, { DBProxyName: PROXY, DBInstanceIdentifiers: ['db1'] }));
    expect(targetReads()).toBe(3);
    expect(sentNames()).not.toContain('DeregisterDBProxyTargetsCommand');
  });

  it('update() waits only on the targets it registered', async () => {
    route([
      [instance('old', { State: 'UNAVAILABLE' }), instance('new', { State: 'REGISTERING' })],
      [instance('old', { State: 'UNAVAILABLE' }), instance('new', { State: 'AVAILABLE' })],
    ]);
    await drive(
      provider.update(
        'Tg',
        TG_ARN,
        TYPE,
        { DBProxyName: PROXY, DBInstanceIdentifiers: ['old', 'new'] },
        { DBProxyName: PROXY, DBInstanceIdentifiers: ['old'] }
      )
    );
    expect(targetReads()).toBe(2);
  });

  it('update() that registers nothing sends no target read', async () => {
    route([[]]);
    await provider.update(
      'Tg',
      TG_ARN,
      TYPE,
      { DBProxyName: PROXY, DBInstanceIdentifiers: [], ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 50 } },
      { DBProxyName: PROXY, DBInstanceIdentifiers: ['gone'] }
    );
    expect(targetReads()).toBe(0);
  });

  it('update() whose added target reads AUTH_FAILURE fails non-retryable', async () => {
    route([[instance('new', { State: 'UNAVAILABLE', Reason: 'AUTH_FAILURE' })]]);
    const error = await drive(
      provider.update(
        'Tg',
        TG_ARN,
        TYPE,
        { DBProxyName: PROXY, DBInstanceIdentifiers: ['new'] },
        { DBProxyName: PROXY }
      )
    );
    expect(String(error)).toMatch(/\(AUTH_FAILURE\), expected AVAILABLE/);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips the create and update waits', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    route([[instance('db1', { State: 'REGISTERING' })]]);
    await provider.create('Tg', TYPE, { DBProxyName: PROXY, DBInstanceIdentifiers: ['db1'] });
    await provider.update(
      'Tg',
      TG_ARN,
      TYPE,
      { DBProxyName: PROXY, DBInstanceIdentifiers: ['db1', 'db2'] },
      { DBProxyName: PROXY, DBInstanceIdentifiers: ['db1'] }
    );
    expect(targetReads()).toBe(0);
  });
});

describe('waitForProxyTargetsAvailable (#7132)', () => {
  const send = vi.fn();
  const client = { send } as unknown as RDSClient;
  const log = createMaskedLogSinks(childLogger, undefined);
  const wrap = (e: unknown) => new Error(`wrapped: ${String(e)}`);
  const one = { clusters: [], instances: ['db1'] };
  const opts = { pollMs: 0, maxPolls: 20 };
  const answer = (targets: unknown[]) => ({ Targets: targets });

  beforeEach(() => {
    send.mockReset();
  });

  it('throws a non-retryable not-confirmed error when its poll cap runs out', async () => {
    send.mockResolvedValue(answer([instance('db1', { State: 'UNAVAILABLE', Reason: 'PENDING_PROXY_CAPACITY' })]));
    const error = await waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, {
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

  it('reads a throttled read as pending and reads again', async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }))
      .mockResolvedValue(answer([instance('db1', { State: 'AVAILABLE' })]));
    await waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, opts);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ends the wait on any other read failure, through the caller wrap', async () => {
    send.mockRejectedValue(Object.assign(new Error('nope'), { name: 'AccessDenied' }));
    const error = await waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, opts).then(
      () => new Error('expected the wait to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/wrapped: .*nope/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads UNUSED, UNREACHABLE and PROMOTED as pending, never as settled or failed', async () => {
    send
      .mockResolvedValueOnce(answer([instance('db1', { State: 'UNUSED' })]))
      .mockResolvedValueOnce(answer([instance('db1', { State: 'UNAVAILABLE', Reason: 'UNREACHABLE' })]))
      .mockResolvedValueOnce(answer([instance('db1', { State: 'UNAVAILABLE', Reason: 'UNREACHABLE' })]))
      .mockResolvedValueOnce(answer([instance('db1', { State: 'UNAVAILABLE', Reason: 'PROMOTED' })]))
      .mockResolvedValue(answer([instance('db1', { State: 'AVAILABLE' })]));
    await waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, opts);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('requires every member row of a cluster, and ignores the TRACKED_CLUSTER row', async () => {
    send
      .mockResolvedValueOnce(
        answer([tracked('c1'), member('w', 'c1', { State: 'AVAILABLE' }), member('r', 'c1', { State: 'UNAVAILABLE' })])
      )
      .mockResolvedValue(
        answer([tracked('c1'), member('w', 'c1', { State: 'AVAILABLE' }), member('r', 'c1', { State: 'AVAILABLE' })])
      );
    await waitForProxyTargetsAvailable(
      client,
      'Tg',
      PROXY,
      'default',
      { clusters: ['c1'], instances: [] },
      log,
      wrap,
      opts
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('follows the Marker across pages', async () => {
    send
      .mockResolvedValueOnce({ Targets: [], Marker: 'm1' })
      .mockResolvedValueOnce(answer([instance('db1', { State: 'AVAILABLE' })]));
    await waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, opts);
    expect((send.mock.calls[1]![0] as DescribeDBProxyTargetsCommand).input).toMatchObject({ Marker: 'm1' });
  });

  it('throws its own not-confirmed error once the resource deadline has expired', async () => {
    send.mockResolvedValue(answer([instance('db1', { State: 'REGISTERING' })]));
    const error = await withResourceDeadline(
      () => waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, { pollMs: 60_000 }),
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
        return answer([instance('db1', { State: 'REGISTERING' })]);
      });
      const error = await waitForProxyTargetsAvailable(client, 'Tg', PROXY, 'default', one, log, wrap, opts).then(
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
