/**
 * Issue [#1874](https://github.com/go-to-k/cdkd/issues/1874) review:
 * `--strict-getatt` re-wraps an Output-resolution failure in a fresh `Error`,
 * which DROPS the non-retryable marker unless the cause is threaded.
 *
 * The marker is a non-enumerable symbol on the ORIGINAL error, and the wrapper
 * inlines the refusal's full text — which for a resolver refusal includes
 * template-controlled identifiers. So a logical id like
 * `MyDependencyViolationHandler` puts `DependencyViolation` (the substring
 * table's only whitespace-free entry) into the wrapper's message, and the
 * classifier reads it as transient.
 *
 * That is reachable, which is why it matters: the throw leaves
 * `executeDeployment`, leaves the child `deploy()`, passes through
 * `NestedStackProvider.create`, and lands in the PARENT's `withRetry` — so a
 * nested stack would re-run a whole child deploy plus rollback per retry on a
 * path that can never succeed. `isMarkedNonRetryable` walks the `.cause`
 * chain, so threading the cause preserves the marker across the wrap.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// A resolver stand-in that rejects the sentinel Output with a MARKED refusal
// whose message carries a retryable substring via the logical id — the shape
// `resolveSplit` produces for `{"Fn::Split": [",", {"Fn::GetAtt":
// ["MyDependencyViolationHandler", "NameServers"]}]}`.
//
// The message is DERIVED FROM THE REAL PRODUCER, not hand-copied: a literal
// copy of `resolveSplit`'s wording has nothing binding it to the source, so it
// drifts silently on the next reword and the test keeps passing against a
// message that no longer exists (the same class the retryable-table test avoids
// by importing the real table). `realSplitRefusalMessage()` runs the actual
// resolver over the actual shape; the assertions below then key on a KERNEL of
// it rather than the full sentence.
const REFUSAL_LOGICAL_ID = 'MyDependencyViolationHandler';

async function realSplitRefusalMessage(): Promise<string> {
  const { IntrinsicFunctionResolver: RealResolver } = await vi.importActual<
    typeof import('../../../src/deployment/intrinsic-function-resolver.js')
  >('../../../src/deployment/intrinsic-function-resolver.js');
  const resolver = new RealResolver();
  try {
    await resolver.resolve(
      { 'Fn::Split': [',', { 'Fn::GetAtt': [REFUSAL_LOGICAL_ID, 'NameServers'] }] },
      {
        resources: {
          [REFUSAL_LOGICAL_ID]: {
            physicalId: 'Z123456789',
            resourceType: 'AWS::Route53::HostedZone',
            properties: {},
            attributes: { NameServers: ['ns-1', 'ns-2', 'ns-3', 'ns-4'] },
            dependencies: [],
          },
        },
        template: {} as CloudFormationTemplate,
      }
    );
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the real resolveSplit to refuse the list-valued Fn::GetAtt');
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation(async (value: unknown) => {
      if (value === '__refusal__') {
        throw markNonRetryable(
          new IntrinsicResolutionRefusalError(await realSplitRefusalMessage())
        );
      }
      return value;
    }),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

describe('--strict-getatt output re-wrap preserves the non-retryable marker (#1874 review)', () => {
  const stackName = 'strict-getatt-refusal-stack';

  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockDagBuilder: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  const makeState = (): StackState => ({
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: 'us-east-1',
    stackName,
    resources: {
      ParamA: {
        physicalId: 'phys-param-a',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        observedProperties: { Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  });

  const template: CloudFormationTemplate = {
    Resources: { ParamA: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: { Refused: { Value: '__refusal__' } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'ParamA',
            { logicalId: 'ParamA', changeType: 'NO_CHANGE', resourceType: 'AWS::SSM::Parameter' },
          ],
        ])
      ),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn(),
      getProviderFor: vi.fn(),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn().mockResolvedValue({ state: makeState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  const deployAndCatch = async (): Promise<Error> => {
    const engine = new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, strictGetAtt: true },
      'us-east-1'
    );
    try {
      await engine.deploy(stackName, template);
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the strict-getatt output failure to reject');
  };

  it('re-wraps the refusal but keeps it non-retryable via the cause chain', async () => {
    const error = await deployAndCatch();

    // It really is the WRAPPER, not the original refusal passed through...
    expect(error.message).toContain('Failed to resolve output Refused');
    expect(error.message).toContain('--strict-getatt');
    expect(error).not.toBeInstanceOf(IntrinsicResolutionRefusalError);
    // ...and the wrapper inlined the refusal text, so the marker is the only
    // thing standing between it and the retry loop.
    expect(error.message).toContain('is ALREADY a list');

    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(
      IntrinsicResolutionRefusalError
    );
  });

  it('is classified non-retryable even though its message carries a retryable pattern', async () => {
    const error = await deployAndCatch();

    // The wrapper inlined the template-controlled logical id, so the message
    // DOES contain a retryable substring — the marker has to win.
    expect(error.message).toContain('DependencyViolation');
    expect(isRetryableTransientError(error, error.message)).toBe(false);
  });
});
