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

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
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
