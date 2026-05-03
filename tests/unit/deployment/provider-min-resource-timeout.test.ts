import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * Verifies the provider self-reported minimum resource timeout
 * (`getMinResourceTimeoutMs?()`).
 *
 * Resolution order at the per-resource call site:
 *   1. per-type CLI override (`resourceTimeoutByType[type]`) — always wins
 *   2. `max(provider.getMinResourceTimeoutMs?(), globalCli)` — provider
 *      lifts the deadline when it knows the global default would abort
 *      a healthy long-running operation (Custom Resource polls up to 1h
 *      while the global default is 30m).
 *   3. CLI global default (`resourceTimeoutMs`).
 *   4. compile-time default (`DEFAULT_RESOURCE_TIMEOUT_MS`).
 *
 * The mock captures the (warnAfterMs, timeoutMs) pair that the engine
 * passed to `withResourceDeadline` for each provisioning call.
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

const captured: Array<{ warnAfterMs: number; timeoutMs: number }> = [];
vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi
    .fn()
    .mockImplementation(
      async (
        operation: () => Promise<unknown>,
        opts: { warnAfterMs: number; timeoutMs: number }
      ) => {
        // The engine resolves the (warn, timeout) pair before invoking
        // withResourceDeadline; capture them in invocation order.
        captured.push({ warnAfterMs: opts.warnAfterMs, timeoutMs: opts.timeoutMs });
        return operation();
      }
    ),
}));

describe('DeployEngine — provider.getMinResourceTimeoutMs() lifts the deadline', () => {
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

  function buildEngine(opts: {
    crGetMinResourceTimeoutMs?: number;
    resourceWarnAfterMs?: number;
    resourceTimeoutMs?: number;
    resourceTimeoutByType?: Record<string, number>;
  }) {
    // CR provider with a self-reported min-timeout (mocked by injecting
    // a `getMinResourceTimeoutMs` method onto the provider double).
    const crProvider = {
      ...(opts.crGetMinResourceTimeoutMs !== undefined && {
        getMinResourceTimeoutMs: () => opts.crGetMinResourceTimeoutMs!,
      }),
      create: vi.fn().mockResolvedValue({ physicalId: 'cr-phys', attributes: {} }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };

    // S3 provider with NO self-report — should follow the global default.
    const s3Provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 's3-phys', attributes: {} }),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };

    const currentState: StackState = {
      version: 1,
      stackName: 'self-report-test',
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
      getExecutionLevels: vi.fn().mockReturnValue([['Bucket', 'CR']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };

    const changes = new Map<string, ResourceChange>([
      ['Bucket', makeChange('Bucket', 'AWS::S3::Bucket')],
      ['CR', makeChange('CR', 'AWS::CloudFormation::CustomResource')],
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
      getProvider: vi.fn().mockImplementation((type: string) => {
        if (type === 'AWS::CloudFormation::CustomResource') return crProvider;
        return s3Provider;
      }),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
    };

    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        CR: { Type: 'AWS::CloudFormation::CustomResource', Properties: {} },
      },
    };

    const engineOpts: Record<string, unknown> = { concurrency: 2 };
    if (opts.resourceWarnAfterMs !== undefined) engineOpts.resourceWarnAfterMs = opts.resourceWarnAfterMs;
    if (opts.resourceTimeoutMs !== undefined) engineOpts.resourceTimeoutMs = opts.resourceTimeoutMs;
    if (opts.resourceTimeoutByType !== undefined)
      engineOpts.resourceTimeoutByType = opts.resourceTimeoutByType;

    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      engineOpts,
      'us-east-1'
    );

    return { engine, template };
  }

  it("uses provider's self-reported timeout when larger than the global", async () => {
    // CR self-reports 60m; CLI global is 30m → effective = max(60m, 30m) = 60m.
    const { engine, template } = buildEngine({
      crGetMinResourceTimeoutMs: 60 * 60_000,
      resourceWarnAfterMs: 5 * 60_000,
      resourceTimeoutMs: 30 * 60_000,
    });

    await engine.deploy('self-report-test', template);

    const byTimeout = new Set(captured.map((c) => c.timeoutMs));
    expect(byTimeout.has(60 * 60_000)).toBe(true); // CR uses self-report
    expect(byTimeout.has(30 * 60_000)).toBe(true); // S3 uses global default
  });

  it("ignores provider's self-report when it is smaller than the global", async () => {
    // CR self-reports 10m; CLI global is 30m → effective = max(10m, 30m) = 30m.
    const { engine, template } = buildEngine({
      crGetMinResourceTimeoutMs: 10 * 60_000,
      resourceWarnAfterMs: 5 * 60_000,
      resourceTimeoutMs: 30 * 60_000,
    });

    await engine.deploy('self-report-test', template);

    expect(captured.length).toBe(2);
    for (const c of captured) {
      expect(c.timeoutMs).toBe(30 * 60_000);
    }
  });

  it('per-type CLI override beats both provider self-report AND global default', async () => {
    // CR self-reports 60m, but the user explicitly says "for CR, use 5m"
    // (the documented escape hatch). Per-type override wins.
    const { engine, template } = buildEngine({
      crGetMinResourceTimeoutMs: 60 * 60_000,
      resourceWarnAfterMs: 1 * 60_000,
      resourceTimeoutMs: 30 * 60_000,
      resourceTimeoutByType: { 'AWS::CloudFormation::CustomResource': 5 * 60_000 },
    });

    await engine.deploy('self-report-test', template);

    const byTimeout = new Set(captured.map((c) => c.timeoutMs));
    expect(byTimeout.has(5 * 60_000)).toBe(true); // CR per-type override (explicit escape)
    expect(byTimeout.has(30 * 60_000)).toBe(true); // S3 still uses global
  });

  it('falls back to globalCli when provider does not implement getMinResourceTimeoutMs', async () => {
    // No self-report at all → behaviour is identical to pre-PR.
    const { engine, template } = buildEngine({
      resourceWarnAfterMs: 5 * 60_000,
      resourceTimeoutMs: 30 * 60_000,
    });

    await engine.deploy('self-report-test', template);

    expect(captured.length).toBe(2);
    for (const c of captured) {
      expect(c.timeoutMs).toBe(30 * 60_000);
    }
  });
});
