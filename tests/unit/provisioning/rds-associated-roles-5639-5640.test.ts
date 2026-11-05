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
 * leave; `onRoleCall` may throw instead of applying a call.
 */
function arm(
  options: {
    roles?: Input[];
    status?: (describes: number) => string;
    onRoleCall?: (name: string, input: Input) => void;
  } = {}
): void {
  let roles = (options.roles ?? []).map((role) => ({ ...role, Status: 'ACTIVE' }));
  let describes = 0;
  mockSend.mockImplementation((command: Command) => {
    const name = command.constructor.name;
    switch (name) {
      case 'DescribeDBClustersCommand':
      case 'DescribeDBInstancesCommand': {
        describes += 1;
        const status = options.status?.(describes) ?? 'available';
        return Promise.resolve(
          name === 'DescribeDBClustersCommand'
            ? {
                DBClusters: [
                  {
                    DBClusterIdentifier: 'c-1',
                    Status: status,
                    DBClusterMembers: [],
                    AssociatedRoles: roles,
                  },
                ],
              }
            : {
                DBInstances: [
                  { DBInstanceIdentifier: 'i-1', DBInstanceStatus: status, AssociatedRoles: roles },
                ],
              }
        );
      }
      case 'CreateDBClusterCommand':
        return Promise.resolve({ DBCluster: { DBClusterIdentifier: 'c-1' } });
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'i-1' } });
      case 'AddRoleToDBClusterCommand':
      case 'AddRoleToDBInstanceCommand':
        options.onRoleCall?.(name, command.input);
        roles = [
          ...roles,
          {
            RoleArn: command.input['RoleArn'] as string,
            FeatureName: command.input['FeatureName'] as string,
            Status: 'PENDING',
          },
        ];
        return Promise.resolve({});
      case 'RemoveRoleFromDBClusterCommand':
      case 'RemoveRoleFromDBInstanceCommand':
        options.onRoleCall?.(name, command.input);
        roles = roles.filter(
          (role) =>
            !(
              role.RoleArn === command.input['RoleArn'] &&
              role.FeatureName === command.input['FeatureName']
            )
        );
        return Promise.resolve({});
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
      default:
        return Promise.resolve({});
    }
  });
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

  it('plans against the live list: nothing re-attached, nothing re-detached, nothing unrecorded detached', () => {
    const a = { RoleArn: ROLE_A, FeatureName: 's3Import' };
    const b = { RoleArn: ROLE_B, FeatureName: 's3Export' };
    const x = { RoleArn: ROLE_X, FeatureName: 'Lambda' };
    // `a` is already attached (a retry after a partial run), `b` was dropped
    // and is still live, `x` was attached out of band and is in no record.
    expect(planAssociatedRoleChanges([a], [a, b], [a, b, x])).toEqual({ toAdd: [], toRemove: [b] });
    // A dropped role already gone is not detached again.
    expect(planAssociatedRoleChanges([a], [a, b], [])).toEqual({ toAdd: [a], toRemove: [] });
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
      arm({ status: (n) => (n <= 2 ? 'creating' : 'available') });
      await provider.create('L', CLUSTER, {
        ...CLUSTER_BASE,
        AssociatedRoles: [{ RoleArn: ROLE_A }],
      });
      expect(sent('AddRoleToDBClusterCommand')).toHaveLength(1);
      // The two `creating` reads came before the attach.
      const order = names();
      const add = order.indexOf('AddRoleToDBClusterCommand');
      expect(order.slice(0, add).filter((n) => n === 'DescribeDBClustersCommand')).toHaveLength(3);
      expect(sleeps).toBe(2);
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

    it('readUnsettled passes a gone resource through', async () => {
      mockSend.mockResolvedValue({ DBClusters: [] });
      expect(
        await provider.readUnsettled('c-1', 'L', CLUSTER, new Set(['AssociatedRoles']))
      ).toBe(RESOURCE_NOT_FOUND);
    });
  });
});
