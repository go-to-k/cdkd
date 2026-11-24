/**
 * go-to-k/cdkd#5064 phase 2, through a deploy's AUTOMATIC rollback (the
 * generated-name-lifecycle integ's phase E2): the deploy replaced Role under a
 * new name, moved a managed policy and an inline policy onto it, then a
 * sibling failed. The in-process rollback shares `replayRollback` with
 * `cdkd rollback`, so it reverted both policies back to the OLD role name
 * before re-creating that role. It must re-create the old role first and
 * delete the new one only after both policies moved back.
 *
 * go-to-k/cdkd#6374: the deploy no longer deletes the old role inline (its
 * delete waits for the cleanup phase, which a failed deploy never reaches), so
 * the rollback reads AWS, finds the old role whole and RE-ADOPTS it: the
 * policies still revert onto it before the new role is deleted. The hoisted
 * re-create itself is covered through `cdkd rollback` in
 * `rollback-renamed-reversal-order-5064.test.ts`, and through the automatic
 * rollback by the second describe below: a renamed DB instance under
 * `UpdateReplacePolicy: Snapshot`, classed here as a type snapshotted BEFORE
 * its delete and given the pre-#6463 snapshot gate, so its delete stays
 * INLINE (go-to-k/cdkd#6445) and the rollback re-creates it ahead of its
 * dependent. The real pre-delete-snapshot types
 * (EBS volume, Redshift cluster, ElastiCache replication group) have no name
 * key a renamed reversal reads, and an RDS instance's own atomic snapshot now
 * defers its delete. A role has no natural non-deferrable shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
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
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockResolvedValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// go-to-k/cdkd#6445: the second describe's DB instance stands in for a type
// snapshotted before its delete, the one Snapshot shape whose replaced delete
// stays inline. The snapshot itself is a no-op here.
const preDeleteSnapshots = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/provisioning/final-snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/final-snapshot.js')>();
  const atomic = new Set(actual.ATOMIC_FINAL_SNAPSHOT_TYPES);
  atomic.delete('AWS::RDS::DBInstance');
  return {
    ...actual,
    ATOMIC_FINAL_SNAPSHOT_TYPES: atomic,
    PRE_DELETE_SNAPSHOT_TYPES: new Set([...actual.PRE_DELETE_SNAPSHOT_TYPES, 'AWS::RDS::DBInstance']),
    createPreDeleteFinalSnapshot: vi.fn(async (_type: string, physicalId: string) => {
      preDeleteSnapshots.push(physicalId);
    }),
  };
});

// go-to-k/cdkd#6463: a pre-delete-snapshot type's create-first replacement now
// defers too, its snapshot moved into the deferred delete. This file keeps the
// pre-#6463 gate, which takes the snapshot before the delete and hands over no
// owed mark, so `deferToCleanupPhase` keeps that delete inline.
vi.mock(
  '../../../src/deployment/deploy-engine/replacement/delete-context.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/deployment/deploy-engine/replacement/delete-context.js')
      >();
    return { ...actual, prepareCreateFirstFinalSnapshot: actual.prepareFinalSnapshotForDelete };
  }
);

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
      readCurrentState: vi.fn(async (physicalId: string) =>
        roles.has(physicalId) ? { RoleName: physicalId } : RESOURCE_NOT_FOUND
      ),
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

  it('E2: re-adopts the old role the failed deploy never deleted, reverts both policies onto it, then deletes the new role', async () => {
    const engine = buildEngine();
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);

    // The forward deploy, as E1/E2 ran it, minus the old role's delete: it
    // waits for the cleanup phase (go-to-k/cdkd#6374).
    const forward = calls.slice(0, calls.indexOf('create Fail') + 1);
    expect(forward).toEqual([
      'create Role',
      `update RoleDefaultPolicy -> ${NEW_ROLE}`,
      `update Managed -> ${NEW_ROLE}`,
      'create Fail',
    ]);
    // The rollback: no re-create, the old role is taken back as it is.
    expect(calls.slice(forward.length)).toEqual([
      `update Managed -> ${OLD_ROLE}`,
      `update RoleDefaultPolicy -> ${OLD_ROLE}`,
      `delete Role ${NEW_ROLE}`,
    ]);
    expect(warned.filter((w) => w.includes('cannot be found'))).toEqual([]);
    expect([...roles]).toEqual([OLD_ROLE]);
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Role']!.physicalId).toBe(OLD_ROLE);
  });

  // Review N4: a new copy the rollback could not delete is never left
  // untracked. go-to-k/cdkd#6374: a re-adopt deletes the new role before it
  // re-points state, so a refused delete leaves the Role record on the new
  // role, and the old one stays recorded as superseded for the next deploy.
  it('a new role the rollback could not delete stays tracked', async () => {
    const engine = buildEngine({ newRoleDeleteFails: true });
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);

    expect(calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Role']!.physicalId).toBe(NEW_ROLE);
    expect(saved.supersededResources?.map((e) => [e.logicalId, e.state.physicalId])).toEqual([
      ['Role', OLD_ROLE],
    ]);
    expect(warned.some((w) => w.includes('Rollback failed for Role') && w.includes('DeleteConflict'))).toBe(true);
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

  // go-to-k/cdkd#6374: the re-adopt keeps no pending new copy (the new role
  // is still the Role record), so the failure the user is told about is the
  // rollback's own save.
  it('reports the refused new-role delete and the failed post-rollback save', async () => {
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
    expect(calls.at(-1)).toBe(`delete Role ${NEW_ROLE}`);
    expect(warned.some((w) => w.includes('Rollback failed for Role'))).toBe(true);
    expect(warned.some((w) => w.includes('Failed to save state after rollback: save refused'))).toBe(
      true
    );
  });

  // Review N-a: the user's Ctrl-C reaches the automatic rollback's replay (a
  // DynamoDB name-release wait, a re-create retry, the next op). Fired through
  // the SIGINT listener `deploy()` itself registers; the sibling failure that
  // started the rollback does not stop it (the tests above run to the end).
  it("a Ctrl-C during the rollback stops its replay, and keeps the new role recorded", async () => {
    // go-to-k/cdkd#6374: pressed during the rollback's first revert (the
    // re-adopt re-creates nothing).
    const engine = buildEngine();
    const { template, saveState } = engine as unknown as {
      template: CloudFormationTemplate;
      saveState: ReturnType<typeof vi.fn>;
    };
    const before = new Set(process.listeners('SIGINT'));
    const provider = (
      engine as unknown as { providerRegistry: { getProviderFor: () => { provider: { update: ReturnType<typeof vi.fn> } } } }
    ).providerRegistry.getProviderFor().provider;
    const update = provider.update.getMockImplementation() as (...a: unknown[]) => Promise<unknown>;
    provider.update.mockImplementation(async (...args: unknown[]) => {
      const out = await update(...args);
      // The rollback's first revert onto the old role: the user presses Ctrl-C.
      if (calls.at(-1) === `update Managed -> ${OLD_ROLE}`) {
        const registered = process.listeners('SIGINT').filter((l) => !before.has(l));
        expect(registered).toHaveLength(1);
        (registered[0] as () => void)();
      }
      return out;
    });
    await expect(engine.deploy(STACK, template)).rejects.toThrow();

    const rollback = calls.slice(calls.indexOf('create Fail') + 1);
    expect(rollback).toEqual([`update Managed -> ${OLD_ROLE}`]);
    // The new role is still the Role record, and the old one stays recorded.
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Role']!.physicalId).toBe(NEW_ROLE);
    expect(saved.supersededResources?.map((e) => e.state.physicalId)).toEqual([OLD_ROLE]);
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


// A replacement whose old-resource delete stays INLINE (go-to-k/cdkd#6374):
// `UpdateReplacePolicy: Snapshot` on a type snapshotted before its delete (the
// mock above), so the delete is not deferred (go-to-k/cdkd#6445), the op journals no survivor verdict, and the
// automatic rollback re-creates the renamed old resource ahead of the
// dependent that reverts onto it.
describe('the automatic rollback re-creates an inline-deleted renamed replacement first (go-to-k/cdkd#5064)', () => {
  const DB = 'AWS::RDS::DBInstance';
  const TARGETS = 'AWS::RDS::DBProxyTargetGroup';
  const OLD_DB = 'app-db-1';
  const NEW_DB = 'app-db-2';
  const TG_ID = 'prx-tg-1';
  let calls: string[];
  let dbs: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    calls = [];
    dbs = new Set([OLD_DB]);
    preDeleteSnapshots.length = 0;
  });

  const dbProps = (id: string) => ({ DBInstanceIdentifier: id, DBInstanceClass: 'db.t4g.micro' });
  const tgProps = (id: string) => ({ DBProxyName: 'prx', DBInstanceIdentifiers: [id] });

  function buildEngine(options: { newDbDeleteFails?: boolean } = {}) {
    const provider = {
      create: vi.fn(async (logicalId: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`create ${logicalId}`);
        if (logicalId === 'Fail') throw new Error('create failed: Fail');
        const id = props['DBInstanceIdentifier'] as string;
        dbs.add(id);
        return { physicalId: id, attributes: {} };
      }),
      update: vi.fn(
        async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
          const db = (props['DBInstanceIdentifiers'] as string[])[0]!;
          calls.push(`update ${logicalId} -> ${db}`);
          if (!dbs.has(db)) throw new Error(`DBInstanceNotFound: ${db} not found.`);
          return { physicalId, wasReplaced: false };
        }
      ),
      delete: vi.fn(async (logicalId: string, physicalId: string) => {
        calls.push(`delete ${logicalId} ${physicalId}`);
        if (options.newDbDeleteFails === true && physicalId === NEW_DB) {
          throw new Error('InvalidDBInstanceState: the instance is being modified.');
        }
        dbs.delete(physicalId);
      }),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(async (physicalId: string) =>
        dbs.has(physicalId) ? { DBInstanceIdentifier: physicalId } : RESOURCE_NOT_FOUND
      ),
    };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName: STACK,
      resources: {
        Db: rec(OLD_DB, DB, dbProps(OLD_DB), []),
        Targets: rec(TG_ID, TARGETS, tgProps(OLD_DB), ['Db']),
      },
      outputs: {},
      lastModified: 0,
    };
    const changes = new Map<string, ResourceChange>([
      [
        'Db',
        {
          logicalId: 'Db',
          changeType: 'UPDATE',
          resourceType: DB,
          currentProperties: dbProps(OLD_DB),
          desiredProperties: dbProps(NEW_DB),
          propertyChanges: [
            { path: 'DBInstanceIdentifier', oldValue: OLD_DB, newValue: NEW_DB, requiresReplacement: true },
          ],
        },
      ],
      [
        'Targets',
        {
          logicalId: 'Targets',
          changeType: 'UPDATE',
          resourceType: TARGETS,
          currentProperties: tgProps(OLD_DB),
          desiredProperties: tgProps(NEW_DB),
          propertyChanges: [
            {
              path: 'DBInstanceIdentifiers',
              oldValue: [OLD_DB],
              newValue: [NEW_DB],
              requiresReplacement: false,
            },
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
    const deps: Record<string, string[]> = { Db: [], Targets: ['Db'], Fail: ['Targets'] };
    const template = {
      Resources: {
        Db: { Type: DB, Properties: dbProps(NEW_DB), UpdateReplacePolicy: 'Snapshot' },
        Targets: { Type: TARGETS, Properties: tgProps(NEW_DB) },
        Fail: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
    } as unknown as CloudFormationTemplate;
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
        getExecutionLevels: vi.fn().mockReturnValue([['Db'], ['Targets'], ['Fail']]),
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
      { dryRun: false, concurrency: 1, forceStatefulRecreation: true } as never,
      'us-east-1',
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
    return { engine, template, saveState, provider };
  }

  it('E2: deletes the old instance inline, then the rollback re-creates it before the target group reverts onto it', async () => {
    const { engine, template, provider } = buildEngine();
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);

    const forward = calls.slice(0, calls.indexOf('create Fail') + 1);
    expect(forward).toEqual([
      'create Db',
      `delete Db ${OLD_DB}`,
      `update Targets -> ${NEW_DB}`,
      'create Fail',
    ]);
    // The final snapshot of the old instance was taken before its inline delete.
    expect(preDeleteSnapshots[0]).toBe(OLD_DB);
    expect(provider.delete).toHaveBeenCalled();
    expect(calls.slice(forward.length)).toEqual([
      'create Db',
      `update Targets -> ${OLD_DB}`,
      `delete Db ${NEW_DB}`,
    ]);
    expect(warned.filter((w) => w.includes('not found'))).toEqual([]);
    expect([...dbs]).toEqual([OLD_DB]);
  });

  // Review N4, through the automatic rollback.
  it('a new instance the rollback could not delete stays recorded as superseded', async () => {
    const { engine, template, saveState } = buildEngine({ newDbDeleteFails: true });
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);

    expect(calls.at(-1)).toBe(`delete Db ${NEW_DB}`);
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Db']!.physicalId).toBe(OLD_DB);
    expect(saved.supersededResources?.map((e) => [e.logicalId, e.state.physicalId])).toEqual([
      ['Db', NEW_DB],
    ]);
    expect(warned.some((w) => w.includes('next `cdkd deploy`'))).toBe(true);
  });

  it('names a new instance it could not delete when the post-rollback save fails too', async () => {
    const { engine, template, saveState } = buildEngine({ newDbDeleteFails: true });
    // Every save after the rollback's delete attempt fails.
    saveState.mockImplementation(async () => {
      if (calls.includes(`delete Db ${NEW_DB}`)) throw new Error('save refused');
      return 'etag-1';
    });
    await expect(engine.deploy(STACK, template)).rejects.toThrow(/Fail/);
    expect(warned.some((w) => w.includes(NEW_DB) && w.includes('is NOT recorded'))).toBe(true);
  });
});
