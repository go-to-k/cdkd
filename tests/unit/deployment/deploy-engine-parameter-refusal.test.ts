/**
 * An UNVERIFIABLE-PARAMETER baseline refusal survives every in-place UPDATE
 * (issue [#3462](https://github.com/go-to-k/cdkd/issues/3462)).
 *
 * `cdkd import` refuses the observed baseline of a resource that depends on a
 * template parameter not provably deployed at its `Default`, and `cdkd deploy`
 * binds that SAME `Default`. An UPDATE that does not rewrite the
 * placeholder-bound leaf leaves the deployed value in AWS, so a readback
 * positioned against the placeholder would persist it. The engine therefore
 * keeps the marker AND its reason through the in-place rebuild and takes NO
 * readback; only a new physical resource discharges the refusal.
 *
 * `readCurrentState` answers the SENTINEL for the refused resource's OLD
 * physical id whenever it is asked, so every "was not persisted" assertion has
 * a case where the wrong value would have been emitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record = (...args: unknown[]): void => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const fns = {
    debug: vi.fn(record),
    info: vi.fn(record),
    warn: vi.fn(record),
    error: vi.fn(record),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// Issue #3468 (orphan adoption runs AFTER the deploy-start stamp): the real
// planner unless a test installs its own.
const orphanPlanOverride = vi.hoisted(() => ({ plan: undefined as unknown }));
vi.mock('../../../src/deployment/orphan-adoption.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    planOrphanAdoption: (...args: unknown[]) =>
      orphanPlanOverride.plan !== undefined
        ? Promise.resolve(orphanPlanOverride.plan)
        : (original['planOrphanAdoption'] as (...a: unknown[]) => unknown)(...args),
  };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const SENTINEL = 'THE-REAL-DECRYPTED-SECRET-3462';
const FN_TYPE = 'AWS::Lambda::Function';
const OLD_PHYS = 'phys-fn';

describe('DeployEngine - an unverifiable-parameter baseline refusal (issue #3462)', () => {
  const stackName = 'parameter-refusal-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
  };

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

  beforeEach(() => {
    vi.clearAllMocks();
    orphanPlanOverride.plan = undefined;

    mockProvider = {
      create: vi.fn().mockResolvedValue({
        physicalId: 'phys-create',
        attributes: {},
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-update', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
    };

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
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) => {
          return Array.from(changes.values()).filter((c) => c.changeType === type);
        }),
    };

    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine(opts: { captureObservedState?: boolean; dryRun?: boolean } = {}) {
    const engineOpts: { dryRun: boolean; captureObservedState?: boolean } = {
      dryRun: opts.dryRun ?? false,
    };
    if (opts.captureObservedState !== undefined) {
      engineOpts.captureObservedState = opts.captureObservedState;
    }
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      engineOpts,
      'us-east-1'
    );
  }

  const RECORDED = {
    Code: { S3Key: 'old.zip' },
    Environment: { Variables: { DB_PASSWORD: 'CHANGEME' } },
  };
  const CODE_ONLY = {
    Code: { S3Key: 'new.zip' },
    Environment: { Variables: { DB_PASSWORD: 'CHANGEME' } },
  };

  function refusedRecord(extra: Partial<ResourceState> = {}): ResourceState {
    return {
      physicalId: OLD_PHYS,
      resourceType: FN_TYPE,
      properties: structuredClone(RECORDED),
      observedBaselineRefused: true,
      observedBaselineRefusalReason: 'unverifiable-parameter',
      ...extra,
    };
  }

  /** `Sibling` is an ordinary resource UPDATEd in the same deploy: it proves captures run at all. */
  function arrange(args: {
    fn: ResourceState;
    desired: Record<string, unknown>;
    change?: Partial<ResourceChange>;
    templateExtra?: Record<string, unknown>;
  }): CloudFormationTemplate {
    logged.length = 0;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        Fn: args.fn,
        Sibling: {
          physicalId: 'phys-sibling',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q', DelaySeconds: 1 },
          observedProperties: { stale: true },
        },
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) =>
      physicalId === OLD_PHYS
        ? { Environment: { Variables: { DB_PASSWORD: SENTINEL } } }
        : { readBack: physicalId }
    );
    mockProvider.update.mockImplementation(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
    }));
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Fn',
          {
            logicalId: 'Fn',
            changeType: 'UPDATE',
            resourceType: FN_TYPE,
            desiredProperties: args.desired,
            currentProperties: args.fn.properties,
            ...args.change,
          } as unknown as ResourceChange,
        ],
        [
          'Sibling',
          {
            logicalId: 'Sibling',
            changeType: 'UPDATE',
            resourceType: 'AWS::SQS::Queue',
            desiredProperties: { QueueName: 'q', DelaySeconds: 2 },
            currentProperties: { QueueName: 'q', DelaySeconds: 1 },
          } as unknown as ResourceChange,
        ],
      ])
    );
    mockDiffCalculator.hasChanges.mockReturnValue(true);
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Fn', 'Sibling']]);
    return {
      Resources: {
        Fn: {
          Type: (args.change?.resourceType as string | undefined) ?? FN_TYPE,
          Properties: args.desired,
          ...args.templateExtra,
        },
        Sibling: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q', DelaySeconds: 2 } },
      },
    } as unknown as CloudFormationTemplate;
  }

  function everySavedState(): StackState[] {
    return mockStateBackend.saveState.mock.calls.map((call) => call[2] as StackState);
  }

  /** Nothing the engine handed ANY collaborator, and no log line, holds the sentinel. */
  function expectSentinelNowhere(): void {
    const handed = [
      ...mockStateBackend.saveState.mock.calls,
      ...mockProvider.update.mock.calls,
      ...mockProvider.create.mock.calls,
      ...mockProvider.delete.mock.calls,
    ];
    expect(JSON.stringify(handed)).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
  }

  /** INVARIANT on every save: the reason never appears without the marker. */
  function expectReasonOnlyWithMarker(): void {
    const saves = everySavedState();
    expect(saves.length).toBeGreaterThan(0);
    for (const saved of saves) {
      for (const record of Object.values(saved.resources)) {
        if (Object.hasOwn(record, 'observedBaselineRefusalReason')) {
          expect(record.observedBaselineRefused).toBe(true);
          expect(['unverifiable-parameter', 'incomplete-resolution']).toContain(
            record.observedBaselineRefusalReason
          );
        }
      }
    }
  }

  function readbackIds(): string[] {
    return mockProvider.readCurrentState.mock.calls.map((call) => call[0] as string);
  }

  it('a CODE-ONLY update keeps marker and reason, takes NO readback for the resource, and its sibling still captures', async () => {
    const template = arrange({ fn: refusedRecord(), desired: CODE_ONLY });
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    expect(mockProvider.update).toHaveBeenCalledTimes(2);
    const saved = everySavedState().at(-1)!;
    const fn = saved.resources['Fn']!;
    // The UPDATE really landed on the record...
    expect(fn.properties).toEqual(CODE_ONLY);
    // ...and the refusal rode through the rebuild.
    expect(fn.observedBaselineRefused).toBe(true);
    expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    expect(fn.observedProperties).toBeUndefined();
    // Never READ, not merely never persisted.
    expect(readbackIds()).toEqual(['phys-sibling']);
    expect(saved.resources['Sibling']!.observedProperties).toEqual({ readBack: 'phys-sibling' });
    expectSentinelNowhere();
    expectReasonOnlyWithMarker();
    expect(logged.some((line) => line.includes('capture SKIPPED for updated Fn'))).toBe(true);
  });

  it('an update that CHANGES the placeholder-bound leaf keeps it too: the engine cannot know what a provider wrote', async () => {
    const desired = {
      Code: { S3Key: 'old.zip' },
      Environment: { Variables: { DB_PASSWORD: 'another-literal' } },
    };
    const template = arrange({ fn: refusedRecord(), desired });
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.properties).toEqual(desired);
    expect(fn.observedBaselineRefused).toBe(true);
    expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    expect(readbackIds()).toEqual(['phys-sibling']);
    expectSentinelNowhere();
  });

  it('a REASON-LESS marker clears on the same code-only update, exactly as before the reason existed', async () => {
    const template = arrange({
      fn: refusedRecord({ observedBaselineRefusalReason: undefined }),
      desired: CODE_ONLY,
    });
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => ({
      readBack: physicalId,
    }));
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(Object.hasOwn(fn, 'observedBaselineRefused')).toBe(false);
    expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
    expect(fn.observedProperties).toEqual({ readBack: OLD_PHYS });
    expectReasonOnlyWithMarker();
  });

  it('a REPLACEMENT clears both fields and reads back ONLY the new physical resource', async () => {
    const desired = { ...CODE_ONLY, FunctionName: 'renamed' };
    const template = arrange({
      fn: refusedRecord(),
      desired,
      change: {
        propertyChanges: [
          { path: 'FunctionName', oldValue: undefined, newValue: 'renamed', requiresReplacement: true },
        ],
      } as Partial<ResourceChange>,
    });
    mockProvider.create.mockResolvedValue({ physicalId: 'phys-fn-new', attributes: {} });
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.physicalId).toBe('phys-fn-new');
    expect(Object.hasOwn(fn, 'observedBaselineRefused')).toBe(false);
    expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
    expect(fn.observedProperties).toEqual({ readBack: 'phys-fn-new' });
    // The OLD resource — the one that can hold the deployed value — is never read.
    expect(readbackIds()).not.toContain(OLD_PHYS);
    expect(readbackIds()).toContain('phys-fn-new');
    expectSentinelNowhere();
    expectReasonOnlyWithMarker();
  });

  it('a TYPE-CHANGE replacement clears both fields; the old half is deleted, never read', async () => {
    const NEW_TYPE = 'AWS::SQS::Queue';
    const desired = { QueueName: 'was-a-function' };
    const template = arrange({
      fn: refusedRecord(),
      desired,
      change: {
        resourceType: NEW_TYPE,
        propertyChanges: [
          { path: 'Type', oldValue: FN_TYPE, newValue: NEW_TYPE, requiresReplacement: true },
        ],
      } as Partial<ResourceChange>,
    });
    mockProvider.create.mockResolvedValue({ physicalId: 'phys-queue-new', attributes: {} });
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.resourceType).toBe(NEW_TYPE);
    expect(fn.physicalId).toBe('phys-queue-new');
    expect(Object.hasOwn(fn, 'observedBaselineRefused')).toBe(false);
    expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
    expect(readbackIds()).not.toContain(OLD_PHYS);
    expect(readbackIds()).toContain('phys-queue-new');
    expectSentinelNowhere();
  });

  it('a provider that REPLACES inside update() (wasReplaced) clears both fields as well', async () => {
    const template = arrange({ fn: refusedRecord(), desired: CODE_ONLY });
    mockProvider.update.mockImplementation(async (logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? { physicalId: 'phys-fn-recreated', wasReplaced: true }
        : { physicalId, wasReplaced: false }
    );
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.physicalId).toBe('phys-fn-recreated');
    expect(Object.hasOwn(fn, 'observedBaselineRefused')).toBe(false);
    expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
    expect(readbackIds()).not.toContain(OLD_PHYS);
    expect(readbackIds()).toContain('phys-fn-recreated');
    expectSentinelNowhere();
  });

  it('wasReplaced with the SAME physical id keeps the refusal: nothing new was built, so the old resource would be read', async () => {
    // `S3BucketProvider.update` answers exactly this when the bound
    // `BucketName` differs from the physical id — a name bound to a placeholder
    // `Default`, which is this refusal class's own shape — and creates nothing.
    const template = arrange({ fn: refusedRecord(), desired: CODE_ONLY });
    mockProvider.update.mockImplementation(async (logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? { physicalId: OLD_PHYS, wasReplaced: true }
        : { physicalId, wasReplaced: false }
    );
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.observedBaselineRefused).toBe(true);
    expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    expect(fn.observedProperties).toBeUndefined();
    expect(readbackIds()).toEqual(['phys-sibling']);
    expectSentinelNowhere();
  });

  it('a REASON WITHOUT the marker is not a refusal: the update clears it and captures, as for any unmarked record', async () => {
    const template = arrange({
      fn: refusedRecord({ observedBaselineRefused: undefined }),
      desired: CODE_ONLY,
    });
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => ({
      readBack: physicalId,
    }));
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
    expect(fn.observedProperties).toEqual({ readBack: OLD_PHYS });
  });

  it('a changed physical id WITHOUT wasReplaced keeps the refusal (fail closed) and reads nothing', async () => {
    const template = arrange({ fn: refusedRecord(), desired: CODE_ONLY });
    mockProvider.update.mockImplementation(async (logicalId: string, physicalId: string) =>
      logicalId === 'Fn' ? { physicalId: 'phys-fn-moved' } : { physicalId, wasReplaced: false }
    );
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.observedBaselineRefused).toBe(true);
    expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    expect(readbackIds()).toEqual(['phys-sibling']);
  });

  it('a METADATA-ONLY update (no provider call) keeps both fields', async () => {
    const template = arrange({
      fn: refusedRecord({ deletionPolicy: 'Delete' }),
      desired: structuredClone(RECORDED),
      change: {
        attributeChanges: [{ attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' }],
      } as Partial<ResourceChange>,
      templateExtra: { DeletionPolicy: 'Retain' },
    });
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    // Only the sibling reached a provider.
    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.deletionPolicy).toBe('Retain');
    expect(fn.observedBaselineRefused).toBe(true);
    expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    expect(readbackIds()).toEqual(['phys-sibling']);
    expectReasonOnlyWithMarker();
  });

  it('a NO_CHANGE deploy leaves it alone: the deploy-start auto-refresh skips the marked record', async () => {
    const template = arrange({
      fn: refusedRecord(),
      desired: structuredClone(RECORDED),
      change: { changeType: 'NO_CHANGE' } as Partial<ResourceChange>,
    });
    await makeEngine({ captureObservedState: true }).deploy(stackName, template);

    const fn = everySavedState().at(-1)!.resources['Fn']!;
    expect(fn.observedBaselineRefused).toBe(true);
    expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
    expect(readbackIds()).toEqual(['phys-sibling']);
    expectSentinelNowhere();
  });

  it('a FAILED update leaves the prior record, refusal included, in every state it saves', async () => {
    const template = arrange({ fn: refusedRecord(), desired: CODE_ONLY });
    mockProvider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
      if (logicalId === 'Fn') throw new Error('update rejected');
      return { physicalId, wasReplaced: false };
    });
    await expect(
      makeEngine({ captureObservedState: true }).deploy(stackName, template)
    ).rejects.toThrow();

    for (const saved of everySavedState()) {
      const fn = saved.resources['Fn'];
      if (fn === undefined) continue;
      expect(fn.observedBaselineRefused).toBe(true);
      expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
      expect(fn.observedProperties).toBeUndefined();
    }
    expect(readbackIds()).not.toContain(OLD_PHYS);
    expectSentinelNowhere();
    expectReasonOnlyWithMarker();
  });
  // ── Issue #3468 ────────────────────────────────────────────────────────
  // cdkd 0.290.35 wrote ARM 4 refusals WITHOUT a reason. A reason-less marker
  // is therefore read FAIL CLOSED against the deploy-time template: when the
  // resource's definition names a declared parameter it is stamped
  // `unverifiable-parameter` at deploy start and every rule above applies.
  describe('a REASON-LESS marker (written by an older cdkd), issue #3468', () => {
    const PARAMETERS = { DbPassword: { Type: 'String', Default: 'CHANGEME' } };

    function reasonless(extra: Partial<ResourceState> = {}): ResourceState {
      const { observedBaselineRefusalReason: _dropped, ...rest } = refusedRecord(extra);
      return rest;
    }

    /** The raw template definition of `Fn` is `fnDefinition`; the resolved bag stays `desired`. */
    function arrangeLegacy(args: {
      fnDefinition: Record<string, unknown>;
      template?: Record<string, unknown>;
      desired?: Record<string, unknown>;
      change?: Partial<ResourceChange>;
      fn?: ResourceState;
    }): CloudFormationTemplate {
      const template = arrange({
        fn: args.fn ?? reasonless(),
        desired: args.desired ?? CODE_ONLY,
        ...(args.change && { change: args.change }),
        templateExtra: args.fnDefinition,
      }) as unknown as Record<string, unknown>;
      Object.assign(template, { Parameters: PARAMETERS }, args.template);
      return template as unknown as CloudFormationTemplate;
    }

    const RAW_CODE = { S3Key: 'new.zip' };

    function expectKeptAndStamped(): void {
      const fn = everySavedState().at(-1)!.resources['Fn']!;
      expect(fn.observedBaselineRefused).toBe(true);
      expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
      expect(fn.observedProperties).toBeUndefined();
      expect(readbackIds()).toEqual(['phys-sibling']);
      expectSentinelNowhere();
      expectReasonOnlyWithMarker();
    }

    function expectClearedAndCaptured(): void {
      const fn = everySavedState().at(-1)!.resources['Fn']!;
      expect(Object.hasOwn(fn, 'observedBaselineRefused')).toBe(false);
      expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
      expect(readbackIds()).toContain(OLD_PHYS);
    }

    const NAMING_SHAPES: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
      [
        'a Ref',
        {
          Properties: {
            Code: RAW_CODE,
            Environment: { Variables: { DB_PASSWORD: { Ref: 'DbPassword' } } },
          },
        },
      ],
      [
        'Fn::Sub text',
        {
          Properties: {
            Code: RAW_CODE,
            Environment: { Variables: { DB_PASSWORD: { 'Fn::Sub': 'pw=${DbPassword}' } } },
          },
        },
      ],
      [
        'an Fn::Sub variable map',
        {
          Properties: {
            Code: RAW_CODE,
            Environment: {
              Variables: { DB_PASSWORD: { 'Fn::Sub': ['pw=${V}', { V: { Ref: 'DbPassword' } }] } },
            },
          },
        },
      ],
      [
        'an Fn::If whose condition reads it, transitively',
        {
          Properties: {
            Code: RAW_CODE,
            Environment: { Variables: { DB_PASSWORD: { 'Fn::If': ['Outer', 'a', 'b'] } } },
          },
        },
        {
          Conditions: {
            Outer: { 'Fn::Not': [{ Condition: 'Inner' }] },
            Inner: { 'Fn::Equals': [{ Ref: 'DbPassword' }, 'x'] },
          },
        },
      ],
      [
        'a resource-level Condition',
        { Condition: 'Inner', Properties: { Code: RAW_CODE } },
        { Conditions: { Inner: { 'Fn::Equals': [{ Ref: 'DbPassword' }, 'x'] } } },
      ],
      [
        'an operand of Fn::Join',
        {
          Properties: {
            Code: RAW_CODE,
            Environment: {
              Variables: { DB_PASSWORD: { 'Fn::Join': ['', ['pw=', { Ref: 'DbPassword' }]] } },
            },
          },
        },
      ],
    ];

    it.each(NAMING_SHAPES)(
      'a code-only update KEEPS it, stamps the reason and takes no readback when the definition names the parameter through %s',
      async (_label, fnDefinition, templateExtra) => {
        const template = arrangeLegacy({
          fnDefinition,
          ...(templateExtra && { template: templateExtra }),
        });
        await makeEngine({ captureObservedState: true }).deploy(stackName, template);
        expect(mockProvider.update).toHaveBeenCalledTimes(2);
        expectKeptAndStamped();
      }
    );

    it('keeps it when the definition reads an ATTRIBUTE of a resource that names the parameter', async () => {
      const template = arrangeLegacy({
        fnDefinition: {
          Properties: {
            Code: RAW_CODE,
            Environment: { Variables: { DB_PASSWORD: { 'Fn::GetAtt': ['Param', 'Value'] } } },
          },
        },
      });
      (template.Resources as Record<string, unknown>)['Param'] = {
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: { Ref: 'DbPassword' } },
      };
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectKeptAndStamped();
    });

    it('keeps it when the definition holds an intrinsic the walk cannot classify and the stack has a named parameter', async () => {
      const template = arrangeLegacy({
        fnDefinition: {
          Properties: { Code: RAW_CODE, Environment: { 'Fn::ToJsonString': { a: 1 } } },
        },
      });
      (template.Resources as Record<string, unknown>)['Other'] = {
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: { Ref: 'DbPassword' } },
      };
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectKeptAndStamped();
    });

    // The fail-closed arms the engine cannot be driven into without breaking
    // on the input first (an unreadable template, a walk that throws) are
    // pinned on the helper: tests/unit/analyzer/parameter-dependence.test.ts.

    it('CLEARS it, exactly as before, when the definition names only a PSEUDO parameter', async () => {
      const template = arrangeLegacy({
        fnDefinition: {
          Properties: {
            Code: RAW_CODE,
            Environment: { Variables: { DB_PASSWORD: { Ref: 'AWS::Region' } } },
          },
        },
      });
      mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => ({
        readBack: physicalId,
      }));
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectClearedAndCaptured();
    });

    it("CLEARS it when the only declared parameter is CDK's Rules-only BootstrapVersion, even beside an unclassifiable intrinsic", async () => {
      const template = arrangeLegacy({
        fnDefinition: {
          Properties: { Code: RAW_CODE, Environment: { 'Fn::ToJsonString': { a: 1 } } },
        },
        template: {
          Parameters: {
            BootstrapVersion: {
              Type: 'AWS::SSM::Parameter::Value<String>',
              Default: '/cdk-bootstrap/hnb659fds/version',
            },
          },
          Rules: {
            CheckBootstrapVersion: {
              Assertions: [
                { Assert: { 'Fn::Not': [{ 'Fn::Contains': [['1'], { Ref: 'BootstrapVersion' }] }] } },
              ],
            },
          },
        },
      });
      mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => ({
        readBack: physicalId,
      }));
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectClearedAndCaptured();
    });

    it('CLEARS it when ANOTHER resource names the parameter and this one does not', async () => {
      const template = arrangeLegacy({ fnDefinition: { Properties: { Code: RAW_CODE } } });
      (template.Resources as Record<string, unknown>)['Other'] = {
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: { Ref: 'DbPassword' } },
      };
      mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => ({
        readBack: physicalId,
      }));
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectClearedAndCaptured();
    });

    it("a marker carrying the OTHER reason is not reason-less: it clears on UPDATE although the definition names the parameter, which is also what a binary that predates the value does", async () => {
      const template = arrangeLegacy({
        fn: refusedRecord({ observedBaselineRefusalReason: 'incomplete-resolution' }),
        fnDefinition: NAMING_SHAPES[0]![1],
      });
      mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => ({
        readBack: physicalId,
      }));
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectClearedAndCaptured();
    });

    it('a REPLACEMENT still discharges it and reads back only the new physical resource', async () => {
      const template = arrangeLegacy({
        fnDefinition: NAMING_SHAPES[0]![1],
        desired: { ...CODE_ONLY, FunctionName: 'renamed' },
        change: {
          propertyChanges: [
            {
              path: 'FunctionName',
              oldValue: undefined,
              newValue: 'renamed',
              requiresReplacement: true,
            },
          ],
        } as Partial<ResourceChange>,
      });
      mockProvider.create.mockResolvedValue({ physicalId: 'phys-fn-new', attributes: {} });
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      const fn = everySavedState().at(-1)!.resources['Fn']!;
      expect(fn.physicalId).toBe('phys-fn-new');
      expect(Object.hasOwn(fn, 'observedBaselineRefused')).toBe(false);
      expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
      expect(readbackIds()).not.toContain(OLD_PHYS);
      expectSentinelNowhere();
    });

    it('a METADATA-ONLY update and a NO_CHANGE deploy both save the stamped form and read nothing', async () => {
      for (const change of [
        {
          attributeChanges: [
            { attribute: 'DeletionPolicy', oldValue: 'Delete', newValue: 'Retain' },
          ],
        },
        { changeType: 'NO_CHANGE' },
      ] as Array<Partial<ResourceChange>>) {
        mockStateBackend.saveState.mockClear();
        mockProvider.readCurrentState.mockClear();
        const template = arrangeLegacy({
          fn: reasonless({ deletionPolicy: 'Delete' }),
          fnDefinition: { ...NAMING_SHAPES[0]![1], DeletionPolicy: 'Retain' },
          desired: structuredClone(RECORDED),
          change,
        });
        await makeEngine({ captureObservedState: true }).deploy(stackName, template);
        expectKeptAndStamped();
      }
    });

    it('a legacy marker that names NO parameter and is only PRESERVED (NO_CHANGE) stays as it was: preserved, not written', async () => {
      const template = arrangeLegacy({
        fnDefinition: { Properties: { Code: RAW_CODE } },
        desired: structuredClone(RECORDED),
        change: { changeType: 'NO_CHANGE' } as Partial<ResourceChange>,
      });
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      const fn = everySavedState().at(-1)!.resources['Fn']!;
      expect(fn.observedBaselineRefused).toBe(true);
      expect(Object.hasOwn(fn, 'observedBaselineRefusalReason')).toBe(false);
      expect(readbackIds()).toEqual(['phys-sibling']);
    });

    it('a FAILED update leaves no sentinel anywhere and never captures the record, in every state it saves', async () => {
      const template = arrangeLegacy({ fnDefinition: NAMING_SHAPES[0]![1] });
      mockProvider.update.mockImplementation(async (logicalId: string, physicalId: string) => {
        if (logicalId === 'Fn') throw new Error('update rejected');
        return { physicalId, wasReplaced: false };
      });
      await expect(
        makeEngine({ captureObservedState: true }).deploy(stackName, template)
      ).rejects.toThrow();
      let savedWithFn = 0;
      for (const saved of everySavedState()) {
        const fn = saved.resources['Fn'];
        if (fn === undefined) continue;
        savedWithFn++;
        expect(fn.observedBaselineRefused).toBe(true);
        // Stamped even though the update failed: the failure save holds the
        // explicit form too.
        expect(fn.observedBaselineRefusalReason).toBe('unverifiable-parameter');
        expect(fn.observedProperties).toBeUndefined();
      }
      expect(savedWithFn).toBeGreaterThan(0);
      expect(readbackIds()).not.toContain(OLD_PHYS);
      expectSentinelNowhere();
      expectReasonOnlyWithMarker();
    });

    it('stamps by REPLACING the record: the object that was loaded is left as it was', async () => {
      const loaded = reasonless();
      const template = arrangeLegacy({ fn: loaded, fnDefinition: NAMING_SHAPES[0]![1] });
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectKeptAndStamped();
      expect(Object.hasOwn(loaded, 'observedBaselineRefusalReason')).toBe(false);
    });

    it('a record ADOPTED from a rollback orphan after the deploy-start stamp is read too', async () => {
      const template = arrangeLegacy({ fnDefinition: NAMING_SHAPES[0]![1] });
      // `Fn` is not in `resources` when the deploy starts: it arrives through
      // the orphan pre-pass, which runs after the first stamp.
      const loaded = (await (
        mockStateBackend.getState as unknown as () => Promise<unknown>
      )()) as { state: StackState; etag: string };
      const adopted = loaded.state.resources['Fn']!;
      delete loaded.state.resources['Fn'];
      loaded.state.orphans = [{ logicalId: 'Fn', orphanedAt: 1, state: adopted }];
      orphanPlanOverride.plan = { adopted: { Fn: adopted }, remaining: [], notices: [], refusals: [] };
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectKeptAndStamped();
    });

    it('a template whose parameter dependence cannot be judged stamps EVERY reason-less marker and says so once, by cause class only', async () => {
      // The definition names no parameter at all; `Parameters` is not a map.
      const template = arrangeLegacy({
        fnDefinition: { Properties: { Code: RAW_CODE } },
        template: { Parameters: 'not-a-map-SECRET-LOOKING-VALUE' },
      });
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectKeptAndStamped();
      const lines = logged.filter((line) => line.includes('could not be judged'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('(unreadable-template)');
      expect(logged.join('\n')).not.toContain('SECRET-LOOKING-VALUE');
    });

    it('says nothing about an unjudgeable template when the template was read', async () => {
      const template = arrangeLegacy({ fnDefinition: NAMING_SHAPES[0]![1] });
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expect(logged.some((line) => line.includes('could not be judged'))).toBe(false);
    });

    it('a reason this binary does not know is read like an absent one: kept and stamped', async () => {
      const template = arrangeLegacy({
        fn: refusedRecord({ observedBaselineRefusalReason: 'a-later-value' as never }),
        fnDefinition: NAMING_SHAPES[0]![1],
      });
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expectKeptAndStamped();
    });

    it('a record the template no longer defines is DELETED as usual: no verdict is needed and nothing is read', async () => {
      const template = arrangeLegacy({
        fnDefinition: NAMING_SHAPES[0]![1],
        change: { changeType: 'DELETE' } as Partial<ResourceChange>,
      });
      delete (template.Resources as Record<string, unknown>)['Fn'];
      await makeEngine({ captureObservedState: true }).deploy(stackName, template);
      expect(mockProvider.delete).toHaveBeenCalledTimes(1);
      expect(mockProvider.delete.mock.calls[0]![1]).toBe(OLD_PHYS);
      expect(everySavedState().at(-1)!.resources['Fn']).toBeUndefined();
      expect(readbackIds()).not.toContain(OLD_PHYS);
      expectSentinelNowhere();
    });

    it('--dry-run saves nothing, stamped or otherwise, and reads nothing', async () => {
      const template = arrangeLegacy({ fnDefinition: NAMING_SHAPES[0]![1] });
      await makeEngine({ captureObservedState: true, dryRun: true }).deploy(stackName, template);
      expect(mockStateBackend.saveState).not.toHaveBeenCalled();
      expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
    });
  });
});
