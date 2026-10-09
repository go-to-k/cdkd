/**
 * go-to-k/cdkd#4705: `cdkd destroy` / `cdkd state destroy` refuse a stack the
 * bucket also records under ANOTHER state prefix, before any lock, prompt or
 * delete; a nested child's destroy (no `crossPrefixCheck`) never scans.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

const { warn, info, createInterface } = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'y'), close: vi.fn() })),
}));
vi.mock('node:readline/promises', () => ({ createInterface }));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info,
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { RetainedTimeUnconfirmedError } from '../../../src/state/retained-time.js';
import { CrossPrefixScanCache } from '../../../src/state/cross-prefix-stack-scan.js';

const REGION = 'us-east-1';

function emptyState(): StackState {
  return {
    version: 8,
    stackName: 'App',
    region: REGION,
    resources: {},
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(opts: {
  crossPrefixCheck?: boolean;
  skipConfirmation?: boolean;
  prefixes?: string[] | Error;
  holders?: Record<string, boolean>;
  retained?: Array<{ logicalId: string; resourceType: string; physicalId: string }>;
}) {
  const acquireLock = vi.fn().mockResolvedValue(true);
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const listTopLevelPrefixes = vi.fn(async () => {
    if (opts.prefixes instanceof Error) throw opts.prefixes;
    return opts.prefixes ?? [];
  });
  const recordUnderPrefix = vi.fn(async (p: string) => (opts.holders?.[p] ? 'holder' : 'absent'));
  const saveRetainedResources = vi.fn(async () => undefined);
  const releaseRegistryMarker = vi.fn(
    async (_s: string, _r: string, _known?: unknown) => 'released' as const
  );
  const ensureRetainedTombstone = vi.fn(async (_s: string, _r: string) => undefined);
  const stateBackend = {
    prefix: 'cdkd',
    getState: vi.fn().mockResolvedValue(null),
    deleteState,
    saveState: vi.fn(),
    listStacks: vi.fn().mockResolvedValue([]),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    listTopLevelPrefixes,
    recordUnderPrefix,
    loadRetainedResources: vi.fn(async () => opts.retained ?? []),
    loadRetainedRecord: vi.fn(async () => opts.retained ?? null),
    ensureRetainedTombstone,
    saveRetainedResources,
    releaseRegistryMarker,
  };
  return {
    acquireLock,
    deleteState,
    listTopLevelPrefixes,
    recordUnderPrefix,
    saveRetainedResources,
    releaseRegistryMarker,
    ensureRetainedTombstone,
    ctx: {
      stateBackend: stateBackend as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock: vi.fn().mockResolvedValue(undefined),
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor: vi.fn() } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'cdkd-state-123456789012',
      skipConfirmation: opts.skipConfirmation ?? true,
      ...(opts.crossPrefixCheck === true && {
        crossPrefixCheck: { cache: new CrossPrefixScanCache(stateBackend) },
      }),
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack — another state prefix records the stack (go-to-k/cdkd#4705)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses before any lock or delete', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd', 'team-b'], holders: { 'team-b': true } });
    await expect(runDestroyForStack('App', emptyState(), h.ctx)).rejects.toThrow(
      /Refusing to destroy stack App \(us-east-1\): it is also recorded under another state prefix .*\(team-b\)/
    );
    expect(h.acquireLock).not.toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
    // Its own prefix is never probed as "another".
    const probed = h.recordUnderPrefix.mock.calls.map((c) => c[0]);
    expect(probed).toContain('team-b');
    expect(probed).not.toContain('cdkd');
  });

  it('proceeds when no other prefix records the stack', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd', 'team-b'] });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.deleteState).toHaveBeenCalledWith('App', REGION);
  });

  it('refuses a NON-empty record before the prompt and the lock (no --yes)', async () => {
    const h = makeCtx({
      crossPrefixCheck: true,
      skipConfirmation: false,
      prefixes: ['cdkd', 'team-b'],
      holders: { 'team-b': true },
    });
    const state = {
      ...emptyState(),
      resources: {
        Q: {
          physicalId: 'q',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    } as StackState;
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(runDestroyForStack('App', state, h.ctx)).rejects.toThrow(
        /Refusing to destroy stack App \(us-east-1\)/
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
    expect(createInterface).not.toHaveBeenCalled();
    expect(h.acquireLock).not.toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
  });

  it('warns and proceeds when S3 denies the LISTING', async () => {
    const h = makeCtx({
      crossPrefixCheck: true,
      prefixes: Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'S3 refused to list bucket'
    );
  });

  it('never scans without crossPrefixCheck (a nested child, a deploy-time removal)', async () => {
    const h = makeCtx({ prefixes: ['team-b'], holders: { 'team-b': true } });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.listTopLevelPrefixes).not.toHaveBeenCalled();
  });
});

describe('runDestroyForStack -- what a destroy keeps, and the registry marker (go-to-k/cdkd#4705)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const retainedState = (): StackState => ({
    ...emptyState(),
    resources: {
      Bucket: {
        physicalId: 'app-bucket-x',
        resourceType: 'AWS::S3::Bucket',
        properties: {},
        deletionPolicy: 'Retain',
        provisionedBy: 'sdk',
      },
      Logs: {
        physicalId: '/cdkd/App-Logs',
        resourceType: 'AWS::Logs::LogGroup',
        properties: { RetentionInDays: 7 },
        deletionPolicy: 'Retain',
        provisionedBy: 'sdk',
      },
      Named: {
        physicalId: 'mine',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: 'mine' },
        deletionPolicy: 'Retain',
        provisionedBy: 'sdk',
      },
      Role: {
        physicalId: 'App-Role',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        deletionPolicy: 'Retain',
        provisionedBy: 'sdk',
      },
    } as unknown as StackState['resources'],
  });

  it('records the kept resources a later create takes back by their GENERATED name, before the record goes', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    await runDestroyForStack('App', retainedState(), h.ctx);
    expect(h.saveRetainedResources).toHaveBeenCalledTimes(1);
    const [, , entries] = h.saveRetainedResources.mock.calls[0]! as unknown as [string, string, unknown[]];
    // The S3 bucket and log group with generated names; not the explicitly
    // named bucket (its create probes by name already), nor a Role (whose
    // create fails natively with EntityAlreadyExists).
    expect(entries).toEqual([
      { logicalId: 'Bucket', resourceType: 'AWS::S3::Bucket', physicalId: 'app-bucket-x' },
      { logicalId: 'Logs', resourceType: 'AWS::Logs::LogGroup', physicalId: '/cdkd/App-Logs' },
    ]);
    expect(h.saveRetainedResources.mock.invocationCallOrder[0]!).toBeLessThan(
      h.deleteState.mock.invocationCallOrder[0]!
    );
  });

  it('F-1: a record written whose S3 time could not be confirmed warns that it was RECORDED, not that it failed', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    h.saveRetainedResources.mockRejectedValueOnce(new RetainedTimeUnconfirmedError(new Error('HEAD 503')));
    await runDestroyForStack('App', retainedState(), h.ctx);
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/Recorded the 2 kept resource\(s\) of App .*their time could not be confirmed from S3/);
    expect(text).not.toMatch(/Could not record the/);
  });

  it('merges with what an earlier destroy kept, replacing the same logical id', async () => {
    const h = makeCtx({
      crossPrefixCheck: true,
      prefixes: ['cdkd'],
      retained: [
        { logicalId: 'Old', resourceType: 'AWS::SQS::Queue', physicalId: 'https://q/App-Old' },
        { logicalId: 'Bucket', resourceType: 'AWS::S3::Bucket', physicalId: 'stale' },
      ],
    });
    await runDestroyForStack('App', retainedState(), h.ctx);
    const [, , entries] = h.saveRetainedResources.mock.calls[0]! as unknown as [string, string, Array<{ logicalId: string; physicalId: string }>];
    expect(entries.map((e) => `${e.logicalId}=${e.physicalId}`)).toEqual([
      'Old=https://q/App-Old',
      'Bucket=app-bucket-x',
      'Logs=/cdkd/App-Logs',
    ]);
  });

  it('releases the registry marker AFTER the record is deleted, for a top-level stack', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    await runDestroyForStack('App', retainedState(), h.ctx);
    expect(h.releaseRegistryMarker).toHaveBeenCalledWith('App', REGION, undefined);
    expect(h.releaseRegistryMarker.mock.invocationCallOrder[0]!).toBeGreaterThan(
      h.deleteState.mock.invocationCallOrder[0]!
    );
  });

  it('G5: the empty-state path releases the marker too, after its record is deleted', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.deleteState).toHaveBeenCalledTimes(1);
    // D-1: kept nothing and no record yet: the empty tombstone is written.
    expect(h.ensureRetainedTombstone).toHaveBeenCalledWith('App', REGION);
    expect(h.releaseRegistryMarker).toHaveBeenCalledWith('App', REGION, undefined);
    expect(h.releaseRegistryMarker.mock.invocationCallOrder[0]!).toBeGreaterThan(
      h.deleteState.mock.invocationCallOrder[0]!
    );
  });

  it('E-6: the main path (resources, none Retain) writes the empty tombstone when no record exists yet', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    const deleted: StackState = {
      ...emptyState(),
      resources: {
        Queue: { physicalId: 'https://q/App-Queue', resourceType: 'AWS::SQS::Queue', properties: {}, provisionedBy: 'sdk' },
      } as unknown as StackState['resources'],
    };
    const provider = { delete: vi.fn(async () => undefined) };
    (h.ctx as unknown as { providerRegistry: unknown }).providerRegistry = {
      getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
      getProvider: vi.fn(() => provider),
    };
    const result = await runDestroyForStack('App', deleted, h.ctx);
    expect(result.errorCount).toBe(0);
    expect(h.deleteState).toHaveBeenCalledTimes(1);
    expect(h.ensureRetainedTombstone).toHaveBeenCalledWith('App', REGION);
  });

  it('E-7: a destroy whose tombstone write fails warns (never silent)', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    h.ensureRetainedTombstone.mockRejectedValueOnce(new Error('AccessDenied'));
    await runDestroyForStack('App', emptyState(), h.ctx);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Could not write the empty kept-resource record of App/));
  });

  it('P3: the destroy tail is the tombstone PUT and the marker DELETE, started together, with the marker read earlier', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    const known = { prefix: 'cdkd', etag: '"e7"' };
    (h.ctx.crossPrefixCheck as unknown as { cache: { knownMarker: unknown } }).cache.knownMarker = vi.fn(
      async () => known
    );
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.ensureRetainedTombstone.mockImplementation(async () => {
      started++;
      await gate;
    });
    h.releaseRegistryMarker.mockImplementation(async () => {
      started++;
      await gate;
      return 'released' as const;
    });
    const run = runDestroyForStack('App', emptyState(), h.ctx);
    // Both in flight before either finished: one round trip, not two.
    for (let i = 0; i < 50 && started < 2; i++) await new Promise((r) => setImmediate(r));
    expect(started).toBe(2);
    release();
    await run;
    expect(h.releaseRegistryMarker).toHaveBeenCalledWith('App', REGION, known);
    expect(h.ensureRetainedTombstone).toHaveBeenCalledTimes(1);
  });

  it('G5: a destroy that keeps the record (a delete failed) keeps the marker', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd'] });
    const failing: StackState = {
      ...emptyState(),
      resources: {
        Queue: {
          physicalId: 'https://q/App-Queue',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          provisionedBy: 'sdk',
        },
      } as unknown as StackState['resources'],
    };
    const result = await runDestroyForStack('App', failing, h.ctx);
    // The delete failed (no provider answers), so the record is preserved.
    expect(result.errorCount).toBeGreaterThan(0);
    expect(h.acquireLock).toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
    expect(h.releaseRegistryMarker).not.toHaveBeenCalled();
  });

  it('a nested child (no crossPrefixCheck) never touches the registry marker', async () => {
    const h = makeCtx({});
    await runDestroyForStack('App~Child', retainedState(), h.ctx);
    expect(h.releaseRegistryMarker).not.toHaveBeenCalled();
  });
});
