import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { renderLikeLogger } from '../../render-like-logger.js';

/**
 * go-to-k/cdkd#7025 step 6: after `cdkd drift --revert` counts a resource
 * reverted, the stack is re-detected and every path the revert sent is
 * compared again. A service that accepts an update without applying the value
 * (#6777) fails the run (exit 2) instead of reporting success.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
// A level the mocked logger honors, so the re-read's held-back lines are
// observable: `warn` / `info` below `error` are dropped, as the real one does.
const logLevel = vi.hoisted(() => ({ current: 'info' as string }));

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: (level: string) => {
      logLevel.current = level;
    },
    getLevel: () => logLevel.current,
    debug: vi.fn(),
    info: (...args: unknown[]) => {
      if (logLevel.current !== 'error') infoSpy(...args);
    },
    warn: (...args: unknown[]) => {
      if (logLevel.current !== 'error') warnSpy(...args);
    },
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({}),
}));

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockSaveState = vi.fn(async () => '"etag-2"');
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

const lockEvents = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => {
      lockEvents.push('acquire');
      return true;
    }),
    releaseLock: vi.fn(async () => {
      lockEvents.push('release');
    }),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { sentDiffPaths } from '../../../src/cli/commands/drift/revert-verify.js';

const TYPE = 'AWS::Lambda::EventSourceMapping';
const RECORDED = { FunctionName: 'fn', BatchSize: 10, MaximumRetryAttempts: 2 };

function stateWith(record: ResourceState): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Mapping: record },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

const record: ResourceState = {
  physicalId: 'esm-1',
  resourceType: TYPE,
  properties: { ...RECORDED },
  observedProperties: { ...RECORDED },
};

/**
 * A provider whose read answers `reads` in turn (the last one repeats): the
 * first is the detection read, each later one a post-revert re-read.
 */
function providerReading(...reads: Array<Record<string, unknown> | undefined>) {
  let call = 0;
  const readCurrentState = vi.fn(async () => {
    lockEvents.push('read');
    const value = reads[Math.min(call, reads.length - 1)];
    call++;
    return value === undefined ? undefined : { ...value };
  });
  const update = vi.fn(async () => {
    lockEvents.push('update');
    return { physicalId: 'esm-1', wasReplaced: false };
  });
  return { readCurrentState, update };
}

async function runRevert(extra: string[] = []): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    // Caught here: it rejects through the stubbed `process.exit` while the
    // timers below are still being advanced.
    const done = cmd
      .parseAsync(['TestStack', '--revert', '--yes', ...extra], { from: 'user' })
      .catch(() => undefined);
    // The re-read waits run on fake timers; advance past all of them.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5_000);
    await done;
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
}

const text = (spy: ReturnType<typeof vi.fn>): string =>
  spy.mock.calls.map((c) => renderLikeLogger(c)).join('\n');

const DRIFTED = { ...RECORDED, MaximumRetryAttempts: 5 };

describe('cdkd drift --revert verifies each reverted resource (go-to-k/cdkd#7025)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockSaveState.mockClear();
    errorSpy.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    lockEvents.length = 0;
    logLevel.current = 'info';
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockImplementation(async () => stateWith(record));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('a re-read that converged passes, and re-reads once after the lock is released', async () => {
    const provider = providerReading(DRIFTED, RECORDED);
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(provider.readCurrentState).toHaveBeenCalledTimes(2);
    expect(lockEvents).toEqual(['read', 'acquire', 'update', 'release', 'read']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(text(errorSpy)).not.toContain('not applied by AWS');
    expect(text(infoSpy)).toContain('Revert summary: 1 reverted.');
  });

  it('a re-read that still differs on the reverted path fails with exit 2, after the waits', async () => {
    const provider = providerReading(DRIFTED);
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    expect(provider.update).toHaveBeenCalledTimes(1);
    // The detection read, then three re-reads.
    expect(provider.readCurrentState).toHaveBeenCalledTimes(4);
    expect(text(errorSpy)).toContain(
      `TestStack/Mapping (${TYPE}): not applied by AWS — AWS accepted the update without applying the reverted value; a re-read still differs from cdkd state at MaximumRetryAttempts.`
    );
    expect(text(infoSpy)).toContain('Revert summary: 1 reverted, 1 not applied by AWS.');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(text(errorSpy)).toContain('1 reverted resource(s) were not applied by AWS');
    // Read-only: no secret, no narrowing, so nothing in the run writes state.
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('a lagging re-read that converges on the second attempt passes', async () => {
    const provider = providerReading(DRIFTED, DRIFTED, RECORDED);
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    expect(provider.readCurrentState).toHaveBeenCalledTimes(3);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(text(errorSpy)).not.toContain('not applied by AWS');
  });

  it('new drift on a path the revert did not send does not fail the resource', async () => {
    const provider = providerReading(DRIFTED, { ...RECORDED, BatchSize: 99 });
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    // Not retried: no reverted path differs on the first re-read.
    expect(provider.readCurrentState).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(text(errorSpy)).not.toContain('not applied by AWS');
  });

  it('a re-read that cannot be compared warns and does not fail', async () => {
    // `undefined` from the read is the "no provider can read it" outcome.
    const provider = providerReading(DRIFTED, undefined);
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    expect(provider.readCurrentState).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(text(warnSpy)).toContain(
      `TestStack/Mapping (${TYPE}): reverted, but cdkd could not verify it: no provider could read it back.`
    );
    expect(text(infoSpy)).toContain('Revert summary: 1 reverted, 1 not verified.');
  });

  it('a re-read whose own read fails prints one could-not-verify line, not the detection warning again', async () => {
    let call = 0;
    const provider = {
      readCurrentState: vi.fn(async () => {
        call++;
        if (call === 1) return { ...DRIFTED };
        throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      }),
      update: vi.fn(async () => ({ physicalId: 'esm-1', wasReplaced: false })),
    };
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    expect(exitSpy).not.toHaveBeenCalled();
    const warnings = text(warnSpy);
    expect(warnings).toContain(`TestStack/Mapping (${TYPE}): reverted, but cdkd could not verify it:`);
    // The re-read's own read-failure line is held back; it would name the AWS error.
    expect(warnings).not.toContain('Rate exceeded');
    expect(logLevel.current).toBe('info');
  });

  it('a path segment spelling a secret-derived name prints masked (go-to-k/cdkd#3869)', async () => {
    const USER_ID = 'team-secret-drift-user';
    const meta = (v: string) => ({ ...RECORDED, Meta: { [USER_ID]: v } });
    const provider = providerReading(meta('b'));
    const userProvider = { readCurrentState: vi.fn(async () => undefined), update: vi.fn() };
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::User' ? userProvider : provider
    );
    mockGetState.mockImplementation(async () => ({
      state: {
        ...stateWith(record).state,
        resources: {
          User: {
            physicalId: USER_ID,
            resourceType: 'AWS::IAM::User',
            properties: { UserName: '***' },
          },
          Mapping: { ...record, properties: meta('a'), observedProperties: meta('a') },
        },
      },
      etag: '"etag-1"',
    }));

    await runRevert();

    expect(exitSpy).toHaveBeenCalledWith(2);
    const line = text(errorSpy)
      .split('\n')
      .find((l) => l.includes('not applied by AWS —'));
    expect(line).toContain('at Meta.***.');
    expect(line).not.toContain(USER_ID);
  });

  it('a re-read that throws warns per resource without waiting', async () => {
    const provider = providerReading(DRIFTED, RECORDED);
    mockRegistryGetProvider.mockReturnValue(provider);
    mockGetState.mockReset();
    mockGetState.mockResolvedValueOnce(stateWith(record)).mockResolvedValue(null);

    await runRevert();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(text(warnSpy)).toContain(
      `TestStack/Mapping (${TYPE}): reverted, but cdkd could not verify it: the re-read failed`
    );
  });

  it('a key the provider reported narrowing is not verified (#1644)', async () => {
    const provider = providerReading(DRIFTED, { ...RECORDED, MaximumRetryAttempts: 3 });
    // The provider says AWS applied 3, not the recorded 2.
    provider.update.mockResolvedValue({
      physicalId: 'esm-1',
      wasReplaced: false,
      effectiveProperties: { ...RECORDED, MaximumRetryAttempts: 3 },
    } as never);
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert();

    // The narrowing is recorded; the mocked state read still returns the old
    // baseline, so only the exclusion keeps the re-read from failing it.
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(provider.readCurrentState).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(text(errorSpy)).not.toContain('not applied by AWS');
  });

  it('a template-only baseline whose revert keeps an untemplated tag passes when AWS holds what was sent', async () => {
    // The `drift-revert` integ's step 6d shape: state records the TEMPLATE
    // tags only, so after a revert that restored `Owner` and kept the
    // AWS-authored `IntegInjected`, state still differs from AWS at `Tags`.
    const bucket: ResourceState = {
      physicalId: 'bucket-1',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'b', Tags: [{ Key: 'Owner', Value: 'cdkd-integ' }] },
    };
    const live = (owner: string) => ({
      BucketName: 'b',
      Tags: [
        { Key: 'IntegInjected', Value: 'yes' },
        { Key: 'Owner', Value: owner },
      ],
    });
    let sent: Record<string, unknown> | undefined;
    let call = 0;
    const provider = {
      readCurrentState: vi.fn(async () => {
        call++;
        if (call === 1) return live('DRIFTED-BY-INTEG');
        // AWS answers in its own order: Owner first.
        const tags = (live('cdkd-integ').Tags as unknown[]).slice().reverse();
        return { BucketName: 'b', Tags: tags };
      }),
      update: vi.fn(async (_l: string, _p: string, _t: string, props: Record<string, unknown>) => {
        sent = props;
        return { physicalId: 'bucket-1', wasReplaced: false };
      }),
    };
    mockRegistryGetProvider.mockReturnValue(provider);
    mockGetState.mockImplementation(async () => ({
      state: { ...stateWith(record).state, resources: { DriftBucket: bucket } },
      etag: '"etag-1"',
    }));

    await runRevert();

    // Premise: the revert kept the untemplated tag and restored Owner.
    expect(sent?.['Tags']).toEqual(
      expect.arrayContaining([
        { Key: 'IntegInjected', Value: 'yes' },
        { Key: 'Owner', Value: 'cdkd-integ' },
      ])
    );
    // Not retried: the first re-read already holds what was sent.
    expect(provider.readCurrentState).toHaveBeenCalledTimes(2);
    expect(text(errorSpy)).not.toContain('not applied by AWS');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--dry-run reverts nothing and re-reads nothing', async () => {
    const provider = providerReading(DRIFTED);
    mockRegistryGetProvider.mockReturnValue(provider);

    await runRevert(['--dry-run']);

    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.readCurrentState).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a not-applied resource and an AWS update failure end in one error naming both', async () => {
    const failing = {
      readCurrentState: vi.fn(async () => ({ ...DRIFTED })),
      update: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const ignoring = providerReading(DRIFTED);
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::Test::Failing' ? failing : ignoring
    );
    mockGetState.mockImplementation(async () => ({
      state: {
        ...stateWith(record).state,
        resources: {
          Mapping: record,
          Other: { ...record, physicalId: 'other-1', resourceType: 'AWS::Test::Failing' },
        },
      },
      etag: '"etag-1"',
    }));

    await runRevert();

    expect(exitSpy).toHaveBeenCalledWith(2);
    const errors = text(errorSpy);
    expect(errors).toContain('Revert completed with 1 resource error(s)');
    expect(errors).toContain('1 reverted resource(s) were not applied by AWS');
    expect(text(infoSpy)).toContain('Revert summary: 1 reverted, 1 not applied by AWS, 1 failed.');
  });
});

describe('sentDiffPaths compares the sent bag with the re-read (go-to-k/cdkd#7025)', () => {
  it("applies the provider's own canonicalizer to both sides", () => {
    const provider = {
      canonicalizeDriftProperties: (_t: string, p: Record<string, unknown>) => ({
        ...p,
        Mode: typeof p['Mode'] === 'string' ? p['Mode'].toLowerCase() : p['Mode'],
      }),
    };
    expect(sentDiffPaths({ Mode: 'FAST' }, { Mode: 'fast' }, ['Mode'], provider, TYPE, {})).toEqual(
      []
    );
    expect(sentDiffPaths({ Mode: 'FAST' }, { Mode: 'slow' }, ['Mode'], provider, TYPE, {})).toEqual(
      ['Mode']
    );
  });

  it('compares only under the targeted top-level keys', () => {
    expect(
      sentDiffPaths({ A: 1, B: 1 }, { A: 1, B: 2 }, ['A'], {}, TYPE, {})
    ).toEqual([]);
  });
});
