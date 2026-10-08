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

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
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
  prefixes?: string[] | Error;
  holders?: Record<string, boolean>;
}) {
  const acquireLock = vi.fn().mockResolvedValue(true);
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const listTopLevelPrefixes = vi.fn(async () => {
    if (opts.prefixes instanceof Error) throw opts.prefixes;
    return opts.prefixes ?? [];
  });
  const recordExistsUnderPrefix = vi.fn(async (p: string) => opts.holders?.[p] ?? false);
  const ownRecordExists = vi.fn(async () => true);
  return {
    acquireLock,
    deleteState,
    listTopLevelPrefixes,
    recordExistsUnderPrefix,
    ownRecordExists,
    ctx: {
      stateBackend: {
        prefix: 'cdkd',
        getState: vi.fn().mockResolvedValue(null),
        deleteState,
        saveState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        listTopLevelPrefixes,
        recordExistsUnderPrefix,
        ownRecordExists,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock: vi.fn().mockResolvedValue(undefined),
        getLockInfo: vi.fn().mockResolvedValue(null),
      } as unknown as LockManager,
      providerRegistry: { getProviderFor: vi.fn() } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'cdkd-state-123456789012',
      skipConfirmation: true,
      ...(opts.crossPrefixCheck !== undefined && { crossPrefixCheck: opts.crossPrefixCheck }),
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack — another state prefix records the stack (go-to-k/cdkd#4705)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses before any lock or delete', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd', 'team-b'], holders: { 'team-b': true } });
    await expect(runDestroyForStack('App', emptyState(), h.ctx)).rejects.toThrow(
      /Refusing to destroy stack App \(us-east-1\): it is also recorded under another state prefix .*\(team-b\)/
    );
    expect(h.acquireLock).not.toHaveBeenCalled();
    expect(h.deleteState).not.toHaveBeenCalled();
    // Its own prefix is never probed as "another".
    expect(h.recordExistsUnderPrefix.mock.calls.map((c) => c[0])).toEqual(['team-b']);
    // The record it destroys is not re-checked.
    expect(h.ownRecordExists).not.toHaveBeenCalled();
  });

  it('proceeds when no other prefix records the stack', async () => {
    const h = makeCtx({ crossPrefixCheck: true, prefixes: ['cdkd', 'team-b'] });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.deleteState).toHaveBeenCalledWith('App', REGION);
  });

  it('warns and proceeds when S3 denies the listing', async () => {
    const h = makeCtx({
      crossPrefixCheck: true,
      prefixes: Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Could not check whether stack App'
    );
  });

  it('never scans without crossPrefixCheck (a nested child, a deploy-time removal)', async () => {
    const h = makeCtx({ prefixes: ['team-b'], holders: { 'team-b': true } });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.listTopLevelPrefixes).not.toHaveBeenCalled();
  });
});
