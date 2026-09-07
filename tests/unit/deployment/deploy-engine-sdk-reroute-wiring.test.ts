import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The info line the flip emits is the only `cdkd deploy` signal that a live
 * resource moved between provisioning layers, so its WORDING is behaviour: an
 * earlier revision told a `'cc-broken'` user to pass `--pin-cc-api`, which that
 * mode deliberately ignores. Captured here rather than left to review.
 */
const infoLines: string[] = [];
const stubLogger = {
  debug: vi.fn(),
  info: vi.fn((m: string) => {
    infoLines.push(m);
  }),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => stubLogger,
};
/**
 * The progress LABEL, captured so the VERB can be asserted. The verb and the
 * routing tag are built from one `needsReplacement`; three review rounds fixed
 * the tag while the verb kept the property half alone, so a `--recreate-via-*`
 * target rendered `Updating` over a destroy + recreate.
 */
const taskLabels: string[] = [];
vi.mock('../../../src/utils/live-renderer.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getLiveRenderer: () => ({
      addTask: (_id: string, label: string) => {
        taskLabels.push(label);
      },
      updateTaskLabel: vi.fn(),
      removeTask: vi.fn(),
      completeTask: vi.fn(),
      failTask: vi.fn(),
      startTask: vi.fn(),
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => stubLogger,
  Logger: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { ResourceProvider, CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState as StateRecord } from '../../../src/types/state.js';
import { STICKY_CC_MIGRATION_EXEMPT } from '../../../src/provisioning/provider-registry.js';

/**
 * What the ENGINE hands `getProviderFor` on the UPDATE path (issue
 * [#2719](https://github.com/go-to-k/cdkd/issues/2719)).
 *
 * The flip condition itself is pinned at the predicate level in
 * `tests/unit/provisioning/provider-registry-sdk-reroute.test.ts` — eight gates,
 * every one mutation-probed. None of that reaches the WIRING, and a review
 * measured the cost: deleting `previousProperties: currentResource.properties`
 * from the update dispatch left all 1,442 `provisionedBy`-touching unit tests
 * green, and the real-AWS fixture cannot see it either, because the one
 * admitted `'sdk-coverage'` type has an empty `silentDrop` map by construction
 * so both bags are always clean there.
 *
 * That line IS the removal-deploy safety property. Without it a resource whose
 * RECORDED bag still carries a Cloud-Control-applied property flips to the SDK
 * provider on the very deploy that removes it, and the removal is silently
 * skipped. So the fence has to be here, on the call, not on the predicate.
 *
 * These cases assert the ARGUMENTS rather than an outcome, deliberately: with a
 * mocked registry there is no routing to observe, and asserting the outcome
 * would only re-test the predicate. The discriminator is what the engine chose
 * to pass.
 */
const STACK = 'MyStack';
/** `NestedStackProvider.deriveChildStackName`'s shape — a child can never equal its parent. */
const CHILD_STACK = 'MyStack~Child';
const LOGICAL_ID = 'MyTopic';
const TYPE = 'AWS::SNS::Topic';

/** The recorded bag. Distinct from the desired one, or the assertion cannot tell them apart. */
const RECORDED_PROPS = { TopicName: 't', DisplayName: 'recorded-value' };
const DESIRED_PROPS = { TopicName: 't', DisplayName: 'desired-value' };

describe('the engine wires the sticky-CC re-route inputs (#2719)', () => {
  let provider: ResourceProvider;
  let getProviderFor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    infoLines.length = 0;
    taskLabels.length = 0;
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'pid', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'pid' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
    getProviderFor = vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const });
  });

  function makeEngine(
    pinCcApi?: { stackName: string; logicalIds: ReadonlySet<string> },
    recreateTargets?: {
      stackName: string;
      viaCcApi: ReadonlySet<string>;
      viaSdkProvider: ReadonlySet<string>;
    }
  ) {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') };
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
      getProviderFor,
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
      { ...(pinCcApi ? { pinCcApi } : {}), ...(recreateTargets ? { recreateTargets } : {}) },
      'us-east-1'
    );
  }

  function provisionOf(engine: InstanceType<typeof DeployEngine>) {
    return (
      engine as unknown as {
        provisionResource: (
          logicalId: string,
          change: ResourceChange,
          stateResources: Record<string, unknown>,
          stackName: string,
          template: CloudFormationTemplate
        ) => Promise<unknown>;
      }
    ).provisionResource.bind(engine);
  }

  function stateResources(resourceType: string = TYPE): Record<string, StateRecord> {
    return {
      [LOGICAL_ID]: {
        physicalId: 'arn:aws:sns:us-east-1:1:t',
        resourceType,
        properties: RECORDED_PROPS,
        attributes: {},
        dependencies: [],
        provisionedBy: 'cc-api',
      } as unknown as StateRecord,
    };
  }

  async function runUpdate(
    engine: InstanceType<typeof DeployEngine>,
    stackName: string,
    resourceType: string = TYPE
  ): Promise<void> {
    const change: ResourceChange = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType,
      currentProperties: RECORDED_PROPS,
      desiredProperties: DESIRED_PROPS,
      propertyChanges: [
        {
          path: 'DisplayName',
          oldValue: 'recorded-value',
          newValue: 'desired-value',
          requiresReplacement: false,
        },
      ],
    } as unknown as ResourceChange;
    await provisionOf(engine)(LOGICAL_ID, change, stateResources(resourceType), stackName, {
      Resources: { [LOGICAL_ID]: { Type: resourceType, Properties: DESIRED_PROPS } },
    });
  }

  /**
   * The UPDATE dispatch, which is the LAST routing call of the two this path
   * makes. The first is the progress LABEL (`deriveLabelRouting`), and since
   * #2719 it carries the same `previousProperties`, so a content-based
   * selector picks the wrong one — the first draft of this file did, and its
   * two negative cases read the label's explicit `forceCcApi: false` instead
   * of the dispatch's absent key. The ORDER is asserted below rather than
   * assumed, so a change in the sequence fails where the selector is defined.
   */
  function updateCall(): Record<string, unknown> {
    const calls = getProviderFor.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls.length, 'expected the label call then the update dispatch').toBe(2);
    return calls[1]!;
  }

  it('makes exactly two routing calls: the label, then the dispatch', async () => {
    // The premise every case below rests on. Asserted rather than assumed:
    // both calls now carry `previousProperties`, so nothing about their
    // CONTENT separates them and a content-based selector silently reads the
    // wrong one. `forceCcApi` is the tell — `deriveLabelRouting` takes it as a
    // defaulted parameter and so always sets the key, while the dispatch
    // spreads it only when the pin matches.
    await runUpdate(makeEngine(), STACK);
    const shapes = getProviderFor.mock.calls.map((c) =>
      Object.keys(c[0] as object)
        .sort()
        .join(',')
    );
    expect(shapes).toEqual([
      'forceCcApi,previousProperties,properties,provisionedBy,resourceType',
      'previousProperties,properties,provisionedBy,resourceType',
    ]);
  });

  it('passes the RECORDED property bag, not the differ\'s current side', async () => {
    await runUpdate(makeEngine(), STACK);
    // Identity, not deep equality: `change.currentProperties` holds an equal
    // object here, so `toEqual` would pass against the wrong source. The state
    // record's bag is the one that survives a template-side removal.
    expect(updateCall()['previousProperties']).toBe(RECORDED_PROPS);
  });

  it('passes the desired bag as `properties`', async () => {
    await runUpdate(makeEngine(), STACK);
    expect(updateCall()['properties']).toEqual(DESIRED_PROPS);
  });

  it('sets forceCcApi when --pin-cc-api names this resource IN THIS STACK', async () => {
    await runUpdate(makeEngine({ stackName: STACK, logicalIds: new Set([LOGICAL_ID]) }), STACK);
    expect(updateCall()['forceCcApi']).toBe(true);
  });

  it('does NOT set forceCcApi for a nested CHILD stack sharing the logical id', async () => {
    // The scope check is the whole reason `pinCcApi` carries a `stackName`:
    // `NestedStackProvider.runChildDeploy` spreads the parent's options into
    // every child engine, so an unscoped Set would pin a same-named resource in
    // a stack the user never named. Measured before this case existed: removing
    // the scope left every unit test green.
    await runUpdate(
      makeEngine({ stackName: STACK, logicalIds: new Set([LOGICAL_ID]) }),
      CHILD_STACK
    );
    expect(updateCall()['forceCcApi']).toBeUndefined();
  });

  it('the LABEL call sees the pin too, so the tag matches the dispatch', async () => {
    // The label and the dispatch resolve the pin through one private helper.
    // They did not always: with separate copies, neutering the LABEL's left
    // every test green, and the visible symptom would be the `[CC API]` tag
    // vanishing from a resource still going through Cloud Control.
    await runUpdate(makeEngine({ stackName: STACK, logicalIds: new Set([LOGICAL_ID]) }), STACK);
    const labelCall = getProviderFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(labelCall['forceCcApi']).toBe(true);
  });

  it('the LABEL call is unpinned for a child stack sharing the logical id', async () => {
    await runUpdate(
      makeEngine({ stackName: STACK, logicalIds: new Set([LOGICAL_ID]) }),
      CHILD_STACK
    );
    const labelCall = getProviderFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(labelCall['forceCcApi']).toBe(false);
  });

  it('announces an sdk-coverage flip with the coverage reason and the pin remedy', async () => {
    getProviderFor.mockReturnValue({ provider, provisionedBy: 'sdk' as const, sdkMigration: true });
    await runUpdate(makeEngine(), STACK);
    const line = infoLines.find((l) => l.includes('SDK provider'));
    expect(line, `no flip line in ${JSON.stringify(infoLines)}`).toBeDefined();
    expect(line).toContain('returning to the SDK provider');
    expect(line).toContain('covers every property');
    expect(line).toContain(`--pin-cc-api ${LOGICAL_ID}`);
  });

  it('announces a cc-broken flip WITHOUT offering a pin that mode ignores', async () => {
    // The wording is per mode because the flips happen for opposite reasons and
    // only one is declinable. Telling a `'cc-broken'` user to pass a flag that
    // `wouldReturnToSdkProvider` ignores is the same defect class as the silent
    // typo this lane closed — a remedy that does nothing.
    const ccBroken = (() => {
      for (const [t, e] of STICKY_CC_MIGRATION_EXEMPT) if (e.mode === 'cc-broken') return t;
      throw new Error('no cc-broken member');
    })();
    getProviderFor.mockReturnValue({ provider, provisionedBy: 'sdk' as const, sdkMigration: true });
    await runUpdate(makeEngine(), STACK, ccBroken);
    const line = infoLines.find((l) => l.includes('SDK provider'));
    expect(line, `no flip line in ${JSON.stringify(infoLines)}`).toBeDefined();
    expect(line).toContain('Cloud Control cannot manage this type');
    expect(line).not.toContain('--pin-cc-api');
    expect(line).not.toContain('covers every property');
  });

  it('the pin does NOT colour the label on a property-driven REPLACEMENT', async () => {
    // A replacement mints a NEW physical resource, so `replaceDecision` routes
    // it by the ordinary matrix — no `provisionedBy`, so the sticky rule the
    // pin suppresses never applies. The dispatch is right; a label that applied
    // the pin anyway printed `[CC API]` over a dispatch heading for the SDK
    // provider. Found by a fix-delta review after the pin wiring landed.
    const change: ResourceChange = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: { TopicName: 'old' },
      desiredProperties: { TopicName: 'new' },
      propertyChanges: [
        { path: 'TopicName', oldValue: 'old', newValue: 'new', requiresReplacement: true },
      ],
    } as unknown as ResourceChange;
    const engine = makeEngine({ stackName: STACK, logicalIds: new Set([LOGICAL_ID]) });
    await provisionOf(engine)(LOGICAL_ID, change, stateResources(), STACK, {
      Resources: { [LOGICAL_ID]: { Type: TYPE, Properties: { TopicName: 'new' } } },
    }).catch(() => undefined);
    // The label must MIRROR `replaceDecision`, which passes neither
    // `provisionedBy` nor `previousProperties`. Asserting only `forceCcApi`
    // was not enough: a first fix dropped the pin and left the sticky inputs
    // in, so rule 2 still returned `cc-api` for any non-exempt record and the
    // label kept printing `[CC API]` over an SDK dispatch. The mutant that
    // restored `existingState` survived that weaker assertion.
    const labelCall = getProviderFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(labelCall['forceCcApi']).toBe(false);
    expect(labelCall['provisionedBy']).toBeUndefined();
    expect(labelCall['previousProperties']).toBeUndefined();
  });

  it('the label mirrors the dispatch for a --recreate-via-sdk-provider target', async () => {
    // The third instance of one class, and the one no test could see: the
    // label asked `changeType === 'UPDATE' && some(requiresReplacement)` while
    // the dispatch asks `propertyDrivenReplacement || recreateFlagged`. For a
    // recreate target whose property change does NOT itself force a
    // replacement, the label took the non-replacement path and routed from the
    // state record — printing `[CC API]` for a `cc-api` record while the
    // dispatch created through the SDK provider.
    await runUpdate(
      makeEngine(undefined, {
        stackName: STACK,
        viaCcApi: new Set<string>(),
        viaSdkProvider: new Set([LOGICAL_ID]),
      }),
      STACK
    );
    const labelCall = getProviderFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(labelCall['provisionedBy']).toBe('sdk');
    expect(labelCall['previousProperties']).toBeUndefined();
    expect(labelCall['forceCcApi']).toBe(false);
  });

  it('the label mirrors the dispatch for a --recreate-via-cc-api target', async () => {
    await runUpdate(
      makeEngine(undefined, {
        stackName: STACK,
        viaCcApi: new Set([LOGICAL_ID]),
        viaSdkProvider: new Set<string>(),
      }),
      STACK
    );
    const labelCall = getProviderFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(labelCall['provisionedBy']).toBe('cc-api');
    expect(labelCall['previousProperties']).toBeUndefined();
    expect(labelCall['forceCcApi']).toBe(true);
  });

  it('a recreate target in a CHILD stack does not steer the parent label', async () => {
    // Same scope rule as the pin: `recreateTargets` travels with the stack it
    // was validated against, and the label must honour that or it re-creates
    // the very leak the scoping exists to close, in the display layer.
    await runUpdate(
      makeEngine(undefined, {
        stackName: STACK,
        viaCcApi: new Set([LOGICAL_ID]),
        viaSdkProvider: new Set<string>(),
      }),
      CHILD_STACK
    );
    const labelCall = getProviderFor.mock.calls[0]![0] as Record<string, unknown>;
    expect(labelCall['provisionedBy']).toBe('cc-api');
    expect(labelCall['previousProperties']).toBe(RECORDED_PROPS);
    expect(labelCall['forceCcApi']).toBe(false);
  });

  it('renders Replacing, not Updating, for a --recreate-via-* target', async () => {
    // The verb and the tag are built from ONE `needsReplacement`. This is the
    // site the class was short by after round four: the tag learned the flag
    // half, the verb did not, so this exact input rendered
    // `Updating X (T) [CC API]` over a destroy + recreate.
    await runUpdate(
      makeEngine(undefined, {
        stackName: STACK,
        viaCcApi: new Set([LOGICAL_ID]),
        viaSdkProvider: new Set<string>(),
      }),
      STACK
    );
    expect(taskLabels[0], `labels: ${JSON.stringify(taskLabels)}`).toContain('Replacing');
    expect(taskLabels[0]).not.toContain('Updating');
  });

  it('still renders Updating for an ordinary in-place update', async () => {
    // The other polarity: a fix that made everything `Replacing` would satisfy
    // the case above while lying about every normal deploy.
    await runUpdate(makeEngine(), STACK);
    expect(taskLabels[0], `labels: ${JSON.stringify(taskLabels)}`).toContain('Updating');
  });

  it('says nothing when the decision is not a flip', async () => {
    await runUpdate(makeEngine(), STACK);
    expect(infoLines.filter((l) => l.includes('SDK provider'))).toEqual([]);
  });

  it('does NOT set forceCcApi for an unpinned resource in the pinned stack', async () => {
    // The other polarity: a scope check that never matches would "pass" the
    // case above by breaking the flag outright.
    await runUpdate(makeEngine({ stackName: STACK, logicalIds: new Set(['SomethingElse']) }), STACK);
    expect(updateCall()['forceCcApi']).toBeUndefined();
  });
});
