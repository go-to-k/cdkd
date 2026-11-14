/**
 * go-to-k/cdkd#6309, engine half: the deploy hands a custom resource's
 * provider the coordinates its `Fn::GetAtt` values sit at (create, update and
 * the update's previous side), records them beside `properties`, and threads
 * the recorded ones into the delete. With the REAL resolver, so `Count` is
 * the number the producer's record holds.
 *
 * And no regression for a stack an earlier cdkd deployed: its record has no
 * coordinates, and an unchanged custom resource is not updated (the skip
 * check compares resolved values, never the payload's string forms).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

const STACK = 'cr-payload-types';
const TOKEN = 'arn:aws:lambda:us-east-1:111122223333:function:handler';
const POL: ResourceState = {
  physicalId: 'arn:aws:iam::111122223333:policy/p',
  resourceType: 'AWS::IAM::ManagedPolicy',
  properties: { PolicyDocument: {} },
  attributes: { AttachmentCount: 0, PolicyArn: 'arn:aws:iam::111122223333:policy/p' },
};
const CR_TEMPLATE_PROPS = {
  ServiceToken: TOKEN,
  Count: { 'Fn::GetAtt': ['Pol', 'AttachmentCount'] },
  Lit: 5,
};
const template: CloudFormationTemplate = {
  Resources: {
    Pol: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: {} } },
    Cr: { Type: 'Custom::Echo', Properties: CR_TEMPLATE_PROPS, DependsOn: ['Pol'] } as never,
  },
};
/** The record an earlier cdkd wrote: no `typedPayloadLeaves`. */
const legacyCr = (properties: Record<string, unknown>): ResourceState => ({
  physicalId: 'cr-phys',
  resourceType: 'Custom::Echo',
  properties,
  dependencies: ['Pol'],
});

describe('DeployEngine - custom resource payload types (#6309)', () => {
  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountInfoCache();
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'cr-phys', attributes: {} }),
      update: vi
        .fn()
        .mockResolvedValue({ physicalId: 'cr-phys', wasReplaced: false, attributes: {} }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
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
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  const stateOf = (resources: Record<string, ResourceState>) => ({
    state: {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK,
      resources,
      outputs: {},
      lastModified: 0,
    } as StackState,
    etag: 'etag-old',
  });

  const deploy = async (
    resources: Record<string, ResourceState>,
    changes: ResourceChange[],
    deployed: CloudFormationTemplate = template,
    options: Record<string, unknown> = {}
  ): Promise<StackState | undefined> => {
    mockStateBackend.getState!.mockResolvedValue(stateOf(resources));
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map(changes.map((change) => [change.logicalId, change]))
    );
    const engine = new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([changes.map((c) => c.logicalId)]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false, ...options },
      'us-east-1'
    );
    await engine.deploy(STACK, deployed);
    return mockStateBackend.saveState!.mock.calls.at(-1)?.[2] as StackState | undefined;
  };

  const crChange = (
    changeType: ResourceChange['changeType'],
    currentProperties?: Record<string, unknown>
  ): ResourceChange =>
    ({
      logicalId: 'Cr',
      changeType,
      resourceType: 'Custom::Echo',
      desiredProperties: CR_TEMPLATE_PROPS,
      ...(currentProperties !== undefined && {
        currentProperties,
        propertyChanges:
          currentProperties['Lit'] === 5
            ? []
            : [{ path: 'Lit', oldValue: currentProperties['Lit'], newValue: 5, requiresReplacement: false }],
      }),
    }) as ResourceChange;

  it('CREATE: hands the provider the GetAtt coordinate and records it', async () => {
    const saved = await deploy({ Pol: POL }, [crChange('CREATE')]);

    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    const [, , properties, context] = mockProvider.create!.mock.calls[0]!;
    // Premise: the resolver served the producer's number, and the literal.
    expect(properties).toMatchObject({ Count: 0, Lit: 5 });
    expect(context).toMatchObject({ typedPayloadLeaves: [['Count']] });
    expect(saved?.resources['Cr']?.typedPayloadLeaves).toStrictEqual([['Count']]);
  });

  it('a non-custom resource records nothing', async () => {
    await deploy({}, [
      {
        logicalId: 'Pol',
        changeType: 'CREATE',
        resourceType: 'AWS::IAM::ManagedPolicy',
        desiredProperties: { PolicyDocument: {} },
      } as ResourceChange,
    ]);
    const [, , , context] = mockProvider.create!.mock.calls[0]!;
    expect(context).not.toHaveProperty('typedPayloadLeaves');
    const saved = mockStateBackend.saveState!.mock.calls.at(-1)?.[2] as StackState;
    expect(saved.resources['Pol']).not.toHaveProperty('typedPayloadLeaves');
  });

  it("UPDATE of a record an earlier cdkd wrote: the new side is typed, the old side unknown", async () => {
    const saved = await deploy(
      { Pol: POL, Cr: legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 4 }) },
      [crChange('UPDATE', { ServiceToken: TOKEN, Count: 0, Lit: 4 })]
    );

    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    const context = mockProvider.update!.mock.calls[0]![5] as Record<string, unknown>;
    expect(context['typedPayloadLeaves']).toStrictEqual([['Count']]);
    expect(context['previousTypedPayloadLeaves']).toBeUndefined();
    expect(saved?.resources['Cr']?.typedPayloadLeaves).toStrictEqual([['Count']]);
  });

  it("UPDATE: the old side reads the record's coordinates", async () => {
    await deploy(
      {
        Pol: POL,
        Cr: { ...legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 4 }), typedPayloadLeaves: [['Lit']] },
      },
      [crChange('UPDATE', { ServiceToken: TOKEN, Count: 0, Lit: 4 })]
    );
    const context = mockProvider.update!.mock.calls[0]![5] as Record<string, unknown>;
    expect(context['previousTypedPayloadLeaves']).toStrictEqual([['Lit']]);
  });

  it('no spurious update: an unchanged custom resource an earlier cdkd deployed is skipped', async () => {
    const saved = await deploy(
      { Pol: POL, Cr: legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 5 }) },
      [crChange('UPDATE', { ServiceToken: TOKEN, Count: 0, Lit: 5 })]
    );

    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockProvider.create).not.toHaveBeenCalled();
    // The skipped record is carried as it was: nothing restamped.
    expect(saved?.resources['Cr']).toBeDefined();
    expect(saved!.resources['Cr']).not.toHaveProperty('typedPayloadLeaves');
  });

  it('REPLACEMENT: the new resource\'s Create is typed and its record stamped', async () => {
    mockProvider.create!.mockResolvedValue({ physicalId: 'cr-phys-new', attributes: {} });
    const change = {
      ...crChange('UPDATE', { ServiceToken: TOKEN, Count: 0, Lit: 4 }),
      propertyChanges: [{ path: 'Lit', oldValue: 4, newValue: 5, requiresReplacement: true }],
    } as ResourceChange;
    const saved = await deploy(
      {
        Pol: POL,
        Cr: { ...legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 4 }), typedPayloadLeaves: [['Lit']] },
      },
      [change]
    );

    // The OLD resource's Delete is typed by the OLD record.
    expect(mockProvider.delete).toHaveBeenCalledTimes(1);
    expect(mockProvider.delete!.mock.calls[0]![1]).toBe('cr-phys');
    expect(mockProvider.delete!.mock.calls[0]![4]).toMatchObject({
      recordedTypedPayloadLeaves: [['Lit']],
    });
    // Premise: the replacement path ran, not an in-place update.
    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    expect(mockProvider.create!.mock.calls[0]![3]).toMatchObject({
      typedPayloadLeaves: [['Count']],
    });
    expect(saved?.resources['Cr']?.physicalId).toBe('cr-phys-new');
    expect(saved?.resources['Cr']?.typedPayloadLeaves).toStrictEqual([['Count']]);
  });

  it('RECREATE (--recreate-via-sdk-provider): the destroy-then-create Create is typed', async () => {
    mockProvider.create!.mockResolvedValue({ physicalId: 'cr-phys-new', attributes: {} });
    const saved = await deploy(
      { Pol: POL, Cr: { ...legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 5 }), provisionedBy: 'cc-api' } },
      [crChange('UPDATE', { ServiceToken: TOKEN, Count: 0, Lit: 5 })],
      template,
      {
        recreateTargets: {
          stackName: STACK,
          viaCcApi: new Set<string>(),
          viaSdkProvider: new Set(['Cr']),
        },
      }
    );

    // Premise: destroy-then-create ran (the old resource deleted first).
    expect(mockProvider.update).not.toHaveBeenCalled();
    expect(mockProvider.delete).toHaveBeenCalledTimes(1);
    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    expect(mockProvider.delete!.mock.invocationCallOrder[0]).toBeLessThan(
      mockProvider.create!.mock.invocationCallOrder[0]!
    );
    expect(mockProvider.create!.mock.calls[0]![3]).toMatchObject({
      typedPayloadLeaves: [['Count']],
    });
    expect(saved?.resources['Cr']?.typedPayloadLeaves).toStrictEqual([['Count']]);
  });

  it("DELETE: threads the record's coordinates to the provider", async () => {
    await deploy(
      {
        Pol: POL,
        Cr: { ...legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 5 }), typedPayloadLeaves: [['Count']] },
      },
      [{ logicalId: 'Cr', changeType: 'DELETE', resourceType: 'Custom::Echo' } as ResourceChange],
      { Resources: { Pol: template.Resources['Pol']! } }
    );

    expect(mockProvider.delete).toHaveBeenCalledTimes(1);
    const context = mockProvider.delete!.mock.calls[0]![4] as Record<string, unknown>;
    expect(context['recordedTypedPayloadLeaves']).toStrictEqual([['Count']]);
  });
});

describe('createFirstThenDeleteOld hands the Create its positions (#6309)', () => {
  it('passes typedPayloadLeaves into the new resource Create context', async () => {
    const { createFirstThenDeleteOld } = await import(
      '../../../src/deployment/deploy-engine/replacement/create-first.js'
    );
    const create = vi.fn().mockResolvedValue({ physicalId: 'cr-phys-new', attributes: {} });
    const deps = {
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      guardedReplacementCreate: (_input: unknown, fn: () => Promise<unknown>) => fn(),
      withRetry: (fn: () => Promise<unknown>) => fn(),
      secretsRun: () => ({}),
    };
    const result = await createFirstThenDeleteOld({} as never, deps as never, {
      logicalId: 'Cr',
      resourceType: 'Custom::Echo',
      oldResourceType: 'Custom::Echo',
      currentResource: legacyCr({ ServiceToken: TOKEN, Count: 0, Lit: 4 }),
      createProvider: { create } as never,
      createProps: { ServiceToken: TOKEN, Count: 0, Lit: 5 },
      deleteProvider: {} as never,
      deleteProvisionedBy: undefined,
      deleteProperties: {},
      secrets: new Map(),
      typedPayloadLeaves: [['Count']],
      change: {} as never,
      equalIdIsSameResource: true,
      snapshotPolicy: undefined,
      deletePolicy: 'Retain',
      trigger: 'test',
      // Create only: the old resource stays, so no delete half runs.
      retainOld: true,
      stackName: STACK,
      createdVia: 'sdk',
      resolvedProps: { ServiceToken: TOKEN, Count: 0, Lit: 5 },
    });
    expect(result).toMatchObject({ physicalId: 'cr-phys-new' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![3]).toMatchObject({ typedPayloadLeaves: [['Count']] });
  });
});
