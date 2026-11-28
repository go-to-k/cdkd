import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeClustersCommand,
  type Cluster,
  type ECSClient,
} from '@aws-sdk/client-ecs';

const { mockSend, warnSpy } = vi.hoisted(() => ({ mockSend: vi.fn(), warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-ecs')>()),
  ECSClient: vi.fn(() => ({
    send: (command: unknown) => mockSend(command),
    config: { region: () => Promise.resolve('us-east-1') },
  })),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import {
  clusterAttachmentsWait,
  waitForClusterSettled,
  CLUSTER_STALE_READ_GRACE_POLLS,
} from '../../../src/provisioning/providers/ecs/cluster-attachments.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: a cluster created (or updated) with
 * ServiceConnectDefaults reads PROVISIONING / attachments UPDATE_IN_PROGRESS
 * for ~20 s (~14 s); CloudFormation completes only once it reads ACTIVE /
 * UPDATE_COMPLETE, and cdkd returned at once.
 */

const TYPE = 'AWS::ECS::Cluster';
const NAME = 'my-cluster';
const ARN = `arn:aws:ecs:us-east-1:123456789012:cluster/${NAME}`;
const NS = 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-1';

const PROVISIONING: Cluster = {
  clusterName: NAME,
  clusterArn: ARN,
  status: 'PROVISIONING',
  attachmentsStatus: 'UPDATE_IN_PROGRESS',
};
const UPDATING: Cluster = { ...PROVISIONING, status: 'ACTIVE' };
const ACTIVE: Cluster = { ...PROVISIONING, status: 'ACTIVE', attachmentsStatus: 'UPDATE_COMPLETE' };
const FAILED_ATTACHMENTS: Cluster = {
  ...ACTIVE,
  attachmentsStatus: 'UPDATE_FAILED',
  attachments: [
    {
      id: 'att-1',
      type: 'sc',
      status: 'UPDATE_FAILED',
      details: [{ name: 'reason', value: 'role arn:aws:iam::123456789012:role/x denied' }],
    },
  ],
};

/** Route the provider's calls; `reads` answers the successive DescribeClusters. */
function route(answered: Cluster, reads: Cluster[]): void {
  const queue = [...reads];
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof DescribeClustersCommand) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { clusters: [next] };
    }
    return { cluster: answered };
  });
}

const sentNames = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

describe('ECS cluster settle wait (#7132)', () => {
  let provider: ECSProvider;
  const realSleep = clusterAttachmentsWait.sleep;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    clusterAttachmentsWait.sleep = () => Promise.resolve();
    provider = new ECSProvider();
  });

  afterEach(() => {
    clusterAttachmentsWait.sleep = realSleep;
    vi.unstubAllEnvs();
  });

  it('create() with ServiceConnectDefaults returns only after the cluster reads ACTIVE / UPDATE_COMPLETE', async () => {
    route(PROVISIONING, [PROVISIONING, UPDATING, ACTIVE]);
    const result = await provider.create('C', TYPE, {
      ClusterName: NAME,
      ServiceConnectDefaults: { Namespace: NS },
    });
    expect(result.physicalId).toBe(NAME);
    expect(sentNames()).toEqual([
      'CreateClusterCommand',
      'DescribeClustersCommand',
      'DescribeClustersCommand',
      'DescribeClustersCommand',
    ]);
    expect((mockSend.mock.calls[1]![0] as DescribeClustersCommand).input).toEqual({
      clusters: [NAME],
      include: ['ATTACHMENTS'],
    });
  });

  it('create() without ServiceConnectDefaults answered ACTIVE sends no read', async () => {
    route({ ...ACTIVE, attachmentsStatus: undefined }, [PROVISIONING]);
    await provider.create('C', TYPE, { ClusterName: NAME });
    expect(sentNames()).toEqual(['CreateClusterCommand']);
  });

  it('create() whose response reports PROVISIONING waits even without ServiceConnectDefaults', async () => {
    route(PROVISIONING, [PROVISIONING, ACTIVE]);
    await provider.create('C', TYPE, { ClusterName: NAME });
    expect(sentNames()).toEqual([
      'CreateClusterCommand',
      'DescribeClustersCommand',
      'DescribeClustersCommand',
    ]);
  });

  it('a create whose attachments end UPDATE_FAILED fails non-retryable, names the cluster it created, and keeps AWS text out of the message', async () => {
    route(PROVISIONING, [PROVISIONING, FAILED_ATTACHMENTS]);
    const error = await provider
      .create('C', TYPE, { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } })
      .then(
        () => new Error('expected the create to fail'),
        (e: unknown) => e
      );
    expect(String(error)).toMatch(/settled as ACTIVE \/ attachments UPDATE_FAILED/);
    expect(String(error)).not.toContain('123456789012:role');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(createdBeforeFailure(error, 'C', TYPE)).toBe(NAME);
  });

  it('a create reports the cluster to the created-resource sink before the wait fails', async () => {
    route(PROVISIONING, [PROVISIONING, FAILED_ATTACHMENTS]);
    const sink = new CreatedResourceSink('C', TYPE);
    await collectCreatedResources(sink, () =>
      provider.create('C', TYPE, { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } })
    ).catch(() => undefined);
    expect(sink.report?.physicalId).toBe(NAME);
  });

  it('create() answered settled takes its first settled read at once: a new cluster has no earlier state', async () => {
    route(ACTIVE, [ACTIVE]);
    await provider.create('C', TYPE, {
      ClusterName: NAME,
      ServiceConnectDefaults: { Namespace: NS },
    });
    expect(sentNames()).toEqual(['CreateClusterCommand', 'DescribeClustersCommand']);
  });

  it('update() answered in progress takes its first settled read at once', async () => {
    route(UPDATING, [ACTIVE]);
    await provider.update(
      'C',
      NAME,
      TYPE,
      { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } },
      { ClusterName: NAME }
    );
    const settleReads = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof DescribeClustersCommand &&
        (c[0] as DescribeClustersCommand).input.include !== undefined
    );
    expect(settleReads).toHaveLength(1);
  });

  it('a create whose cluster reads FAILED fails', async () => {
    route(PROVISIONING, [{ ...PROVISIONING, status: 'FAILED' }]);
    await expect(
      provider.create('C', TYPE, { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } })
    ).rejects.toThrow(/settled as FAILED/);
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips the create wait', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    route(PROVISIONING, [PROVISIONING]);
    await provider.create('C', TYPE, {
      ClusterName: NAME,
      ServiceConnectDefaults: { Namespace: NS },
    });
    expect(sentNames()).toEqual(['CreateClusterCommand']);
  });

  it('update() changing ServiceConnectDefaults waits after UpdateCluster until the attachments settle', async () => {
    route(UPDATING, [UPDATING, UPDATING, ACTIVE]);
    await provider.update(
      'C',
      NAME,
      TYPE,
      { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } },
      { ClusterName: NAME }
    );
    const names = sentNames();
    const at = names.indexOf('UpdateClusterCommand');
    expect(at).toBeGreaterThanOrEqual(0);
    // Three settle reads after the call, then the update's own ARN read.
    expect(names.slice(at + 1, at + 4)).toEqual([
      'DescribeClustersCommand',
      'DescribeClustersCommand',
      'DescribeClustersCommand',
    ]);
    expect((mockSend.mock.calls[at + 1]![0] as DescribeClustersCommand).input).toEqual({
      clusters: [NAME],
      include: ['ATTACHMENTS'],
    });
  });

  it('update() changing only ClusterSettings sends no settle read', async () => {
    route(ACTIVE, [ACTIVE]);
    await provider.update(
      'C',
      NAME,
      TYPE,
      { ClusterName: NAME, ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }] },
      { ClusterName: NAME }
    );
    const describes = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is DescribeClustersCommand => c instanceof DescribeClustersCommand);
    expect(describes.every((c) => c.input.include === undefined)).toBe(true);
    expect(sentNames()).toContain('UpdateClusterCommand');
  });

  it('update() answered settled reads a settled cluster as stale for the grace polls first', async () => {
    route(ACTIVE, [ACTIVE]);
    await provider.update(
      'C',
      NAME,
      TYPE,
      { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } },
      { ClusterName: NAME }
    );
    const settleReads = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof DescribeClustersCommand &&
        (c[0] as DescribeClustersCommand).input.include !== undefined
    );
    expect(settleReads).toHaveLength(CLUSTER_STALE_READ_GRACE_POLLS + 1);
  });

  it('update() whose attachments end UPDATE_FAILED after UPDATE_IN_PROGRESS fails non-retryable', async () => {
    route(UPDATING, [UPDATING, FAILED_ATTACHMENTS]);
    const error = await provider
      .update(
        'C',
        NAME,
        TYPE,
        { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } },
        { ClusterName: NAME }
      )
      .then(
        () => new Error('expected the update to fail'),
        (e: unknown) => e
      );
    expect(String(error)).toMatch(/UPDATE_FAILED/);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('update() that never saw UPDATE_IN_PROGRESS warns on a stale UPDATE_FAILED and continues', async () => {
    route(ACTIVE, [FAILED_ATTACHMENTS]);
    await provider.update(
      'C',
      NAME,
      TYPE,
      { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } },
      { ClusterName: NAME }
    );
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /UPDATE_FAILED attachments from before this update/
    );
  });

  it('--no-wait (CDKD_NO_WAIT=true) skips the update wait', async () => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    route(UPDATING, [UPDATING]);
    await provider.update(
      'C',
      NAME,
      TYPE,
      { ClusterName: NAME, ServiceConnectDefaults: { Namespace: NS } },
      { ClusterName: NAME }
    );
    const settleReads = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof DescribeClustersCommand &&
        (c[0] as DescribeClustersCommand).input.include !== undefined
    );
    expect(settleReads).toHaveLength(0);
  });
});

describe('waitForClusterSettled (#7132)', () => {
  const send = vi.fn();
  const client = { send } as unknown as ECSClient;
  const log = createMaskedLogSinks({ debug: vi.fn(), warn: vi.fn() }, undefined);
  const realSleep = clusterAttachmentsWait.sleep;
  const opts = { staleReadGracePolls: 0, pollMs: 0 };

  beforeEach(() => {
    send.mockReset();
    clusterAttachmentsWait.sleep = () => Promise.resolve();
  });
  afterEach(() => {
    clusterAttachmentsWait.sleep = realSleep;
  });

  it('reads again after a throttled read', async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .mockResolvedValueOnce({ clusters: [ACTIVE] });
    await waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, opts);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ends the wait unchanged on any other read failure', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    send.mockRejectedValueOnce(denied);
    await expect(waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, opts)).rejects.toBe(
      denied
    );
  });

  it('reads a cluster not yet visible again, then fails past the grace', async () => {
    send.mockResolvedValue({ clusters: [], failures: [{ reason: 'MISSING' }] });
    const error = await waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, opts).then(
      () => new Error('expected the wait to fail'),
      (e: unknown) => e
    );
    expect(String(error)).toMatch(/could not be read back/);
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });

  it('fails on INACTIVE', async () => {
    send.mockResolvedValue({ clusters: [{ ...ACTIVE, status: 'INACTIVE' }] });
    await expect(waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, opts)).rejects.toThrow(
      /settled as INACTIVE/
    );
  });

  it('throws a non-retryable not-confirmed error when its poll cap runs out', async () => {
    send.mockResolvedValue({ clusters: [PROVISIONING] });
    const error = await waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, {
      ...opts,
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
    clusterAttachmentsWait.sleep = realSleep;
    send.mockResolvedValue({ clusters: [PROVISIONING] });
    const error = await withResourceDeadline(
      () =>
        waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, {
          staleReadGracePolls: 0,
          pollMs: 60_000,
        }),
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
        return { clusters: [PROVISIONING] };
      });
      const error = await waitForClusterSettled(client, 'C', NAME, log, PROVISIONING, opts).then(
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
