import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionUpdate } from '../../../src/deployment/deploy-engine/update.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const logged = vi.hoisted(() => ({
  setLevel: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { ...logged, child: () => fns };
  return { getLogger: () => fns };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

/**
 * go-to-k/cdkd#2676, the `update.ts` slice: a logical id the UPDATE arm
 * interpolates into a log line or a thrown message is flattened to one line,
 * so a newline in it cannot start a line cdkd never wrote.
 */
describe('provisionUpdate — interpolated ids are flattened (#2676)', () => {
  const EVIL = 'Evil\nForged line';
  const TYPE = 'AWS::SQS::Queue';
  const PROPS = { QueueName: 'q' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the missing-record throw renders the id on one line', async () => {
    const change: ResourceChange = {
      logicalId: EVIL,
      changeType: 'UPDATE',
      resourceType: TYPE,
      desiredProperties: PROPS,
    };
    const err = await provisionUpdate
      .call({} as never, EVIL, change, {}, 'S')
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toBe('Cannot update Evil Forged line: resource not found in state');
  });

  it('the no-change skip line renders the id on one line', async () => {
    const provider: ResourceProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
    };
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      getAllowedUnsupportedProperties: vi.fn(() => new Set<string>()),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const engine = new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as never,
      registry as never,
      {},
      'us-east-1'
    );
    const change: ResourceChange = {
      logicalId: EVIL,
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: PROPS,
      desiredProperties: PROPS,
      propertyChanges: [],
    };
    const stateResources = {
      [EVIL]: {
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
        resourceType: TYPE,
        properties: PROPS,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { [EVIL]: { Type: TYPE, Properties: PROPS } },
    };
    await (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<void>;
      }
    ).provisionResource(EVIL, change, stateResources, 'S', template);

    expect(provider.update).not.toHaveBeenCalled();
    const skips = logged.debug.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Skipping '));
    expect(skips).toEqual([
      'Skipping Evil Forged line: no actual changes after intrinsic function resolution',
    ]);
  });
});
