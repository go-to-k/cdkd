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
 * fallback's create), while the in-place UPDATE does not. The other arm of
 * `preparePropertiesForCcApi`, an SDK provider's `preparePropertiesForFallback`
 * hook, is pinned on the ordinary CREATE and the in-place UPDATE only, since the
 * engine takes the name back out of whatever that arm produced; the two
 * replacement creates are exercised through the `applyDefaultNameForFallback`
 * arm alone. A hook on a provider whose type is not registered is not consulted.
 *
 * Asserted on the ARGUMENTS the provider receives: the provider is a mock, so
 * no patch exists to observe, and the arguments are what the fix changes.
 */
describe('DeployEngine - Cloud Control fallback name is filled on CREATE, not on UPDATE (#3174)', () => {
  const stackName = 'lmi-stack';
  const RESOURCE_TYPE = 'AWS::Lambda::CapacityProvider';
  const PHYSICAL_ID = 'imported-provider-name';
  // `DeployEngine.deploy` runs under `withStackName(stackName)`, so the name the
  // fill generates is exactly `<stack>-<logicalId>`.
  const GENERATED_NAME = 'lmi-stack-Provider';

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

  function makeEngine(
    options: Record<string, unknown> = {},
    registryOverrides: Record<string, unknown> = {}
  ) {
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
        // No SDK provider for the type by default, so the engine takes the
        // `applyDefaultNameForFallback` arm — the real one, unmocked.
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set()),
        ...registryOverrides,
      } as never,
      { dryRun: false, ...options } as never,
      'us-east-1'
    );
  }

  function templateWith(
    properties: Record<string, unknown>,
    type: string = RESOURCE_TYPE
  ): CloudFormationTemplate {
    return { Resources: { Provider: { Type: type, Properties: properties } } };
  }

  function change(
    changeType: 'CREATE' | 'UPDATE',
    desired: Record<string, unknown>,
    current?: Record<string, unknown>,
    propertyChanges?: unknown[],
    type: string = RESOURCE_TYPE
  ): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'Provider',
        {
          logicalId: 'Provider',
          changeType,
          resourceType: type,
          desiredProperties: desired,
          ...(current !== undefined && { currentProperties: current }),
          ...(propertyChanges !== undefined && { propertyChanges }),
        } as unknown as ResourceChange,
      ],
    ]);
  }

  function priorState(recorded: Record<string, unknown>, type: string = RESOURCE_TYPE): StackState {
    return {
      version: 10,
      region: 'us-east-1',
      stackName,
      resources: {
        Provider: {
          physicalId: PHYSICAL_ID,
          resourceType: type,
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

  it('CREATE: the provider receives the generated CapacityProviderName', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
    mockDiffCalculator.calculateDiff.mockResolvedValue(change('CREATE', BASE));

    await makeEngine().deploy(stackName, templateWith(BASE));

    expect(createdBag()['CapacityProviderName']).toBe(GENERATED_NAME);
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
    // A premise, not a pin: the recorded bag never holds a generated name and
    // the fix does not touch the previous side, so this cannot fail on its own.
    // It is kept because the absence on BOTH sides is what keeps the patch free
    // of a name operation.
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

  it('property-driven REPLACEMENT: the replacement create still receives the generated name', async () => {
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
    expect(createdBag()['CapacityProviderName']).toBe(GENERATED_NAME);
  });

  it('UPDATE-not-supported REPLACEMENT: the fallback create still receives the generated name', async () => {
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
    expect(createdBag()['CapacityProviderName']).toBe(GENERATED_NAME);
  });

  /**
   * The other arm of `preparePropertiesForCcApi`: a type WITH a registered SDK
   * provider that implements `preparePropertiesForFallback`. No shipped provider
   * implements the hook today, which is exactly why the arm needs its own case:
   * the helper's unit cases in `resource-name.test.ts` cannot see which bag the
   * engine hands the wrapper. `AWS::S3::Bucket` is a `FALLBACK_NAME_RULES` type
   * (`BucketName`), so a name the hook generates is one the update must drop.
   */
  describe('through an SDK provider preparePropertiesForFallback hook', () => {
    const S3_TYPE = 'AWS::S3::Bucket';
    const HOOK_NAME = 'hook-generated-bucket';
    const BUCKET_BASE = { VersioningConfiguration: { Status: 'Enabled' } };
    const BUCKET_DESIRED = { ...BUCKET_BASE, Tags: [{ Key: 'phase', Value: 'update' }] };

    function hookRegistry() {
      const hook = vi.fn(
        (_logicalId: string, _type: string, props: Record<string, unknown>) => ({
          ...props,
          BucketName: HOOK_NAME,
        })
      );
      const sdkProvider = { ...mockProvider, preparePropertiesForFallback: hook };
      return {
        hook,
        overrides: {
          getRegisteredTypes: vi.fn().mockReturnValue([S3_TYPE]),
          getProvider: vi.fn().mockReturnValue(sdkProvider),
          // Cloud Control still runs the operation (the provider mock stands in
          // for it); the hook is consulted only to prepare the bag.
          getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'cc-api' }),
        },
      };
    }

    it('CREATE: the Cloud Control create receives the name the hook generated', async () => {
      const { hook, overrides } = hookRegistry();
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        change('CREATE', BUCKET_BASE, undefined, undefined, S3_TYPE)
      );

      await makeEngine({}, overrides).deploy(stackName, templateWith(BUCKET_BASE, S3_TYPE));

      // Premise: the hook arm ran, not `applyDefaultNameForFallback`.
      expect(hook).toHaveBeenCalled();
      expect(createdBag()['BucketName']).toBe(HOOK_NAME);
    });

    it('UPDATE: the name the hook generated is taken back out of the update bag', async () => {
      const { hook, overrides } = hookRegistry();
      mockStateBackend.getState.mockResolvedValue({
        state: priorState(BUCKET_BASE, S3_TYPE),
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        change('UPDATE', BUCKET_DESIRED, BUCKET_BASE, undefined, S3_TYPE)
      );

      await makeEngine({}, overrides).deploy(stackName, templateWith(BUCKET_DESIRED, S3_TYPE));

      // Premise: the hook arm ran and produced the name, so its absence below
      // is the engine's doing rather than a bag that never held it.
      expect(hook).toHaveBeenCalled();
      expect(hook.mock.results.at(-1)!.value).toHaveProperty('BucketName', HOOK_NAME);
      expect(mockProvider.update).toHaveBeenCalledTimes(1);
      const desired = mockProvider.update.mock.calls.at(-1)![3] as Record<string, unknown>;
      expect(desired).not.toHaveProperty('BucketName');
      expect(desired['Tags']).toEqual(BUCKET_DESIRED.Tags);
    });

    it('CREATE: a hook on a provider whose type is not registered is not consulted', async () => {
      const { hook, overrides } = hookRegistry();
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockDiffCalculator.calculateDiff.mockResolvedValue(change('CREATE', BASE));

      // `getProvider` would hand back the hook-carrying provider, but the
      // CapacityProvider type is not among the registered types.
      await makeEngine(
        {},
        { ...overrides, getRegisteredTypes: vi.fn().mockReturnValue([S3_TYPE]) }
      ).deploy(stackName, templateWith(BASE));

      expect(hook).not.toHaveBeenCalled();
      expect(createdBag()['CapacityProviderName']).toBe(GENERATED_NAME);
      expect(createdBag()).not.toHaveProperty('BucketName');
    });
  });
});
