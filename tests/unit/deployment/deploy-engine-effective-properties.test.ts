import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

// Logger silenced — keep test output clean.
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
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// p-limit no-op so concurrency does not gate this test.
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Issue #1591: the engine records the DESIRED properties into state, which is
 * right almost always — but wrong for a provider that deliberately NARROWS
 * what it sends. `EC2Provider.createRoute`'s multi-destination warn arm is the
 * live case: it picks one destination key and drops the rest, so the recorded
 * bag described something AWS never held, `readCurrentState` could only return
 * the one key AWS did hold, and the difference was PERMANENT phantom drift —
 * re-reported by every `cdkd drift` and re-triggered by `drift --revert`.
 *
 * A provider now says what it actually delivered via `effectiveProperties`, and
 * the engine records THAT instead. This file pins the engine half at all three
 * state-write sites; the EC2 half is pinned in
 * `tests/unit/provisioning/ec2-route-effective-properties.test.ts`.
 *
 * The load-bearing assertion in every case is that `effectiveProperties`
 * REPLACES the desired bag rather than merging with it — a merge would put the
 * dropped keys straight back and restore the drift.
 */
describe('DeployEngine - effectiveProperties overrides what is recorded in state (#1591)', () => {
  const stackName = 'effective-properties-stack';
  const RESOURCE_TYPE = 'AWS::EC2::Route';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  // The shape the EC2 Route warn arm produces: every declared destination key
  // desired, exactly one of them actually sent.
  const DESIRED = {
    RouteTableId: 'rtb-1',
    DestinationCidrBlock: '10.0.0.0/16',
    DestinationIpv6CidrBlock: '::/0',
    GatewayId: 'igw-1',
  };
  const NARROWED = {
    RouteTableId: 'rtb-1',
    DestinationCidrBlock: '10.0.0.0/16',
    GatewayId: 'igw-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['MyRoute']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-new') };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  const template: CloudFormationTemplate = {
    Resources: { MyRoute: { Type: RESOURCE_TYPE, Properties: DESIRED } },
  };

  function changeMap(changeType: 'CREATE' | 'UPDATE'): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'MyRoute',
        {
          logicalId: 'MyRoute',
          changeType,
          resourceType: RESOURCE_TYPE,
          desiredProperties: DESIRED,
        },
      ],
    ]);
  }

  function priorState(): StackState {
    return {
      version: 3,
      region: 'us-east-1',
      stackName,
      resources: {
        MyRoute: {
          physicalId: 'rtb-1|10.0.0.0/16',
          resourceType: RESOURCE_TYPE,
          properties: { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16' },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
  }

  function savedRecord() {
    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    return savedState.resources['MyRoute']!;
  }

  describe('CREATE path', () => {
    it('records the narrowed bag when the provider returns effectiveProperties', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({
        physicalId: 'rtb-1|10.0.0.0/16',
        attributes: {},
        effectiveProperties: NARROWED,
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual(NARROWED);
      // The whole point: the dropped key is GONE from state, so it can never
      // be compared against an AWS read that cannot return it.
      expect(savedRecord().properties).not.toHaveProperty('DestinationIpv6CidrBlock');
    });

    it('records the DESIRED bag when the provider returns none', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({ physicalId: 'rtb-1|10.0.0.0/16', attributes: {} });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual(DESIRED);
    });
  });

  describe('UPDATE path — the one the phantom drift actually reached users on', () => {
    it('records the narrowed bag when the provider returns effectiveProperties', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.update.mockResolvedValue({
        physicalId: 'rtb-1|10.0.0.0/16',
        wasReplaced: true,
        attributes: {},
        effectiveProperties: NARROWED,
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual(NARROWED);
      expect(savedRecord().properties).not.toHaveProperty('DestinationIpv6CidrBlock');
    });

    it('records the DESIRED bag when the provider returns none', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.update.mockResolvedValue({
        physicalId: 'rtb-1|10.0.0.0/16',
        wasReplaced: false,
        attributes: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual(DESIRED);
    });
  });

  describe('the OTHER two engine write sites — both were uncovered', () => {
    // The test review found that reverting either of these to `resolvedProps`
    // left the ENTIRE unit suite green, including the one the PR's own comment
    // calls load-bearing. A wired site with no test is indistinguishable from
    // an unwired one.
    it('property-driven REPLACEMENT inside UPDATE records the narrowed bag', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.create.mockResolvedValue({
        // A DISTINCT id: a create returning the CURRENT physical id trips the
        // name-idempotent replacement guard (#1207) before any state write.
        physicalId: 'rtb-1|10.0.0.0/24',
        attributes: {},
        effectiveProperties: NARROWED,
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'MyRoute',
            {
              logicalId: 'MyRoute',
              changeType: 'UPDATE',
              resourceType: RESOURCE_TYPE,
              desiredProperties: DESIRED,
              // A create-only destination key changed -> replacement, which is
              // exactly what this PR's own narrowing provokes on the next
              // deploy of a still-invalid template.
              propertyChanges: [
                {
                  propertyPath: 'DestinationIpv6CidrBlock',
                  changeType: 'ADD',
                  requiresReplacement: true,
                },
              ],
            } as unknown as ResourceChange,
          ],
        ])
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.create).toHaveBeenCalled();
      expect(savedRecord().properties).toEqual(NARROWED);
    });

    it('the update-failure REPLACEMENT FALLBACK records the narrowed bag', async () => {
      // `provider.update` failing with the Cloud Control "does not support
      // UPDATE" signal makes the engine fall back to delete+create, rebuilding
      // the update result in a fresh literal — which drops
      // `effectiveProperties` unless it is carried explicitly.
      //
      // The CC signal rather than the typed `ResourceUpdateNotSupportedError`:
      // the typed one is gated on the user passing `--replace`, so using it
      // here would couple this test to that policy instead of to the literal
      // under test.
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.update.mockRejectedValue(
        new Error('UnsupportedActionException: resource does not support UPDATE')
      );
      mockProvider.create.mockResolvedValue({
        physicalId: 'rtb-1|10.0.0.0/24',
        attributes: {},
        effectiveProperties: NARROWED,
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.create).toHaveBeenCalled();
      expect(savedRecord().properties).toEqual(NARROWED);
      expect(savedRecord().properties).not.toHaveProperty('DestinationIpv6CidrBlock');
    });
  });

  describe('the field REPLACES rather than merges', () => {
    it('a key present in the desired bag but absent from effectiveProperties is dropped', async () => {
      // A merge implementation would silently pass every assertion above (the
      // narrowed bag is a subset of the desired one), so the discriminating
      // case is a key that only the DESIRED side carries. Under a merge it
      // survives; under a replace it is gone — and only "gone" kills the drift.
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({
        physicalId: 'rtb-1|10.0.0.0/16',
        attributes: {},
        effectiveProperties: { RouteTableId: 'rtb-1' },
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual({ RouteTableId: 'rtb-1' });
    });

    it('an EMPTY effectiveProperties is honored, not treated as absent', async () => {
      // `{}` is falsy-adjacent in the shapes this codebase spreads with
      // `...(x && {x})`, so a truthiness-gated implementation would fall back
      // to the desired bag here. `??` is the correct gate: only an ABSENT
      // field means "record the desired properties".
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({
        physicalId: 'rtb-1|10.0.0.0/16',
        attributes: {},
        effectiveProperties: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual({});
    });
  });
});
