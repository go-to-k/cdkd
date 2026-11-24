import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  enclosingDeadlineRemainingMs,
  withResourceDeadline,
} from '../../../src/deployment/resource-deadline.js';
import {
  DeferredReadinessRun,
  deferredReadinessPoll,
} from '../../../src/deployment/deferred-readiness-run.js';
import {
  awaitUpstreamReadiness,
  deferReadiness,
  withDeferredReadinessScope,
  type DeferredReadinessScope,
  type DeferredReadinessEntry,
  type ReadinessWait,
} from '../../../src/provisioning/deferred-readiness.js';
import { isInterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { ProvisioningError, ResourceTimeoutError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#6940: the readiness waits `--no-wait` skips, kept per resource
 * and run only when the deploy needs one, as one shared wait.
 */

type LogFn = (message: string, ...args: unknown[]) => void;
const quietLogger = () => ({ info: vi.fn<LogFn>(), debug: vi.fn<LogFn>() });

function makeRun(
  overrides: {
    interrupted?: () => boolean;
    timeoutMs?: number;
    mask?: (logicalId: string, text: string) => string;
  } = {}
): { run: DeferredReadinessRun; logger: ReturnType<typeof quietLogger> } {
  const logger = quietLogger();
  const run = new DeferredReadinessRun({
    logger,
    region: 'us-east-1',
    budget: () => {
      const timeoutMs = overrides.timeoutMs ?? 2_000_000;
      return { warnAfterMs: timeoutMs / 2, timeoutMs };
    },
    interrupted: overrides.interrupted ?? (() => false),
    ...(overrides.mask && { mask: overrides.mask }),
  });
  return { run, logger };
}

const one = (wait: ReadinessWait, physicalId = 'id-1'): Map<string, DeferredReadinessEntry> =>
  new Map([[physicalId, { wait, inContext: (fn) => fn() }]]);

describe('DeferredReadinessRun (#6940)', () => {
  afterEach(() => {
    deferredReadinessPoll.intervalMs = 500;
  });

  it('answers undefined for a resource whose wait was not deferred', () => {
    const { run } = makeRun();
    expect(run.isEmpty).toBe(true);
    expect(run.awaitReady('Nat', 'needed')).toBeUndefined();
  });

  it('runs the deferred wait ONCE and shares it between every need', async () => {
    const { run, logger } = makeRun();
    let release!: () => void;
    const wait = vi.fn(
      (): Promise<void> =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    run.record('Db', 'AWS::RDS::DBCluster', 'CREATE', one(wait));
    expect(run.isEmpty).toBe(false);
    expect(run.isDeferred('Db')).toBe(true);
    const first = run.awaitReady('Db', 'Fn::GetAtt Endpoint.Address needs it');
    const second = run.awaitReady('Db', 'custom resource Seed is invoked after it');
    await vi.waitFor(() => expect(wait).toHaveBeenCalled());
    release();
    await first;
    await run.awaitAll(['Db', 'Other'], 'another need');
    expect(wait).toHaveBeenCalledTimes(1);
    // One line, worded from the FIRST need.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0]![0])).toContain('Fn::GetAtt Endpoint.Address');
  });

  it('starts no wait until a need asks for it', () => {
    const { run } = makeRun();
    const wait = vi.fn(async () => undefined);
    run.record('Nat', 'AWS::EC2::NatGateway', 'CREATE', one(wait));
    expect(wait).not.toHaveBeenCalled();
  });

  it('an operation that deferred nothing clears an earlier entry', () => {
    const { run } = makeRun();
    run.record('Nat', 'AWS::EC2::NatGateway', 'CREATE', one(async () => undefined));
    run.record('Nat', 'AWS::EC2::NatGateway', 'UPDATE', new Map());
    expect(run.isDeferred('Nat')).toBe(false);
    expect(run.isEmpty).toBe(true);
  });

  it('a resource that ends failed rejects with an error naming IT and the need', async () => {
    const { run } = makeRun();
    run.record(
      'Db',
      'AWS::RDS::DBCluster',
      'CREATE',
      one(async () => {
        throw new Error('DBCluster Db entered status failed while being created');
      })
    );
    const ready = run.awaitReady('Db', 'custom resource Seed is invoked after it')!;
    await expect(ready).rejects.toBeInstanceOf(ProvisioningError);
    await expect(ready).rejects.toMatchObject({
      logicalId: 'Db',
      resourceType: 'AWS::RDS::DBCluster',
    });
    await expect(ready).rejects.toThrow(
      /Db \(AWS::RDS::DBCluster\) did not become ready \(custom resource Seed is invoked after it\): DBCluster Db entered status failed/
    );
    // awaitAll surfaces the same failure.
    await expect(run.awaitAll(['Db'], 'again')).rejects.toBeInstanceOf(ProvisioningError);
  });

  it('a failed sibling (the engine interrupt) aborts the wait and its signal', async () => {
    deferredReadinessPoll.intervalMs = 5;
    let interrupted = false;
    const { run } = makeRun({ interrupted: () => interrupted });
    let seen: AbortSignal | undefined;
    run.record(
      'Lb',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'CREATE',
      one((signal) => {
        seen = signal;
        return new Promise(() => undefined);
      })
    );
    const ready = run.awaitReady('Lb', 'needed')!;
    interrupted = true;
    const error = await ready.catch((e: unknown) => e);
    expect(isInterruptedWaitError(error)).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it('is bounded by the resource type deadline', async () => {
    const { run } = makeRun({ timeoutMs: 20 });
    run.record('Cert', 'AWS::CertificateManager::Certificate', 'CREATE', one(() => new Promise(() => undefined)));
    await expect(run.awaitReady('Cert', 'needed')!).rejects.toBeInstanceOf(ResourceTimeoutError);
  });

  it('awaits every deferred resource of a set, concurrently, and skips the rest', async () => {
    const { run } = makeRun();
    const started: string[] = [];
    const releases: Array<() => void> = [];
    for (const id of ['A', 'B']) {
      run.record(
        id,
        'AWS::EC2::NatGateway',
        'CREATE',
        one(
          () =>
            new Promise<void>((resolve) => {
              started.push(id);
              releases.push(resolve);
            })
        )
      );
    }
    const all = run.awaitAll(['A', 'NotDeferred', 'B'], 'needed');
    await vi.waitFor(() => expect(started).toStrictEqual(['A', 'B']));
    for (const release of releases) release();
    await all;
  });
});

describe('DeferredReadinessRun context, masking and stop (#6940 review)', () => {
  afterEach(() => {
    deferredReadinessPoll.intervalMs = 500;
  });

  const scopeFor = (logicalId: string, resourceType: string): DeferredReadinessScope => ({
    logicalId,
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  });

  it('runs the wait in the DEFERRING operation\'s async context, not the first consumer\'s', async () => {
    const tag = new AsyncLocalStorage<string>();
    const scope = scopeFor('Db', 'AWS::RDS::DBCluster');
    let seen: string | undefined;
    await tag.run('upstream', () =>
      withDeferredReadinessScope(scope, async () => {
        deferReadiness('Db', 'AWS::RDS::DBCluster', 'db-1', async () => {
          seen = tag.getStore();
        });
      })
    );
    const { run } = makeRun();
    run.record('Db', 'AWS::RDS::DBCluster', 'CREATE', scope.deferred);
    await tag.run('consumer', () => run.awaitReady('Db', 'needed'));
    expect(seen).toBe('upstream');
  });

  it("gets its OWN budget: never the upstream's settled deadline, nor the consumer's", async () => {
    const scope = scopeFor('Db', 'AWS::RDS::DBCluster');
    let remaining = 0;
    // The upstream operation ran under a 50 ms deadline, long elapsed when
    // the first need arrives.
    await withResourceDeadline(
      () =>
        withDeferredReadinessScope(scope, async () => {
          deferReadiness('Db', 'AWS::RDS::DBCluster', 'db-1', async () => {
            remaining = enclosingDeadlineRemainingMs();
          });
        }),
      { warnAfterMs: 25, timeoutMs: 50, onTimeout: () => new Error('upstream timeout') }
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { run } = makeRun();
    run.record('Db', 'AWS::RDS::DBCluster', 'CREATE', scope.deferred);
    // The consumer (a Lambda function, say) runs under a 1-second deadline.
    await withResourceDeadline(() => run.awaitReady('Db', 'needed')!, {
      warnAfterMs: 500,
      timeoutMs: 1_000,
      onTimeout: () => new Error('consumer timeout'),
    });
    // makeRun's budget for the type: 2_000_000 ms.
    expect(remaining).toBeGreaterThan(1_000_000);
  });

  it("masks the line and the error with the upstream resource's secrets", async () => {
    const mask = (logicalId: string, text: string): string =>
      logicalId === 'Db' ? text.replaceAll('prod-billing-db-x7', '***') : text;
    const { run, logger } = makeRun({ mask });
    run.record(
      'Db',
      'AWS::RDS::DBCluster',
      'CREATE',
      one(async () => {
        throw new Error('Timed out waiting for DBCluster prod-billing-db-x7 to become available');
      })
    );
    const error = await run.awaitReady('Db', 'needed')!.catch((e: unknown) => e);
    expect((error as Error).message).toContain('***');
    expect((error as Error).message).not.toContain('prod-billing-db-x7');
    for (const call of logger.info.mock.calls) expect(String(call[0])).not.toContain('prod-billing-db-x7');
  });

  it("words each consumer's error with its own need", async () => {
    const { run } = makeRun();
    run.record(
      'Db',
      'AWS::RDS::DBCluster',
      'CREATE',
      one(async () => {
        throw new Error('failed');
      })
    );
    const first = await run.awaitReady('Db', 'custom resource A is invoked after it')!.catch((e: unknown) => e);
    const second = await run.awaitReady('Db', 'Fn::GetAtt Endpoint.Address needs it')!.catch((e: unknown) => e);
    expect((first as Error).message).toContain('custom resource A is invoked after it');
    expect((second as Error).message).toContain('Fn::GetAtt Endpoint.Address needs it');
  });

  it('aborts the provider poll and stops its interrupt poll when the deadline runs out', async () => {
    deferredReadinessPoll.intervalMs = 5;
    const { run } = makeRun({ timeoutMs: 20 });
    let seen: AbortSignal | undefined;
    run.record(
      'Cert',
      'AWS::CertificateManager::Certificate',
      'CREATE',
      one((signal) => {
        seen = signal;
        return new Promise(() => undefined);
      })
    );
    const clear = vi.spyOn(globalThis, 'clearInterval');
    await expect(run.awaitReady('Cert', 'needed')!).rejects.toBeInstanceOf(ResourceTimeoutError);
    expect(seen?.aborted).toBe(true);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe('deferReadiness / awaitUpstreamReadiness (#6940)', () => {
  const scopeFor = (
    logicalId: string,
    resourceType: string,
    awaitUpstream = vi.fn(async () => undefined)
  ): DeferredReadinessScope => ({
    logicalId,
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: awaitUpstream,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource: () => undefined,
  });

  it('records into the scope bound for the same logical id and type', async () => {
    const scope = scopeFor('Nat', 'AWS::EC2::NatGateway');
    const wait = async (): Promise<void> => undefined;
    await withDeferredReadinessScope(scope, async () => {
      deferReadiness('Nat', 'AWS::EC2::NatGateway', 'nat-1', wait);
      // Another resource, or another type, reports nothing into this scope.
      deferReadiness('Other', 'AWS::EC2::NatGateway', 'nat-2', wait);
      deferReadiness('Nat', 'AWS::EC2::Instance', 'i-1', wait);
    });
    expect([...scope.deferred.keys()]).toStrictEqual(['nat-1']);
  });

  it('a retry re-reporting the same resource replaces its wait', async () => {
    const scope = scopeFor('Nat', 'AWS::EC2::NatGateway');
    const later = async (): Promise<void> => undefined;
    await withDeferredReadinessScope(scope, async () => {
      deferReadiness('Nat', 'AWS::EC2::NatGateway', 'nat-1', async () => undefined);
      deferReadiness('Nat', 'AWS::EC2::NatGateway', 'nat-1', later);
    });
    expect(scope.deferred.get('nat-1')?.wait).toBe(later);
  });

  it('outside a scope (rollback, destroy, a direct call) does nothing', async () => {
    expect(() =>
      deferReadiness('Nat', 'AWS::EC2::NatGateway', 'nat-1', async () => undefined)
    ).not.toThrow();
    await expect(awaitUpstreamReadiness('Seed')).resolves.toBeUndefined();
  });

  it('awaitUpstreamReadiness asks only the scope bound for that logical id', async () => {
    const awaitUpstream = vi.fn(async () => undefined);
    const scope = scopeFor('Seed', 'Custom::Seed', awaitUpstream);
    await withDeferredReadinessScope(scope, async () => {
      await awaitUpstreamReadiness('Other');
      expect(awaitUpstream).not.toHaveBeenCalled();
      await awaitUpstreamReadiness('Seed');
    });
    expect(awaitUpstream).toHaveBeenCalledTimes(1);
  });
});
