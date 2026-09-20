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

  function makeEngine(opts: { captureObservedState?: boolean } = {}) {
    const engineOpts: { dryRun: boolean; captureObservedState?: boolean } = { dryRun: false };
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
          expect(record.observedBaselineRefusalReason).toBe('unverifiable-parameter');
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
});
