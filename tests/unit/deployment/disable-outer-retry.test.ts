import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * Verifies that providers exposing `disableOuterRetry: true` (notably the
 * Custom Resource provider) are NOT retried by the deploy engine's outer
 * `withRetry` loop.
 *
 * Why this matters: the outer retry re-invokes `provider.create()` from
 * the top, which for CR generates a fresh pre-signed S3 URL and a fresh
 * RequestId. The first attempt's Lambda response then lands at an S3 key
 * nobody polls — hanging the deploy until the polling timeout. PR #94
 * fixed the in-call invariant; this test pins the matching engine-side
 * behaviour so the bug can't regress.
 *
 * Strategy: mock the `withRetry` helper at the module boundary so we can
 * observe whether the engine routes the create call through it (the
 * normal path) or bypasses it (the disableOuterRetry path).
 */

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: {
    isSupportedResourceType: vi.fn(() => true),
  },
}));

// Bypass the wall-clock deadline wrapper.
vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi
    .fn()
    .mockImplementation(async (operation: () => Promise<unknown>) => operation()),
}));

const withRetryMock = vi.fn();
vi.mock('../../../src/deployment/retry.js', () => ({
  withRetry: vi
    .fn()
    .mockImplementation(async (operation: () => Promise<unknown>, _logicalId: string) => {
      withRetryMock();
      return operation();
    }),
}));

describe('DeployEngine — provider.disableOuterRetry bypasses withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withRetryMock.mockClear();
  });

  function buildEngine(opts: { disableOuterRetry: boolean | undefined }) {
    const provider = {
      ...(opts.disableOuterRetry !== undefined && {
        disableOuterRetry: opts.disableOuterRetry,
      }),
      create: vi
        .fn()
        .mockResolvedValue({ physicalId: 'phys-1', attributes: {} }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };

    const currentState: StackState = {
      version: 1,
      stackName: 'retry-test',
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };

    const mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'etag-0' }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
    };

    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['CR']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };

    const change: ResourceChange = {
      logicalId: 'CR',
      changeType: 'CREATE',
      resourceType: 'AWS::CloudFormation::CustomResource',
      newProperties: {},
      propertyChanges: [],
    };
    const changes = new Map<string, ResourceChange>([['CR', change]]);

    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((c: Map<string, ResourceChange>, type: string) =>
          [...c.values()].filter((ch) => ch.changeType === type)
        ),
    };

    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
    };

    const template: CloudFormationTemplate = {
      Resources: {
        CR: { Type: 'AWS::CloudFormation::CustomResource', Properties: {} },
      },
    };

    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 1 },
      'us-east-1'
    );

    return { engine, template, provider };
  }

  it('does NOT route through withRetry when provider.disableOuterRetry=true (CR-style)', async () => {
    const { engine, template, provider } = buildEngine({ disableOuterRetry: true });

    await engine.deploy('retry-test', template);

    // The provider's create still runs (single-shot), but withRetry is
    // bypassed entirely so a transient error wouldn't generate a fresh
    // pre-signed URL on retry.
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(withRetryMock).not.toHaveBeenCalled();
  });

  it('routes through withRetry when disableOuterRetry is unset (default behaviour)', async () => {
    const { engine, template, provider } = buildEngine({ disableOuterRetry: undefined });

    await engine.deploy('retry-test', template);

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(withRetryMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT route through withRetry when provider.disableOuterRetry=false explicitly', async () => {
    // Sanity: only `true` triggers the bypass; explicit false is just default.
    const { engine, template, provider } = buildEngine({ disableOuterRetry: false });

    await engine.deploy('retry-test', template);

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(withRetryMock).toHaveBeenCalledTimes(1);
  });
});
