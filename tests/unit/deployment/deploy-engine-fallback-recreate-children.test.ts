/**
 * go-to-k/cdkd#4444 (scaffold shared with the #4411 file): a parent the
 * update-failure FALLBACK re-creates under the same id (an in-place UPDATE the
 * provider refuses with `ResourceUpdateNotSupportedError`, then `--replace`'s
 * delete + create) takes its children along, yet the diff never promoted them:
 * they are `NO_CHANGE` rows the engine dispatches as soon as the parent
 * completes.
 *
 * The shape: a fixed-name Lambda function whose `Runtime` update is refused,
 * so the fallback deletes it and creates it again under the same name, and its
 * `AWS::Lambda::Permission`. Deleting the function deletes its resource-based
 * policy, so the permission is gone, while its `FunctionName` resolves to
 * exactly what the record holds: the diff called it unchanged and state kept a
 * permission AWS no longer had.
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
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

const STACK = 'fallback-recreate-children-stack';
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

describe('DeployEngine - children of a fallback same-id re-create (go-to-k/cdkd#4444)', () => {
  let sdk: Provider;
  let cc: Provider;
  let stateBackend: Record<
    | 'getState'
    | 'saveState'
    | 'appendRollbackJournalSegment'
    | 'deleteRollbackJournal'
    | 'loadRollbackJournal'
    | 'markRollbackJournalSuperseded'
    | 'popRollbackJournalSegment',
    ReturnType<typeof vi.fn>
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider();
    cc = makeProvider();
    // The function's in-place update is refused, so `--replace` re-creates it.
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(new ResourceUpdateNotSupportedError(FN_TYPE, 'Fn', 'Runtime cannot change'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: priorState(), etag: 'etag-old' }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
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
        getProviderFor: vi.fn().mockReturnValue({ provider: sdk, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, replace: true, ...options } as never,
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

  /** The function's Runtime moves (an in-place row); nothing reading it does. */
  function changedTemplate(): CloudFormationTemplate {
    const t = template();
    t.Resources['Fn']!.Properties = { ...FN_PROPS, Runtime: 'nodejs24.x' };
    return t;
  }

  it('re-creates the NO_CHANGE permission the fallback re-create took with it, and deletes nothing of it', async () => {
    await makeEngine().deploy(STACK, changedTemplate());

    // The fallback: delete the function, create it under the same name.
    expect(callsFor(sdk.delete, 'Fn')).toHaveLength(1);
    expect(callsFor(sdk.create, 'Fn')).toHaveLength(1);
    expect(saved('Fn')?.physicalId).toBe('my-fn');

    const created = callsFor(sdk.create, 'Perm');
    expect(created).toHaveLength(1);
    expect((created[0]![2] as Record<string, unknown>)['FunctionName']).toBe('my-fn');
    expect(callsFor(sdk.delete, 'Perm')).toHaveLength(0);
    expect(saved('Perm')?.physicalId).toBe('Perm-new');
    // A reader that is not stored inside the function is left alone.
    for (const fn of [sdk.create, sdk.update, sdk.delete]) {
      expect(callsFor(fn, 'Param')).toHaveLength(0);
    }
  });

  it('dispatches nothing extra without --replace (no fallback re-create happened)', async () => {
    await expect(makeEngine({ replace: false }).deploy(STACK, changedTemplate())).rejects.toThrow();
    expect(callsFor(sdk.create, 'Perm')).toHaveLength(0);
  });

  it('counts each child re-created after the fallback as an update', async () => {
    const result = await makeEngine().deploy(STACK, changedTemplate());
    // Fn (fallback) and Perm (its child); Param is unchanged.
    expect(result.updated).toBe(2);
    expect(result.unchanged).toBe(1);
  });

  it('follows grandchildren: a permission on an alias the fallback re-create took along', async () => {
    const aliasArn = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn:live';
    const aliasProps = { FunctionName: 'my-fn', FunctionVersion: '$LATEST', Name: 'live' };
    const state = priorState();
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
    sdk.create.mockImplementation((logicalId: string) =>
      Promise.resolve({
        physicalId: logicalId === 'Fn' ? 'my-fn' : logicalId === 'Alias' ? aliasArn : `${logicalId}-new`,
        attributes: {},
      })
    );
    const t = changedTemplate();
    t.Resources['Alias'] = {
      Type: 'AWS::Lambda::Alias',
      Properties: { ...aliasProps, FunctionName: { Ref: 'Fn' } },
    };
    t.Resources['AliasPerm'] = {
      Type: PERMISSION_TYPE,
      Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Alias' } },
    };

    await makeEngine().deploy(STACK, t);

    for (const id of ['Perm', 'Alias', 'AliasPerm']) {
      expect(callsFor(sdk.create, id), id).toHaveLength(1);
      expect(callsFor(sdk.delete, id), id).toHaveLength(0);
    }
  });

  /**
   * `Sib` reads the function and is scheduled after it; its update fails. The
   * permission went with the function, so it must be restored right after the
   * function, not after every other node.
   */
  function failingSiblingTemplate(): CloudFormationTemplate {
    const t = changedTemplate();
    t.Resources['Sib'] = {
      Type: PARAM_TYPE,
      Properties: { Name: 'sib', Type: 'String', Value: { 'Fn::Join': ['', [{ Ref: 'Fn' }, '-v2']] } },
    };
    return t;
  }

  function withSibling(): void {
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
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(new ResourceUpdateNotSupportedError(FN_TYPE, 'Fn', 'Runtime cannot change'))
        : logicalId === 'Sib'
          ? Promise.reject(new Error('ValidationException: forced sibling failure'))
          : Promise.resolve({ physicalId, wasReplaced: false })
    );
  }

  it('restores the child right after the parent, so a later sibling failure does not leave it missing', async () => {
    withSibling();

    await expect(makeEngine({ noRollback: true }).deploy(STACK, failingSiblingTemplate())).rejects.toThrow('Failed to update resource Sib');

    expect(callsFor(sdk.update, 'Sib')).toHaveLength(1);
    expect(callsFor(sdk.create, 'Perm')).toHaveLength(1);
    expect(callsFor(sdk.delete, 'Perm')).toHaveLength(0);
    // The failed deploy keeps the record of the child it re-created.
    expect(saved('Perm')?.physicalId).toBe('Perm-new');
  });

  it('makes a pending reader of the child wait for its re-create, and resolve its new id', async () => {
    const state = priorState();
    const props = { Name: 'reader', Type: 'String', Value: 'my-fn/stack-Perm-ABC/v1' };
    state.resources['Reader'] = {
      physicalId: 'reader',
      resourceType: PARAM_TYPE,
      properties: props,
      observedProperties: props,
      attributes: {},
      dependencies: ['Fn', 'Perm'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const t = changedTemplate();
    // Reads the function (so it waits for it) and the permission.
    t.Resources['Reader'] = {
      Type: PARAM_TYPE,
      Properties: {
        Name: 'reader',
        Type: 'String',
        Value: { 'Fn::Join': ['/', [{ Ref: 'Fn' }, { Ref: 'Perm' }, 'v2']] },
      },
    };

    await makeEngine().deploy(STACK, t);

    const updated = callsFor(sdk.update, 'Reader');
    expect(updated).toHaveLength(1);
    expect((updated[0]![3] as Record<string, unknown>)['Value']).toBe('my-fn/Perm-new/v2');
  });

  it('fails the deploy when the child\'s re-create is rejected, journals it as an UPDATE, and deletes nothing', async () => {
    sdk.create.mockImplementation((logicalId: string) =>
      logicalId === 'Perm'
        ? Promise.reject(
            Object.assign(new Error('The policy is malformed'), { name: 'InvalidParameterValueException' })
          )
        : Promise.resolve({ physicalId: logicalId === 'Fn' ? 'my-fn' : `${logicalId}-new`, attributes: {} })
    );

    await expect(makeEngine({ noRollback: true }).deploy(STACK, changedTemplate())).rejects.toThrow('Failed to update resource Perm');

    const segments = stateBackend.appendRollbackJournalSegment.mock.calls.map(
      (c) => c[2] as { failedOperations: Array<{ logicalId: string; changeType: string }> }
    );
    const failed = segments.flatMap((seg) => seg.failedOperations);
    expect(failed.map((op) => [op.logicalId, op.changeType])).toEqual([['Perm', 'UPDATE']]);
    // Only the fallback's own delete of the old function, nothing after it.
    expect(callsFor(sdk.delete, 'Fn')).toHaveLength(1);
    expect(callsFor(sdk.delete, 'Perm')).toHaveLength(0);
  });

  it('dispatches no child when the fallback re-create lands under a NEW physical id', async () => {
    sdk.create.mockImplementation((logicalId: string) =>
      Promise.resolve({ physicalId: logicalId === 'Fn' ? 'my-fn-2' : `${logicalId}-new`, attributes: {} })
    );

    await makeEngine().deploy(STACK, changedTemplate());

    expect(saved('Fn')?.physicalId).toBe('my-fn-2');
    // Not dispatched at all: the permission stays the NO_CHANGE row it was.
    for (const fn of [sdk.create, sdk.update, sdk.delete]) {
      expect(callsFor(fn, 'Perm')).toHaveLength(0);
    }
  });

  it("is seen as WRITTEN by the failed-deploy path (go-to-k/cdkd#4443), so its record is kept, not forgotten", async () => {
    withSibling();

    await expect(
      makeEngine({ noRollback: true }).deploy(STACK, failingSiblingTemplate())
    ).rejects.toThrow('Failed to update resource Sib');

    // Once re-created, every later state write -- the failure path's included
    // -- keeps the permission's new record.
    const saves = stateBackend.saveState.mock.calls.map((c) => (c[2] as StackState).resources);
    const first = saves.findIndex((resources) => resources['Perm']?.physicalId === 'Perm-new');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(saves.length - first).toBeGreaterThan(1);
    for (const resources of saves.slice(first)) {
      expect(resources['Perm']?.physicalId).toBe('Perm-new');
    }
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('Perm') && line.includes('record is dropped'))).toBe(false);
  });
});
