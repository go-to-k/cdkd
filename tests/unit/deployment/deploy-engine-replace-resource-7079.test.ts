/**
 * go-to-k/cdkd#7079: `--replace-resource <logicalId>` plans the named
 * resource's UPDATE as a replacement, as a template create-only change does,
 * and a Cloud Control `NotUpdatable` refusal names the property, the command
 * and a prefilled issue link.
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

const STACK = 'replace-resource-stack';
const REGION = 'us-east-1';
const FN_TYPE = 'AWS::Lambda::Function';
const PERMISSION_TYPE = 'AWS::Lambda::Permission';
const PARAM_TYPE = 'AWS::SSM::Parameter';
const OLD_ID = 'stack-Fn-OLD';
const NEW_ID = 'stack-Fn-NEW';
const PERMISSION_PROPS = {
  Action: 'lambda:InvokeFunction',
  FunctionName: OLD_ID,
  Principal: 'sns.amazonaws.com',
};

function template(memory = 128): CloudFormationTemplate {
  return {
    Resources: {
      Fn: { Type: FN_TYPE, Properties: { Runtime: 'nodejs22.x', MemorySize: memory } },
      RefParam: {
        Type: PARAM_TYPE,
        Properties: { Name: 'ref', Type: 'String', Value: { Ref: 'Fn' } },
      },
      Perm: {
        Type: PERMISSION_TYPE,
        Properties: { ...PERMISSION_PROPS, FunctionName: { Ref: 'Fn' } },
      },
    },
  };
}

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

function priorState(): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Fn: rec(OLD_ID, FN_TYPE, { Runtime: 'nodejs22.x', MemorySize: 128 }, []),
      RefParam: rec('ref', PARAM_TYPE, { Name: 'ref', Type: 'String', Value: OLD_ID }, ['Fn']),
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
      Promise.resolve({
        physicalId: logicalId === 'Fn' ? NEW_ID : `stack-${logicalId}-NEW`,
        attributes: {},
      })
    ),
    update: vi.fn((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

/** Cloud Control's asynchronous `NotUpdatable` answer, as `CloudControlOperationFailedError` carries it. */
function notUpdatable(): Error {
  return Object.assign(new Error('Resource is not updatable with parameters provided'), {
    ccErrorCode: 'NotUpdatable',
    ccOperation: 'UPDATE',
  });
}

describe('DeployEngine - --replace-resource (go-to-k/cdkd#7079)', () => {
  let sdk: Provider;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider();
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
      { dryRun: false, ...options } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const targets = (...ids: string[]) => ({
    replaceResources: { stackName: STACK, logicalIds: new Set(ids) },
  });

  function saved(id: string): ResourceState | undefined {
    const calls = stateBackend['saveState']!.mock.calls;
    return (calls[calls.length - 1]?.[2] as StackState | undefined)?.resources[id];
  }

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);

  const errorOf = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => undefined,
      (e: unknown) => e
    );

  const chain = (error: unknown): Array<{ code?: unknown; message: string }> => {
    const out: Array<{ code?: unknown; message: string }> = [];
    for (let e = error; e instanceof Error; e = e.cause) {
      out.push({ code: (e as { code?: unknown }).code, message: e.message });
    }
    return out;
  };

  const providerCalls = (): number =>
    sdk.create.mock.calls.length + sdk.update.mock.calls.length + sdk.delete.mock.calls.length;

  it('replaces the named resource instead of updating it, and moves its readers', async () => {
    await makeEngine(targets('Fn')).deploy(STACK, template(256));

    expect(callsFor(sdk.update, 'Fn')).toHaveLength(0);
    expect(callsFor(sdk.create, 'Fn')).toHaveLength(1);
    expect(callsFor(sdk.delete, 'Fn').map((c) => c[1])).toEqual([OLD_ID]);
    expect(saved('Fn')?.physicalId).toBe(NEW_ID);
    // The readers move with it: the parameter in place, the permission
    // (create-only FunctionName) replaced.
    expect(saved('RefParam')?.properties?.['Value']).toBe(NEW_ID);
    expect(callsFor(sdk.create, 'Perm')).toHaveLength(1);
    expect(saved('Perm')?.properties?.['FunctionName']).toBe(NEW_ID);
  });

  it('updates in place without the flag', async () => {
    await makeEngine().deploy(STACK, template(256));
    expect(callsFor(sdk.update, 'Fn')).toHaveLength(1);
    expect(callsFor(sdk.create, 'Fn')).toHaveLength(0);
  });

  it('does not apply to another stack of the run', async () => {
    await makeEngine({
      replaceResources: { stackName: 'other-stack', logicalIds: new Set(['Fn']) },
    }).deploy(STACK, template(256));
    expect(callsFor(sdk.update, 'Fn')).toHaveLength(1);
    expect(callsFor(sdk.create, 'Fn')).toHaveLength(0);
  });

  it('refuses a target this deploy does not change, before any provider call', async () => {
    const error = await errorOf(makeEngine(targets('Fn')).deploy(STACK, template(128)));
    expect(chain(error).map((l) => l.code)).toContain('REPLACE_RESOURCE_REFUSED');
    expect(chain(error)[0]!.message).toMatch(/--recreate-via-cc-api/);
    expect(providerCalls()).toBe(0);
  });

  it('warns and replaces nothing for an id this stack lacks', async () => {
    await makeEngine(targets('Missing')).deploy(STACK, template(256));
    expect(callsFor(sdk.update, 'Fn')).toHaveLength(1);
    const warns = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('--replace-resource Missing: not replaced'))).toBe(true);
  });

  /** `Fn`'s update plus a stateful SSM parameter `Cfg` whose `Value` changes. */
  function withStatefulTarget(): CloudFormationTemplate {
    const t = template(256);
    t.Resources['Cfg'] = {
      Type: PARAM_TYPE,
      Properties: { Name: 'cfg', Type: 'String', Value: 'v2' },
    };
    const state = priorState();
    state.resources['Cfg'] = rec('cfg', PARAM_TYPE, { Name: 'cfg', Type: 'String', Value: 'v1' }, []);
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });
    return t;
  }

  it('refuses a stateful target before any provider call', async () => {
    const error = await errorOf(makeEngine(targets('Cfg')).deploy(STACK, withStatefulTarget()));
    expect(chain(error).map((l) => l.code)).toContain('STATEFUL_REPLACE_BLOCKED');
    expect(chain(error)[0]!.message).toMatch(/Cfg \(AWS::SSM::Parameter\)/);
    expect(providerCalls()).toBe(0);
  });

  it('replaces a stateful target under --force-stateful-recreation', async () => {
    await makeEngine({ ...targets('Cfg'), forceStatefulRecreation: true }).deploy(
      STACK,
      withStatefulTarget()
    );
    expect(callsFor(sdk.update, 'Cfg')).toHaveLength(0);
    expect(callsFor(sdk.create, 'Cfg')).toHaveLength(1);
  });

  it('needs no confirmation for a stateful target under UpdateReplacePolicy: Retain', async () => {
    const t = withStatefulTarget();
    t.Resources['Cfg']!.UpdateReplacePolicy = 'Retain';
    await makeEngine(targets('Cfg')).deploy(STACK, t);
    expect(callsFor(sdk.create, 'Cfg')).toHaveLength(1);
    expect(callsFor(sdk.delete, 'Cfg')).toHaveLength(0);
  });

  it('reads only the template UpdateReplacePolicy: a recorded Retain the template dropped is refused', async () => {
    const t = withStatefulTarget();
    const { state } = (await (stateBackend['getState'] as () => Promise<unknown>)()) as {
      state: StackState;
    };
    state.resources['Cfg']!.updateReplacePolicy = 'Retain';
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });
    const error = await errorOf(makeEngine(targets('Cfg')).deploy(STACK, t));
    expect(chain(error).map((l) => l.code)).toContain('STATEFUL_REPLACE_BLOCKED');
    expect(providerCalls()).toBe(0);
  });

  it('refuses a stateful reader the replacement would replace, before any provider call', async () => {
    const t = template(256);
    t.Resources['Named'] = {
      Type: PARAM_TYPE,
      Properties: { Name: { 'Fn::Join': ['-', [{ Ref: 'Fn' }, 'cfg']] }, Type: 'String', Value: 'v' },
    };
    const state = priorState();
    state.resources['Named'] = rec(
      `${OLD_ID}-cfg`,
      PARAM_TYPE,
      { Name: `${OLD_ID}-cfg`, Type: 'String', Value: 'v' },
      ['Fn']
    );
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });

    const error = await errorOf(makeEngine(targets('Fn')).deploy(STACK, t));
    expect(chain(error).map((l) => l.code)).toContain('STATEFUL_REPLACE_BLOCKED');
    expect(chain(error)[0]!.message).toMatch(/A --replace-resource target is read/);
    expect(providerCalls()).toBe(0);
  });

  it('refuses a nested stack target', async () => {
    const t = template(256);
    t.Resources['Child'] = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://example.com/b.json' },
    };
    const state = priorState();
    state.resources['Child'] = rec(
      'arn:aws:cloudformation:us-east-1:123456789012:stack/child/x',
      'AWS::CloudFormation::Stack',
      { TemplateURL: 'https://example.com/a.json' },
      []
    );
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-old' });
    const error = await errorOf(makeEngine(targets('Child')).deploy(STACK, t));
    expect(chain(error).map((l) => l.code)).toContain('REPLACE_RESOURCE_REFUSED');
    expect(providerCalls()).toBe(0);
  });

  it('a NotUpdatable refusal names the property, the command and the issue link', async () => {
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(notUpdatable())
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const error = await errorOf(makeEngine().deploy(STACK, template(256)));
    const text = chain(error)
      .map((l) => l.message)
      .join('\n');
    expect(text).toContain(
      'Fn (AWS::Lambda::Function): Cloud Control refused this update in place (NotUpdatable), which changes MemorySize; CloudFormation replaces the resource for such a change.'
    );
    // `--replace` is run-wide, so the remedy never advises it.
    expect(text).not.toMatch(/--replace(?!-resource)/);
    expect(text).not.toContain('is stateful');
    expect(text).toContain(`cdkd deploy ${STACK} --replace-resource Fn`);
    const link = /https:\/\/github\.com\/go-to-k\/cdkd\/issues\/new\?\S+/.exec(text)?.[0];
    expect(link).toBeDefined();
    const params = new URL(link!).searchParams;
    expect(params.get('title')).toBe('Replacement rule: AWS::Lambda::Function MemorySize');
    expect(params.get('body')).toContain('Resource type: AWS::Lambda::Function');
    expect(params.get('body')).toContain('Property: MemorySize');
    expect(params.get('body')).toContain('Error code: NotUpdatable');
    // Never a value, a physical id, a region or a stack name.
    for (const leak of ['256', OLD_ID, REGION, STACK]) expect(link).not.toContain(leak);
  });

  it('states the data loss for a stateful type, and leaves the confirmation flag out of the command', async () => {
    const t = withStatefulTarget();
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Cfg'
        ? Promise.reject(notUpdatable())
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const error = await errorOf(makeEngine().deploy(STACK, t));
    const text = chain(error)
      .map((l) => l.message)
      .join('\n');
    expect(text).toContain(`cdkd deploy ${STACK} --replace-resource Cfg.`);
    expect(text).not.toContain('--replace-resource Cfg --force-stateful-recreation');
    expect(text).toContain(
      'Cfg is stateful: replacing it deletes its data, which the deploy asks you to confirm with --force-stateful-recreation.'
    );
  });

  it('states no data loss for a stateful type under UpdateReplacePolicy: Retain', async () => {
    const t = withStatefulTarget();
    t.Resources['Cfg']!.UpdateReplacePolicy = 'Retain';
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Cfg'
        ? Promise.reject(notUpdatable())
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const text = chain(await errorOf(makeEngine().deploy(STACK, t)))
      .map((l) => l.message)
      .join('\n');
    expect(text).toContain('--replace-resource Cfg');
    expect(text).not.toContain('is stateful');
  });

  it('reads the synchronous NotUpdatableException too', async () => {
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(
            Object.assign(new Error('Failed to update Fn'), {
              logicalId: 'Fn',
              cause: Object.assign(new Error('createOnlyProperties cannot be updated'), {
                name: 'NotUpdatableException',
              }),
            })
          )
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const text = chain(await errorOf(makeEngine().deploy(STACK, template(256))))
      .map((l) => l.message)
      .join('\n');
    expect(text).toContain(`cdkd deploy ${STACK} --replace-resource Fn`);
  });

  it('adds nothing for a NotUpdatable code reported by another operation', async () => {
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(Object.assign(notUpdatable(), { ccOperation: 'CREATE' }))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const text = chain(await errorOf(makeEngine().deploy(STACK, template(256))))
      .map((l) => l.message)
      .join('\n');
    expect(text).not.toContain('--replace-resource');
  });

  it('refuses a target whose only changes are speculative (a read of a replaced resource)', async () => {
    // `RefParam` changes only because it reads `Fn`, which is replaced.
    const error = await errorOf(makeEngine(targets('Fn', 'RefParam')).deploy(STACK, template(256)));
    expect(chain(error).map((l) => l.code)).toContain('REPLACE_RESOURCE_REFUSED');
    expect(chain(error)[0]!.message).toMatch(/changes no property of RefParam/);
    expect(providerCalls()).toBe(0);
  });

  it('warns and replaces nothing for a target this deploy creates', async () => {
    const t = template(256);
    t.Resources['Fresh'] = { Type: PARAM_TYPE, Properties: { Name: 'fresh', Type: 'String', Value: 'v' } };
    await makeEngine(targets('Fresh')).deploy(STACK, t);
    expect(callsFor(sdk.create, 'Fresh')).toHaveLength(1);
    const warns = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warns).toContain('--replace-resource Fresh: not replaced, this deploy will create it instead.');
  });

  it("adds nothing to another update failure, or to a NotUpdatable naming another resource", async () => {
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Fn'
        ? Promise.reject(
            Object.assign(new Error('child failed'), {
              cause: Object.assign(notUpdatable(), { logicalId: 'ChildResource' }),
            })
          )
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const error = await errorOf(makeEngine().deploy(STACK, template(256)));
    const text = chain(error)
      .map((l) => l.message)
      .join('\n');
    expect(text).not.toContain('--replace-resource');
  });
});
