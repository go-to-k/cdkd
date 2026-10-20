/**
 * go-to-k/cdkd#5064 phase 2, through a deploy's AUTOMATIC rollback (the
 * generated-name-lifecycle integ's phase E2): the deploy replaced Role under a
 * new name, moved a managed policy and an inline policy onto it, then a
 * sibling failed. The in-process rollback shares `replayRollback` with
 * `cdkd rollback`, so it reverted both policies back to the OLD role name
 * before re-creating that role. It must re-create the old role first and
 * delete the new one only after both policies moved back.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const warned = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: string) => warned.push(String(m))),
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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const STACK = 'App';
const ROLE = 'AWS::IAM::Role';
const MANAGED = 'AWS::IAM::ManagedPolicy';
const INLINE = 'AWS::IAM::Policy';
const OLD_ROLE = 'App-Role-7b29ef5fc296';
const NEW_ROLE = 'App-Role-gen2-0a1b2c3d4e5f';
const MANAGED_ARN = 'arn:aws:iam::111122223333:policy/App-Managed';
const DOC = { Version: '2012-10-17', Statement: [] };

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
    attributes: {},
    dependencies,
    provisionedBy: 'sdk',
  }) as ResourceState;

const roleProps = (path: string) => ({ AssumeRolePolicyDocument: DOC, Path: path });
const managedProps = (role: string) => ({ PolicyDocument: DOC, Roles: [role] });
const inlineProps = (role: string) => ({
  PolicyName: 'RoleDefaultPolicy',
  PolicyDocument: DOC,
  Roles: [role],
});

describe('the automatic rollback re-creates a renamed replacement before its dependents revert (go-to-k/cdkd#5064)', () => {
  let calls: string[];
  let roles: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    calls = [];
    roles = new Set([OLD_ROLE]);
  });

  function buildEngine(options: { newRoleDeleteFails?: boolean } = {}): DeployEngine {
    const provider = {
      create: vi.fn(async (logicalId: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`create ${logicalId}`);
        if (logicalId === 'Fail') throw new Error('create failed: Fail');
        // The deploy's create of the new role, then the rollback's re-create of the old.
        const name = props['Path'] === '/v2/' ? NEW_ROLE : OLD_ROLE;
        roles.add(name);
        return { physicalId: name, attributes: {} };
      }),
      update: vi.fn(
        async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
          const role = (props['Roles'] as string[])[0]!;
          calls.push(`update ${logicalId} -> ${role}`);
          if (!roles.has(role)) throw new Error(`The role with name ${role} cannot be found.`);
          return { physicalId, wasReplaced: false };
        }
      ),
      delete: vi.fn(async (logicalId: string, physicalId: string) => {
        calls.push(`delete ${logicalId} ${physicalId}`);
        if (options.newRoleDeleteFails === true && physicalId === NEW_ROLE) {
          throw new Error('DeleteConflict: Cannot delete entity, must detach all policies first.');
        }
        roles.delete(physicalId);
      }),
      getAttribute: vi.fn(),
    };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK,
      resources: {
        Role: rec(OLD_ROLE, ROLE, roleProps('/'), []),
        RoleDefaultPolicy: rec('App-Role-DefaultPolicy', INLINE, inlineProps(OLD_ROLE), ['Role']),
        Managed: rec(MANAGED_ARN, MANAGED, managedProps(OLD_ROLE), ['Role', 'RoleDefaultPolicy']),
      },
      outputs: {},
      lastModified: 0,
    };
    const changes = new Map<string, ResourceChange>([
      [
        'Role',
        {
          logicalId: 'Role',
          changeType: 'UPDATE',
          resourceType: ROLE,
          currentProperties: roleProps('/'),
          desiredProperties: roleProps('/v2/'),
          propertyChanges: [
            { path: 'Path', oldValue: '/', newValue: '/v2/', requiresReplacement: true },
          ],
        },
      ],
      [
        'RoleDefaultPolicy',
        {
          logicalId: 'RoleDefaultPolicy',
          changeType: 'UPDATE',
          resourceType: INLINE,
          currentProperties: inlineProps(OLD_ROLE),
          desiredProperties: inlineProps(NEW_ROLE),
          propertyChanges: [
            { path: 'Roles', oldValue: [OLD_ROLE], newValue: [NEW_ROLE], requiresReplacement: false },
          ],
        },
      ],
      [
        'Managed',
        {
          logicalId: 'Managed',
          changeType: 'UPDATE',
          resourceType: MANAGED,
          currentProperties: managedProps(OLD_ROLE),
          desiredProperties: managedProps(NEW_ROLE),
          propertyChanges: [
            { path: 'Roles', oldValue: [OLD_ROLE], newValue: [NEW_ROLE], requiresReplacement: false },
          ],
        },
      ],
      [
        'Fail',
        {
          logicalId: 'Fail',
          changeType: 'CREATE',
          resourceType: 'AWS::SQS::Queue',
          desiredProperties: {},
          propertyChanges: [],
        },
      ],
    ]);
    const deps: Record<string, string[]> = {
      Role: [],
      RoleDefaultPolicy: ['Role'],
      Managed: ['Role', 'RoleDefaultPolicy'],
      Fail: ['Managed'],
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Role: { Type: ROLE, Properties: roleProps('/v2/') },
        RoleDefaultPolicy: { Type: INLINE, Properties: inlineProps(NEW_ROLE) },
        Managed: { Type: MANAGED, Properties: managedProps(NEW_ROLE) },
        Fail: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
    } as CloudFormationTemplate;
    const saveState = vi.fn().mockResolvedValue('etag-1');
    const engine = new DeployEngine(
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'etag-0' }),
        saveState,
        appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      } as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi
          .fn()
          .mockReturnValue([['Role'], ['RoleDefaultPolicy'], ['Managed'], ['Fail']]),
        getDirectDependencies: vi.fn((_dag: unknown, id: string) => deps[id] ?? []),
      } as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(changes),
        hasChanges: vi.fn().mockReturnValue(true),
        filterByType: vi.fn((c: Map<string, ResourceChange>, type: string) =>
          [...c.values()].filter((x) => x.changeType === type)
        ),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, concurrency: 1 } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    return Object.assign(engine, { template, saveState });
  }

  it('E2: re-creates the old role, reverts both policies onto it, then deletes the new role', async () => {
    const engine = buildEngine();
    const template = (engine as unknown as { template: CloudFormationTemplate }).template;
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);

    // The forward deploy, as E1/E2 ran it.
    const forward = calls.slice(0, calls.indexOf('create Fail') + 1);
    expect(forward).toEqual([
      'create Role',
      `delete Role ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${NEW_ROLE}`,
      `update Managed -> ${NEW_ROLE}`,
      'create Fail',
    ]);
    // The rollback.
    expect(calls.slice(forward.length)).toEqual([
      'create Role',
      `update Managed -> ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${OLD_ROLE}`,
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(warned.filter((w) => w.includes('cannot be found'))).toEqual([]);
    expect([...roles]).toEqual([OLD_ROLE]);
  });

  // Review N4: the automatic rollback's one save records a new copy its
  // deferred delete could not remove, as `cdkd rollback` does, so the next
  // deploy deletes it instead of leaving it untracked.
  it('a new role the rollback could not delete stays recorded as superseded', async () => {
    const engine = buildEngine({ newRoleDeleteFails: true });
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);

    expect(calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Role']!.physicalId).toBe(OLD_ROLE);
    expect(saved.supersededResources?.map((e) => [e.logicalId, e.state.physicalId])).toEqual([
      ['Role', NEW_ROLE],
    ]);
    expect(warned.some((w) => w.includes('next `cdkd deploy`'))).toBe(true);
  });

  it('a new role the rollback deleted is not recorded', async () => {
    const engine = buildEngine();
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.supersededResources).toBeUndefined();
  });

  it('names a new role it could not delete when the post-rollback save fails too', async () => {
    const engine = buildEngine({ newRoleDeleteFails: true });
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    // Every save after the rollback's delete attempt fails.
    saveState.mockImplementation(async () => {
      if (calls.includes(`delete Role ${NEW_ROLE}`)) throw new Error('save refused');
      return 'etag-1';
    });
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);
    expect(
      warned.some((w) => w.includes(NEW_ROLE) && w.includes('is NOT recorded'))
    ).toBe(true);
  });

  // Review N-a: the user's Ctrl-C reaches the automatic rollback's replay (a
  // DynamoDB name-release wait, a re-create retry, the next op). Fired through
  // the SIGINT listener `deploy()` itself registers; the sibling failure that
  // started the rollback does not stop it (the tests above run to the end).
  it("a Ctrl-C during the rollback stops its replay, and keeps the new role recorded", async () => {
    const engine = buildEngine();
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    const before = new Set(process.listeners('SIGINT'));
    const provider = (
      engine as unknown as { providerRegistry: { getProviderFor: () => { provider: { create: ReturnType<typeof vi.fn> } } } }
    ).providerRegistry.getProviderFor().provider;
    const create = provider.create.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    provider.create.mockImplementation(async (...args: unknown[]) => {
      const out = await create(...args);
      // The rollback's re-create of the old role: the user presses Ctrl-C.
      if (args[0] === 'Role' && calls.filter((c) => c === 'create Role').length === 2) {
        const registered = process.listeners('SIGINT').filter((l) => !before.has(l));
        expect(registered).toHaveLength(1);
        (registered[0] as () => void)();
      }
      return out;
    });
    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    const rollback = calls.slice(calls.indexOf('create Fail') + 1);
    expect(rollback).toEqual(['create Role']);
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.supersededResources?.map((e) => e.state.physicalId)).toEqual([NEW_ROLE]);
    // Ops were left unreverted: the journal stays for `cdkd rollback`.
    const backend = (engine as unknown as { stateBackend: Record<string, ReturnType<typeof vi.fn>> })
      .stateBackend;
    expect(backend['deleteRollbackJournal']).not.toHaveBeenCalled();
    expect(backend['reduceRollbackJournalToFailedOperations']).not.toHaveBeenCalled();
    expect(backend['popRollbackJournalSegment']).not.toHaveBeenCalled();
    // ...and the remedy is named.
    expect(
      warned.filter((w) => w.includes('automatic rollback was interrupted') && w.includes(`cdkd rollback ${STACK}`))
    ).toHaveLength(1);
  });

  it('a clean automatic rollback still settles its journal (control)', async () => {
    const engine = buildEngine();
    const { template } = engine as unknown as { template: CloudFormationTemplate };
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);
    const backend = (engine as unknown as { stateBackend: Record<string, ReturnType<typeof vi.fn>> })
      .stateBackend;
    // The completed ops' segment is settled.
    const settled = ['deleteRollbackJournal', 'reduceRollbackJournalToFailedOperations', 'popRollbackJournalSegment']
      .filter((m) => backend[m]!.mock.calls.length > 0);
    expect(settled).not.toEqual([]);
    expect(warned.some((w) => w.includes('automatic rollback was interrupted'))).toBe(false);
  });
});

