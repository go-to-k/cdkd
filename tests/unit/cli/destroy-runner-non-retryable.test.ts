import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issue #1778: the destroy delete-retry loop classifies with
 * `isRetryableTransientError(...) || msg.includes('Too Many Requests')`. The
 * shared classifier honors the non-retryable marker, but the second arm is a
 * raw message test that bypassed it — the same hole `retry.ts` had for custom
 * classifiers, reached through a different door.
 *
 * The `Too Many Requests` arm is load-bearing (the wrapped `ProvisioningError`
 * carries the phrasing after the original 429 `$metadata` is lost), so the
 * marker GATES both arms rather than replacing either. These tests pin both
 * halves of that: a marked refusal is terminal even when its message carries
 * the throttle phrase, and an UNMARKED throttle still retries exactly as
 * before.
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
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';

const REGION = 'us-east-1';
/** Carries the phrase the second, marker-blind arm matches on. */
const THROTTLE_MESSAGE = 'Failed to delete MyTable: Too Many Requests';

function makeState(): StackState {
  const resource: ResourceState = {
    physicalId: 'phys-id',
    resourceType: 'AWS::Glue::Table',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { Table: resource },
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack honors the non-retryable marker (issue #1778)', () => {
  // Deliberately PER TEST rather than a shared spy reset in `beforeEach`: a
  // regression in the first test leaves its retry loop running past the test
  // timeout, and a shared mock then carries those late calls into the second
  // test's count — which is how a probe of this file first reported the
  // INVERTED CONTROL failing for a reason that had nothing to do with it.
  function makeCtx(mockProviderDelete: ReturnType<typeof vi.fn>) {
    return {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attempts a MARKED throttle-worded refusal exactly ONCE', async () => {
    const mockProviderDelete = vi
      .fn()
      .mockRejectedValue(markNonRetryable(new Error(THROTTLE_MESSAGE)));

    const result = await runDestroyForStack('TestStack', makeState(), makeCtx(mockProviderDelete));

    // No retry, so no backoff sleep is ever scheduled — the test needs no
    // timer control at all, which is itself the observation being made.
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(result.errorCount).toBe(1);
  });

  it('INVERTED CONTROL — the same UNMARKED message still retries all 4 attempts', async () => {
    const mockProviderDelete = vi.fn().mockRejectedValue(new Error(THROTTLE_MESSAGE));
    vi.useFakeTimers();

    const pending = runDestroyForStack('TestStack', makeState(), makeCtx(mockProviderDelete));

    // The loop sleeps 5s -> 10s -> 20s between its 4 attempts. Advance exactly
    // those steps rather than running ALL timers, which would also fire the
    // per-resource deadline and abort the delete for the wrong reason.
    for (const delay of [5_000, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    const result = await pending;

    expect(mockProviderDelete).toHaveBeenCalledTimes(4);
    expect(result.errorCount).toBe(1);
  });
});
