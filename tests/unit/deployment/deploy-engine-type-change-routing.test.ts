/**
 * Issues [#2668](https://github.com/go-to-k/cdkd/issues/2668) and
 * [#3036](https://github.com/go-to-k/cdkd/issues/3036): a resource whose `Type`
 * changes on an existing logical id.
 *
 * The diff emits it as an UPDATE carrying the TEMPLATE's (new) type. A
 * replacement has two halves with two types, and this suite pins which type
 * each half routes on:
 *
 *   - the OLD resource's delete (and the stateful guard that decides whether it
 *     may happen) → the STATE record's type and layer;
 *   - the create → the template's type;
 *   - the no-op skip never swallows the row, even when the two property bags
 *     compare equal (#3036).
 *
 * The registry double hands out ONE PROVIDER PER TYPE, which is the whole
 * discriminator: with a single shared provider "delete was called" is satisfied
 * by the mis-route this fixes.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

/** The live-progress LABEL, captured so the VERB can be asserted. */
const taskLabels: string[] = [];
vi.mock('../../../src/utils/live-renderer.js', async (orig) => {
  const actual = (await orig()) as { getLiveRenderer: () => Record<string, unknown> };
  return {
    ...actual,
    // The REAL renderer with `addTask` observed, so nothing else it does changes.
    getLiveRenderer: () => {
      const real = actual.getLiveRenderer();
      return new Proxy(real, {
        get(target, prop) {
          const value = target[prop as string];
          if (typeof value !== 'function') return value;
          const fn = value as (...args: unknown[]) => unknown;
          if (prop === 'addTask') {
            return (id: string, label: string) => {
              taskLabels.push(label);
              return fn.call(target, id, label);
            };
          }
          return fn.bind(target);
        },
      });
    },
  };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK_NAME = 'MyStack';
const LOGICAL_ID = 'Thing';
const OLD_TYPE = 'AWS::SNS::Topic';
const NEW_TYPE = 'AWS::SQS::Queue';
/** In `STATEFUL_TYPES`; `AWS::SNS::Topic` and `AWS::SQS::Queue` are not. */
const STATEFUL_TYPE = 'AWS::SSM::Parameter';
const OLD_PHYSICAL_ID = 'arn:aws:sns:us-east-1:111122223333:old-topic';
const NEW_PHYSICAL_ID = 'https://sqs.us-east-1.amazonaws.com/111122223333/new-queue';

type ProviderDouble = {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
};

function makeProvider(createdPhysicalId: string): ProviderDouble {
  return {
    create: vi.fn().mockResolvedValue({
      physicalId: createdPhysicalId,
      attributes: { Arn: `attr-of-${createdPhysicalId}` },
    }),
    update: vi.fn().mockResolvedValue({ physicalId: createdPhysicalId }),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

describe('DeployEngine routes each half of a Type-change replacement on its own type', () => {
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
  /** The change map the last `arrange` handed the diff double, for a case that edits it. */
  let arrangedChanges: Map<string, ResourceChange>;
  /** One provider per (type, layer): `sdk:<type>` / `cc-api:<type>`. */
  let providers: Map<string, ProviderDouble>;
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };
  let mockExportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };

  const providerFor = (type: string, layer: 'sdk' | 'cc-api' = 'sdk'): ProviderDouble => {
    const key = `${layer}:${type}`;
    let p = providers.get(key);
    if (!p) {
      // Every double "creates" the same id so a test can also make the two
      // types' ids COLLIDE by overriding one of them.
      p = makeProvider(NEW_PHYSICAL_ID);
      providers.set(key, p);
    }
    return p;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    taskLabels.length = 0;
    providers = new Map();
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
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockProviderRegistry = {
      getProvider: vi.fn().mockImplementation((type: string) => providerFor(type)),
      // Mirrors the real decision's two inputs that matter here: the TYPE picks
      // the provider, and a recorded `cc-api` layer is sticky.
      getProviderFor: vi
        .fn()
        .mockImplementation((input: { resourceType: string; provisionedBy?: 'sdk' | 'cc-api' }) => {
          const layer = input.provisionedBy === 'cc-api' ? 'cc-api' : 'sdk';
          return { provider: providerFor(input.resourceType, layer), provisionedBy: layer };
        }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    mockExportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options } as never,
      'us-east-1',
      mockExportIndexStore as never
    );
  }

  interface Arrangement {
    recordedType: string;
    templateType: string;
    recordedProps?: Record<string, unknown>;
    templateProps?: Record<string, unknown>;
    provisionedBy?: 'sdk' | 'cc-api';
    /** Omit the diff's synthetic `Type` row, as a change-shape regression would. */
    omitTypeRow?: boolean;
    attributeChanges?: ResourceChange['attributeChanges'];
    updateReplacePolicy?: 'Retain' | 'Snapshot';
  }

  function arrange(a: Arrangement): CloudFormationTemplate {
    const recordedProps = a.recordedProps ?? { Marker: 'old' };
    const templateProps = a.templateProps ?? { Marker: 'new' };
    const record = {
      physicalId: OLD_PHYSICAL_ID,
      resourceType: a.recordedType,
      properties: { ...recordedProps },
      // Create-time attributes of the OLD resource: they must not survive onto
      // the new record.
      attributes: { Arn: 'attr-of-the-OLD-resource', TopicName: 'old-topic' },
      dependencies: [],
      ...(a.provisionedBy && { provisionedBy: a.provisionedBy }),
    } as unknown as ResourceState;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK_NAME,
      resources: { [LOGICAL_ID]: record },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const typeDiffers = a.recordedType !== a.templateType;
    const change: ResourceChange = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: a.templateType,
      currentProperties: { ...recordedProps },
      desiredProperties: { ...templateProps },
      propertyChanges:
        typeDiffers && !a.omitTypeRow
          ? [
              {
                path: 'Type',
                oldValue: a.recordedType,
                newValue: a.templateType,
                requiresReplacement: true,
              },
            ]
          : typeDiffers
            ? []
            : [{ path: 'Marker', oldValue: 'old', newValue: 'new', requiresReplacement: false }],
      ...(a.attributeChanges && { attributeChanges: a.attributeChanges }),
    };
    arrangedChanges = new Map<string, ResourceChange>([[LOGICAL_ID, change]]);
    mockDiffCalculator.calculateDiff.mockResolvedValue(arrangedChanges);
    return {
      Resources: {
        [LOGICAL_ID]: {
          Type: a.templateType,
          Properties: { ...templateProps },
          ...(a.updateReplacePolicy && { UpdateReplacePolicy: a.updateReplacePolicy }),
        },
      },
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

  /** The engine wraps a provisioning failure; the refusal's text is on the `cause` chain. */
  function chainText(err: unknown): string {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
      parts.push(`${(cur as { code?: string }).code ?? ''} ${cur.message}`);
      cur = cur.cause;
    }
    return parts.join('\n');
  }

  /** The record the LAST `saveState` persisted for the row. */
  function savedRecord(): ResourceState | undefined {
    const calls = mockStateBackend.saveState.mock.calls;
    const last = calls[calls.length - 1];
    return (last?.[2] as StackState | undefined)?.resources[LOGICAL_ID];
  }

  for (const layer of ['sdk', 'cc-api'] as const) {
    it(`deletes the OLD resource through the OLD type's provider (record on ${layer})`, async () => {
      const template = arrange({
        recordedType: OLD_TYPE,
        templateType: NEW_TYPE,
        provisionedBy: layer,
      });
      const err = await deployAndCatch(makeEngine(), template);
      expect(err).toBeUndefined();

      // The delete: old type, recorded layer, old physical id.
      const oldProvider = providerFor(OLD_TYPE, layer);
      expect(oldProvider.delete).toHaveBeenCalledTimes(1);
      const [delLogicalId, delPhysicalId, delType] = oldProvider.delete.mock.calls[0]!;
      expect(delLogicalId).toBe(LOGICAL_ID);
      expect(delPhysicalId).toBe(OLD_PHYSICAL_ID);
      expect(delType).toBe(OLD_TYPE);

      // The mis-route this replaces: the NEW type's provider, on either layer,
      // must never be asked to delete anything.
      expect(providerFor(NEW_TYPE, 'sdk').delete).not.toHaveBeenCalled();
      expect(providerFor(NEW_TYPE, 'cc-api').delete).not.toHaveBeenCalled();

      // The create: new type, and NOT the old type's provider. The new
      // resource's layer is a fresh decision, not the old record's.
      const newProvider = providerFor(NEW_TYPE, 'sdk');
      expect(newProvider.create).toHaveBeenCalledTimes(1);
      expect(newProvider.create.mock.calls[0]![1]).toBe(NEW_TYPE);
      expect(oldProvider.create).not.toHaveBeenCalled();

      // Never an in-place update, of either type.
      for (const p of providers.values()) expect(p.update).not.toHaveBeenCalled();
    });
  }

  it('records the NEW type, the new physical id, and none of the old attributes', async () => {
    const template = arrange({ recordedType: OLD_TYPE, templateType: NEW_TYPE });
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    const record = savedRecord();
    expect(record?.resourceType).toBe(NEW_TYPE);
    expect(record?.physicalId).toBe(NEW_PHYSICAL_ID);
    expect(record?.attributes).toEqual({ Arn: `attr-of-${NEW_PHYSICAL_ID}` });
    expect(record?.attributes).not.toHaveProperty('TopicName');
  });

  describe('#3036: the no-op skip must not swallow a Type change', () => {
    const SAME = { Marker: 'same' };

    it('replaces when the two property bags compare EQUAL', async () => {
      const template = arrange({
        recordedType: OLD_TYPE,
        templateType: NEW_TYPE,
        recordedProps: SAME,
        templateProps: SAME,
      });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      // Pre-fix: zero provider calls and the record kept the OLD type.
      expect(providerFor(NEW_TYPE).create).toHaveBeenCalledTimes(1);
      expect(providerFor(OLD_TYPE).delete).toHaveBeenCalledTimes(1);
      expect(providerFor(OLD_TYPE).delete.mock.calls[0]![1]).toBe(OLD_PHYSICAL_ID);
      expect(savedRecord()?.resourceType).toBe(NEW_TYPE);
    });

    it('replaces rather than taking the attribute-only branch nested in the skip', async () => {
      // That branch spreads `...currentResource`, so it kept the OLD type while
      // reporting "updated (metadata)".
      const template = arrange({
        recordedType: OLD_TYPE,
        templateType: NEW_TYPE,
        recordedProps: SAME,
        templateProps: SAME,
        attributeChanges: [
          { attribute: 'DeletionPolicy', oldValue: undefined, newValue: 'Delete' },
        ] as ResourceChange['attributeChanges'],
      });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      expect(providerFor(NEW_TYPE).create).toHaveBeenCalledTimes(1);
      expect(savedRecord()?.resourceType).toBe(NEW_TYPE);
    });

    it('replaces even when the change carries no synthetic Type row', async () => {
      // The verdict is read off the RECORD, so a diff shape that drops the row
      // cannot send the old physical id into the new type's `update()`.
      const template = arrange({
        recordedType: OLD_TYPE,
        templateType: NEW_TYPE,
        omitTypeRow: true,
      });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      expect(providerFor(NEW_TYPE).create).toHaveBeenCalledTimes(1);
      expect(providerFor(NEW_TYPE).update).not.toHaveBeenCalled();
      expect(providerFor(OLD_TYPE).delete).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: an unchanged type with equal bags is still skipped', async () => {
      // The other polarity. A fix that disabled the skip outright would turn
      // every resolved-equal UPDATE into a provider call.
      const template = arrange({
        recordedType: OLD_TYPE,
        templateType: OLD_TYPE,
        recordedProps: SAME,
        templateProps: SAME,
      });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      for (const p of providers.values()) {
        expect(p.create).not.toHaveBeenCalled();
        expect(p.update).not.toHaveBeenCalled();
        expect(p.delete).not.toHaveBeenCalled();
      }
    });
  });

  describe('the stateful guard evaluates the OLD type', () => {
    it('refuses a STATEFUL old type becoming a non-stateful one, before any provider call', async () => {
      // Pre-fix the guard keyed on the template's type, so this escaped it.
      const template = arrange({ recordedType: STATEFUL_TYPE, templateType: NEW_TYPE });
      const err = await deployAndCatch(makeEngine({ noRollback: true }), template);
      expect(err, 'the deploy did not throw').toBeDefined();
      expect(chainText(err)).toContain('STATEFUL_REPLACE_BLOCKED');
      expect(chainText(err)).toContain('--force-stateful-recreation');
      expect(chainText(err)).toContain(STATEFUL_TYPE);
      for (const p of providers.values()) {
        expect(p.create).not.toHaveBeenCalled();
        expect(p.delete).not.toHaveBeenCalled();
      }
    });

    it('proceeds under --force-stateful-recreation, deleting through the stateful OLD type', async () => {
      const template = arrange({ recordedType: STATEFUL_TYPE, templateType: NEW_TYPE });
      const err = await deployAndCatch(makeEngine({ forceStatefulRecreation: true }), template);
      expect(err).toBeUndefined();
      const oldDelete = providerFor(STATEFUL_TYPE).delete;
      expect(oldDelete).toHaveBeenCalledTimes(1);
      expect(oldDelete.mock.calls[0]![2]).toBe(STATEFUL_TYPE);
      // The consent reaches the provider's own data guard.
      expect(oldDelete.mock.calls[0]![4]).toMatchObject({ forceDataDelete: true });
    });

    it('does NOT refuse a non-stateful old type becoming a stateful one', async () => {
      // Nothing stateful is destroyed; pre-fix this was a false refusal.
      const template = arrange({ recordedType: OLD_TYPE, templateType: STATEFUL_TYPE });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      expect(providerFor(STATEFUL_TYPE).create).toHaveBeenCalledTimes(1);
      expect(providerFor(OLD_TYPE).delete).toHaveBeenCalledTimes(1);
    });
  });

  it('treats an EQUAL physical id across two types as two resources', async () => {
    // Overlapping namespaces: a log group and a Lambda function can both be the
    // bare name `myapp`. The same-type guard reads an equal id as "the Create
    // API handed back the existing resource" and refuses; across a Type change
    // the create was genuine and the old resource still has to go.
    providerFor(NEW_TYPE).create.mockResolvedValue({ physicalId: OLD_PHYSICAL_ID, attributes: {} });
    const template = arrange({ recordedType: OLD_TYPE, templateType: NEW_TYPE });
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    expect(providerFor(OLD_TYPE).delete).toHaveBeenCalledTimes(1);
    expect(providerFor(NEW_TYPE).delete).not.toHaveBeenCalled();
    expect(savedRecord()?.resourceType).toBe(NEW_TYPE);
  });

  it('CONTROL: an equal physical id within ONE type is still refused as name-idempotent', async () => {
    const SAME_TYPE = OLD_TYPE;
    providerFor(SAME_TYPE).create.mockResolvedValue({
      physicalId: OLD_PHYSICAL_ID,
      attributes: {},
    });
    const template = arrange({ recordedType: SAME_TYPE, templateType: SAME_TYPE });
    // Make the same-type row a replacement.
    arrangedChanges.get(LOGICAL_ID)!.propertyChanges![0]!.requiresReplacement = true;
    const err = await deployAndCatch(makeEngine({ noRollback: true }), template);
    expect(chainText(err)).toContain('name-idempotent');
    expect(providerFor(SAME_TYPE).delete).not.toHaveBeenCalled();
  });

  it('journals BOTH types, so a rollback can re-create the old one through its own provider', async () => {
    // `resourceType` on the op is the template's type; without the second field
    // the journal names only the NEW one.
    const template = arrange({ recordedType: OLD_TYPE, templateType: NEW_TYPE });
    // A second resource that depends on the replaced one and FAILS, so the
    // completed replacement is what the journal segment has to carry.
    arrangedChanges.set('Boom', {
      logicalId: 'Boom',
      changeType: 'CREATE',
      resourceType: 'AWS::Test::Boom',
      desiredProperties: {},
    });
    (template.Resources as Record<string, unknown>)['Boom'] = {
      Type: 'AWS::Test::Boom',
      Properties: {},
    };
    mockDagBuilder.getDirectDependencies.mockImplementation((_dag: unknown, id: string) =>
      id === 'Boom' ? [LOGICAL_ID] : []
    );
    providerFor('AWS::Test::Boom').create.mockRejectedValue(new Error('boom'));
    const appendRollbackJournalSegment = vi.fn().mockResolvedValue(undefined);
    Object.assign(mockStateBackend, { appendRollbackJournalSegment });

    const err = await deployAndCatch(makeEngine({ noRollback: true }), template);
    expect(err, 'the deploy did not fail').toBeDefined();
    expect(appendRollbackJournalSegment).toHaveBeenCalledTimes(1);
    const segment = appendRollbackJournalSegment.mock.calls[0]![2] as {
      operations: Array<Record<string, unknown>>;
    };
    const op = segment.operations.find((o) => o['logicalId'] === LOGICAL_ID);
    expect(op, 'the completed replacement was not journaled').toBeDefined();
    expect(op!['resourceType']).toBe(NEW_TYPE);
    expect(op!['previousResourceType']).toBe(OLD_TYPE);
    expect((op!['previousState'] as ResourceState).resourceType).toBe(OLD_TYPE);
  });

  describe('one SDK provider serving BOTH types is one id namespace', () => {
    // Every `Custom::*` type routes to one `CustomResourceProvider`, and a
    // handler may return the same `PhysicalResourceId` for `Custom::Foo` and
    // `Custom::Bar`. There the equal id IS the existing resource: deleting "the
    // old one" would send `Delete` for what the create just built.
    const shareOneProvider = (): ProviderDouble => {
      const shared = makeProvider(OLD_PHYSICAL_ID);
      mockProviderRegistry.getProviderFor.mockImplementation(() => ({
        provider: shared,
        provisionedBy: 'sdk' as const,
      }));
      mockProviderRegistry.getProvider.mockReturnValue(shared);
      return shared;
    };

    it('keeps the name-idempotent guard live: refuses, and deletes NOTHING', async () => {
      const shared = shareOneProvider();
      const template = arrange({ recordedType: 'Custom::Foo', templateType: 'Custom::Bar' });
      const err = await deployAndCatch(makeEngine({ noRollback: true }), template);
      expect(chainText(err)).toContain('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
      expect(shared.delete).not.toHaveBeenCalled();
    });

    it('CONTROL: the same shared provider with a DIFFERENT new id replaces normally', async () => {
      const shared = shareOneProvider();
      shared.create.mockResolvedValue({ physicalId: 'a-new-id', attributes: {} });
      const template = arrange({ recordedType: 'Custom::Foo', templateType: 'Custom::Bar' });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      expect(shared.delete).toHaveBeenCalledTimes(1);
      expect(shared.delete.mock.calls[0]![1]).toBe(OLD_PHYSICAL_ID);
      expect(shared.delete.mock.calls[0]![2]).toBe('Custom::Foo');
    });

    it('Cloud Control serving both types is NOT one namespace (it addresses by type + id)', async () => {
      const shared = makeProvider(OLD_PHYSICAL_ID);
      mockProviderRegistry.getProviderFor.mockImplementation(() => ({
        provider: shared,
        provisionedBy: 'cc-api' as const,
      }));
      const template = arrange({
        recordedType: OLD_TYPE,
        templateType: NEW_TYPE,
        provisionedBy: 'cc-api',
      });
      expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
      expect(shared.delete).toHaveBeenCalledTimes(1);
      expect(shared.delete.mock.calls[0]![2]).toBe(OLD_TYPE);
    });
  });

  it('--recreate-via-cc-api on a type-changed row deletes through the OLD type', async () => {
    const template = arrange({ recordedType: OLD_TYPE, templateType: NEW_TYPE });
    const engine = makeEngine({
      recreateTargets: {
        stackName: STACK_NAME,
        viaCcApi: new Set([LOGICAL_ID]),
        viaSdkProvider: new Set<string>(),
      },
    });
    expect(await deployAndCatch(engine, template)).toBeUndefined();
    const oldDelete = providerFor(OLD_TYPE, 'sdk').delete;
    expect(oldDelete).toHaveBeenCalledTimes(1);
    expect(oldDelete.mock.calls[0]![1]).toBe(OLD_PHYSICAL_ID);
    expect(oldDelete.mock.calls[0]![2]).toBe(OLD_TYPE);
    expect(providerFor(NEW_TYPE, 'cc-api').create).toHaveBeenCalledTimes(1);
    expect(providerFor(NEW_TYPE, 'cc-api').delete).not.toHaveBeenCalled();
    expect(providerFor(NEW_TYPE, 'sdk').delete).not.toHaveBeenCalled();
  });

  it('the --replace delete-first fallback deletes through the OLD type, then creates the new one', async () => {
    const newProvider = providerFor(NEW_TYPE);
    newProvider.create
      .mockRejectedValueOnce(
        new Error(
          `CREATE failed for ${LOGICAL_ID}: Resource of type '${NEW_TYPE}' with identifier 'x' already exists.`
        )
      )
      .mockResolvedValue({ physicalId: NEW_PHYSICAL_ID, attributes: {} });
    const template = arrange({ recordedType: OLD_TYPE, templateType: NEW_TYPE });
    expect(await deployAndCatch(makeEngine({ replace: true }), template)).toBeUndefined();
    const oldDelete = providerFor(OLD_TYPE).delete;
    expect(oldDelete).toHaveBeenCalledTimes(1);
    expect(oldDelete.mock.calls[0]![2]).toBe(OLD_TYPE);
    expect(newProvider.delete).not.toHaveBeenCalled();
    expect(newProvider.create).toHaveBeenCalledTimes(2);
    expect(newProvider.create.mock.calls[1]![1]).toBe(NEW_TYPE);
  });

  it('a create-first collision WITHOUT --replace says the holder may be an unrelated resource', async () => {
    providerFor(NEW_TYPE).create.mockRejectedValue(
      new Error(
        `CREATE failed for ${LOGICAL_ID}: Resource of type '${NEW_TYPE}' with identifier 'x' already exists.`
      )
    );
    const template = arrange({ recordedType: OLD_TYPE, templateType: NEW_TYPE });
    const err = await deployAndCatch(makeEngine({ noRollback: true }), template);
    expect(chainText(err)).toContain('NAMED_REPLACEMENT_COLLISION');
    expect(chainText(err)).toContain(`changes the resource's Type (${OLD_TYPE} -> ${NEW_TYPE})`);
    expect(providerFor(OLD_TYPE).delete).not.toHaveBeenCalled();
  });

  it('UpdateReplacePolicy: Snapshot takes the final snapshot of the OLD type', async () => {
    // `AWS::RDS::DBInstance` is an atomic-final-snapshot type; the topic
    // replacing it is not. Keyed on the template's type the old instance was
    // deleted with NO snapshot identifier (or refused as unsupported).
    const RDS = 'AWS::RDS::DBInstance';
    const template = arrange({
      recordedType: RDS,
      templateType: OLD_TYPE,
      updateReplacePolicy: 'Snapshot',
    });
    const err = await deployAndCatch(makeEngine({ forceStatefulRecreation: true }), template);
    expect(err).toBeUndefined();
    const oldDelete = providerFor(RDS).delete;
    expect(oldDelete).toHaveBeenCalledTimes(1);
    expect(oldDelete.mock.calls[0]![2]).toBe(RDS);
    expect(
      (oldDelete.mock.calls[0]![4] as { finalSnapshotIdentifier?: string }).finalSnapshotIdentifier
    ).toEqual(expect.any(String));
  });

  it('labels the row Replacing, even when the change carries no synthetic Type row', async () => {
    const template = arrange({
      recordedType: OLD_TYPE,
      templateType: NEW_TYPE,
      omitTypeRow: true,
    });
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    expect(taskLabels.some((l) => l.startsWith(`Replacing ${LOGICAL_ID}`))).toBe(true);
    expect(taskLabels.some((l) => l.startsWith(`Updating ${LOGICAL_ID}`))).toBe(false);
  });

  it('the stateful refusal names the OLD type, the new one, and `Type` as the cause', async () => {
    const template = arrange({
      recordedType: STATEFUL_TYPE,
      templateType: NEW_TYPE,
      omitTypeRow: true,
    });
    const err = await deployAndCatch(makeEngine({ noRollback: true }), template);
    expect(chainText(err)).toContain(`${LOGICAL_ID} (${STATEFUL_TYPE}) requires replacement`);
    expect(chainText(err)).toContain(`immutable property changed: Type, to ${NEW_TYPE})`);
  });

  it('under UpdateReplacePolicy: Retain, creates the new type and deletes nothing', async () => {
    const template = arrange({
      recordedType: OLD_TYPE,
      templateType: NEW_TYPE,
      updateReplacePolicy: 'Retain',
    });
    expect(await deployAndCatch(makeEngine(), template)).toBeUndefined();
    expect(providerFor(NEW_TYPE).create).toHaveBeenCalledTimes(1);
    for (const p of providers.values()) expect(p.delete).not.toHaveBeenCalled();
  });
});
