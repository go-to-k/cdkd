import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { DetachInternetGatewayCommand } from '@aws-sdk/client-ec2';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * go-to-k/cdkd#6592: `withDependencyViolationRetry` gives an internet
 * gateway detach / delete a 10-minute budget, then rethrows. The outer retry
 * layers (the destroy runner's 3-attempt loop, `withRetry`) used to call the
 * provider again, each call starting a FRESH 10-minute budget, so a destroy
 * took the whole 30-minute per-resource timeout to report the failure. The
 * exhausted error is now marked non-retryable, so no outer layer re-runs it.
 */

const mockSend = vi.fn();

vi.mock('../../../src/utils/logger.js', () => {
  const log = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { getLogger: () => ({ ...log, child: () => log }) };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

const REGION = 'us-east-1';
const MAPPED =
  'Network vpc-1 has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.';

/**
 * AWS-shaped: the `$fault` / `$metadata` make the provider's wrap name the
 * error by its class (`DependencyViolation`), which is what the outer
 * classifiers match. Without them the wrap keeps AWS's wording, which carries
 * no retryable needle, and the regression these tests pin cannot show.
 */
function dependencyViolation(): Error {
  return Object.assign(new Error(MAPPED), {
    name: 'DependencyViolation',
    Code: 'DependencyViolation',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
}

type Helper = {
  withDependencyViolationRetry: <T>(
    op: () => Promise<T>,
    opts: { description: string; totalBudgetMs?: number }
  ) => Promise<T>;
};

/** A provider whose helper sleep advances a fake clock instead of waiting. */
function providerOnFakeClock(): EC2Provider {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const provider = new EC2Provider();
  (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
    now += ms;
  };
  return provider;
}

function detachCalls(): number {
  return mockSend.mock.calls.filter((c) => c[0] instanceof DetachInternetGatewayCommand).length;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockSend.mockReset();
});

describe('withDependencyViolationRetry exhaustion (go-to-k/cdkd#6592)', () => {
  it('marks the error it rethrows once the budget is exhausted, keeping the cause chain', async () => {
    mockSend.mockImplementation(() => Promise.reject(dependencyViolation()));
    const provider = providerOnFakeClock();

    const error = await provider
      .delete('Attach', 'igw-1|vpc-1', 'AWS::EC2::VPCGatewayAttachment', {})
      .then(
        () => undefined,
        (e: unknown) => e as Error & { cause?: unknown }
      );

    expect(error).toBeDefined();
    // One full 10-minute run: the budget ran out inside the helper.
    expect(detachCalls()).toBeGreaterThan(10);
    // The provider's wrap keeps AWS's error as its cause, and the mark is
    // read over that chain.
    expect((error!.cause as Error).name).toBe('DependencyViolation');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(false);
  });

  it('leaves an error it rethrows at once (not a DependencyViolation) unmarked', async () => {
    const provider = providerOnFakeClock();
    const throttle = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });

    const error = await (provider as unknown as Helper)
      .withDependencyViolationRetry(() => Promise.reject(throttle), { description: 'test' })
      .catch((e: unknown) => e);

    expect(error).toBe(throttle);
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('withRetry does not re-run an exhausted detach', async () => {
    mockSend.mockImplementation(() => Promise.reject(dependencyViolation()));
    const provider = providerOnFakeClock();
    const outerSleep = vi.fn(async () => {});

    await expect(
      withRetry(
        () => provider.delete('Attach', 'igw-1|vpc-1', 'AWS::EC2::VPCGatewayAttachment', {}),
        'Attach',
        { sleep: outerSleep }
      )
    ).rejects.toThrow();

    expect(outerSleep).not.toHaveBeenCalled();
  });
});

describe('destroy runner after an exhausted detach (go-to-k/cdkd#6592)', () => {
  function makeState(): StackState {
    const resource: ResourceState = {
      physicalId: 'igw-1|vpc-1',
      resourceType: 'AWS::EC2::VPCGatewayAttachment',
      properties: {},
      attributes: {},
      dependencies: [],
    };
    return {
      version: 8,
      stackName: 'TestStack',
      region: REGION,
      resources: { Attach: resource },
      outputs: {},
      lastModified: 1,
    };
  }

  it('calls provider.delete once, not once per outer attempt', async () => {
    mockSend.mockImplementation(() => Promise.reject(dependencyViolation()));
    vi.useFakeTimers();
    const provider = new EC2Provider();
    // The helper's sleep moves the faked clock without firing any timer, so
    // each provider.delete is one full 10-minute run that gives up.
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    };
    const providerDelete = vi.fn((logicalId: string, physicalId: string, type: string) =>
      provider.delete(logicalId, physicalId, type, {})
    );
    const ctx = {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn(async () => ({ state: makeState(), etag: 'e' })),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: providerDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };

    const pending = runDestroyForStack('TestStack', makeState(), ctx);
    // Lets the pre-fix loop's 5s / 10s / 20s backoffs elapse, so a
    // regression shows as a call count rather than a hang.
    for (const delay of [5_000, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    const result = await pending;

    expect(providerDelete).toHaveBeenCalledTimes(1);
    expect(result.errorCount).toBe(1);
  });
});
