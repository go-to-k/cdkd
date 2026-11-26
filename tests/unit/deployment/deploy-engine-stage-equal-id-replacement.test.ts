import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
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

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * go-to-k/cdkd#7072: a stage's id is its bare stage name, scoped by an API the
 * id does not carry. A stage moved to a replaced API (measured: `$default` on a
 * new HTTP API) is a NEW stage under the old id: the engine keeps it and
 * deletes the old stage through the old record (its own API id), as
 * CloudFormation does, instead of refusing it as a name-idempotent create.
 */
describe.each([
  ['AWS::ApiGatewayV2::Stage', 'ApiId', '$default'],
  ['AWS::ApiGateway::Stage', 'RestApiId', 'prod'],
])('DeployEngine — an equal %s id on another API (go-to-k/cdkd#7072)', (TYPE, KEY, ID) => {
  const OLD = { StageName: ID, [KEY]: 'apiold0001' };
  const NEW = { StageName: ID, [KEY]: 'apinew0002' };

  let provider: ResourceProvider;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: ID, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      {},
      'us-east-1'
    );
  }

  async function invokeProvision(
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    changedPath: string
  ): Promise<Record<string, StateRecord>> {
    const change: ResourceChange = {
      logicalId: 'Rule',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: oldProps,
      desiredProperties: newProps,
      propertyChanges: [
        {
          path: changedPath,
          oldValue: oldProps[changedPath],
          newValue: newProps[changedPath],
          requiresReplacement: true,
        },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      Rule: {
        physicalId: ID,
        resourceType: TYPE,
        properties: oldProps,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { Rule: { Type: TYPE, Properties: newProps } },
    };
    await provisionResource(makeEngine(), 'Rule', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  it('keeps the new stage and deletes the old one from the OLD API', async () => {
    const state = await invokeProvision(OLD, NEW, KEY);

    expect(callOrder).toEqual(['create', 'delete']);
    expect(provider.delete).toHaveBeenCalledWith('Rule', ID, TYPE, OLD, expect.anything());
    expect(state['Rule']!.properties).toEqual(NEW);
  });

  it('CONTROL: the same API keeps the name-idempotent refusal', async () => {
    const err = await invokeProvision({ ...OLD, Description: 'a' }, { ...OLD, Description: 'b' }, 'Description').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; cause?: { code?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
  });
});
