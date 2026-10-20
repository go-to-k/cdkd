/**
 * go-to-k/cdkd#4411: a resource AWS stores INSIDE a parent the deploy destroys
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

const STACK = 'child-of-recreated-parent-stack';
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

describe('DeployEngine - a child stored inside a parent recreated under the same id (go-to-k/cdkd#4411)', () => {
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

  function makeEngine(target = 'Fn', extra: Record<string, unknown> = {}): DeployEngine {
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
        dryRun: false,
        recreateTargets: {
          stackName: STACK,
          viaCcApi: new Set([target]),
          viaSdkProvider: new Set<string>(),
        },
        ...extra,
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
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

  it('re-creates the permission the recreated function took with it, and deletes nothing of it', async () => {
    await makeEngine().deploy(STACK, template());

    // The parent: destroyed on its SDK layer, created on Cloud Control,
    // under the same id.
    expect(callsFor(sdk.delete, 'Fn')).toHaveLength(1);
    expect(callsFor(cc.create, 'Fn')).toHaveLength(1);
    expect(saved('Fn')?.physicalId).toBe('my-fn');

    // The permission: created again on the new function...
    const created = callsFor(sdk.create, 'Perm');
    expect(created).toHaveLength(1);
    expect((created[0]![2] as Record<string, unknown>)['FunctionName']).toBe('my-fn');
    // ...never deleted: the old statement went with the old function, and a
    // delete keyed by the same statement would remove the new one.
    for (const p of [sdk, cc]) expect(callsFor(p.delete, 'Perm')).toHaveLength(0);
    expect(saved('Perm')?.physicalId).toBe('Perm-new');
  });

  // go-to-k/cdkd#5064 phase 2: a child that went with its re-created parent is
  // re-created under the name it had: its generation does not move.
  it('on a stack with an instance id, the lost child keeps its name generation', async () => {
    const state = priorState();
    state.stackInstanceId = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    state.resources['Perm']!.nameGeneration = 2;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    await makeEngine().deploy(STACK, template());
    expect(callsFor(sdk.create, 'Perm')).toHaveLength(1);
    expect(saved('Perm')?.nameGeneration).toBe(2);
    expect(saved('Perm')?.nameGenerationHigh).toBeUndefined();
  });

  // go-to-k/cdkd#4604: both arms deleted (or lost) the old resource before
  // the create — the recreated function, and the permission that went with it.
  it('records each resource whose old copy was gone before its create', async () => {
    const engine = makeEngine();
    await engine.deploy(STACK, template());
    const gone = (
      engine as unknown as { replacementRun: { oldDeletedBeforeCreate: Set<string> } }
    ).replacementRun.oldDeletedBeforeCreate;
    expect([...gone].sort()).toEqual(['Fn', 'Perm']);
  });

  // go-to-k/cdkd#4690: both are journaled as delete-first, so a rollback
  // deletes their new copies before re-creating the old ones.
  it('journals the recreate and the lost child as delete-first when a later op fails', async () => {
    const journal = {
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      listStacks: vi.fn().mockResolvedValue([]),
    };
    Object.assign(stateBackend, journal);
    sdk.create.mockImplementation((logicalId: string) =>
      logicalId === 'Late'
        ? Promise.reject(new Error('create failed: Late'))
        : Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} })
    );
    const t = template();
    t.Resources['Late'] = { Type: 'AWS::SNS::Topic', Properties: {}, DependsOn: ['Perm'] };
    await expect(makeEngine('Fn', { noRollback: true }).deploy(STACK, t)).rejects.toThrow();
    const seg = journal.appendRollbackJournalSegment.mock.calls.at(-1)![2] as {
      operations: Array<{ logicalId: string; oldDeletedBeforeCreate?: boolean }>;
    };
    const stamp = (id: string): boolean | undefined =>
      seg.operations.find((o) => o.logicalId === id)?.oldDeletedBeforeCreate;
    expect(stamp('Fn')).toBe(true);
    expect(stamp('Perm')).toBe(true);
  });

  it('leaves alone a reader that is not stored inside the function', async () => {
    await makeEngine().deploy(STACK, template());
    for (const p of [sdk, cc]) {
      for (const fn of [p.create, p.update, p.delete]) {
        expect(callsFor(fn, 'Param')).toHaveLength(0);
      }
    }
  });

  it('does nothing extra when the recreate gives the function a new id (its readers move anyway)', async () => {
    cc.create.mockImplementation((logicalId: string) =>
      Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} })
    );
    await makeEngine().deploy(STACK, template());
    // The permission's `FunctionName` moved, so the ordinary path already
    // sends it on: whichever call that is carries the new function, and the
    // engine never treats the old one as gone with its parent.
    // `create(logicalId, type, props)`, `update(logicalId, id, type, props, ...)`.
    const sent = [
      ...callsFor(sdk.create, 'Perm').map((c) => c[2]),
      ...callsFor(sdk.update, 'Perm').map((c) => c[3]),
    ] as Array<Record<string, unknown>>;
    expect(sent.length).toBeGreaterThan(0);
    for (const props of sent) expect(props['FunctionName']).toBe('Fn-new');
  });

  const record = (
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    dependencies: string[] = []
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

  it('re-creates a permission held by an ALIAS, which went with the recreated function too', async () => {
    const alias = { FunctionName: 'my-fn', FunctionVersion: '$LATEST', Name: 'live' };
    const aliasArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn:live';
    const state = priorState();
    state.resources['Alias'] = record(aliasArn, 'AWS::Lambda::Alias', alias, ['Fn']);
    state.resources['AliasPerm'] = record(
      'stack-AliasPerm-X',
      PERMISSION_TYPE,
      { ...PERMISSION_PROPS, FunctionName: aliasArn },
      ['Alias']
    );
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    // The alias comes back under the same ARN.
    sdk.create.mockImplementation((logicalId: string) =>
      Promise.resolve({
        physicalId: logicalId === 'Alias' ? aliasArn : `${logicalId}-new`,
        attributes: {},
      })
    );
    const t = template();
    t.Resources['Alias'] = {
      Type: 'AWS::Lambda::Alias',
      Properties: { ...alias, FunctionName: { Ref: 'Fn' } },
    };
    t.Resources['AliasPerm'] = {
      Type: PERMISSION_TYPE,
      Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Alias' } },
    };
    await makeEngine().deploy(STACK, t);

    expect(callsFor(sdk.create, 'Alias')).toHaveLength(1);
    expect(callsFor(sdk.create, 'AliasPerm')).toHaveLength(1);
    for (const p of [sdk, cc]) {
      expect(callsFor(p.delete, 'Alias')).toHaveLength(0);
      expect(callsFor(p.delete, 'AliasPerm')).toHaveLength(0);
    }
  });

  it('re-puts a topic policy, which names its topics, in place rather than re-creating it', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const policyProps = { Topics: [topicArn], PolicyDocument: { Statement: [] } };
    const state: StackState = {
      ...priorState(),
      resources: {
        Topic: record(topicArn, 'AWS::SNS::Topic', { TopicName: 'my-topic' }),
        Policy: record('stack-Policy-X', 'AWS::SNS::TopicPolicy', policyProps, ['Topic']),
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: topicArn, attributes: {} });
    const t: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
        Policy: {
          Type: 'AWS::SNS::TopicPolicy',
          Properties: { ...policyProps, Topics: [{ Ref: 'Topic' }] },
        },
      },
    };
    await makeEngine('Topic').deploy(STACK, t);

    expect(callsFor(cc.create, 'Topic')).toHaveLength(1);
    // The unchanged policy is written again, through its update...
    const updated = callsFor(sdk.update, 'Policy');
    expect(updated).toHaveLength(1);
    expect((updated[0]![3] as Record<string, unknown>)['Topics']).toEqual([topicArn]);
    // ...never re-created, and never deleted.
    for (const p of [sdk, cc]) {
      expect(callsFor(p.create, 'Policy')).toHaveLength(0);
      expect(callsFor(p.delete, 'Policy')).toHaveLength(0);
    }
  });

  it('warns when the re-put child is recorded on Cloud Control, whose empty patch restores nothing', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const policyProps = { Topics: [topicArn], PolicyDocument: { Statement: [] } };
    const state: StackState = {
      ...priorState(),
      resources: {
        Topic: record(topicArn, 'AWS::SNS::Topic', { TopicName: 'my-topic' }),
        Policy: {
          ...record('stack-Policy-X', 'AWS::SNS::TopicPolicy', policyProps, ['Topic']),
          provisionedBy: 'cc-api',
        } as ResourceState,
      },
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    cc.create.mockResolvedValue({ physicalId: topicArn, attributes: {} });
    // The provider's own word that its patch was empty (go-to-k/cdkd#4443).
    cc.update.mockImplementation((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false, sentNothing: true })
    );
    const t: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
        Policy: {
          Type: 'AWS::SNS::TopicPolicy',
          Properties: { ...policyProps, Topics: [{ Ref: 'Topic' }] },
        },
      },
    };
    await makeEngine('Topic').deploy(STACK, t);

    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('Policy went with Topic') && line.includes('recorded on Cloud Control'))).toBe(true);
  });

  it('a permission the same deploy RE-POINTS from a surviving function to the recreated one takes the ordinary replacement, deleting its old statement', async () => {
    const state = priorState();
    state.resources['FnB'] = record('fn-b', FN_TYPE, { FunctionName: 'fn-b' });
    // Recorded on the SURVIVING function...
    state.resources['Perm'] = record(
      PERMISSION_ID,
      PERMISSION_TYPE,
      { ...PERMISSION_PROPS, FunctionName: 'fn-b' },
      ['FnB']
    );
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const t = template();
    t.Resources['FnB'] = { Type: FN_TYPE, Properties: { FunctionName: 'fn-b' } };
    // ...and now pointed at the recreated one.
    await makeEngine().deploy(STACK, t);

    const created = callsFor(sdk.create, 'Perm');
    expect(created).toHaveLength(1);
    expect((created[0]![2] as Record<string, unknown>)['FunctionName']).toBe('my-fn');
    // The statement on fn-b is removed, as before this change.
    const deleted = callsFor(sdk.delete, 'Perm');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]![1]).toBe(PERMISSION_ID);
  });

  // go-to-k/cdkd#5118: once the old copy is gone only the user's interrupt
  // stops a re-create. A sibling's failure claims `interruptCause` first, as
  // `execute.ts` does (`??=`).
  function siblingFails(engine: DeployEngine): void {
    const fields = engine as unknown as { interrupted: boolean; interruptCause: string | null };
    fields.interrupted = true;
    fields.interruptCause ??= 'sibling-failure';
  }
  const throttle = (): Error =>
    Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });

  it("the lost child's re-create is not aborted by a sibling's failure (review S2)", async () => {
    const engine = makeEngine();
    let attempts = 0;
    sdk.create.mockImplementation((logicalId: string) => {
      if (logicalId !== 'Perm') return Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} });
      attempts++;
      if (attempts === 1) {
        siblingFails(engine);
        return Promise.reject(throttle());
      }
      return Promise.resolve({ physicalId: 'Perm-new', attributes: {} });
    });
    await engine.deploy(STACK, template()).catch(() => undefined);
    expect(attempts).toBe(2);
  }, 30_000);

  it('a Ctrl-C after a sibling has failed stops the delete-first re-create (review S1, the real SIGINT handler)', async () => {
    const engine = makeEngine();
    const before = new Set(process.listeners('SIGINT'));
    let attempts = 0;
    cc.create.mockImplementation((logicalId: string) => {
      if (logicalId !== 'Fn') return Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} });
      attempts++;
      if (attempts === 1) siblingFails(engine);
      else if (attempts === 2) {
        const registered = process.listeners('SIGINT').filter((l) => !before.has(l));
        expect(registered, 'deploy() registered no SIGINT listener').toHaveLength(1);
        (registered[0] as () => void)();
      } else return Promise.resolve({ physicalId: 'my-fn', attributes: {} });
      // The late name release of the just-deleted function.
      return Promise.reject(new Error('Function already exists: my-fn'));
    });
    await expect(engine.deploy(STACK, template())).rejects.toThrow();
    expect(attempts).toBe(2);
  }, 30_000);

  // go-to-k/cdkd#5131: the old copy's delete returns while AWS may still hold
  // its name; its provider's name-release wait runs before the re-create.
  it('waits for the deleted function to release its name before the re-create (#5131)', async () => {
    const order: string[] = [];
    const del = sdk.delete.getMockImplementation() as ((...a: unknown[]) => unknown) | undefined;
    sdk.delete.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'Fn') order.push('delete');
      return del?.(...args);
    });
    const create = cc.create.getMockImplementation() as (...a: unknown[]) => unknown;
    cc.create.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'Fn') order.push('create');
      return create(...args);
    });
    (sdk as Record<string, unknown>)['waitForNameReleased'] = vi.fn(async (id: string) => {
      order.push(`wait ${id}`);
    });
    await makeEngine().deploy(STACK, template());
    expect(order).toEqual(['delete', 'wait Fn', 'create']);
  });
});

