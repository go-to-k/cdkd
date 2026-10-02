import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issue #4318: the destroy loop gives up at its attempt cap with no hook of its
 * own, so the `--remove-protection` compensation learns which attempt is the
 * last from the loop's `runDeleteAttempt` scope. These cases pin that the loop
 * SETS it, per attempt: a provider reading `isTerminalDeleteFailure` on a
 * persistent retryable failure must see "terminal" on the last attempt only.
 */

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// Keep the import graph light: the runner only touches these on the
// cross-region path, which these tests never exercise.
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { isTerminalDeleteFailure } from '../../../src/provisioning/providers/deletion-protection-compensation.js';

const REGION = 'us-east-1';

function makeState(): StackState {
  const resource: ResourceState = {
    physicalId: '/aws/lambda/lg-1',
    resourceType: 'AWS::Logs::LogGroup',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { LogGroup: resource },
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(provider: Record<string, unknown>) {
  return {
    stateBackend: {
      saveState: vi.fn().mockResolvedValue('"etag"'),
      deleteState: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    } as unknown as S3StateBackend,
    lockManager: {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
    } as unknown as LockManager,
    providerRegistry: {
      getProviderFor: () => ({ provider }),
    } as unknown as ProviderRegistry,
    baseAwsClients: {} as AwsClients,
    baseRegion: REGION,
    stateBucket: 'test-bucket',
    skipConfirmation: true,
    removeProtection: true,
  };
}

/** A provider whose every delete fails retryably, recording what each attempt saw. */
function denyingProvider(extra: Record<string, unknown> = {}) {
  const seen: boolean[] = [];
  const del = vi.fn(async () => {
    // An await first, as a real provider has: the scope must survive it.
    await Promise.resolve();
    const error = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    seen.push(isTerminalDeleteFailure(error));
    throw error;
  });
  return { provider: { delete: del, ...extra }, seen, del };
}

describe('runDestroyForStack scopes each delete attempt (issue #4318)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a persistent retryable failure reads terminal on the LAST of the 4 attempts only', async () => {
    const { provider, seen, del } = denyingProvider();
    vi.useFakeTimers();

    const pending = runDestroyForStack('TestStack', makeState(), makeCtx(provider));
    for (const delay of [5_000, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    const result = await pending;

    expect(del).toHaveBeenCalledTimes(4);
    expect(seen).toEqual([false, false, false, true]);
    expect(result.errorCount).toBe(1);
  });

  it('a provider that opts out of the outer retry runs ONE attempt, and it is the last', async () => {
    const { provider, seen, del } = denyingProvider({ disableOuterRetry: true });

    const result = await runDestroyForStack('TestStack', makeState(), makeCtx(provider));

    expect(del).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true]);
    expect(result.errorCount).toBe(1);
  });
});
