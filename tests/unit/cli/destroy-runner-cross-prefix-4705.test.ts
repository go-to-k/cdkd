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
import { resetCrossPrefixNoticesForTest } from '../../../src/state/cross-prefix-stack-scan.js';

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
}) {
  const acquireLock = vi.fn().mockResolvedValue(true);
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const listTopLevelPrefixes = vi.fn(async () => {
    if (opts.prefixes instanceof Error) throw opts.prefixes;
    return opts.prefixes ?? [];
  });
  const recordUnderPrefix = vi.fn(async (p: string) => (opts.holders?.[p] ? 'holder' : 'absent'));
  const ownRecordExists = vi.fn(async () => true);
  const stateBackend = {
    prefix: 'cdkd',
    getState: vi.fn().mockResolvedValue(null),
    deleteState,
    saveState: vi.fn(),
    listStacks: vi.fn().mockResolvedValue([]),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    listTopLevelPrefixes,
    recordUnderPrefix,
    ownRecordExists,
  };
  return {
    acquireLock,
    deleteState,
    listTopLevelPrefixes,
    recordUnderPrefix,
    ownRecordExists,
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
      ...(opts.crossPrefixCheck === true && { crossPrefixCheck: { target: stateBackend } }),
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack — another state prefix records the stack (go-to-k/cdkd#4705)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCrossPrefixNoticesForTest();
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
    // The record it destroys is not re-checked.
    expect(h.ownRecordExists).not.toHaveBeenCalled();
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

  it('does not warn when S3 denies the LISTING: one info line, then proceeds', async () => {
    const h = makeCtx({
      crossPrefixCheck: true,
      prefixes: Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'Could not check whether stack App'
    );
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'This identity may not list bucket'
    );
  });

  it('never scans without crossPrefixCheck (a nested child, a deploy-time removal)', async () => {
    const h = makeCtx({ prefixes: ['team-b'], holders: { 'team-b': true } });
    const result = await runDestroyForStack('App', emptyState(), h.ctx);
    expect(result.skippedEmpty).toBe(true);
    expect(h.listTopLevelPrefixes).not.toHaveBeenCalled();
  });
});
