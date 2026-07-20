import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Capture logger.error lines so the test can assert on the per-resource
// failure message a cancelled sibling reports.
const errorLines: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const sink = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((msg: string) => {
      errorLines.push(String(msg));
    }),
  };
  return {
    getLogger: () => ({
      ...sink,
      child: () => sink,
    }),
  };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
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

/**
 * When one resource fails, the engine sets `interrupted` so in-flight
 * siblings abort promptly. Before the fix, the sibling's abort error was
 * unconditionally "Deployment interrupted by user (Ctrl+C)" — misattributing
 * a failure-triggered cancellation to a Ctrl+C nobody pressed. The sibling
 * must now report the cause accurately.
 */
describe('DeployEngine - interrupt cause attribution', () => {
  const stackName = 'interrupt-cause-test';

  beforeEach(() => {
    vi.clearAllMocks();
    errorLines.length = 0;
  });

  function makeChange(logicalId: string): ResourceChange {
    return {
      logicalId,
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      newProperties: {},
      propertyChanges: [],
    } as unknown as ResourceChange;
  }

  it('reports "aborted after another resource failed" (not Ctrl+C) on a cancelled sibling', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        FailFast: { Type: 'AWS::S3::Bucket', Properties: {} },
        SlowSibling: { Type: 'AWS::S3::Bucket', Properties: {} },
      },
    };
    const changes = new Map<string, ResourceChange>([
      ['FailFast', makeChange('FailFast')],
      ['SlowSibling', makeChange('SlowSibling')],
    ]);

    const mockProvider = {
      create: vi.fn().mockImplementation((logicalId: string) => {
        if (logicalId === 'FailFast') {
          // Fail AFTER SlowSibling's first retryable rejection has put it
          // into the withRetry backoff sleep (which polls isInterrupted
          // every second).
          return new Promise((_, reject) =>
            setTimeout(() => reject(new Error('boom: non-retryable create failure')), 200)
          );
        }
        // Retryable rejection (matches the 'cannot be assumed' pattern) so
        // the sibling lands in the interruptible backoff sleep.
        return Promise.reject(
          new Error('The role defined for the resource cannot be assumed yet')
        );
      }),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const currentState: StackState = {
      version: 1,
      stackName,
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };

    const engine = new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'etag-0' }),
        saveState: vi.fn().mockResolvedValue('etag-1'),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['FailFast', 'SlowSibling']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(changes),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi
          .fn()
          .mockImplementation((c: Map<string, ResourceChange>, type: string) =>
            [...c.values()].filter((ch) => ch.changeType === type)
          ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        getCloudControlProvider: vi.fn(),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { concurrency: 4, noRollback: false },
      'us-east-1'
    );

    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    const siblingLine = errorLines.find((l) => l.includes('Failed to create SlowSibling'));
    expect(siblingLine).toBeDefined();
    expect(siblingLine).toContain('Deployment aborted after another resource failed');
    expect(siblingLine).not.toContain('Ctrl+C');
  }, 20_000);
});
