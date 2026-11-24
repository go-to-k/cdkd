import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6940 review (S2): a deferred readiness wait the deploy aborts
 * (its deadline, Ctrl-C, a failed sibling) stops the provider's own poll,
 * rather than polling on in the background.
 */

const mocks = vi.hoisted(() => ({ waitStable: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const child: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  child['child'] = () => child;
  return { getLogger: () => child };
});
vi.mock('@aws-sdk/client-ecs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-ecs')>()),
  waitUntilServicesStable: (...args: unknown[]) => mocks.waitStable(...args),
}));

import { waitForInstanceAvailable } from '../../../src/provisioning/providers/rds/waits.js';
import { settleService } from '../../../src/provisioning/providers/ecs/service-create.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';
import type { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import type { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import {
  waitForClusterAvailable as docdbWaitForClusterAvailable,
  waitForInstanceAvailable as docdbWaitForInstanceAvailable,
} from '../../../src/provisioning/providers/docdb/wait.js';
import {
  waitForClusterAvailable as neptuneWaitForClusterAvailable,
  waitForInstanceAvailable as neptuneWaitForInstanceAvailable,
} from '../../../src/provisioning/providers/neptune/waits.js';
import { waitForClusterAvailable as cacheWaitForClusterAvailable } from '../../../src/provisioning/providers/elasticache/cache-cluster.js';
import { waitForCertificateIssued } from '../../../src/provisioning/providers/acm-certificate/wait.js';
import { abortableSleep } from '../../../src/provisioning/deferred-readiness.js';

const scope = (logicalId: string, resourceType: string): DeferredReadinessScope => ({
  logicalId,
  resourceType,
  deferred: new Map(),
  awaitUpstreamReadiness: async () => undefined,
  awaitUpstreamReadinessRaw: async () => undefined,
  awaitDeferredResource: () => undefined,
});

describe('an aborted deferred wait stops the provider poll (#6940)', () => {
  beforeEach(() => {
    mocks.waitStable.mockReset();
    delete process.env['CDKD_NO_WAIT'];
  });
  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it('RDS: waitForInstanceAvailable stops describing once the signal aborts', async () => {
    const controller = new AbortController();
    let reads = 0;
    const fake = {
      logger: { debug: () => undefined },
      describeDBInstance: async () => {
        reads++;
        if (reads === 2) controller.abort();
        return { DBInstanceStatus: 'creating' };
      },
      // Never resolves on its own: only the abort can end the sleep.
      sleep: () => new Promise<void>(() => undefined),
    } as unknown as RDSProvider;
    const wait = waitForInstanceAvailable.call(
      fake,
      'Db',
      'mydb',
      1_800_000,
      'being created',
      controller.signal
    );
    // First read, then a sleep the abort cuts; the second read aborts.
    setTimeout(() => controller.abort(), 10);
    await expect(wait).rejects.toThrow(/aborted/);
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(after);
    expect(reads).toBeLessThanOrEqual(2);
  });

  it('ECS: the deferred steady-state wait aborts its SDK waiter with the signal', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    let waiterSignal: AbortSignal | undefined;
    mocks.waitStable.mockImplementation(
      (config: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          waiterSignal = config.abortSignal;
          config.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const fake = {
      logger: { info: () => undefined, debug: () => undefined, warn: () => undefined },
      getClient: () => ({ send: async () => ({ services: [] }) }),
      wrapWaiterResultError: (error: unknown) => error,
    } as unknown as ECSProvider;
    const log = {
      mask: (text: string) => text,
      debug: () => undefined,
      warn: () => undefined,
    } as unknown as Parameters<typeof settleService>[3];
    const s = scope('Svc', 'AWS::ECS::Service');
    await withDeferredReadinessScope(s, () =>
      settleService.call(fake, 'Svc', 'arn:svc', 'cluster', log, undefined, undefined)
    );
    expect(mocks.waitStable).not.toHaveBeenCalled();
    const controller = new AbortController();
    const wait = s.deferred.get('arn:svc')!.wait(controller.signal);
    await vi.waitFor(() => expect(mocks.waitStable).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(wait).rejects.toThrow();
    expect(waiterSignal?.aborted).toBe(true);
  });
});

interface PollCase {
  label: string;
  /** Run the wait against a fake whose read aborts after the first call. */
  run: (onRead: () => void, signal: AbortSignal) => Promise<unknown>;
}

const noop = (): undefined => undefined;
// Never resolves on its own: only the abort can end the sleep.
const neverSleep = (): Promise<void> => new Promise<void>(() => undefined);

const pollCases: PollCase[] = [
  {
    label: 'DocDB waitForClusterAvailable',
    run: (onRead, signal) =>
      docdbWaitForClusterAvailable.call(
        {
          logger: { debug: noop },
          describeDBCluster: async () => {
            onRead();
            return { Status: 'creating' };
          },
          sleep: neverSleep,
        } as never,
        'Cluster',
        'c1',
        1_800_000,
        signal
      ),
  },
  {
    label: 'DocDB waitForInstanceAvailable',
    run: (onRead, signal) =>
      docdbWaitForInstanceAvailable.call(
        {
          logger: { debug: noop },
          describeDBInstance: async () => {
            onRead();
            return { DBInstanceStatus: 'creating' };
          },
          sleep: neverSleep,
        } as never,
        'Db',
        'i1',
        1_800_000,
        signal
      ),
  },
  {
    label: 'Neptune waitForClusterAvailable',
    run: (onRead, signal) =>
      neptuneWaitForClusterAvailable.call(
        {
          logger: { debug: noop },
          describeDBCluster: async () => {
            onRead();
            return { Status: 'creating' };
          },
          sleep: neverSleep,
        } as never,
        'Cluster',
        'c1',
        'being created',
        1_800_000,
        signal
      ),
  },
  {
    label: 'Neptune waitForInstanceAvailable',
    run: (onRead, signal) =>
      neptuneWaitForInstanceAvailable.call(
        {
          logger: { debug: noop },
          describeDBInstance: async () => {
            onRead();
            return { DBInstanceStatus: 'creating' };
          },
          sleep: neverSleep,
        } as never,
        'Db',
        'i1',
        1_800_000,
        signal
      ),
  },
  {
    label: 'ElastiCache waitForClusterAvailable',
    run: (onRead, signal) =>
      cacheWaitForClusterAvailable.call(
        {
          logger: { debug: noop },
          describeCacheCluster: async () => {
            onRead();
            return { CacheClusterStatus: 'creating' };
          },
          sleep: neverSleep,
        } as never,
        'cache1',
        600_000,
        undefined,
        [],
        signal
      ),
  },
  {
    // The ACM poll sleeps in its own ticks, so the abort ends it at the next
    // attempt rather than inside a sleep.
    label: 'ACM waitForCertificateIssued',
    run: (onRead, signal) =>
      waitForCertificateIssued.call(
        {
          logger: { debug: noop, info: noop },
          maxPollAttempts: 1000,
          pollIntervalMs: 5,
          acmClient: {
            send: async () => {
              onRead();
              return { Certificate: { Status: 'PENDING_VALIDATION', DomainValidationOptions: [] } };
            },
          },
          writeValidationRecords: async () => undefined,
          renderValidationOptions: () => undefined,
        } as never,
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
        'Cert',
        'AWS::CertificateManager::Certificate',
        new Map(),
        signal
      ),
  },
];

describe.each(pollCases)('an aborted deferred wait stops $label (#6940)', (c) => {
  it('rejects once the signal aborts and reads no more', async () => {
    const controller = new AbortController();
    let reads = 0;
    const wait = c.run(() => {
      reads++;
      if (reads === 1) controller.abort();
    }, controller.signal);
    await expect(wait).rejects.toThrow(/aborted/);
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads).toBe(after);
    expect(reads).toBe(1);
  });
});

describe('abortableSleep (#6940)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects at once on abort and clears its timer', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const sleeping = abortableSleep(neverSleep, 10_000, controller.signal);
    const before = clearSpy.mock.calls.length;
    controller.abort();
    await expect(sleeping).rejects.toThrow(/aborted/);
    expect(clearSpy.mock.calls.length).toBe(before + 1);
  });
});
