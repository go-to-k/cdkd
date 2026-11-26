/**
 * The update-failure fallback (`--replace` after a provider's
 * `ResourceUpdateNotSupportedError`) re-creates a resource under a NEW
 * physical id. Its readers the diff called NO_CHANGE must be re-resolved
 * against the new id, and a reader whose reading property is create-only must
 * be replaced, as for a planned replacement.
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

const STACK = 'fallback-new-id-readers-stack';
const REGION = 'us-east-1';
const FN_TYPE = 'AWS::Lambda::Function';
const PERMISSION_TYPE = 'AWS::Lambda::Permission';
const PARAM_TYPE = 'AWS::SSM::Parameter';
const FN_PROPS = { Runtime: 'nodejs22.x' };
const OLD_ID = 'stack-Fn-OLD';
const NEW_ID = 'stack-Fn-NEW';
const arnOf = (id: string): string => `arn:aws:lambda:${REGION}:123456789012:function:${id}`;
const PERMISSION_PROPS = {
  Action: 'lambda:InvokeFunction',
  FunctionName: OLD_ID,
  Principal: 'sns.amazonaws.com',
};

function template(runtime = 'nodejs22.x'): CloudFormationTemplate {
  return {
    Resources: {
      Fn: { Type: FN_TYPE, Properties: { ...FN_PROPS, Runtime: runtime } },
      RefParam: {
        Type: PARAM_TYPE,
        Properties: { Name: 'ref', Type: 'String', Value: { Ref: 'Fn' } },
      },
      AttParam: {
        Type: PARAM_TYPE,
        Properties: { Name: 'att', Type: 'String', Value: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
      },
      // `FunctionName` is create-only on a permission.
      Perm: {
        Type: PERMISSION_TYPE,
        Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
      },
    },
  };
}

function priorState(): StackState {
  const rec = (
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    dependencies: string[],
    attributes: Record<string, unknown> = {}
  ): ResourceState =>
    ({
      physicalId,
      resourceType,
      properties,
      observedProperties: properties,
      attributes,
      dependencies,
      provisionedBy: 'sdk',
    }) as ResourceState;
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Fn: rec(OLD_ID, FN_TYPE, FN_PROPS, [], { Arn: arnOf(OLD_ID) }),
      RefParam: rec('ref', PARAM_TYPE, { Name: 'ref', Type: 'String', Value: OLD_ID }, ['Fn']),
      AttParam: rec('att', PARAM_TYPE, { Name: 'att', Type: 'String', Value: arnOf(OLD_ID) }, [
        'Fn',
      ]),
      Perm: rec('stack-Perm-OLD', PERMISSION_TYPE, PERMISSION_PROPS, ['Fn']),
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
          ? { physicalId: NEW_ID, attributes: { Arn: arnOf(NEW_ID) } }
          : { physicalId: `stack-${logicalId}-NEW`, attributes: {} }
      )
    ),
    update: vi.fn((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

describe('DeployEngine - NO_CHANGE readers of a fallback replacement under a new id', () => {
  let sdk: Provider;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider();
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
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
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

  const sentProps = (fn: ReturnType<typeof vi.fn>, id: string, at: number): unknown =>
    callsFor(fn, id)[0]?.[at];

  it('updates the NO_CHANGE Ref and Fn::GetAtt readers to the new id', async () => {
    await makeEngine().deploy(STACK, template('nodejs24.x'));

    // The premise: the fallback replaced the function under a new id.
    expect(saved('Fn')?.physicalId).toBe(NEW_ID);
    expect(callsFor(sdk.delete, 'Fn').map((c) => c[1])).toEqual([OLD_ID]);

    expect(callsFor(sdk.update, 'RefParam')).toHaveLength(1);
    expect((sentProps(sdk.update, 'RefParam', 3) as Record<string, unknown>)['Value']).toBe(NEW_ID);
    expect(saved('RefParam')?.properties?.['Value']).toBe(NEW_ID);
    expect(saved('RefParam')?.physicalId).toBe('ref');

    expect(callsFor(sdk.update, 'AttParam')).toHaveLength(1);
    expect((sentProps(sdk.update, 'AttParam', 3) as Record<string, unknown>)['Value']).toBe(
      arnOf(NEW_ID)
    );
    expect(saved('AttParam')?.properties?.['Value']).toBe(arnOf(NEW_ID));
  });

  it('replaces the reader whose create-only property holds the reference', async () => {
    await makeEngine().deploy(STACK, template('nodejs24.x'));

    expect(callsFor(sdk.update, 'Perm')).toHaveLength(0);
    expect(callsFor(sdk.create, 'Perm')).toHaveLength(1);
    expect((sentProps(sdk.create, 'Perm', 2) as Record<string, unknown>)['FunctionName']).toBe(
      NEW_ID
    );
    expect(callsFor(sdk.delete, 'Perm').map((c) => c[1])).toEqual(['stack-Perm-OLD']);
    expect(saved('Perm')?.physicalId).toBe('stack-Perm-NEW');
    expect(saved('Perm')?.properties?.['FunctionName']).toBe(NEW_ID);
  });

  it('dispatches each promoted reader after the replacement, and counts it', async () => {
    const result = await makeEngine().deploy(STACK, template('nodejs24.x'));
    const firstCallOrder = (fn: ReturnType<typeof vi.fn>, id: string): number => {
      const at = fn.mock.calls.findIndex((c) => c[0] === id);
      return at < 0 ? Number.POSITIVE_INFINITY : fn.mock.invocationCallOrder[at]!;
    };
    const fnCreated = firstCallOrder(sdk.create, 'Fn');
    for (const id of ['RefParam', 'AttParam', 'Perm']) {
      const first = Math.min(firstCallOrder(sdk.create, id), firstCallOrder(sdk.update, id));
      expect(Number.isFinite(first), id).toBe(true);
      expect(first, id).toBeGreaterThan(fnCreated);
    }
    expect(result.unchanged).toBe(0);
  });

  it('follows a replaced reader to its own readers', async () => {
    const t = template('nodejs24.x');
    t.Resources['PermParam'] = {
      Type: PARAM_TYPE,
      Properties: { Name: 'perm', Type: 'String', Value: { Ref: 'Perm' } },
    };
    const state = priorState();
    const props = { Name: 'perm', Type: 'String', Value: 'stack-Perm-OLD' };
    state.resources['PermParam'] = {
      physicalId: 'perm',
      resourceType: PARAM_TYPE,
      properties: props,
      observedProperties: props,
      attributes: {},
      dependencies: ['Perm'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });

    await makeEngine().deploy(STACK, t);

    expect(callsFor(sdk.update, 'PermParam')).toHaveLength(1);
    expect(saved('PermParam')?.properties?.['Value']).toBe('stack-Perm-NEW');
  });

  it('runs the in-place attribute pass after it: a custom resource reading the id moves its Data', async () => {
    const t = template('nodejs24.x');
    t.Resources['Cr'] = {
      Type: 'Custom::Thing',
      Properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h', Fn: { Ref: 'Fn' } },
    };
    t.Resources['CrParam'] = {
      Type: PARAM_TYPE,
      Properties: { Name: 'cr', Type: 'String', Value: { 'Fn::GetAtt': ['Cr', 'Out'] } },
    };
    const state = priorState();
    const crProps = { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h', Fn: OLD_ID };
    state.resources['Cr'] = {
      physicalId: 'cr-id',
      resourceType: 'Custom::Thing',
      properties: crProps,
      observedProperties: crProps,
      attributes: { Out: 'out-old' },
      dependencies: ['Fn'],
      provisionedBy: 'sdk',
    } as ResourceState;
    const paramProps = { Name: 'cr', Type: 'String', Value: 'out-old' };
    state.resources['CrParam'] = {
      physicalId: 'cr',
      resourceType: PARAM_TYPE,
      properties: paramProps,
      observedProperties: paramProps,
      attributes: {},
      dependencies: ['Cr'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(new ResourceUpdateNotSupportedError(FN_TYPE, 'Fn', 'Runtime cannot change'))
        : Promise.resolve({
            physicalId,
            wasReplaced: false,
            ...(logicalId === 'Cr' && { attributes: { Out: 'out-new' } }),
          })
    );

    await makeEngine().deploy(STACK, t);

    expect(callsFor(sdk.update, 'Cr')).toHaveLength(1);
    expect(callsFor(sdk.update, 'CrParam')).toHaveLength(1);
    expect(saved('CrParam')?.properties?.['Value']).toBe('out-new');
  });

  /** A stateful reader (an SSM parameter) whose create-only `Name` carries the id. */
  function withStatefulReader(): CloudFormationTemplate {
    const t = template('nodejs24.x');
    t.Resources['NamedParam'] = {
      Type: PARAM_TYPE,
      Properties: {
        Name: { 'Fn::Join': ['-', [{ Ref: 'Fn' }, 'cfg']] },
        Type: 'String',
        Value: 'v',
      },
    };
    const state = priorState();
    const props = { Name: `${OLD_ID}-cfg`, Type: 'String', Value: 'v' };
    state.resources['NamedParam'] = {
      physicalId: `${OLD_ID}-cfg`,
      resourceType: PARAM_TYPE,
      properties: props,
      observedProperties: props,
      attributes: {},
      dependencies: ['Fn'],
      provisionedBy: 'sdk',
    } as ResourceState;
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });
    return t;
  }

  it('refuses to replace a stateful reader without --force-stateful-recreation', async () => {
    const error: unknown = await makeEngine()
      .deploy(STACK, withStatefulReader())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    const codes: unknown[] = [];
    for (let e = error; e instanceof Error; e = e.cause) {
      codes.push((e as { code?: unknown }).code);
    }
    expect(codes).toContain('STATEFUL_REPLACE_BLOCKED');
    expect(callsFor(sdk.create, 'NamedParam')).toHaveLength(0);
    // Nothing of the stateful reader is deleted by the forward deploy.
    expect(
      callsFor(sdk.delete, 'NamedParam').filter((c) => c[1] === `${OLD_ID}-cfg`)
    ).toHaveLength(0);
  });

  it('replaces a stateful reader under --force-stateful-recreation', async () => {
    await makeEngine({ forceStatefulRecreation: true }).deploy(STACK, withStatefulReader());
    expect(callsFor(sdk.create, 'NamedParam')).toHaveLength(1);
    expect((sentProps(sdk.create, 'NamedParam', 2) as Record<string, unknown>)['Name']).toBe(
      `${NEW_ID}-cfg`
    );
  });

  it('promotes nothing without --replace (no fallback replacement ran)', async () => {
    await expect(makeEngine({ replace: false }).deploy(STACK, template('nodejs24.x'))).rejects.toThrow();
    for (const id of ['RefParam', 'AttParam', 'Perm']) {
      expect(callsFor(sdk.create, id), id).toHaveLength(0);
      expect(callsFor(sdk.update, id), id).toHaveLength(0);
    }
  });

  it('promotes nothing when the fallback re-creates the resource under the same id', async () => {
    sdk.create.mockImplementation((logicalId: string) =>
      Promise.resolve(
        logicalId === 'Fn'
          ? { physicalId: OLD_ID, attributes: { Arn: arnOf(OLD_ID) } }
          : { physicalId: `stack-${logicalId}-NEW`, attributes: {} }
      )
    );
    await makeEngine().deploy(STACK, template('nodejs24.x'));
    expect(saved('Fn')?.physicalId).toBe(OLD_ID);
    for (const id of ['RefParam', 'AttParam']) {
      expect(callsFor(sdk.update, id), id).toHaveLength(0);
    }
  });
});
