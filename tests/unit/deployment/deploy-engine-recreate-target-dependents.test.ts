/**
 * go-to-k/cdkd#4383: the same-stack readers of a `--recreate-via-*` target are
 * re-provisioned against the physical id the recreate mints. A security
 * group's `GroupId` is AWS-assigned, so the recreated group comes back under a
 * new id, and a reader the template did not touch (a `NO_CHANGE` row before
 * the fix) kept the deleted one in AWS and in state.
 *
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator`,
 * `DagBuilder` and `IntrinsicFunctionResolver`, so the promotion, the DAG
 * order, the re-resolution against the in-flight state and the summary counts
 * are the production ones. Only the providers are doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
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

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

// No real AWS client: the create-only DescribeType lookups fail fast, which is
// the registry-only classification.
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'recreate-dependents-stack';
const REGION = 'us-east-1';
const SG_TYPE = 'AWS::EC2::SecurityGroup';
const PARAM_TYPE = 'AWS::SSM::Parameter';

const TEMPLATE: CloudFormationTemplate = {
  Resources: {
    Sg: { Type: SG_TYPE, Properties: { GroupDescription: 'sg' } },
    // Reads the group's id by Ref, in place.
    RefReader: {
      Type: PARAM_TYPE,
      Properties: { Name: 'ref-reader', Type: 'String', Value: { Ref: 'Sg' } },
    },
    // Reads it by Fn::GetAtt.
    GetAttReader: {
      Type: PARAM_TYPE,
      Properties: {
        Name: 'getatt-reader',
        Type: 'String',
        Value: { 'Fn::GetAtt': ['Sg', 'GroupId'] },
      },
    },
    // Reads nothing.
    Bystander: {
      Type: PARAM_TYPE,
      Properties: { Name: 'bystander', Type: 'String', Value: 'v' },
    },
  },
};

function priorState(): StackState {
  const param = (name: string, value: string, deps: string[]): ResourceState => {
    const properties = { Name: name, Type: 'String', Value: value };
    return {
      physicalId: name,
      resourceType: PARAM_TYPE,
      properties,
      observedProperties: properties,
      attributes: {},
      dependencies: deps,
      provisionedBy: 'sdk',
    } as ResourceState;
  };
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Sg: {
        physicalId: 'sg-old',
        resourceType: SG_TYPE,
        properties: { GroupDescription: 'sg' },
        observedProperties: { GroupDescription: 'sg' },
        attributes: { GroupId: 'sg-old' },
        dependencies: [],
        provisionedBy: 'sdk',
      } as ResourceState,
      RefReader: param('ref-reader', 'sg-old', ['Sg']),
      GetAttReader: param('getatt-reader', 'sg-old', ['Sg']),
      Bystander: param('bystander', 'v', []),
    },
    outputs: {},
    lastModified: 0,
  };
}

type Provider = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;

function makeProvider(): Provider {
  return {
    // The recreated group comes back under a NEW, AWS-assigned id.
    create: vi.fn().mockResolvedValue({ physicalId: 'sg-new', attributes: { GroupId: 'sg-new' } }),
    update: vi.fn((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

describe('DeployEngine - readers of a --recreate-via-* target (go-to-k/cdkd#4383)', () => {
  let sdk: Provider;
  let cc: Provider;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider();
    cc = makeProvider();
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: priorState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine(
    opts: { dryRun?: boolean; targetStack?: string; forceStatefulRecreation?: boolean } = {}
  ): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(sdk),
        getProviderFor: vi
          .fn()
          .mockImplementation((input: { provisionedBy?: 'sdk' | 'cc-api' }) =>
            input.provisionedBy === 'cc-api'
              ? { provider: cc, provisionedBy: 'cc-api' as const }
              : { provider: sdk, provisionedBy: 'sdk' as const }
          ),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        dryRun: opts.dryRun ?? false,
        ...(opts.forceStatefulRecreation && { forceStatefulRecreation: true }),
        recreateTargets: {
          stackName: opts.targetStack ?? STACK,
          viaCcApi: new Set(['Sg']),
          viaSdkProvider: new Set<string>(),
        },
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  function saved(id: string): ResourceState | undefined {
    const calls = stateBackend.saveState.mock.calls;
    return (calls[calls.length - 1]?.[2] as StackState | undefined)?.resources[id];
  }

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);

  it('re-provisions a Ref and a Fn::GetAtt reader against the recreated id', async () => {
    const result = await makeEngine().deploy(STACK, TEMPLATE);

    // The target: destroyed on its SDK layer, created on Cloud Control.
    expect(callsFor(sdk.delete, 'Sg')).toHaveLength(1);
    expect(callsFor(cc.create, 'Sg')).toHaveLength(1);
    expect(saved('Sg')?.physicalId).toBe('sg-new');

    // Each reader is sent the NEW id, and its record says so.
    const refUpdate = callsFor(sdk.update, 'RefReader');
    expect(refUpdate).toHaveLength(1);
    expect((refUpdate[0]![3] as Record<string, unknown>)['Value']).toBe('sg-new');
    expect(saved('RefReader')?.properties['Value']).toBe('sg-new');

    const getAttUpdate = callsFor(sdk.update, 'GetAttReader');
    expect(getAttUpdate).toHaveLength(1);
    expect((getAttUpdate[0]![3] as Record<string, unknown>)['Value']).toBe('sg-new');
    expect(saved('GetAttReader')?.properties['Value']).toBe('sg-new');

    // A resource reading nothing is left alone.
    for (const p of [sdk, cc]) {
      for (const fn of [p.create, p.update, p.delete]) {
        expect(callsFor(fn, 'Bystander')).toHaveLength(0);
      }
    }
    expect(result.updated).toBe(3);
    expect(result.unchanged).toBe(1);
  });

  it('counts the promoted readers in a --dry-run, and sends nothing', async () => {
    const result = await makeEngine({ dryRun: true }).deploy(STACK, TEMPLATE);

    expect(result.updated).toBe(3);
    expect(result.unchanged).toBe(1);
    for (const p of [sdk, cc]) {
      for (const fn of [p.create, p.update, p.delete]) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('sends nothing to the readers of a target the recreate gives back the SAME id, a create-only reader included', async () => {
    // The commonest `--recreate-via-*` target is addressed by name (a fixed
    // function name), so the recreate keeps its id. Every reader is promoted
    // all the same; `NamedBySg` (a topic, not stateful) reads it through the
    // create-only `TopicName`, so its promotion asks for a replacement. The
    // engine resolves each one, finds the record unchanged, lowers the
    // ceiling and skips the provider.
    cc.create.mockResolvedValue({ physicalId: 'sg-old', attributes: { GroupId: 'sg-old' } });
    const template: CloudFormationTemplate = {
      Resources: {
        ...TEMPLATE.Resources,
        NamedBySg: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'Sg' } },
        },
      },
    };
    const state = priorState();
    const named = { TopicName: 'sg-old' };
    state.resources['NamedBySg'] = {
      physicalId: 'arn:aws:sns:us-east-1:123456789012:sg-old',
      resourceType: 'AWS::SNS::Topic',
      properties: named,
      observedProperties: named,
      attributes: {},
      dependencies: ['Sg'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });

    // PREMISE: the readers really are promoted (the target and its three
    // readers plan as updates), so what follows is the engine's skip of a
    // promoted reader and not a reader the diff never sent.
    const plan = await makeEngine({ dryRun: true }).deploy(STACK, template);
    expect(plan.updated).toBe(4);
    expect(plan.unchanged).toBe(1);

    await makeEngine().deploy(STACK, template);

    // The target itself is still recreated.
    expect(callsFor(sdk.delete, 'Sg')).toHaveLength(1);
    expect(callsFor(cc.create, 'Sg')).toHaveLength(1);
    for (const id of ['RefReader', 'GetAttReader', 'NamedBySg', 'Bystander']) {
      for (const p of [sdk, cc]) {
        for (const fn of [p.create, p.update, p.delete]) {
          expect(callsFor(fn, id), id).toHaveLength(0);
        }
      }
    }
    expect(saved('NamedBySg')?.physicalId).toBe('arn:aws:sns:us-east-1:123456789012:sg-old');
    expect(saved('RefReader')?.properties['Value']).toBe('sg-old');
  });

  describe('a stateful reader holding the target in a create-only property', () => {
    // An EBS volume whose create-only `KmsKeyId` reads the recreated target:
    // the promotion's replacement ceiling stands (the id moved), so the volume
    // is REPLACED, which the stateful guard must still gate — after the diff
    // and before any provider call (`refuseStatefulReplacedReaders`).
    function arrangeVolume(): CloudFormationTemplate {
      const state = priorState();
      const props = { AvailabilityZone: 'us-east-1a', KmsKeyId: 'sg-old' };
      state.resources['Volume'] = {
        physicalId: 'vol-old',
        resourceType: 'AWS::EC2::Volume',
        properties: props,
        observedProperties: props,
        attributes: {},
        dependencies: ['Sg'],
        provisionedBy: 'sdk',
      } as ResourceState;
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      return {
        Resources: {
          ...TEMPLATE.Resources,
          Volume: {
            Type: 'AWS::EC2::Volume',
            Properties: { AvailabilityZone: 'us-east-1a', KmsKeyId: { Ref: 'Sg' } },
          },
        },
      };
    }

    it('without --force-stateful-recreation the deploy is refused before ANY provider call', async () => {
      const template = arrangeVolume();
      await expect(makeEngine().deploy(STACK, template)).rejects.toMatchObject({
        code: 'STATEFUL_REPLACE_BLOCKED',
      });
      // Nothing touched: not the volume, and not the target either, which the
      // replacement guard alone (mid-deploy) would have refused only after
      // the security group was already destroyed and recreated.
      for (const p of [sdk, cc]) {
        for (const fn of [p.create, p.update, p.delete]) expect(fn).not.toHaveBeenCalled();
      }
      expect(stateBackend.saveState).not.toHaveBeenCalled();
    });

    it('a --dry-run reports the same refusal', async () => {
      const template = arrangeVolume();
      await expect(makeEngine({ dryRun: true }).deploy(STACK, template)).rejects.toMatchObject({
        code: 'STATEFUL_REPLACE_BLOCKED',
      });
    });

    it('is not refused when the volume is condition-false (the deploy deletes it instead)', async () => {
      const template = arrangeVolume();
      template.Conditions = { WithVolume: { 'Fn::Equals': ['a', 'b'] } };
      template.Resources['Volume']!.Condition = 'WithVolume';
      const result = await makeEngine({ dryRun: true }).deploy(STACK, template);
      expect(result.deleted).toBe(1);
    });

    it('with --force-stateful-recreation the volume is replaced against the new id', async () => {
      const template = arrangeVolume();
      sdk.create.mockImplementation((logicalId: string) =>
        Promise.resolve(
          logicalId === 'Volume'
            ? { physicalId: 'vol-new', attributes: {} }
            : { physicalId: 'sg-new', attributes: { GroupId: 'sg-new' } }
        )
      );
      await makeEngine({ forceStatefulRecreation: true }).deploy(STACK, template);

      const created = callsFor(sdk.create, 'Volume');
      expect(created).toHaveLength(1);
      expect((created[0]![2] as Record<string, unknown>)['KmsKeyId']).toBe('sg-new');
      expect(callsFor(sdk.delete, 'Volume')).toHaveLength(1);
      expect(saved('Volume')?.physicalId).toBe('vol-new');
    });
  });

  describe('a stateful parameter whose create-only Name embeds the target id (round 3)', () => {
    // `AWS::SSM::Parameter` is stateful, and `Name` is create-only. On main a
    // recreate of a target that keeps its id sent nothing to such a reader;
    // the early refusal must not take that away.
    function arrange(target: {
      type: string;
      properties: Record<string, unknown>;
      physicalId: string;
    }): CloudFormationTemplate {
      const state = priorState();
      state.resources['Sg'] = {
        physicalId: target.physicalId,
        resourceType: target.type,
        properties: target.properties,
        observedProperties: target.properties,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      } as ResourceState;
      const props = { Name: `/app/${target.physicalId}`, Type: 'String', Value: 'v' };
      state.resources['Param'] = {
        physicalId: props.Name,
        resourceType: PARAM_TYPE,
        properties: props,
        observedProperties: props,
        attributes: {},
        dependencies: ['Sg'],
        provisionedBy: 'sdk',
      } as ResourceState;
      stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      return {
        Resources: {
          Sg: { Type: target.type, Properties: target.properties },
          Param: {
            Type: PARAM_TYPE,
            Properties: { Name: { 'Fn::Sub': '/app/${Sg}' }, Type: 'String', Value: 'v' },
          },
        },
      };
    }

    it('a fixed-name function that keeps its id: not refused, and nothing is sent to the parameter', async () => {
      const template = arrange({
        type: 'AWS::Lambda::Function',
        properties: { FunctionName: 'my-fn' },
        physicalId: 'my-fn',
      });
      cc.create.mockResolvedValue({ physicalId: 'my-fn', attributes: {} });
      await makeEngine().deploy(STACK, template);

      expect(callsFor(sdk.delete, 'Sg')).toHaveLength(1);
      expect(callsFor(cc.create, 'Sg')).toHaveLength(1);
      for (const p of [sdk, cc]) {
        for (const fn of [p.create, p.update, p.delete]) {
          expect(callsFor(fn, 'Param')).toHaveLength(0);
        }
      }
      expect(saved('Param')?.physicalId).toBe('/app/my-fn');
    });

    it('an AWS-assigned id: refused before any provider call', async () => {
      const template = arrange({
        type: SG_TYPE,
        properties: { GroupDescription: 'sg' },
        physicalId: 'sg-old',
      });
      await expect(makeEngine().deploy(STACK, template)).rejects.toMatchObject({
        code: 'STATEFUL_REPLACE_BLOCKED',
      });
      for (const p of [sdk, cc]) {
        for (const fn of [p.create, p.update, p.delete]) expect(fn).not.toHaveBeenCalled();
      }
    });
  });

  it('promotes nothing when the targets were validated against ANOTHER stack', async () => {
    // A nested child engine receives the parent's option bag; neither the
    // target nor its readers in THIS stack are touched.
    const result = await makeEngine({ dryRun: true, targetStack: 'SomeOtherStack' }).deploy(
      STACK,
      TEMPLATE
    );

    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(4);
  });
});
