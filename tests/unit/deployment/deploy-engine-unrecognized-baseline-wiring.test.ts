/**
 * Issue [#3713](https://github.com/go-to-k/cdkd/issues/3713): a top-level key
 * absent from the CFn schema snapshot routes the resource through Cloud
 * Control — UNLESS the state record already holds it with a deep-equal value.
 * That exception is what keeps an existing deployment on its route, and it
 * only works when every caller threads the record's bag as the baseline.
 *
 * The predicate is pinned in `provider-registry-unrecognized-properties.test.ts`;
 * none of that reaches the WIRING. Each case here fails when ONE engine call
 * site stops passing the record:
 *
 *   - the pre-flight `validateResourceProperties` rows;
 *   - the no-change skip's desired-side narrowing (an OUTCOME: the provider is
 *     not called, because `withoutAcceptedSilentDropProperties` runs for real);
 *   - `replaceDecision` (property-driven replacement), and the progress label
 *     that mirrors it;
 *   - `replDecision` (the UPDATE-not-supported replacement).
 *
 * The registry is a double, so the routing sites assert the ARGUMENT the engine
 * chose to pass — with a mocked registry there is no route to observe.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import {
  findRoutableUnrecognizedProperties,
  getPropertyCoverage,
} from '../../../src/provisioning/property-coverage.js';

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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK_NAME = 'MyStack';
const LOGICAL_ID = 'MyAlarm';
/** Routable, with a REMOVABLE silent drop — `diff-calculator-silent-drop.test.ts`'s pair. */
const TYPE = 'AWS::CloudWatch::Alarm';
const DROPPED = 'EvaluationWindow';
const ALLOW_KEY = `${TYPE}:${DROPPED}`;
/** A property name no CFn schema will ever carry. */
const UNKNOWN = 'CdkdTotallyNewPropertyFromTheFuture';
/**
 * A SCALAR on purpose: the skip compares against a desired bag that
 * `redactSecretsForState` rebuilds with null-prototype objects, so an
 * object-valued key never deep-equals the record there (reported with #3713).
 */
const UNKNOWN_VALUE = 'held-since-the-last-deploy';
const WINDOW = { WallClockWindow: { Timezone: 'UTC' } };

const WRITTEN: Record<string, unknown> = {
  AlarmName: 'alarm-1',
  ComparisonOperator: 'GreaterThanThreshold',
  EvaluationPeriods: 1,
  MetricName: 'Errors',
  Namespace: 'AWS/Lambda',
  Threshold: 1,
};

/** The record: the unknown key already deployed, unchanged in the template. */
const RECORDED = { ...WRITTEN, [UNKNOWN]: UNKNOWN_VALUE };

describe('DeployEngine threads the record as the unrecognized-property baseline (#3713)', () => {
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
  };
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
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
    getAllowedUnsupportedProperties: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'alarm-1', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'alarm-1' }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
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
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set([ALLOW_KEY])),
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
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  function arrange(
    templateProps: Record<string, unknown>,
    propertyChanges: ResourceChange['propertyChanges']
  ): CloudFormationTemplate {
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK_NAME,
      resources: {
        [LOGICAL_ID]: {
          physicalId: 'alarm-1',
          resourceType: TYPE,
          properties: structuredClone(RECORDED),
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as unknown as ResourceState,
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const change: ResourceChange = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: structuredClone(RECORDED),
      desiredProperties: structuredClone(templateProps),
      propertyChanges,
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(new Map([[LOGICAL_ID, change]]));
    return {
      Resources: { [LOGICAL_ID]: { Type: TYPE, Properties: structuredClone(templateProps) } },
    } as CloudFormationTemplate;
  }

  async function deployAndCatch(
    engine: InstanceType<typeof DeployEngine>,
    template: CloudFormationTemplate
  ): Promise<unknown> {
    return engine.deploy(STACK_NAME, template).then(
      () => undefined,
      (e: unknown) => e
    );
  }

  function routingCalls(): Array<Record<string, unknown>> {
    return mockProviderRegistry.getProviderFor.mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
  }

  it('PREMISE: the fixture key routes on presence and stays put against the record', () => {
    const coverage = getPropertyCoverage(TYPE);
    if (!coverage) throw new Error(`${TYPE} lost its property-coverage record`);
    expect(coverage.ccRouteUnavailable).toBe(false);
    expect(coverage.silentDrop.has(DROPPED)).toBe(true);
    expect(coverage.createOnlyDrops.has(DROPPED)).toBe(false);
    const desired = { ...RECORDED, [DROPPED]: WINDOW };
    expect(findRoutableUnrecognizedProperties(TYPE, desired, new Set())).toEqual([UNKNOWN]);
    expect(findRoutableUnrecognizedProperties(TYPE, desired, new Set(), RECORDED)).toEqual([]);
  });

  it('pre-flight: every validateResourceProperties row carries the record bag', async () => {
    const template = arrange({ ...RECORDED, Threshold: 2 }, [
      { path: 'Threshold', oldValue: 1, newValue: 2, requiresReplacement: false },
    ]);
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    expect(mockProviderRegistry.validateResourceProperties).toHaveBeenCalledTimes(1);
    const rows = mockProviderRegistry.validateResourceProperties.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    const row = rows.find((r) => r['logicalId'] === LOGICAL_ID);
    expect(row, `rows: ${JSON.stringify(rows)}`).toBeDefined();
    expect(row!['previousProperties']).toEqual(RECORDED);
  });

  it('no-change skip: an unchanged unknown key does not block the allow-listed narrowing', async () => {
    // The template adds only the allow-listed drop the SDK route never writes,
    // and keeps the unknown key the record already holds. Against the record,
    // the unknown key is not route-driving, so the desired side loses the
    // accepted drop and equals the record: no provider call. On PRESENCE the
    // unknown key would route the resource, the accepted list empties, and the
    // skip is missed — a redundant update on every deploy.
    const template = arrange({ ...RECORDED, [DROPPED]: WINDOW }, [
      { path: DROPPED, oldValue: undefined, newValue: WINDOW, requiresReplacement: false },
    ]);
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    expect(provider.update).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('no-change skip, other polarity: a CHANGED unknown key still reaches the provider', async () => {
    // Without this, a skip that fired unconditionally would pass the case above.
    const template = arrange({ ...RECORDED, [UNKNOWN]: 'changed', [DROPPED]: WINDOW }, [
      { path: UNKNOWN, oldValue: UNKNOWN_VALUE, newValue: 'changed', requiresReplacement: false },
    ]);
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
  });

  it('replaceDecision (property-driven replacement) passes the record bag', async () => {
    const template = arrange({ ...RECORDED, AlarmName: 'alarm-2' }, [
      { path: 'AlarmName', oldValue: 'alarm-1', newValue: 'alarm-2', requiresReplacement: true },
    ]);
    await deployAndCatch(makeEngine(), template);
    // The label call always sets `forceCcApi`; the old delete carries no
    // `properties`. What remains is the replacement's create decision.
    const creates = routingCalls().filter((c) => 'properties' in c && !('forceCcApi' in c));
    expect(creates.length, `calls: ${JSON.stringify(routingCalls())}`).toBe(1);
    expect(creates[0]!['properties']).toEqual({ ...RECORDED, AlarmName: 'alarm-2' });
    expect(creates[0]!['previousProperties']).toEqual(RECORDED);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('replacement: the progress LABEL and the dispatch agree on an unchanged unknown key', async () => {
    // The label (`peekRoutingForLabel`) mirrors `replaceDecision`; if it
    // dropped the record's bag, it would judge the unchanged key on PRESENCE
    // and print `[CC API]` over a replacement the dispatch sends to the SDK
    // provider. The double answers with the REAL predicate, so the decision
    // each call would get is observable as well as the argument.
    mockProviderRegistry.getProviderFor.mockImplementation(
      (input: { resourceType: string; properties?: Record<string, unknown>; previousProperties?: Record<string, unknown> }) =>
        findRoutableUnrecognizedProperties(
          input.resourceType,
          input.properties,
          new Set(),
          input.previousProperties
        ).length > 0
          ? { provider, provisionedBy: 'cc-api' as const }
          : { provider, provisionedBy: 'sdk' as const }
    );
    const template = arrange({ ...RECORDED, AlarmName: 'alarm-2' }, [
      { path: 'AlarmName', oldValue: 'alarm-1', newValue: 'alarm-2', requiresReplacement: true },
    ]);
    await deployAndCatch(makeEngine(), template);
    const calls = routingCalls();
    const results = mockProviderRegistry.getProviderFor.mock.results.map(
      (r) => (r.value as { provisionedBy: string }).provisionedBy
    );
    const labelIndex = calls.findIndex((c) => 'forceCcApi' in c);
    const dispatchIndex = calls.findIndex((c) => 'properties' in c && !('forceCcApi' in c));
    expect(labelIndex, JSON.stringify(calls)).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex, JSON.stringify(calls)).toBeGreaterThanOrEqual(0);
    expect(calls[labelIndex]!['previousProperties']).toEqual(RECORDED);
    expect(calls[dispatchIndex]!['previousProperties']).toEqual(RECORDED);
    expect(results[labelIndex]).toBe('sdk');
    expect(results[dispatchIndex]).toBe('sdk');
  });

  it('replDecision (UPDATE-not-supported replacement) passes the record bag', async () => {
    provider.update.mockRejectedValue(new ResourceUpdateNotSupportedError(TYPE, LOGICAL_ID));
    const template = arrange({ ...RECORDED, Threshold: 2 }, [
      { path: 'Threshold', oldValue: 1, newValue: 2, requiresReplacement: false },
    ]);
    expect(await deployAndCatch(makeEngine({ replace: true }), template)).toBeUndefined();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledTimes(1);
    // The last routing call is the replacement create's; the update dispatch
    // before it carries `provisionedBy`, which `replDecision` never does.
    const calls = routingCalls();
    const last = calls[calls.length - 1]!;
    expect(Object.keys(last), `calls: ${JSON.stringify(calls)}`).not.toContain('provisionedBy');
    expect(last['properties']).toEqual({ ...RECORDED, Threshold: 2 });
    expect(last['previousProperties']).toEqual(RECORDED);
  });
});
