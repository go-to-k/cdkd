// go-to-k/cdkd#5639 / #5640: `AssociatedRoles` on AWS::RDS::DBCluster and
// AWS::RDS::DBInstance on the SDK route, through the plan the Neptune cluster
// already used (`db-associated-roles.ts`). A create attaches each role once the
// resource is `available`; an update detaches the dropped ones and attaches the
// added ones, planned against the live list; a malformed list is refused before
// any call; the readback reports the associations in the CFn shape.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const warn = vi.fn();

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import {
  associatedRoleList,
  associatedRolesNamed,
  canonicalAssociatedRoles,
  isRoleCallNotAvailableRefusal,
  planAssociatedRoleChanges,
} from '../../../src/provisioning/providers/db-associated-roles.js';
import { isAuxiliaryFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import {
  settleUnsettledPrevious,
  unsettledAfterUpdate,
} from '../../../src/deployment/unsettled-convergence.js';

type Input = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Input };

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';
const ROLE_A = 'arn:aws:iam::123456789012:role/role-a';
const ROLE_B = 'arn:aws:iam::123456789012:role/role-b';
const ROLE_X = 'arn:aws:iam::123456789012:role/out-of-band';

const CLUSTER_BASE: Input = {
  DBClusterIdentifier: 'c-1',
  Engine: 'aurora-postgresql',
  MasterUsername: 'admin',
};
const INSTANCE_BASE: Input = {
  DBInstanceIdentifier: 'i-1',
  DBInstanceClass: 'db.t4g.micro',
  Engine: 'postgres',
  AllocatedStorage: '20',
  MasterUsername: 'admin',
};

function sentCommands(): Command[] {
  return mockSend.mock.calls.map(([command]) => command as Command);
}
function sent(name: string): Input[] {
  return sentCommands()
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}
function names(): string[] {
  return sentCommands().map((command) => command.constructor.name);
}

/**
 * DescribeDBClusters / DescribeDBInstances answer `status` (a function of the
 * call count, `available` by default) and the roles the Add / Remove calls
 * leave. An attach shows, and a detach takes effect, only `lag` Describes
 * after the call (0: at once), as AWS lists a change a moment later;
 * `onRoleCall` may throw instead of applying a call, and `empty` answers no
 * resource on the Describes it names.
 */
function arm(
  options: {
    roles?: Input[];
    status?: (describes: number) => string;
    onRoleCall?: (name: string, input: Input) => void;
    lag?: number;
    empty?: (describes: number) => boolean;
    /** When it answers a list, the live roles every Describe reports instead. */
    rolesNow?: () => Input[] | undefined;
    /** Thrown by a Remove* call AFTER the detach took effect (a lost response). */
    failAfterRemove?: Error;
  } = {}
): { describes: () => number } {
  let roles: Input[] = (options.roles ?? []).map((role) => ({ ...role, Status: 'ACTIVE' }));
  let pending: Array<{ after: number; apply: () => void }> = [];
  let describes = 0;
  const later = (apply: () => void): void => {
    if ((options.lag ?? 0) === 0) apply();
    else pending.push({ after: options.lag ?? 0, apply });
  };
  mockSend.mockImplementation((command: Command) => {
    const name = command.constructor.name;
    switch (name) {
      case 'DescribeDBClustersCommand':
      case 'DescribeDBInstancesCommand': {
        describes += 1;
        for (const entry of pending) entry.after -= 1;
        for (const entry of pending.filter((e) => e.after < 0)) entry.apply();
        pending = pending.filter((e) => e.after >= 0);
        if (options.empty?.(describes) === true) {
          return Promise.resolve(
            name === 'DescribeDBClustersCommand' ? { DBClusters: [] } : { DBInstances: [] }
          );
        }
        const status = options.status?.(describes) ?? 'available';
        const listed = options.rolesNow?.() ?? roles;
        return Promise.resolve(
          name === 'DescribeDBClustersCommand'
            ? {
                DBClusters: [
                  {
                    DBClusterIdentifier: 'c-1',
                    Status: status,
                    DBClusterMembers: [],
                    AssociatedRoles: listed,
                  },
                ],
              }
            : {
                DBInstances: [
                  { DBInstanceIdentifier: 'i-1', DBInstanceStatus: status, AssociatedRoles: listed },
                ],
              }
        );
      }
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'i-1' } });
      case 'AddRoleToDBClusterCommand':
      case 'AddRoleToDBInstanceCommand': {
        options.onRoleCall?.(name, command.input);
        const added = {
          RoleArn: command.input['RoleArn'] as string,
          FeatureName: command.input['FeatureName'] as string,
          Status: 'PENDING',
        };
        later(() => {
          roles = [...roles, added];
        });
        return Promise.resolve({});
      }
      case 'RemoveRoleFromDBClusterCommand':
      case 'RemoveRoleFromDBInstanceCommand': {
        options.onRoleCall?.(name, command.input);
        const { RoleArn: arn, FeatureName: feature } = command.input;
        later(() => {
          roles = roles.filter((role) => !(role['RoleArn'] === arn && role['FeatureName'] === feature));
        });
        if (options.failAfterRemove !== undefined) return Promise.reject(options.failAfterRemove);
        return Promise.resolve({});
      }
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
      default:
        return Promise.resolve({});
    }
  });
  return { describes: () => describes };
}

/**
 * Wraps the provider's pre-call `available` wait (cluster or instance) so
 * `onReturn` runs when it resolves: the live list can then change "across the
 * wait".
 */
function afterWait(provider: unknown, onReturn: () => void): void {
  const target = provider as Record<string, (...args: unknown[]) => Promise<void>>;
  for (const name of ['waitForClusterAvailable', 'waitForInstanceAvailable']) {
    const original = target[name]!.bind(provider);
    target[name] = async (...args: unknown[]) => {
      await original(...args);
      onReturn();
    };
  }
}

/** The Describe and sleep counts once `name` was first sent. */
function describesBefore(name: string): number {
  const order = names();
  return order
    .slice(0, order.indexOf(name))
    .filter((n) => n === 'DescribeDBClustersCommand' || n === 'DescribeDBInstancesCommand').length;
}

describe('db-associated-roles (go-to-k/cdkd#5639 / #5640)', () => {
  it('reads absent / null as empty, a malformed list as unusable, and collapses a repeat', () => {
    expect(associatedRoleList(undefined)).toEqual([]);
    expect(associatedRoleList(null)).toEqual([]);
    expect(associatedRoleList('arn')).toBeUndefined();
    expect(associatedRoleList([{ FeatureName: 's3Import' }])).toBeUndefined();
    expect(associatedRoleList([{ RoleArn: ROLE_A, FeatureName: 7 }])).toBeUndefined();
    expect(
      associatedRoleList([
        { RoleArn: ROLE_A, FeatureName: '' },
        { RoleArn: ROLE_A },
        { RoleArn: ROLE_B, FeatureName: 's3Import' },
      ])
    ).toEqual([{ RoleArn: ROLE_A }, { RoleArn: ROLE_B, FeatureName: 's3Import' }]);
  });

  it('requires a FeatureName only for the instance shape', () => {
    expect(associatedRoleList([{ RoleArn: ROLE_A }])).toEqual([{ RoleArn: ROLE_A }]);
    expect(associatedRoleList([{ RoleArn: ROLE_A }], { featureNameRequired: true })).toBeUndefined();
  });

  it('plans as CloudFormation does, minus what the live list shows done', () => {
    const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
    const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
    const x = { RoleArn: ROLE_X, FeatureName: 'Lambda' };
    // Without the live list: what the template added and dropped.
    expect(planAssociatedRoleChanges([a, x], [b, x])).toEqual({ toAdd: [a], toRemove: [b] });
    // `a` is already attached (a retry after a partial run): not attached again.
    expect(planAssociatedRoleChanges([a], [b], [a, b])).toEqual({ toAdd: [], toRemove: [b] });
    // A dropped role already gone is not detached again.
    expect(planAssociatedRoleChanges([a], [b], [])).toEqual({ toAdd: [a], toRemove: [] });
    // A declared role detached outside cdkd is not attached again by an
    // unrelated update; a role attached outside cdkd is not detached.
    expect(planAssociatedRoleChanges([a], [a], [x])).toEqual({ toAdd: [], toRemove: [] });
    // The same role for another feature is another association.
    expect(planAssociatedRoleChanges([{ ...a, FeatureName: 's3Export' }], [a], [a])).toEqual({
      toAdd: [{ ...a, FeatureName: 's3Export' }],
      toRemove: [a],
    });
  });

  it('projects the live list onto what the record, the template or an attempt names', () => {
    const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
    const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
    const x = { RoleArn: ROLE_X, FeatureName: 'Lambda' };
    expect(associatedRolesNamed([a, b, x], [a], undefined, undefined)).toEqual([a]);
    expect(associatedRolesNamed([a, b, x], undefined, [b], [`${ROLE_X}\nLambda`])).toEqual([b, x]);
    // A redacted attempted name names nothing.
    expect(associatedRolesNamed([x], undefined, undefined, ['***'])).toEqual([]);
  });

  it('reports a declared role detached outside cdkd as held, but not one cdkd itself detached', () => {
    const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
    const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
    // B: in the record and the template, gone from AWS, touched by no attempt.
    expect(associatedRolesNamed([a], [a, b], [a, b], undefined)).toEqual([a, b]);
    // An attempt of cdkd's detached it: the convergence must attach it again.
    expect(associatedRolesNamed([a], [a, b], [a, b], [`${ROLE_B}\ns3Export`])).toEqual([a]);
    // Only the template declares it: an add still owed, never reported held.
    expect(associatedRolesNamed([a], [a], [a, b], undefined)).toEqual([a]);
  });

  it('folds a repeated entry and an empty FeatureName for drift, leaving a malformed list alone', () => {
    expect(canonicalAssociatedRoles([{ RoleArn: ROLE_A, FeatureName: '' }, { RoleArn: ROLE_A }])).toEqual([
      { RoleArn: ROLE_A },
    ]);
    expect(canonicalAssociatedRoles([{ FeatureName: 'x' }])).toEqual([{ FeatureName: 'x' }]);
  });

  it('classifies the busy role-call refusal of either fault, nothing else', () => {
    const fault = (name: string, message: string): Error =>
      Object.assign(new Error(message), { name });
    const busy = 'The DB cluster c-1 is not available for IAM role association, disassociation, or updates.';
    expect(isRoleCallNotAvailableRefusal(fault('InvalidDBClusterStateFault', busy))).toBe(true);
    expect(isRoleCallNotAvailableRefusal(fault('InvalidDBInstanceStateFault', busy))).toBe(true);
    expect(isRoleCallNotAvailableRefusal(fault('DBClusterRoleQuotaExceededFault', busy))).toBe(false);
    expect(isRoleCallNotAvailableRefusal(fault('InvalidDBClusterStateFault', 'other'))).toBe(false);
  });
});

describe('RDSProvider AssociatedRoles (go-to-k/cdkd#5639 / #5640)', () => {
  let provider: RDSProvider;
  let sleeps: number;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    provider = new RDSProvider();
    sleeps = 0;
    // A wait that never settles fails the case instead of spinning.
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      sleeps += 1;
      if (sleeps > 20) throw new Error('test sleep budget exceeded: a wait never settled');
    };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  describe('DBCluster create', () => {
    it('attaches each declared role after the cluster is available, with its feature', async () => {
      arm();
      await provider.create('L', CLUSTER, {
        ...CLUSTER_BASE,
        AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }, { RoleArn: ROLE_B }],
      });
      expect(sent('AddRoleToDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_A, FeatureName: 's3Import' },
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_B },
      ]);
      const order = names();
      expect(order.indexOf('CreateDBClusterCommand')).toBeLessThan(
        order.indexOf('AddRoleToDBClusterCommand')
      );
    });

    it('waits for available before attaching under --no-wait too, and skips only the settle wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      // The attach shows only three Describes later: a settle wait would sleep.
      arm({ status: (n) => (n <= 2 ? 'creating' : 'available'), lag: 3 });
      await provider.create('L', CLUSTER, {
        ...CLUSTER_BASE,
        AssociatedRoles: [{ RoleArn: ROLE_A }],
      });
      expect(sent('AddRoleToDBClusterCommand')).toHaveLength(1);
      // Two `creating` reads, the `available` one, then the plan's read.
      expect(describesBefore('AddRoleToDBClusterCommand')).toBe(4);
      // Both sleeps came before the attach: nothing waited for it to show.
      expect(sleeps).toBe(2);
    });

    it.each([
      [CLUSTER, 'AddRoleToDBClusterCommand', 'c-1'],
      [INSTANCE, 'AddRoleToDBInstanceCommand', 'i-1'],
    ])('%s: without --no-wait, returns only once the attached role is listed', async (type, add, id) => {
      const live = arm({ lag: 3 });
      const base = type === CLUSTER ? CLUSTER_BASE : INSTANCE_BASE;
      await provider.update(
        'L',
        id,
        type,
        { ...base, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
        base
      );
      expect(sent(add)).toHaveLength(1);
      const afterAdd = live.describes() - describesBefore(add);
      // The lag's three Describes before the one listing it, then the attributes read.
      expect(afterAdd).toBeGreaterThanOrEqual(4);
      expect(sleeps).toBeGreaterThanOrEqual(3);
    });

    it.each([
      [CLUSTER, 'RemoveRoleFromDBClusterCommand', 'c-1'],
      [INSTANCE, 'RemoveRoleFromDBInstanceCommand', 'i-1'],
    ])('%s: without --no-wait, returns only once the detached role is gone', async (type, remove, id) => {
      const role = { RoleArn: ROLE_A, FeatureName: 's3Import' };
      const live = arm({ roles: [role], lag: 2 });
      const base = type === CLUSTER ? CLUSTER_BASE : INSTANCE_BASE;
      await provider.update('L', id, type, base, { ...base, AssociatedRoles: [role] });
      expect(sent(remove)).toHaveLength(1);
      expect(live.describes() - describesBefore(remove)).toBeGreaterThanOrEqual(3);
      expect(sleeps).toBeGreaterThanOrEqual(2);
    });

    it('under --no-wait an update returns without waiting for the attach to show', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      arm({ lag: 3 });
      await provider.update(
        'L',
        'i-1',
        INSTANCE,
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
        INSTANCE_BASE
      );
      expect(sent('AddRoleToDBInstanceCommand')).toHaveLength(1);
      expect(sleeps).toBe(0);
    });

    it('sends no role call for an empty or absent list', async () => {
      arm();
      await provider.create('L', CLUSTER, { ...CLUSTER_BASE, AssociatedRoles: [] });
      await provider.create('L', CLUSTER, CLUSTER_BASE);
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
    });

    it('refuses a malformed list before CreateDBCluster', async () => {
      arm();
      await expect(
        provider.create('L', CLUSTER, { ...CLUSTER_BASE, AssociatedRoles: [{ FeatureName: 'x' }] })
      ).rejects.toThrow(/AssociatedRoles must be a list of objects with a RoleArn; nothing was changed/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a rollback re-create warns, attaches none and records none', async () => {
      arm();
      const result = await provider.create(
        'L',
        CLUSTER,
        { ...CLUSTER_BASE, AssociatedRoles: 'not-a-list' },
        { replayingState: true }
      );
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the replayed AssociatedRoles'));
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('AssociatedRoles');
    });

    it('a rollback re-create with a well-formed list attaches it', async () => {
      arm();
      await provider.create(
        'L',
        CLUSTER,
        { ...CLUSTER_BASE, AssociatedRoles: [{ RoleArn: ROLE_A }] },
        { replayingState: true }
      );
      expect(sent('AddRoleToDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_A },
      ]);
    });

    it("marks a role call's failure auxiliary, so it is never this cluster name's collision", async () => {
      arm({
        onRoleCall: () => {
          throw Object.assign(new Error('Role already exists'), {
            name: 'DBClusterRoleAlreadyExistsFault',
          });
        },
      });
      const error = await provider
        .create('L', CLUSTER, { ...CLUSTER_BASE, AssociatedRoles: [{ RoleArn: ROLE_A }] })
        .catch((e: unknown) => e);
      expect(isAuxiliaryFailure(error)).toBe(true);
    });
  });

  describe('DBCluster update', () => {
    const update = (next: Input, prev: Input, context?: Record<string, unknown>) =>
      provider.update(
        'L',
        'c-1',
        CLUSTER,
        { ...CLUSTER_BASE, ...next },
        { ...CLUSTER_BASE, ...prev },
        context
      );

    it('detaches the dropped role before attaching the added one, and marks both', async () => {
      arm({ roles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] });
      const markUnsettled = vi.fn();
      const markAttempted = vi.fn();
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_B, FeatureName: 's3Export' }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
        { markUnsettled, markAttempted }
      );
      const order = names();
      expect(order.indexOf('RemoveRoleFromDBClusterCommand')).toBeLessThan(
        order.indexOf('AddRoleToDBClusterCommand')
      );
      expect(sent('RemoveRoleFromDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_A, FeatureName: 's3Import' },
      ]);
      expect(sent('AddRoleToDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_B, FeatureName: 's3Export' },
      ]);
      expect(markUnsettled).toHaveBeenCalledWith('AssociatedRoles');
      expect(markAttempted).toHaveBeenCalledWith('AssociatedRoles', [`${ROLE_B}\ns3Export`]);
    });

    it('removing the whole list detaches every recorded role still live', async () => {
      arm({ roles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_X }] });
      await update({}, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      expect(sent('RemoveRoleFromDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_A },
      ]);
      expect(sent('AddRoleToDBClusterCommand')).toEqual([]);
    });

    it('marks nothing and calls nothing when the live list already matches', async () => {
      arm({ roles: [{ RoleArn: ROLE_A }] });
      const markUnsettled = vi.fn();
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_A }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A }] },
        { markUnsettled }
      );
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
      expect(markUnsettled).not.toHaveBeenCalled();
    });

    it('waits out a busy refusal and resends the call', async () => {
      let refusals = 0;
      arm({
        onRoleCall: (name) => {
          if (name === 'AddRoleToDBClusterCommand' && refusals === 0) {
            refusals += 1;
            throw Object.assign(
              new Error(
                'The DB cluster c-1 is not available for IAM role association, disassociation, or updates.'
              ),
              { name: 'InvalidDBClusterStateFault' }
            );
          }
        },
      });
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {});
      expect(sent('AddRoleToDBClusterCommand')).toHaveLength(2);
    });

    it('refuses a malformed desired list before any call, on a rollback replay too', async () => {
      arm();
      for (const context of [undefined, { replayingState: true }, { desiredFromAwsReadback: true }]) {
        await expect(
          update({ AssociatedRoles: { RoleArn: ROLE_A } }, { AssociatedRoles: [{ RoleArn: ROLE_A }] }, context)
        ).rejects.toThrow(/AssociatedRoles must be a list of objects with a RoleArn/);
      }
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      [CLUSTER, 'c-1'],
      [INSTANCE, 'i-1'],
    ])('%s: a re-run after a partial swap plans against the live list read after the wait', async (type, id) => {
      // An earlier run already detached A and attached B; the record still says
      // A. Until the wait returns AWS still lists A (the earlier run's calls
      // were settling), so only a plan read after the wait sees B.
      const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
      const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
      let waited = false;
      arm({ rolesNow: () => (waited ? [b] : [a]) });
      afterWait(provider, () => {
        waited = true;
      });
      const base = type === CLUSTER ? CLUSTER_BASE : INSTANCE_BASE;
      const markUnsettled = vi.fn();
      await provider.update(
        'L',
        id,
        type,
        { ...base, AssociatedRoles: [b] },
        { ...base, AssociatedRoles: [a] },
        { markUnsettled }
      );
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
      expect(markUnsettled).not.toHaveBeenCalled();
    });

    it.each([
      [CLUSTER, 'c-1', 'AddRoleToDBClusterCommand'],
      [INSTANCE, 'i-1', 'AddRoleToDBInstanceCommand'],
    ])(
      '%s: a role detached outside cdkd beside an added one is neither attached again nor kept unsettled',
      async (type, id, add) => {
        const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
        const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
        const c = { RoleArn: ROLE_X, FeatureName: 'Lambda' };
        // The record and the template declare A and B; B was detached outside cdkd.
        arm({ roles: [a] });
        const base = type === CLUSTER ? CLUSTER_BASE : INSTANCE_BASE;
        const recorded = { ...base, AssociatedRoles: [a, b] };
        const desired = { ...base, AssociatedRoles: [a, b, c] };
        const markUnsettled = vi.fn();
        await provider.update('L', id, type, desired, recorded, { markUnsettled });
        expect(sent(add).map((input) => input['RoleArn'])).toEqual([ROLE_X]);
        expect(markUnsettled).toHaveBeenCalledWith('AssociatedRoles');
        const identity = {
          provider,
          logicalId: 'L',
          physicalId: id,
          resourceType: type,
          recordedProperties: recorded,
        };
        const names = new Set(['AssociatedRoles']);
        // The post-update proof does not keep the name unsettled over B...
        expect(await unsettledAfterUpdate({ ...identity, names, desired })).toEqual([]);
        // ...and a convergence from it (were it kept) would not attach B again.
        const previous = await settleUnsettledPrevious({
          ...identity,
          names,
          previous: recorded,
          desired,
        });
        mockSend.mockClear();
        await provider.update('L', id, type, desired, previous);
        expect(sent(add)).toEqual([]);
      }
    );

    it.each([
      [CLUSTER, 'c-1', 'AddRoleToDBClusterCommand', 'DBClusterRoleNotFoundFault'],
      [INSTANCE, 'i-1', 'AddRoleToDBInstanceCommand', 'DBInstanceRoleNotFoundFault'],
    ])(
      '%s: a detach AWS applied but that still threw is attached again by the convergence',
      async (type, id, add, fault) => {
        const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
        // AWS removed B, then the call failed (a replayed request reads not found).
        arm({
          roles: [b],
          failAfterRemove: Object.assign(new Error('Role not found'), { name: fault }),
        });
        const base = type === CLUSTER ? CLUSTER_BASE : INSTANCE_BASE;
        const before = { ...base, AssociatedRoles: [b] };
        const markAttempted = vi.fn();
        await expect(
          provider.update('L', id, type, base, before, { markUnsettled: vi.fn(), markAttempted })
        ).rejects.toThrow(/Role not found/);
        const attempted = new Map([
          ['AssociatedRoles', new Set(markAttempted.mock.calls.flatMap(([, items]) => items))],
        ]);
        // The rollback reverts to the record [B]: B is gone, and the run touched it.
        const identity = {
          provider,
          logicalId: 'L',
          physicalId: id,
          resourceType: type,
          recordedProperties: before,
        };
        const names = new Set(['AssociatedRoles']);
        const previous = await settleUnsettledPrevious({
          ...identity,
          names,
          previous: base,
          desired: before,
          attemptedItems: attempted,
        });
        mockSend.mockClear();
        await provider.update('L', id, type, before, previous);
        expect(sent(add).map((input) => input['RoleArn'])).toEqual([ROLE_B]);
      }
    );

    it('a partial failure marks the name, records only the calls that went through, and throws', async () => {
      const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
      const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
      const c = { RoleArn: ROLE_X, FeatureName: 'Lambda' };
      arm({
        roles: [a],
        onRoleCall: (name, input) => {
          if (name === 'AddRoleToDBClusterCommand' && input['RoleArn'] === ROLE_X) {
            throw Object.assign(new Error('Role quota exceeded'), {
              name: 'DBClusterRoleQuotaExceededFault',
            });
          }
        },
      });
      const markUnsettled = vi.fn();
      const markAttempted = vi.fn();
      await expect(
        update(
          { AssociatedRoles: [b, c] },
          { AssociatedRoles: [a] },
          { markUnsettled, markAttempted }
        )
      ).rejects.toThrow(/Role quota exceeded/);
      expect(markUnsettled).toHaveBeenCalledWith('AssociatedRoles');
      // The detach of A and the attach of B went through; C did not.
      expect(markAttempted.mock.calls).toEqual([
        ['AssociatedRoles', [`${ROLE_A}\ns3Import`]],
        ['AssociatedRoles', [`${ROLE_B}\ns3Export`]],
      ]);
    });

    it('does not re-attach a declared role detached outside cdkd, as CloudFormation does not', async () => {
      // The template and the record both declare ROLE_A; AWS no longer holds it.
      arm({ roles: [] });
      const markUnsettled = vi.fn();
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_A }], DeletionProtection: true },
        { AssociatedRoles: [{ RoleArn: ROLE_A }] },
        { markUnsettled }
      );
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
      expect(markUnsettled).not.toHaveBeenCalled();
    });

    it('changes nothing when the Describe after the wait answers no cluster', async () => {
      // The update's own reads answer; the role plan's read (after the wait) does not.
      let planning = false;
      const live = arm({ empty: () => planning });
      (provider as unknown as { waitForClusterAvailable: () => Promise<void> }).waitForClusterAvailable =
        async () => {
          planning = true;
        };
      await expect(
        update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, { AssociatedRoles: [{ RoleArn: ROLE_B }] })
      ).rejects.toThrow(/Describe returned no cluster while planning its role changes/);
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
      expect(live.describes()).toBeGreaterThan(0);
    });

    it('refuses to start the role calls when the resource deadline leaves no time', async () => {
      arm();
      const { withResourceDeadline } = await import('../../../src/deployment/resource-deadline.js');
      await expect(
        withResourceDeadline(
          () => update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}),
          { warnAfterMs: 5_000, timeoutMs: 10_000, onTimeout: () => new Error('deadline') }
        )
      ).rejects.toThrow(/the resource timeout leaves no more time to change the roles of the cluster/);
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
    });

    it('reads a malformed record as nothing to detach, and still attaches what is not live', async () => {
      arm({ roles: [{ RoleArn: ROLE_B }] });
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, { AssociatedRoles: 'garbage' });
      expect(sent('RemoveRoleFromDBClusterCommand')).toEqual([]);
      expect(sent('AddRoleToDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'c-1', RoleArn: ROLE_A },
      ]);
    });
  });

  describe('DBInstance', () => {
    it('attaches each declared role after the create, with its feature', async () => {
      arm();
      await provider.create('L', INSTANCE, {
        ...INSTANCE_BASE,
        AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }],
      });
      expect(sent('AddRoleToDBInstanceCommand')).toEqual([
        { DBInstanceIdentifier: 'i-1', RoleArn: ROLE_A, FeatureName: 's3Import' },
      ]);
    });

    it("marks a role call's failure auxiliary, so it is never this instance name's collision", async () => {
      arm({
        onRoleCall: () => {
          throw Object.assign(new Error('Role already exists'), {
            name: 'DBInstanceRoleAlreadyExistsFault',
          });
        },
      });
      const error = await provider
        .create('L', INSTANCE, {
          ...INSTANCE_BASE,
          AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }],
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(isAuxiliaryFailure(error)).toBe(true);
    });

    it('refuses an entry without a FeatureName before CreateDBInstance', async () => {
      arm();
      await expect(
        provider.create('L', INSTANCE, { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A }] })
      ).rejects.toThrow(/a list of objects with a RoleArn and a FeatureName; nothing was changed/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('an update detaches the dropped role and attaches the added one', async () => {
      arm({ roles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] });
      await provider.update(
        'L',
        'i-1',
        INSTANCE,
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Export' }] },
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] }
      );
      expect(sent('RemoveRoleFromDBInstanceCommand')).toEqual([
        { DBInstanceIdentifier: 'i-1', RoleArn: ROLE_A, FeatureName: 's3Import' },
      ]);
      expect(sent('AddRoleToDBInstanceCommand')).toEqual([
        { DBInstanceIdentifier: 'i-1', RoleArn: ROLE_A, FeatureName: 's3Export' },
      ]);
    });

    it('an update waits for the instance to read available before the role call', async () => {
      // A Modify / reboot leaves the instance `modifying` for a few reads.
      const markUnsettled = vi.fn();
      const markAttempted = vi.fn();
      let modified = false;
      arm({
        status: () => (modified ? 'modifying' : 'available'),
        roles: [{ RoleArn: ROLE_B, FeatureName: 's3Export' }],
      });
      const original = mockSend.getMockImplementation()!;
      let reads = 0;
      mockSend.mockImplementation((command: Command) => {
        const name = command.constructor.name;
        if (name === 'ModifyDBInstanceCommand') modified = true;
        if (name === 'DescribeDBInstancesCommand' && modified && ++reads > 3) modified = false;
        return original(command);
      });
      await provider.update(
        'L',
        'i-1',
        INSTANCE,
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_B, FeatureName: 's3Export' }] },
        { markUnsettled, markAttempted }
      );
      const order = names();
      const remove = order.indexOf('RemoveRoleFromDBInstanceCommand');
      expect(remove).toBeGreaterThan(order.indexOf('ModifyDBInstanceCommand'));
      expect(remove).toBeLessThan(order.indexOf('AddRoleToDBInstanceCommand'));
      // The `modifying` reads were waited out (slept on) before the detach.
      expect(sleeps).toBeGreaterThan(0);
      expect(markUnsettled).toHaveBeenCalledWith('AssociatedRoles');
      expect(markAttempted).toHaveBeenCalledWith('AssociatedRoles', [`${ROLE_A}\ns3Import`]);
    });

    it('waits out a busy refusal of the instance call and resends it', async () => {
      let refusals = 0;
      arm({
        onRoleCall: (name) => {
          if (name === 'AddRoleToDBInstanceCommand' && refusals === 0) {
            refusals += 1;
            throw Object.assign(
              new Error(
                'The DB instance i-1 is not available for IAM role association, disassociation, or updates.'
              ),
              { name: 'InvalidDBInstanceStateFault' }
            );
          }
        },
      });
      await provider.update(
        'L',
        'i-1',
        INSTANCE,
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
        INSTANCE_BASE
      );
      expect(sent('AddRoleToDBInstanceCommand')).toHaveLength(2);
    });

    it('a rollback re-create with a well-formed list attaches it', async () => {
      arm();
      await provider.create(
        'L',
        INSTANCE,
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
        { replayingState: true }
      );
      expect(sent('AddRoleToDBInstanceCommand')).toEqual([
        { DBInstanceIdentifier: 'i-1', RoleArn: ROLE_A, FeatureName: 's3Import' },
      ]);
    });

    it('changes nothing when the Describe after the wait answers no instance', async () => {
      let planning = false;
      arm({ empty: () => planning });
      afterWait(provider, () => {
        planning = true;
      });
      await expect(
        provider.update(
          'L',
          'i-1',
          INSTANCE,
          { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
          INSTANCE_BASE
        )
      ).rejects.toThrow(/Describe returned no instance while planning its role changes/);
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
    });

    it('refuses to start the role calls when the resource deadline leaves no time', async () => {
      arm();
      const { withResourceDeadline } = await import('../../../src/deployment/resource-deadline.js');
      await expect(
        withResourceDeadline(
          () =>
            provider.update(
              'L',
              'i-1',
              INSTANCE,
              { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }] },
              INSTANCE_BASE
            ),
          { warnAfterMs: 5_000, timeoutMs: 10_000, onTimeout: () => new Error('deadline') }
        )
      ).rejects.toThrow(/the resource timeout leaves no more time to change the roles of the instance/);
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
    });

    it('a rollback re-create warns, attaches none and records none', async () => {
      arm();
      const result = await provider.create(
        'L',
        INSTANCE,
        { ...INSTANCE_BASE, AssociatedRoles: [{ RoleArn: ROLE_A }] },
        { replayingState: true }
      );
      expect(names().filter((n) => n.includes('Role'))).toEqual([]);
      expect(result.effectiveProperties).not.toHaveProperty('AssociatedRoles');
      expect(result.effectiveProperties).toMatchObject({ DBInstanceClass: 'db.t4g.micro' });
    });
  });

  describe('readback', () => {
    it.each([
      [CLUSTER, 'c-1'],
      [INSTANCE, 'i-1'],
    ])('%s reports the associations without Status, an empty list when none', async (type, id) => {
      arm({ roles: [{ RoleArn: ROLE_A, FeatureName: 's3Import' }, { RoleArn: ROLE_B }] });
      const live = (await provider.readCurrentState(id, 'L', type)) as Input;
      expect(live['AssociatedRoles']).toEqual([
        { RoleArn: ROLE_A, FeatureName: 's3Import' },
        { RoleArn: ROLE_B },
      ]);
      arm();
      const empty = (await provider.readCurrentState(id, 'L', type)) as Input;
      expect(empty['AssociatedRoles']).toEqual([]);
    });

    it('compares the list unordered and folds both sides alike', () => {
      for (const type of [CLUSTER, INSTANCE]) {
        expect(provider.getDriftUnorderedPaths(type)).toContain('AssociatedRoles');
        expect(
          provider.canonicalizeDriftProperties(type, {
            AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: '' }, { RoleArn: ROLE_A }],
          })
        ).toEqual({ AssociatedRoles: [{ RoleArn: ROLE_A }] });
      }
    });

    it('readUnsettled keeps only the associations the record, the template or an attempt names', async () => {
      arm({ roles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_X }] });
      const live = (await provider.readUnsettled(
        'c-1',
        'L',
        CLUSTER,
        new Set(['AssociatedRoles']),
        { AssociatedRoles: [{ RoleArn: ROLE_A }] },
        { AssociatedRoles: [] },
        new Map()
      )) as Input;
      expect(live['AssociatedRoles']).toEqual([{ RoleArn: ROLE_A }]);
    });

    it('the post-update proof folds both sides like drift', () => {
      for (const type of [CLUSTER, INSTANCE]) {
        expect(
          provider.canonicalizeUnsettledProperties(type, {
            AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: '' }, { RoleArn: ROLE_A }],
          })
        ).toEqual({ AssociatedRoles: [{ RoleArn: ROLE_A }] });
      }
    });

    it('readUnsettled leaves the live roles alone when AssociatedRoles is not unsettled', async () => {
      arm({ roles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_X }] });
      const live = (await provider.readUnsettled(
        'c-1',
        'L',
        CLUSTER,
        new Set(['Port']),
        { AssociatedRoles: [{ RoleArn: ROLE_A }] }
      )) as Input;
      expect(live['AssociatedRoles']).toEqual([{ RoleArn: ROLE_A }, { RoleArn: ROLE_X }]);
    });

    it('readUnsettled passes a gone resource through', async () => {
      mockSend.mockResolvedValue({ DBClusters: [] });
      expect(
        await provider.readUnsettled('c-1', 'L', CLUSTER, new Set(['AssociatedRoles']))
      ).toBe(RESOURCE_NOT_FOUND);
    });
  });
});
