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

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * go-to-k/cdkd#5137: a legacy stack's Lambda permission id is the bare logical
 * id, and AWS scopes a statement id to its function. A replacement moving the
 * permission to another function therefore creates a NEW statement under the
 * old id. The engine must keep it and delete the old statement through the old
 * record (its own FunctionName), not refuse it as an adopted existing resource.
 * The CONTROL (same function) keeps the refusal.
 */
describe('DeployEngine — an equal Lambda permission id on another function (go-to-k/cdkd#5137)', () => {
  const TYPE = 'AWS::Lambda::Permission';
  const ID = 'ApiPermission';
  const base = { Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com' };
  const OLD = { ...base, FunctionName: 'old-fn' };
  const NEW = { ...base, FunctionName: 'changed-name' };
  const SAME_FN_OLD = { ...base, FunctionName: 'fn', SourceAccount: '111111111111' };
  const SAME_FN_NEW = { ...base, FunctionName: 'fn', SourceAccount: '222222222222' };

  let provider: ResourceProvider;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: ID, attributes: { Id: ID } };
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
      logicalId: 'Perm',
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
      Perm: {
        physicalId: ID,
        resourceType: TYPE,
        properties: oldProps,
        attributes: { Id: ID },
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { Perm: { Type: TYPE, Properties: newProps } },
    };
    await provisionResource(makeEngine(), 'Perm', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  it('keeps the new statement and deletes the old one from the OLD function', async () => {
    const state = await invokeProvision(OLD, NEW, 'FunctionName');

    expect(callOrder).toEqual(['create', 'delete']);
    expect(provider.delete).toHaveBeenCalledWith('Perm', ID, TYPE, OLD, expect.anything());
    expect(state['Perm']!.physicalId).toBe(ID);
    expect(state['Perm']!.properties).toEqual(NEW);
  });

  it('CONTROL: the same function keeps the name-idempotent refusal', async () => {
    const err = await invokeProvision(SAME_FN_OLD, SAME_FN_NEW, 'SourceAccount').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; cause?: { code?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
  });
});
