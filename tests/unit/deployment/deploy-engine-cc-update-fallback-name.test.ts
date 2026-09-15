import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Issue #3174 — the Cloud Control name fill belongs to CREATE only.
 *
 * `AWS::Lambda::CapacityProvider` has no SDK provider, so its create goes
 * through Cloud Control, which fails without `CapacityProviderName`; the engine
 * fills one from `FALLBACK_NAME_RULES`. An UPDATE is different: Cloud Control
 * builds a JSON Patch from the recorded bag, which holds the TEMPLATE's
 * resolved properties and so never carries the generated name. Filling it on
 * the desired side there makes the patch `add` the name — accepted only while
 * the live name happens to equal the generated one, a refused create-only
 * change for a provider running under any other name.
 *
 * The invariant has two halves, and both are pinned: every CREATE the engine
 * issues through Cloud Control still fills the name (the ordinary create, the
 * property-driven replacement's create, and the UPDATE-not-supported
 * fallback's create), while the in-place UPDATE does not.
 *
 * Asserted on the ARGUMENTS the provider receives: the provider is a mock, so
 * no patch exists to observe, and the arguments are what the fix changes.
 */
describe('DeployEngine - Cloud Control fallback name is filled on CREATE, not on UPDATE (#3174)', () => {
  const stackName = 'lmi-stack';
  const RESOURCE_TYPE = 'AWS::Lambda::CapacityProvider';
  const PHYSICAL_ID = 'imported-provider-name';

  const BASE = {
    PermissionsConfig: { CapacityProviderOperatorRoleArn: 'arn:aws:iam::111122223333:role/op' },
    VpcConfig: { SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] },
  };
  const DESIRED = { ...BASE, Tags: [{ Key: 'phase', Value: 'update' }] };

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: PHYSICAL_ID, attributes: {} }),
      update: vi.fn().mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['Provider']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        hasProvider: vi.fn().mockReturnValue(true),
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'cc-api' }),
        // No SDK provider for the type, so the engine takes the
        // `applyDefaultNameForFallback` arm — the real one, unmocked.
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set()),
      } as never,
      { dryRun: false, ...options } as never,
      'us-east-1'
    );
  }

  function templateWith(properties: Record<string, unknown>): CloudFormationTemplate {
    return { Resources: { Provider: { Type: RESOURCE_TYPE, Properties: properties } } };
  }

  function change(
    changeType: 'CREATE' | 'UPDATE',
    desired: Record<string, unknown>,
    current?: Record<string, unknown>,
    propertyChanges?: unknown[]
  ): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'Provider',
        {
          logicalId: 'Provider',
          changeType,
          resourceType: RESOURCE_TYPE,
          desiredProperties: desired,
          ...(current !== undefined && { currentProperties: current }),
          ...(propertyChanges !== undefined && { propertyChanges }),
        } as unknown as ResourceChange,
      ],
    ]);
  }

  function priorState(recorded: Record<string, unknown>): StackState {
    return {
      version: 10,
      region: 'us-east-1',
      stackName,
      resources: {
        Provider: {
          physicalId: PHYSICAL_ID,
          resourceType: RESOURCE_TYPE,
          properties: recorded,
          attributes: {},
          provisionedBy: 'cc-api',
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
  }

  function createdBag(): Record<string, unknown> {
    return mockProvider.create.mock.calls.at(-1)![2] as Record<string, unknown>;
  }

  it('CREATE: the provider receives a generated CapacityProviderName', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockDiffCalculator.calculateDiff.mockResolvedValue(change('CREATE', BASE));

    await makeEngine().deploy(stackName, templateWith(BASE));

    expect(typeof createdBag()['CapacityProviderName']).toBe('string');
    expect(createdBag()['CapacityProviderName']).toMatch(/Provider$/);
  });

  it('UPDATE: neither side the provider receives carries a generated CapacityProviderName', async () => {
    // A record whose bag names nothing, under a physical id that is not the
    // generated name: the shape of a provider imported under another name.
    mockStateBackend.getState.mockResolvedValue({ state: priorState(BASE), etag: 'etag-old' });
    mockDiffCalculator.calculateDiff.mockResolvedValue(change('UPDATE', DESIRED, BASE));

    await makeEngine().deploy(stackName, templateWith(DESIRED));

    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    const [, physicalId, , desired, previous] = mockProvider.update.mock.calls.at(-1)! as [
      string,
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(physicalId).toBe(PHYSICAL_ID);
    expect(desired).not.toHaveProperty('CapacityProviderName');
    expect(previous).not.toHaveProperty('CapacityProviderName');
    // The real change still reaches the provider.
    expect(desired['Tags']).toEqual(DESIRED.Tags);
  });

  it('UPDATE: a template-supplied name is still sent', async () => {
    const named = { ...DESIRED, CapacityProviderName: PHYSICAL_ID };
    const recorded = { ...BASE, CapacityProviderName: PHYSICAL_ID };
    mockStateBackend.getState.mockResolvedValue({ state: priorState(recorded), etag: 'etag-old' });
    mockDiffCalculator.calculateDiff.mockResolvedValue(change('UPDATE', named, recorded));

    await makeEngine().deploy(stackName, templateWith(named));

    const desired = mockProvider.update.mock.calls.at(-1)![3] as Record<string, unknown>;
    expect(desired['CapacityProviderName']).toBe(PHYSICAL_ID);
  });

  it('property-driven REPLACEMENT: the replacement create still receives a generated name', async () => {
    const recorded = { ...BASE, VpcConfig: { SubnetIds: ['subnet-old'], SecurityGroupIds: ['sg-1'] } };
    mockStateBackend.getState.mockResolvedValue({ state: priorState(recorded), etag: 'etag-old' });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      change('UPDATE', BASE, recorded, [
        {
          path: 'VpcConfig',
          oldValue: recorded.VpcConfig,
          newValue: BASE.VpcConfig,
          requiresReplacement: true,
        },
      ])
    );
    mockProvider.create.mockResolvedValue({ physicalId: 'replacement-provider', attributes: {} });

    await makeEngine().deploy(stackName, templateWith(BASE));

    // Premise: this took the replacement path, not an in-place update.
    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    expect(createdBag()['CapacityProviderName']).toMatch(/Provider$/);
  });

  it('UPDATE-not-supported REPLACEMENT: the fallback create still receives a generated name', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: priorState(BASE), etag: 'etag-old' });
    mockDiffCalculator.calculateDiff.mockResolvedValue(change('UPDATE', DESIRED, BASE));
    mockProvider.update.mockRejectedValue(
      new ResourceUpdateNotSupportedError(RESOURCE_TYPE, 'Provider')
    );
    mockProvider.create.mockResolvedValue({ physicalId: 'replacement-provider', attributes: {} });

    // `--replace` is what routes a typed update refusal into the fallback.
    await makeEngine({ replace: true }).deploy(stackName, templateWith(DESIRED));

    // Premise: the in-place update was attempted (without the name) and refused.
    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    expect(mockProvider.update.mock.calls.at(-1)![3]).not.toHaveProperty('CapacityProviderName');
    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    expect(createdBag()['CapacityProviderName']).toMatch(/Provider$/);
  });
});
