import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * Verifies the per-resource-type override added in v2 of issue #91.
 *
 * `withResourceDeadline` is the chokepoint that receives the resolved
 * `warnAfterMs` / `timeoutMs` for each provider call. We replace it with
 * a stub that records the resolution arguments, then drive the engine
 * with two CREATE changes of different resource types and assert the
 * stub saw the expected (per-type vs global vs default) values.
 *
 * Resolution order under test:
 *   1. per-type override (`resourceTimeoutByType[resourceType]`)
 *   2. caller-supplied global (`resourceTimeoutMs`)
 *   3. compile-time default (`DEFAULT_RESOURCE_TIMEOUT_MS`)
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

// Capture (warnAfterMs, timeoutMs) per call by replacing withResourceDeadline.
const captured: Array<{ warnAfterMs: number; timeoutMs: number }> = [];
vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi
    .fn()
    .mockImplementation(
      async (operation: () => Promise<unknown>, opts: { warnAfterMs: number; timeoutMs: number }) => {
        captured.push({ warnAfterMs: opts.warnAfterMs, timeoutMs: opts.timeoutMs });
        return operation();
      }
    ),
}));

describe('DeployEngine — per-resource-type timeout resolution (#91 v2)', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  function makeChange(logicalId: string, type: string): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: type,
      newProperties: {},
      propertyChanges: [],
    };
  }

  function buildEngine(options: {
    resourceWarnAfterMs?: number;
    resourceTimeoutMs?: number;
    resourceWarnAfterByType?: Record<string, number>;
    resourceTimeoutByType?: Record<string, number>;
  }) {
    const provider = {
      create: vi
        .fn()
        .mockResolvedValue({ physicalId: 'phys', attributes: {} }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };

    const currentState: StackState = {
      version: 1,
      stackName: 'timeout-test',
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
      getExecutionLevels: vi.fn().mockReturnValue([['Bucket', 'Distro']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };

    const changes = new Map<string, ResourceChange>([
      ['Bucket', makeChange('Bucket', 'AWS::S3::Bucket')],
      ['Distro', makeChange('Distro', 'AWS::CloudFront::Distribution')],
    ]);

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
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Distro: { Type: 'AWS::CloudFront::Distribution', Properties: {} },
      },
    };

    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { concurrency: 2, ...options },
      'us-east-1'
    );

    return { engine, template };
  }

  it('uses the per-type override for matching resourceType, global for the rest', async () => {
    const { engine, template } = buildEngine({
      resourceWarnAfterMs: 5 * 60_000,
      resourceTimeoutMs: 30 * 60_000,
      resourceTimeoutByType: { 'AWS::CloudFront::Distribution': 60 * 60_000 },
    });

    await engine.deploy('timeout-test', template);

    // The two CREATEs may complete in any order — index by their captured
    // pairs by timeout value to keep the assertion order-independent.
    const byTimeout = new Map(captured.map((c) => [c.timeoutMs, c]));
    expect(byTimeout.has(60 * 60_000)).toBe(true); // CloudFront override
    expect(byTimeout.has(30 * 60_000)).toBe(true); // global default
    // Both inherit the global warn-after (no per-type warn override given).
    for (const c of captured) {
      expect(c.warnAfterMs).toBe(5 * 60_000);
    }
  });

  it('falls back to the compile-time default when neither global nor per-type is set', async () => {
    const { engine, template } = buildEngine({});

    await engine.deploy('timeout-test', template);

    // DEFAULT_RESOURCE_TIMEOUT_MS = 30m, DEFAULT_RESOURCE_WARN_AFTER_MS = 5m.
    expect(captured.length).toBe(2);
    for (const c of captured) {
      expect(c.timeoutMs).toBe(30 * 60_000);
      expect(c.warnAfterMs).toBe(5 * 60_000);
    }
  });

  it('per-type warn-after overrides global warn-after for matching type only', async () => {
    const { engine, template } = buildEngine({
      resourceWarnAfterMs: 5 * 60_000,
      resourceTimeoutMs: 30 * 60_000,
      resourceWarnAfterByType: { 'AWS::CloudFront::Distribution': 10 * 60_000 },
    });

    await engine.deploy('timeout-test', template);

    const byWarn = new Map(captured.map((c) => [c.warnAfterMs, c]));
    expect(byWarn.has(10 * 60_000)).toBe(true); // CloudFront override
    expect(byWarn.has(5 * 60_000)).toBe(true); // S3 inherits global
    for (const c of captured) {
      expect(c.timeoutMs).toBe(30 * 60_000);
    }
  });
});
