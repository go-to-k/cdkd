import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  getPropertyCoverage,
  withoutAcceptedSilentDropProperties,
  withoutSilentDropProperties,
} from '../../../src/provisioning/property-coverage.js';
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
 * Issue [#2750](https://github.com/go-to-k/cdkd/issues/2750) — the WRITE half.
 *
 * `--allow-unsupported-properties <Type>:<Prop>` keeps a resource on its SDK
 * Provider and accepts that the property is never sent to AWS. The record that
 * deploy then wrote carried the full TEMPLATE bag, that property included, so
 * state claimed a value AWS did not hold. Everything reading the bag was told
 * the same thing — and the one that made it a silent data loss was the later
 * flag-less deploy: the resource correctly auto-routes to Cloud Control (issue
 * #614), `CloudControlProvider.update` builds its JSON Patch from the recorded
 * bag, finds the property identical on both sides, omits it, and the deploy
 * reports success having sent nothing for it.
 *
 * Measured live on `AWS::CloudWatch::Alarm` / `EvaluationWindow` by
 * `tests/integration/sdk-to-cc-autoroute/` — the type and property this file
 * uses, so the unit and the fixture pin the same case. The end-to-end sequence
 * stays the fixture's job; what is assertable here without Cloud Control is the
 * half that causes the damage: what the engine PERSISTS.
 *
 * The premise (that `EvaluationWindow` really is a silent drop for this type,
 * and the other keys really are handled) is asserted rather than assumed —
 * `property-coverage.generated.ts` is regenerated from the CFn schema
 * fixtures, and a provider gaining coverage would otherwise turn every case
 * below into a vacuous pass.
 */
describe('DeployEngine - a silent-dropped property is NOT recorded (#2750)', () => {
  const stackName = 'silent-drop-record-stack';
  const RESOURCE_TYPE = 'AWS::CloudWatch::Alarm';
  const DROPPED = 'EvaluationWindow';
  const PHYSICAL_ID = 'silent-drop-record-stack-alarm';

  const WRITTEN = {
    AlarmName: PHYSICAL_ID,
    ComparisonOperator: 'GreaterThanThreshold',
    EvaluationPeriods: 1,
    MetricName: 'Errors',
    Namespace: 'AWS/Lambda',
    Threshold: 1,
  };
  // What the template declares: everything above PLUS the property the SDK
  // provider has no wiring for.
  const DESIRED = { ...WRITTEN, [DROPPED]: { WallClockWindow: { Timezone: 'UTC' } } };

  it('PREMISE: the fixture keys are classified as this file assumes', () => {
    const coverage = getPropertyCoverage(RESOURCE_TYPE);
    if (!coverage) throw new Error(`${RESOURCE_TYPE} lost its property-coverage record`);
    expect(coverage.silentDrop.has(DROPPED)).toBe(true);
    for (const key of Object.keys(WRITTEN)) {
      expect(coverage.handled.has(key)).toBe(true);
    }
  });

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
    hasProvider: ReturnType<typeof vi.fn>;
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
    getAllowedUnsupportedProperties: ReturnType<typeof vi.fn>;
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
      getExecutionLevels: vi.fn().mockReturnValue([['MyAlarm']]),
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
      hasProvider: vi.fn().mockReturnValue(true),
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      getAllowedUnsupportedProperties: vi
        .fn()
        .mockReturnValue(new Set([`${RESOURCE_TYPE}:${DROPPED}`])),
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
    Resources: { MyAlarm: { Type: RESOURCE_TYPE, Properties: DESIRED } },
  };

  function changeMap(changeType: 'CREATE' | 'UPDATE'): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'MyAlarm',
        {
          logicalId: 'MyAlarm',
          changeType,
          resourceType: RESOURCE_TYPE,
          desiredProperties: DESIRED,
          ...(changeType === 'UPDATE' ? { currentProperties: recordedByOldBinary() } : {}),
        } as unknown as ResourceChange,
      ],
    ]);
  }

  /**
   * The poisoned record a pre-fix binary wrote: the full template bag, the
   * never-written property included, on the SDK route.
   */
  function recordedByOldBinary(): Record<string, unknown> {
    return { ...DESIRED, Threshold: 2 };
  }

  function priorState(provisionedBy: 'sdk' | 'cc-api' = 'sdk'): StackState {
    return {
      version: 7,
      region: 'us-east-1',
      stackName,
      resources: {
        MyAlarm: {
          physicalId: PHYSICAL_ID,
          resourceType: RESOURCE_TYPE,
          properties: recordedByOldBinary(),
          attributes: {},
          provisionedBy,
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
  }

  function savedRecord() {
    const savedState = mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    return savedState.resources['MyAlarm']!;
  }

  describe('CREATE path', () => {
    it('records only what the SDK route wrote', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({ physicalId: PHYSICAL_ID, attributes: {} });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).not.toHaveProperty(DROPPED);
      expect(savedRecord().properties).toEqual(WRITTEN);
    });

    /**
     * The NEGATIVE CONTROL, and the case a route-blind narrowing gets wrong:
     * Cloud Control forwards the FULL property map, so a cc-api record really
     * does describe AWS. Stripping the key there would make every later diff
     * report it as an addition and re-send it forever.
     */
    it('records the FULL bag on the Cloud Control route', async () => {
      mockProviderRegistry.getProviderFor.mockReturnValue({
        provider: mockProvider,
        provisionedBy: 'cc-api',
      });
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({ physicalId: PHYSICAL_ID, attributes: {} });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toHaveProperty(DROPPED);
      expect(savedRecord().properties).toEqual(DESIRED);
    });

    it('composes with effectiveProperties — the provider narrows first, the route second', async () => {
      // Both narrowings must apply, and neither may undo the other: a provider
      // that reports what it narrowed still knows nothing about a key it has no
      // wiring for, so recording `effectiveProperties` verbatim would put the
      // silent drop back whenever the provider happens to echo the bag.
      mockStateBackend.getState.mockResolvedValue({ state: null, etag: undefined });
      mockProvider.create.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        attributes: {},
        effectiveProperties: { ...DESIRED, Threshold: 99 },
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('CREATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).toEqual({ ...WRITTEN, Threshold: 99 });
    });
  });

  describe('UPDATE path', () => {
    it('records only what the SDK route wrote', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.update.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      expect(savedRecord().properties).not.toHaveProperty(DROPPED);
      expect(savedRecord().properties).toEqual(WRITTEN);
    });

    /**
     * The READ half's other end, and what heals a record a pre-fix binary
     * already poisoned. When the flag is dropped the resource auto-routes to
     * Cloud Control, whose `update` diffs `previousProperties` against the
     * desired bag: with the stale key still on the previous side the patch omits
     * it and the property never reaches AWS — the reported bug. The engine
     * strips it before the call, so the patch carries an `add`.
     *
     * Asserted on the ARGUMENT rather than on an outcome: the provider is a
     * mock, so no patch exists to observe, and the argument is the thing the
     * fix changes.
     */
    it('hands the provider a previous side with the never-written key removed', async () => {
      mockProviderRegistry.getProviderFor.mockReturnValue({
        provider: mockProvider,
        provisionedBy: 'cc-api',
      });
      mockStateBackend.getState.mockResolvedValue({ state: priorState('sdk'), etag: 'etag-old' });
      mockProvider.update.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      const previousProperties = mockProvider.update.mock.calls.at(-1)![4] as Record<
        string,
        unknown
      >;
      expect(previousProperties).not.toHaveProperty(DROPPED);
      // Not a wholesale replacement of the previous side: everything the SDK
      // route DID write must survive, or the patch would re-send the whole bag.
      expect(previousProperties['Threshold']).toBe(2);

      // The UPDATE site's negative control for `propertiesToRecord`'s route
      // gate. This deploy lands on Cloud Control, which sends the full map, so
      // the record must KEEP the property — hardcoding `'sdk'` at that site
      // passed the whole suite until this line, and its consequence is the
      // mirror of the bug: after the healing update the record would be
      // narrowed while `provisionedBy: 'cc-api'`, so every later diff would
      // report the key as an addition and re-send it forever.
      expect(savedRecord().properties).toHaveProperty(DROPPED);
      expect(savedRecord().provisionedBy).toBe('cc-api');
    });

    /**
     * The engine's SECOND gate on the healing path, and the one the diff test
     * cannot reach: even after `DiffCalculator` reports an UPDATE, the update
     * arm re-compares the resolved bag against the record and skips the
     * resource when they match. Against a record a pre-fix binary poisoned the
     * never-written key sits on BOTH sides there, so the recorded bag makes
     * that skip fire and no provider is ever chosen.
     */
    it('does not skip the resource when the ONLY difference is the never-written key', async () => {
      mockProviderRegistry.getAllowedUnsupportedProperties.mockReturnValue(new Set());
      mockProviderRegistry.getProviderFor.mockReturnValue({
        provider: mockProvider,
        provisionedBy: 'cc-api',
      });
      // A poisoned record IDENTICAL to the template — the flag-less redeploy of
      // an otherwise unchanged stack, which is the issue's headline sequence.
      const poisoned = { ...DESIRED };
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 7,
          region: 'us-east-1',
          stackName,
          resources: {
            MyAlarm: {
              physicalId: PHYSICAL_ID,
              resourceType: RESOURCE_TYPE,
              properties: poisoned,
              attributes: {},
              provisionedBy: 'sdk',
            },
          },
          outputs: {},
          lastModified: 0,
        } as unknown as StackState,
        etag: 'etag-old',
      });
      mockProvider.update.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'MyAlarm',
            {
              logicalId: 'MyAlarm',
              changeType: 'UPDATE',
              resourceType: RESOURCE_TYPE,
              desiredProperties: DESIRED,
              currentProperties: poisoned,
            } as unknown as ResourceChange,
          ],
        ])
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.update).toHaveBeenCalled();
      const previousProperties = mockProvider.update.mock.calls.at(-1)![4] as Record<
        string,
        unknown
      >;
      expect(previousProperties).not.toHaveProperty(DROPPED);
    });

    it('leaves the previous side ALONE for a record already on Cloud Control', async () => {
      // The mirror of the case above. A cc-api record's bag was written by
      // Cloud Control from the full map, so the key on the previous side is a
      // real AWS value; removing it would make every update re-send it.
      mockProviderRegistry.getProviderFor.mockReturnValue({
        provider: mockProvider,
        provisionedBy: 'cc-api',
      });
      mockStateBackend.getState.mockResolvedValue({
        state: priorState('cc-api'),
        etag: 'etag-old',
      });
      mockProvider.update.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      const previousProperties = mockProvider.update.mock.calls.at(-1)![4] as Record<
        string,
        unknown
      >;
      expect(previousProperties).toHaveProperty(DROPPED);
    });

    it('the update-failure REPLACEMENT FALLBACK records only what was written', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.update.mockRejectedValue(
        new Error('UnsupportedActionException: resource does not support UPDATE')
      );
      mockProvider.create.mockResolvedValue({ physicalId: `${PHYSICAL_ID}-2`, attributes: {} });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.create).toHaveBeenCalled();
      expect(savedRecord().properties).not.toHaveProperty(DROPPED);
    });

    it('the property-driven REPLACEMENT inside UPDATE records only what was written', async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.create.mockResolvedValue({ physicalId: `${PHYSICAL_ID}-2`, attributes: {} });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'MyAlarm',
            {
              logicalId: 'MyAlarm',
              changeType: 'UPDATE',
              resourceType: RESOURCE_TYPE,
              desiredProperties: DESIRED,
              currentProperties: recordedByOldBinary(),
              propertyChanges: [
                { propertyPath: 'AlarmName', changeType: 'MODIFY', requiresReplacement: true },
              ],
            } as unknown as ResourceChange,
          ],
        ])
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.create).toHaveBeenCalled();
      expect(savedRecord().properties).not.toHaveProperty(DROPPED);
    });
  });

  /**
   * Issue [#2809](https://github.com/go-to-k/cdkd/issues/2809): the no-change
   * re-check's DESIRED operand. Since #2750 its stored operand is the record
   * minus the removable drops the SDK route cannot write, while the desired
   * one was the full resolved bag, so for an SDK-routed resource carrying an
   * allow-listed removable drop the two could never be equal and neither the
   * skip nor the attribute-only branch nested inside it was reachable. (A
   * create-only drop stays on both sides, so it never caused a mismatch.)
   *
   * The diff is mocked to REPORT an UPDATE. The real diff reaches this arm two
   * ways: a property change the re-check exists to absorb (an intrinsic
   * resolving to the value already stored), and a policy-only change carried
   * in `attributeChanges`, which the SNS cases below use and
   * `tests/integration/sdk-to-cc-autoroute` phases 4b/4c exercise live. What
   * it never reports is a property change confined to the dropped key, since
   * it narrows both of its own sides.
   *
   * A consequence, and deliberate: a record a pre-#2750 binary wrote still
   * HOLDS the allow-listed key, and a flag-ful policy-only deploy now takes the
   * attribute-only branch, which keeps the recorded properties as they are, so
   * the leftover key stays. The redundant `update()` used to rewrite it away.
   * That is harmless, because every reader narrows the record first (the
   * diff's stored side, `currentPropsAsWritten`); a deploy without the flag
   * narrows nothing on the desired side and is the healing path.
   */
  describe('the no-change re-check narrows its DESIRED side too (#2809)', () => {
    function recordState(
      logicalId: string,
      resourceType: string,
      physicalId: string,
      properties: Record<string, unknown>,
      // `undefined` = a pre-v7 record, which carries no marker at all.
      provisionedBy: 'sdk' | 'cc-api' | undefined,
      deletionPolicy?: 'Delete' | 'Retain'
    ): StackState {
      return {
        version: 7,
        region: 'us-east-1',
        stackName,
        resources: {
          [logicalId]: {
            physicalId,
            resourceType,
            properties,
            attributes: {},
            ...(provisionedBy !== undefined && { provisionedBy }),
            ...(deletionPolicy !== undefined && { deletionPolicy }),
          },
        },
        outputs: {},
        lastModified: 0,
      } as unknown as StackState;
    }

    function updateOf(
      logicalId: string,
      resourceType: string,
      desiredProperties: Record<string, unknown>,
      currentProperties: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ): Map<string, ResourceChange> {
      return new Map<string, ResourceChange>([
        [
          logicalId,
          {
            logicalId,
            changeType: 'UPDATE',
            resourceType,
            desiredProperties,
            currentProperties,
            ...extra,
          } as unknown as ResourceChange,
        ],
      ]);
    }

    it('skips the provider when the ONLY difference is the allow-listed drop', async () => {
      // What a post-#2750 binary records: the template bag minus the drop. The
      // allow set (from `beforeEach`) names that drop, so this deploy stays on
      // the SDK route and nothing it can send differs from what AWS holds.
      mockStateBackend.getState.mockResolvedValue({
        state: recordState('MyAlarm', RESOURCE_TYPE, PHYSICAL_ID, WRITTEN, 'sdk'),
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        updateOf('MyAlarm', RESOURCE_TYPE, DESIRED, WRITTEN)
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });

    it('also skips for a record with NO provisionedBy marker, which counts as SDK', async () => {
      // A pre-v7 record was SDK-managed, and `currentPropsAsWritten` narrows it
      // (its test is `=== 'cc-api'`), so the desired side must narrow for it
      // too. Keyed on `=== 'sdk'` instead, this record would compare an
      // unnarrowed desired bag against a narrowed stored one -- the defect.
      mockStateBackend.getState.mockResolvedValue({
        state: recordState('MyAlarm', RESOURCE_TYPE, PHYSICAL_ID, WRITTEN, undefined),
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        updateOf('MyAlarm', RESOURCE_TYPE, DESIRED, WRITTEN)
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });

    it('still skips on the Cloud Control route, where the record DOES hold the key', async () => {
      // The route gate's control. Cloud Control forwards the full map, so a
      // cc-api record holds the key and so does the template: nothing differs.
      // Narrowing the desired side regardless of route would remove the key
      // from ONE operand only and send an update for a resource nothing changed.
      mockStateBackend.getState.mockResolvedValue({
        state: recordState('MyAlarm', RESOURCE_TYPE, PHYSICAL_ID, DESIRED, 'cc-api'),
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        updateOf('MyAlarm', RESOURCE_TYPE, DESIRED, DESIRED)
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });

    it('compares the FULL desired bag when the registry double has no allow-set method', async () => {
      // `getAllowedUnsupportedProperties` is called `?.()` for the test doubles,
      // as at the diff call. Without an allow set nothing is narrowed, so the
      // drop stays on the desired side, the record lacks it, and the provider
      // is called -- the pre-#2809 comparison, not a throw. Dropping the
      // `allowedSilentDrops` guard hands the helper `undefined`, and the drop
      // present here makes that throw.
      delete (mockProviderRegistry as Partial<typeof mockProviderRegistry>)
        .getAllowedUnsupportedProperties;
      mockProvider.update.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      });
      mockStateBackend.getState.mockResolvedValue({
        state: recordState('MyAlarm', RESOURCE_TYPE, PHYSICAL_ID, WRITTEN, 'sdk'),
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        updateOf('MyAlarm', RESOURCE_TYPE, DESIRED, WRITTEN)
      );

      await makeEngine().deploy(stackName, template);

      expect(mockProvider.update).toHaveBeenCalledTimes(1);
    });

    describe('an attribute-only flip on a type whose update() RE-CREATES', () => {
      const SUB_TYPE = 'AWS::SNS::Subscription';
      const SUB_DROPPED = 'Region';
      // The shape CDK emits: `Region` is set only for a topic in ANOTHER region,
      // so the topic (and the subscription, which lives with it) is in
      // us-west-2 while the queue stays in the stack's us-east-1.
      const SUB_ARN = 'arn:aws:sns:us-west-2:123456789012:orders:5f2c0b44';
      const SUB_WRITTEN = {
        Protocol: 'sqs',
        TopicArn: 'arn:aws:sns:us-west-2:123456789012:orders',
        Endpoint: 'arn:aws:sqs:us-east-1:123456789012:orders-queue',
      };
      const SUB_DESIRED = { ...SUB_WRITTEN, [SUB_DROPPED]: 'us-west-2' };

      it('PREMISE: Region is a REMOVABLE silent drop for this type', () => {
        const coverage = getPropertyCoverage(SUB_TYPE);
        if (!coverage) throw new Error(`${SUB_TYPE} lost its property-coverage record`);
        expect(coverage.silentDrop.has(SUB_DROPPED)).toBe(true);
        for (const key of Object.keys(SUB_WRITTEN)) {
          expect(coverage.handled.has(key)).toBe(true);
        }
        // Removable, not merely a drop: a CREATE-ONLY drop is left on BOTH sides
        // by the record-side helper, so the skip was reachable all along and
        // this whole case would pass without the fix.
        expect(withoutSilentDropProperties(SUB_TYPE, SUB_DESIRED)).toEqual(SUB_WRITTEN);
        // And through the helper the re-check itself calls, with this case's
        // allow set: the desired side the engine compares is the written bag.
        expect(
          withoutAcceptedSilentDropProperties(
            SUB_TYPE,
            SUB_DESIRED,
            new Set([`${SUB_TYPE}:${SUB_DROPPED}`])
          )
        ).toEqual(SUB_WRITTEN);
      });

      it('refreshes DeletionPolicy in state and never reaches the provider', async () => {
        mockProviderRegistry.getAllowedUnsupportedProperties.mockReturnValue(
          new Set([`${SUB_TYPE}:${SUB_DROPPED}`])
        );
        mockDagBuilder.getExecutionLevels.mockReturnValue([['MySub']]);
        mockStateBackend.getState.mockResolvedValue({
          state: recordState('MySub', SUB_TYPE, SUB_ARN, SUB_WRITTEN, 'sdk', 'Delete'),
          etag: 'etag-old',
        });
        const subTemplate = {
          Resources: {
            MySub: { Type: SUB_TYPE, Properties: SUB_DESIRED, DeletionPolicy: 'Retain' },
          },
        } as unknown as CloudFormationTemplate;
        mockDiffCalculator.calculateDiff.mockResolvedValue(
          updateOf('MySub', SUB_TYPE, SUB_DESIRED, SUB_WRITTEN, {
            attributeChanges: [
              { attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' },
            ],
          })
        );

        await makeEngine().deploy(stackName, subTemplate);

        // The provider is a mock, so what is pinned HERE is that no provider
        // call happens for a flip no AWS property carries. That the real one
        // would re-create is pinned beside the provider, by
        // `tests/unit/provisioning/sns-subscription-provider.test.ts`'s
        // "update() unsubscribes the old subscription before subscribing a new
        // one": Unsubscribe first, then Subscribe, and a different ARN.
        expect(mockProvider.update).not.toHaveBeenCalled();
        expect(mockProvider.delete).not.toHaveBeenCalled();
        expect(mockProvider.create).not.toHaveBeenCalled();
        const saved = (mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState)
          .resources['MySub']!;
        expect(saved.deletionPolicy).toBe('Retain');
        expect(saved.physicalId).toBe(SUB_ARN);
        // The refresh keeps the narrowed record as written: it must not pick
        // up the template's `Region`, which the SDK route never sent.
        expect(saved.properties).toEqual(SUB_WRITTEN);
      });
    });
  });

  describe('the engine WIRES the allow set into the diff', () => {
    /**
     * The desired side's half of the narrowing lives in `DiffCalculator`, and it
     * cannot ask a registry — so the engine has to hand it the flag set. Without
     * this the record-side fix alone reports the template's key as ADDED on
     * every later flag-ful deploy, and for a create-only property that is a
     * REPLACEMENT of a resource nobody touched.
     */
    it("passes the registry's allow set as calculateDiff's 5th argument", async () => {
      mockStateBackend.getState.mockResolvedValue({ state: priorState(), etag: 'etag-old' });
      mockProvider.update.mockResolvedValue({
        physicalId: PHYSICAL_ID,
        wasReplaced: false,
        attributes: {},
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(changeMap('UPDATE'));

      await makeEngine().deploy(stackName, template);

      const call = mockDiffCalculator.calculateDiff.mock.calls.at(-1)!;
      expect(call[4]).toBeInstanceOf(Set);
      expect(Array.from(call[4] as Set<string>)).toEqual([`${RESOURCE_TYPE}:${DROPPED}`]);
      expect(mockProviderRegistry.getAllowedUnsupportedProperties).toHaveBeenCalled();
    });
  });
});
