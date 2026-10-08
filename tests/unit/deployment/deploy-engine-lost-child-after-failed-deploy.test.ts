/**
 * go-to-k/cdkd#4443 (scaffold shared with the #4411 file): a FAILED deploy
 * forgets the state record of a child that went with a parent it re-created
 * under the same id, when it never restored it, so the next deploy creates it.
 *
 * Below, the #4411 setting: a resource AWS stores INSIDE a parent the deploy destroys
 * and re-creates under the same physical id is re-created with it.
 *
 * The shape: a fixed-name Lambda function recreated by `--recreate-via-cc-api`
 * (delete-first, since the name is the id) and its `AWS::Lambda::Permission`.
 * Deleting the function deletes its resource-based policy, so the permission
 * is gone, while its `FunctionName` resolves to exactly what the record holds:
 * the engine's no-op skip sent nothing and state kept a permission AWS no
 * longer had.
 *
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator`,
 * `DagBuilder` and `IntrinsicFunctionResolver`; only the providers are doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';

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

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'lost-child-after-failed-deploy-stack';
const REGION = 'us-east-1';
const FN_TYPE = 'AWS::Lambda::Function';
const PERMISSION_TYPE = 'AWS::Lambda::Permission';
const PARAM_TYPE = 'AWS::SSM::Parameter';
const FN_PROPS = { FunctionName: 'my-fn', Runtime: 'nodejs22.x' };
const PERMISSION_PROPS = {
  Action: 'lambda:InvokeFunction',
  FunctionName: 'my-fn',
  Principal: 'sns.amazonaws.com',
};
const PERMISSION_ID = 'stack-Perm-ABC';

function template(): CloudFormationTemplate {
  return {
    Resources: {
      Fn: {
        Type: FN_TYPE,
        Properties: { ...FN_PROPS },
      },
      Perm: {
        Type: PERMISSION_TYPE,
        Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
      },
      // Reads the function too, but is not stored inside it: a parameter's
      // value survives the function's delete.
      Param: {
        Type: PARAM_TYPE,
        Properties: { Name: 'p', Type: 'String', Value: { Ref: 'Fn' } },
      },
    },
  };
}

function priorState(): StackState {
  const rec = (
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    dependencies: string[]
  ): ResourceState =>
    ({
      physicalId,
      resourceType,
      properties,
      observedProperties: properties,
      attributes: {},
      dependencies,
      provisionedBy: 'sdk',
    }) as ResourceState;
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Fn: rec('my-fn', FN_TYPE, FN_PROPS, []),
      Perm: rec(PERMISSION_ID, PERMISSION_TYPE, PERMISSION_PROPS, ['Fn']),
      Param: rec('p', PARAM_TYPE, { Name: 'p', Type: 'String', Value: 'my-fn' }, ['Fn']),
    },
    outputs: {},
    lastModified: 0,
  };
}

type Provider = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;

function makeProvider(): Provider {
  return {
    create: vi.fn((logicalId: string) =>
      Promise.resolve(
        logicalId === 'Fn'
          ? // A fixed name: the recreated function keeps its id.
            { physicalId: 'my-fn', attributes: {} }
          : { physicalId: `${logicalId}-new`, attributes: {} }
      )
    ),
    update: vi.fn((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}


describe('DeployEngine - a failed deploy forgets the children it never restored (go-to-k/cdkd#4443)', () => {
  let sdk: Provider;
  let cc: Provider;
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    listStacks: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider();
    cc = makeProvider();
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: priorState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      listStacks: vi.fn().mockResolvedValue([]),
    };
  });

  function makeEngine(
    options: Record<string, unknown> = {},
    providerType: 'sdk' | 'cloud-control' = 'sdk'
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
        getProviderType: vi.fn().mockReturnValue(providerType),
      } as never,
      {
        dryRun: false,
        recreateTargets: {
          stackName: STACK,
          viaCcApi: new Set(['Fn']),
          viaSdkProvider: new Set<string>(),
        },
        ...options,
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  function lastSaved(): StackState {
    const calls = stateBackend.saveState.mock.calls;
    return calls[calls.length - 1]![2] as StackState;
  }

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);

  /**
   * The permission waits on `Sib` (DependsOn), which reads the function and
   * whose update fails: the function is recreated, then the deploy fails before
   * the permission is reached.
   */
  function failingTemplate(): CloudFormationTemplate {
    const t = template();
    t.Resources['Sib'] = {
      Type: PARAM_TYPE,
      Properties: { Name: 'sib', Type: 'String', Value: { 'Fn::Join': ['', [{ Ref: 'Fn' }, '-v2']] } },
    };
    t.Resources['Perm']!.DependsOn = ['Sib'];
    return t;
  }

  function stateWithSibling(): StackState {
    const state = priorState();
    const props = { Name: 'sib', Type: 'String', Value: 'my-fn-v1' };
    state.resources['Sib'] = {
      physicalId: 'sib',
      resourceType: PARAM_TYPE,
      properties: props,
      observedProperties: props,
      attributes: {},
      dependencies: ['Fn'],
      provisionedBy: 'sdk',
    } as ResourceState;
    return state;
  }

  function sibFails(): void {
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Sib'
        ? Promise.reject(new Error('ValidationException: forced sibling failure'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
  }

  for (const noRollback of [false, true]) {
    it(`drops the permission's record when the deploy fails before restoring it (noRollback=${noRollback}), and the next deploy creates it`, async () => {
      stateBackend.getState.mockResolvedValue({ state: stateWithSibling(), etag: 'etag-old' });
      sibFails();

      await expect(makeEngine({ noRollback }).deploy(STACK, failingTemplate())).rejects.toThrow();

      // The function was recreated under its id; the permission never ran.
      expect(callsFor(cc.create, 'Fn')).toHaveLength(1);
      for (const p of [sdk, cc]) expect(callsFor(p.create, 'Perm')).toHaveLength(0);
      const saved = lastSaved();
      expect(saved.resources['Fn']?.physicalId).toBe('my-fn');
      expect(Object.hasOwn(saved.resources, 'Perm')).toBe(false);
      // Every state write after the failure omits it, not only the last.
      const afterFailure = stateBackend.saveState.mock.calls
        .map((c) => c[2] as StackState)
        .filter((st) => st.resources['Fn'] !== undefined && !Object.hasOwn(st.resources, 'Perm'));
      expect(afterFailure.length).toBeGreaterThan(0);

      // The next deploy, from what was saved, creates the permission again.
      vi.clearAllMocks();
      sdk = makeProvider();
      cc = makeProvider();
      stateBackend.getState.mockResolvedValue({ state: saved, etag: 'etag-2' });
      const second = new DeployEngine(
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
        { dryRun: false } as never,
        REGION,
        {
          updateForStack: vi.fn().mockResolvedValue(undefined),
          lookup: vi.fn().mockResolvedValue(null),
          patchEntry: vi.fn().mockResolvedValue(undefined),
        } as never
      );
      await second.deploy(STACK, failingTemplate());
      const created = [...callsFor(sdk.create, 'Perm'), ...callsFor(cc.create, 'Perm')];
      expect(created).toHaveLength(1);
      expect((created[0]![2] as Record<string, unknown>)['FunctionName']).toBe('my-fn');
    });
  }

  it('keeps the record of a child the deploy restored before it failed', async () => {
    stateBackend.getState.mockResolvedValue({ state: stateWithSibling(), etag: 'etag-old' });
    sibFails();
    // No DependsOn: the permission is restored first, then the sibling fails.
    const t = failingTemplate();
    delete t.Resources['Perm']!.DependsOn;
    t.Resources['Sib']!.DependsOn = ['Perm'];

    // --no-rollback, so the record is the deploy's own and nothing reverts it.
    await expect(makeEngine({ noRollback: true }).deploy(STACK, t)).rejects.toThrow();

    expect(callsFor(sdk.create, 'Perm')).toHaveLength(1);
    expect(lastSaved().resources['Perm']?.physicalId).toBe('Perm-new');
  });

  it('keeps the record of a child still recorded on ANOTHER parent (being moved onto the recreated one)', async () => {
    const state = stateWithSibling();
    state.resources['FnB'] = {
      physicalId: 'fn-b',
      resourceType: FN_TYPE,
      properties: { FunctionName: 'fn-b' },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    } as ResourceState;
    state.resources['Perm'] = { ...state.resources['Perm']!, properties: { ...PERMISSION_PROPS, FunctionName: 'fn-b' } };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    sibFails();
    const t = failingTemplate();
    t.Resources['FnB'] = { Type: FN_TYPE, Properties: { FunctionName: 'fn-b' } };

    await expect(makeEngine().deploy(STACK, t)).rejects.toThrow();

    // Its statement still lives on fn-b: forgetting it would orphan it.
    expect(lastSaved().resources['Perm']?.properties['FunctionName']).toBe('fn-b');
  });

  for (const noRollback of [false, true]) {
    it(`keeps the record of a child this deploy CREATED on the recreated parent before failing (noRollback=${noRollback})`, async () => {
      stateBackend.getState.mockResolvedValue({ state: stateWithSibling(), etag: 'etag-old' });
      sibFails();
      const t = failingTemplate();
      delete t.Resources['Perm']!.DependsOn;
      t.Resources['NewPerm'] = {
        Type: PERMISSION_TYPE,
        Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
      };
      t.Resources['Sib']!.DependsOn = ['Perm', 'NewPerm'];

      await expect(makeEngine({ noRollback }).deploy(STACK, t)).rejects.toThrow();

      expect(callsFor(sdk.create, 'NewPerm')).toHaveLength(1);
      if (noRollback) {
        // Live in AWS, so it keeps its record.
        expect(lastSaved().resources['NewPerm']?.physicalId).toBe('NewPerm-new');
      } else {
        // The rollback still knows it, and deletes what it created.
        expect(callsFor(sdk.delete, 'NewPerm')).toHaveLength(1);
      }
    });
  }

  it('keeps the record of a child this deploy MOVED onto the recreated parent before failing', async () => {
    const state = stateWithSibling();
    state.resources['FnB'] = {
      physicalId: 'fn-b',
      resourceType: FN_TYPE,
      properties: { FunctionName: 'fn-b' },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    } as ResourceState;
    state.resources['Perm'] = {
      ...state.resources['Perm']!,
      properties: { ...PERMISSION_PROPS, FunctionName: 'fn-b' },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    sibFails();
    const t = failingTemplate();
    t.Resources['FnB'] = { Type: FN_TYPE, Properties: { FunctionName: 'fn-b' } };
    delete t.Resources['Perm']!.DependsOn;
    t.Resources['Sib']!.DependsOn = ['Perm'];

    await expect(makeEngine({ noRollback: true }).deploy(STACK, t)).rejects.toThrow();

    // Moved: created on my-fn, deleted from fn-b, and recorded on my-fn.
    expect(callsFor(sdk.create, 'Perm')).toHaveLength(1);
    expect(lastSaved().resources['Perm']?.physicalId).toBe('Perm-new');
  });

  it('keeps the record of a child whose own write was attempted and then threw (it may be live)', async () => {
    stateBackend.getState.mockResolvedValue({ state: stateWithSibling(), etag: 'etag-old' });
    sdk.create.mockImplementation((logicalId: string) =>
      logicalId === 'Perm'
        ? Promise.reject(
            Object.assign(new Error('The policy is malformed'), {
              name: 'MalformedPolicyDocumentException',
            })
          )
        : Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} })
    );
    const t = failingTemplate();
    delete t.Resources['Perm']!.DependsOn;
    delete t.Resources['Sib'];

    await expect(makeEngine({ noRollback: true }).deploy(STACK, t)).rejects.toThrow();

    expect(callsFor(sdk.create, 'Perm').length).toBeGreaterThan(0);
    // A definite AWS rejection is not marked refused-before-applying (only EC2
    // marks one), so the op journals an attempted bag and the record is kept...
    expect(lastSaved().resources['Perm']?.physicalId).toBe(PERMISSION_ID);
    // ...and said so, with the way back.
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(
      warned.some(
        (line) =>
          line.includes('Perm (AWS::Lambda::Permission)') &&
          line.includes('state record is kept because the write may have reached AWS') &&
          line.includes('--recreate-via-cc-api Perm (which moves it to Cloud Control) to write it again')
      )
    ).toBe(true);
  });

  it('drops the grandchild too: a permission on an alias of the recreated function, when the deploy fails before the alias', async () => {
    const aliasArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn:live';
    const state = stateWithSibling();
    const aliasProps = { FunctionName: 'my-fn', FunctionVersion: '$LATEST', Name: 'live' };
    state.resources['Alias'] = {
      physicalId: aliasArn,
      resourceType: 'AWS::Lambda::Alias',
      properties: aliasProps,
      attributes: {},
      dependencies: ['Fn'],
      provisionedBy: 'sdk',
    } as ResourceState;
    state.resources['AliasPerm'] = {
      physicalId: 'stack-AliasPerm-X',
      resourceType: PERMISSION_TYPE,
      properties: { ...PERMISSION_PROPS, FunctionName: aliasArn },
      attributes: {},
      dependencies: ['Alias'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    sibFails();
    const t = failingTemplate();
    t.Resources['Alias'] = {
      Type: 'AWS::Lambda::Alias',
      Properties: { ...aliasProps, FunctionName: { Ref: 'Fn' } },
      DependsOn: ['Sib'],
    };
    t.Resources['AliasPerm'] = {
      Type: PERMISSION_TYPE,
      Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Alias' } },
    };

    await expect(makeEngine({ noRollback: true }).deploy(STACK, t)).rejects.toThrow();

    const saved = lastSaved();
    expect(Object.hasOwn(saved.resources, 'Alias')).toBe(false);
    expect(Object.hasOwn(saved.resources, 'AliasPerm')).toBe(false);
  });

  it('forgets a re-put topic policy recorded on Cloud Control even after its (empty) update returned', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const policyProps = { Topics: [topicArn], PolicyDocument: { Statement: [] } };
    const sibProps = { Name: 'sib', Type: 'String', Value: 'v1' };
    const state: StackState = {
      ...priorState(),
      resources: {
        Topic: {
          physicalId: topicArn,
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'my-topic' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Policy: {
          physicalId: 'stack-Policy-X',
          resourceType: 'AWS::SNS::TopicPolicy',
          properties: policyProps,
          attributes: {},
          dependencies: ['Topic'],
          provisionedBy: 'cc-api',
        } as ResourceState,
        Sib: {
          physicalId: 'sib',
          resourceType: PARAM_TYPE,
          properties: sibProps,
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: topicArn, attributes: {} });
    // The provider's own word: its patch from record to template was empty.
    cc.update.mockImplementation((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false, sentNothing: true })
    );
    sibFails();
    const t: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
        Policy: {
          Type: 'AWS::SNS::TopicPolicy',
          Properties: { ...policyProps, Topics: [{ Ref: 'Topic' }] },
        },
        Sib: {
          Type: PARAM_TYPE,
          Properties: { ...sibProps, Value: 'v2' },
          DependsOn: ['Policy'],
        },
      },
    };
    await expect(
      makeEngine({
        noRollback: true,
        recreateTargets: { stackName: STACK, viaCcApi: new Set(['Topic']), viaSdkProvider: new Set() },
      }).deploy(STACK, t)
    ).rejects.toThrow();

    // Its update ran (and sent nothing), then the deploy failed.
    expect(callsFor(cc.update, 'Policy')).toHaveLength(1);
    expect(Object.hasOwn(lastSaved().resources, 'Policy')).toBe(false);
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('its update sent no change'))).toBe(true);
  });

  it('keeps a re-put topic policy whose template equals its record but whose provider still wrote (a secret leaf: redacted-equal, plaintext-different)', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const policyProps = { Topics: [topicArn], PolicyDocument: { Statement: [] } };
    const sibProps = { Name: 'sib', Type: 'String', Value: 'v1' };
    const state: StackState = {
      ...priorState(),
      resources: {
        Topic: {
          physicalId: topicArn,
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'my-topic' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Policy: {
          physicalId: 'stack-Policy-X',
          resourceType: 'AWS::SNS::TopicPolicy',
          properties: policyProps,
          attributes: {},
          dependencies: ['Topic'],
          provisionedBy: 'cc-api',
        } as ResourceState,
        Sib: {
          physicalId: 'sib',
          resourceType: PARAM_TYPE,
          properties: sibProps,
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: topicArn, attributes: {} });
    // The provider's own word: its patch from record to template was empty.
    cc.update.mockImplementation((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    );
    sibFails();
    const t: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
        Policy: {
          Type: 'AWS::SNS::TopicPolicy',
          Properties: { ...policyProps, Topics: [{ Ref: 'Topic' }] },
        },
        Sib: {
          Type: PARAM_TYPE,
          Properties: { ...sibProps, Value: 'v2' },
          DependsOn: ['Policy'],
        },
      },
    };
    await expect(
      makeEngine({
        noRollback: true,
        recreateTargets: { stackName: STACK, viaCcApi: new Set(['Topic']), viaSdkProvider: new Set() },
      }).deploy(STACK, t)
    ).rejects.toThrow();

    // Its update ran (and sent nothing), then the deploy failed.
    expect(callsFor(cc.update, 'Policy')).toHaveLength(1);
    // The mark comes from the provider, never from a parallel comparison.
    expect(lastSaved().resources['Policy']?.physicalId).toBe('stack-Policy-X');
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('its update sent no change'))).toBe(false);
  });

  it('keeps a re-put topic policy recorded on Cloud Control whose update threw BEFORE the provider could say it sent nothing', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const policyProps = { Topics: [topicArn], PolicyDocument: { Statement: [] } };
    const sibProps = { Name: 'sib', Type: 'String', Value: 'v1' };
    const state: StackState = {
      ...priorState(),
      resources: {
        Topic: {
          physicalId: topicArn,
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'my-topic' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Policy: {
          physicalId: 'stack-Policy-X',
          resourceType: 'AWS::SNS::TopicPolicy',
          properties: policyProps,
          attributes: {},
          dependencies: ['Topic'],
          provisionedBy: 'cc-api',
        } as ResourceState,
        Sib: {
          physicalId: 'sib',
          resourceType: PARAM_TYPE,
          properties: sibProps,
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: topicArn, attributes: {} });
    sibFails();
    cc.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Policy'
        ? // A shape the real provider produces before its empty-patch return:
          // reading a referenced value it compares was refused.
          Promise.reject(new Error('AccessDeniedException: not authorized to read the reference'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const t: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
        Policy: {
          Type: 'AWS::SNS::TopicPolicy',
          Properties: { ...policyProps, Topics: [{ Ref: 'Topic' }] },
        },
        Sib: {
          Type: PARAM_TYPE,
          Properties: { ...sibProps, Value: 'v2' },
          DependsOn: ['Policy'],
        },
      },
    };
    await expect(
      makeEngine({
        noRollback: true,
        recreateTargets: { stackName: STACK, viaCcApi: new Set(['Topic']), viaSdkProvider: new Set() },
      }).deploy(STACK, t)
    ).rejects.toThrow();

    expect(callsFor(cc.update, 'Policy').length).toBeGreaterThan(0);
    expect(lastSaved().resources['Policy']?.physicalId).toBe('stack-Policy-X');
    // The recovery a record on Cloud Control accepts: back to the SDK route.
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(
      warned.some(
        (line) =>
          line.includes('state record is kept') &&
          line.includes('--recreate-via-sdk-provider Policy (adding the --prefer-sdk-route') &&
          line.includes('to write it again')
      )
    ).toBe(true);
    expect(warned.some((line) => line.includes('--recreate-via-cc-api Policy'))).toBe(false);
  });

  it('keeps a re-put topic policy recorded on Cloud Control whose provider reports a write (its document also changed)', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const policyProps = { Topics: [topicArn], PolicyDocument: { Statement: [] } };
    const sibProps = { Name: 'sib', Type: 'String', Value: 'v1' };
    const state: StackState = {
      ...priorState(),
      resources: {
        Topic: {
          physicalId: topicArn,
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'my-topic' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Policy: {
          physicalId: 'stack-Policy-X',
          resourceType: 'AWS::SNS::TopicPolicy',
          properties: policyProps,
          attributes: {},
          dependencies: ['Topic'],
          provisionedBy: 'cc-api',
        } as ResourceState,
        Sib: {
          physicalId: 'sib',
          resourceType: PARAM_TYPE,
          properties: sibProps,
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: topicArn, attributes: {} });
    sibFails();
    const t: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
        Policy: {
          Type: 'AWS::SNS::TopicPolicy',
          Properties: {
            ...policyProps,
            Topics: [{ Ref: 'Topic' }],
            PolicyDocument: { Statement: [{ Effect: 'Deny' }] },
          },
        },
        Sib: {
          Type: PARAM_TYPE,
          Properties: { ...sibProps, Value: 'v2' },
          DependsOn: ['Policy'],
        },
      },
    };
    await expect(
      makeEngine({
        noRollback: true,
        recreateTargets: { stackName: STACK, viaCcApi: new Set(['Topic']), viaSdkProvider: new Set() },
      }).deploy(STACK, t)
    ).rejects.toThrow();

    expect(callsFor(cc.update, 'Policy')).toHaveLength(1);
    expect(lastSaved().resources['Policy']?.physicalId).toBe('stack-Policy-X');
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('whose update sends no change'))).toBe(false);
  });

  // The real predicates decide these two: `AWS::IAM::Policy` has no Cloud
  // Control handlers (`hasNoCloudControlHandlers`), `AWS::Lambda::EventInvokeConfig`
  // is 'cc-broken' (`ccBrokenReason`), and both are SDK-recorded, so no
  // --recreate-via-* flag is accepted for them.
  it('forgets an SDK IAM policy whose re-put threw: no recovery flag would be accepted', async () => {
    const policyProps = { PolicyName: 'deny-all', Roles: ['fixed-role'], PolicyDocument: { Statement: [] } };
    const state: StackState = {
      ...priorState(),
      resources: {
        Role: {
          physicalId: 'fixed-role',
          resourceType: 'AWS::IAM::Role',
          properties: { RoleName: 'fixed-role' },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Policy: {
          physicalId: 'deny-all',
          resourceType: 'AWS::IAM::Policy',
          properties: policyProps,
          attributes: {},
          dependencies: ['Role'],
          provisionedBy: 'sdk',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: 'fixed-role', attributes: {} });
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Policy'
        ? Promise.reject(
            Object.assign(new Error('The policy is malformed'), {
              name: 'MalformedPolicyDocumentException',
            })
          )
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const t: CloudFormationTemplate = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'fixed-role' } },
        Policy: {
          Type: 'AWS::IAM::Policy',
          Properties: { ...policyProps, Roles: [{ Ref: 'Role' }] },
        },
      },
    };
    await expect(
      makeEngine({
        noRollback: true,
        recreateTargets: { stackName: STACK, viaCcApi: new Set(['Role']), viaSdkProvider: new Set() },
      }).deploy(STACK, t)
    ).rejects.toThrow();

    expect(callsFor(sdk.update, 'Policy').length).toBeGreaterThan(0);
    expect(Object.hasOwn(lastSaved().resources, 'Policy')).toBe(false);
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('--recreate-via-cc-api Policy'))).toBe(false);
    expect(warned.some((line) => line.includes('--recreate-via-sdk-provider Policy'))).toBe(false);
    expect(
      warned.some((line) => line.includes('Its write may still be on Role (fixed-role)'))
    ).toBe(true);
  });

  it('forgets an SDK EventInvokeConfig whose re-create threw: its type is cc-broken', async () => {
    const state = stateWithSibling();
    const eicProps = { FunctionName: 'my-fn', Qualifier: '$LATEST', MaximumRetryAttempts: 0 };
    state.resources['Eic'] = {
      physicalId: 'my-fn|$LATEST',
      resourceType: 'AWS::Lambda::EventInvokeConfig',
      properties: eicProps,
      attributes: {},
      dependencies: ['Fn'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    sdk.create.mockImplementation((logicalId: string) =>
      logicalId === 'Eic'
        ? Promise.reject(
            Object.assign(new Error('Invalid destination'), {
              name: 'InvalidParameterValueException',
            })
          )
        : Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} })
    );
    const t = failingTemplate();
    delete t.Resources['Sib'];
    delete t.Resources['Perm']!.DependsOn;
    t.Resources['Eic'] = {
      Type: 'AWS::Lambda::EventInvokeConfig',
      Properties: { ...eicProps, FunctionName: { Ref: 'Fn' } },
    };

    await expect(makeEngine({ noRollback: true }).deploy(STACK, t)).rejects.toThrow();

    expect(callsFor(sdk.create, 'Eic').length).toBeGreaterThan(0);
    expect(Object.hasOwn(lastSaved().resources, 'Eic')).toBe(false);
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('--recreate-via-cc-api Eic'))).toBe(false);
  });
  it('forgets a Cloud Control-only metric filter whose re-create threw: no SDK provider takes the flag', async () => {
    // A metric filter has no SDK provider, so it is always recorded on Cloud
    // Control and --recreate-via-sdk-provider is refused for it.
    const groupName = '/fixed/group';
    const filterProps = { LogGroupName: groupName, FilterPattern: 'ERROR', MetricTransformations: [] };
    const state: StackState = {
      ...priorState(),
      resources: {
        Group: {
          physicalId: groupName,
          resourceType: 'AWS::Logs::LogGroup',
          properties: { LogGroupName: groupName },
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Filter: {
          physicalId: 'stack-Filter-X',
          resourceType: 'AWS::Logs::MetricFilter',
          properties: filterProps,
          attributes: {},
          dependencies: ['Group'],
          provisionedBy: 'cc-api',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    // Whichever route the re-create takes, AWS rejects it.
    const rejectFilter = (logicalId: string) =>
      logicalId === 'Filter'
        ? Promise.reject(
            Object.assign(new Error('Invalid filter pattern'), {
              name: 'InvalidParameterException',
            })
          )
        : Promise.resolve({ physicalId: groupName, attributes: {} });
    cc.create.mockImplementation(rejectFilter);
    sdk.create.mockImplementation(rejectFilter);
    const t: CloudFormationTemplate = {
      Resources: {
        Group: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: groupName } },
        Filter: {
          Type: 'AWS::Logs::MetricFilter',
          Properties: { ...filterProps, LogGroupName: { Ref: 'Group' } },
        },
      },
    };
    await expect(
      makeEngine(
        {
          noRollback: true,
          recreateTargets: { stackName: STACK, viaCcApi: new Set(['Group']), viaSdkProvider: new Set() },
        },
        'cloud-control'
      ).deploy(STACK, t)
    ).rejects.toThrow();

    expect([...callsFor(cc.create, 'Filter'), ...callsFor(sdk.create, 'Filter')].length).toBeGreaterThan(0);
    expect(Object.hasOwn(lastSaved().resources, 'Filter')).toBe(false);
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('--recreate-via-sdk-provider'))).toBe(false);
    expect(warned.some((line) => line.includes('state record is kept'))).toBe(false);
    // Its create was attempted, so the write may be live on the group.
    expect(
      warned.some(
        (line) =>
          line.includes('Filter (AWS::Logs::MetricFilter)') &&
          line.includes('Its write may still be on Group (/fixed/group)') &&
          line.includes('remove it from that resource by hand')
      )
    ).toBe(true);
  });
});
