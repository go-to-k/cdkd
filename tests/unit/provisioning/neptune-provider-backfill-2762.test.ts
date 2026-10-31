// go-to-k/cdkd#2762: the DBCluster / DBInstance properties backfilled into
// `handledProperties`. sdk-wire-coverage-15 proves each reaches the wire; this
// suite holds the arms a generic probe cannot spell: the role plan against the
// live list, its waits, the refusals, the major-upgrade pair and drift.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    NeptuneClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => logger };
  return { getLogger: () => logger };
});

import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const CLUSTER = 'AWS::Neptune::DBCluster';
const INSTANCE = 'AWS::Neptune::DBInstance';
const ROLE_A = 'arn:aws:iam::123456789012:role/a';
const ROLE_B = 'arn:aws:iam::123456789012:role/b';

interface LiveRole {
  RoleArn: string;
  FeatureName?: string;
  Status?: string;
}

/** Answers the fake cluster; each Describe consumes one entry of `statuses`. */
function armCluster(options: { roles?: LiveRole[]; statuses?: string[] } = {}): {
  sent: (command: string) => Record<string, unknown>[];
} {
  const roles = [...(options.roles ?? [])];
  const statuses = [...(options.statuses ?? [])];
  mockSend.mockImplementation((command: { constructor: { name: string }; input: LiveRole }) => {
    const name = command.constructor.name;
    if (name === 'CreateDBClusterCommand') return Promise.resolve({ DBCluster: {} });
    if (name === 'AddRoleToDBClusterCommand') {
      roles.push({ ...command.input, Status: 'ACTIVE' });
    }
    if (name === 'RemoveRoleFromDBClusterCommand') {
      roles.splice(
        roles.findIndex((role) => role.RoleArn === command.input.RoleArn),
        1
      );
    }
    if (name === 'DescribeDBClustersCommand') {
      return Promise.resolve({
        DBClusters: [
          { Status: statuses.shift() ?? 'available', AssociatedRoles: roles.map((r) => ({ ...r })) },
        ],
      });
    }
    return Promise.resolve({});
  });
  return {
    sent: (command) =>
      mockSend.mock.calls
        .map(([call]) => call as { constructor: { name: string }; input: Record<string, unknown> })
        .filter((call) => call.constructor.name === command)
        .map((call) => call.input),
  };
}

describe('NeptuneProvider backfilled properties (go-to-k/cdkd#2762)', () => {
  let provider: NeptuneProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new NeptuneProvider();
    // A fake clock the sleeps advance, so a wait's cap is reached at once.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(
      provider as unknown as { sleep(ms: number): Promise<void> },
      'sleep'
    ).mockImplementation((ms) => {
      now += ms;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['CDKD_NO_WAIT'];
  });

  const update = (
    next: Record<string, unknown>,
    previous: Record<string, unknown>,
    type = CLUSTER,
    context?: Record<string, unknown>
  ) => provider.update('L', 'cluster-1', type, next, previous, context);

  describe('AssociatedRoles', () => {
    it('attaches each declared role after the create, keeping its FeatureName', async () => {
      const wire = armCluster();
      await provider.create('L', CLUSTER, {
        AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 'f' }, { RoleArn: ROLE_B }],
      });
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([
        expect.objectContaining({ RoleArn: ROLE_A, FeatureName: 'f' }),
        expect.objectContaining({ RoleArn: ROLE_B }),
      ]);
      expect(wire.sent('AddRoleToDBClusterCommand')[1]).not.toHaveProperty('FeatureName');
      expect(wire.sent('CreateDBClusterCommand')[0]).not.toHaveProperty('AssociatedRoles');
    });

    it('still waits for `available` under --no-wait, which AddRoleToDBCluster needs', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const wire = armCluster({ statuses: ['creating', 'available'] });
      await provider.create('L', CLUSTER, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      const order = mockSend.mock.calls.map(([call]) => (call as object).constructor.name);
      expect(order.indexOf('AddRoleToDBClusterCommand')).toBe(3);
      expect(order.slice(1, 3)).toEqual(['DescribeDBClustersCommand', 'DescribeDBClustersCommand']);
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(1);
    });

    it('a no-role create under --no-wait keeps skipping the wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const wire = armCluster({ statuses: ['creating'] });
      await provider.create('L', CLUSTER, {});
      expect(wire.sent('DescribeDBClustersCommand')).toHaveLength(1);
    });

    it('marks the cluster created when the attach fails, so it is not orphaned unnamed', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'AddRoleToDBClusterCommand'
          ? Promise.reject(new Error('role refused'))
          : answer(command)
      );
      const failure = await provider
        .create('L', CLUSTER, {
          DBClusterIdentifier: 'cluster-1',
          AssociatedRoles: [{ RoleArn: ROLE_A }],
        })
        .catch((error: unknown) => error);
      expect(createdBeforeFailure(failure, 'L', CLUSTER)).toBe('cluster-1');
    });

    it('on update, detaches what the template dropped before attaching what it added', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_B }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A }] }
      );
      const names = mockSend.mock.calls.map(([call]) => (call as object).constructor.name);
      expect(names.indexOf('RemoveRoleFromDBClusterCommand')).toBeLessThan(
        names.indexOf('AddRoleToDBClusterCommand')
      );
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'cluster-1', RoleArn: ROLE_A },
      ]);
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'cluster-1', RoleArn: ROLE_B },
      ]);
    });

    it('treats a FeatureName change as detach + attach: AWS keys on both', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_A, FeatureName: 'old', Status: 'ACTIVE' }] });
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 'new' }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 'old' }] }
      );
      expect(wire.sent('RemoveRoleFromDBClusterCommand')[0]).toMatchObject({ FeatureName: 'old' });
      expect(wire.sent('AddRoleToDBClusterCommand')[0]).toMatchObject({ FeatureName: 'new' });
    });

    it('plans against the live list: a retry neither re-attaches nor re-detaches', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_B, Status: 'ACTIVE' }] });
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_B }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A }] }
      );
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toEqual([]);
    });

    it('leaves a role attached out of band alone', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_B, Status: 'ACTIVE' }] });
      await update({ AssociatedRoles: [] }, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toEqual([]);
    });

    it('a malformed record only misses detaches (add-only)', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      await update({ AssociatedRoles: [{ RoleArn: ROLE_B }] }, { AssociatedRoles: 'junk' });
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toEqual([]);
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(1);
    });

    it('waits out PENDING, and for a detached role to leave', async () => {
      armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      const answer = mockSend.getMockImplementation()!;
      let added = false;
      let reads = 0;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        if (name === 'AddRoleToDBClusterCommand') added = true;
        if (added && name === 'DescribeDBClustersCommand') {
          reads += 1;
          return Promise.resolve({
            DBClusters: [
              {
                Status: 'available',
                AssociatedRoles: [
                  { RoleArn: ROLE_B, Status: reads < 3 ? 'PENDING' : 'ACTIVE' },
                  ...(reads < 2 ? [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] : []),
                ],
              },
            ],
          });
        }
        return answer(command);
      });
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_B }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A }] }
      );
      expect(reads).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns about an INVALID role rather than failing an accepted attach', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      let added = false;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'AddRoleToDBClusterCommand') added = true;
        return added && command.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.resolve({
              DBClusters: [
                { Status: 'available', AssociatedRoles: [{ RoleArn: ROLE_B, Status: 'INVALID' }] },
              ],
            })
          : answer(command);
      });
      await update({ AssociatedRoles: [{ RoleArn: ROLE_B }] }, {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(`${ROLE_B} as INVALID`);
    });

    it('caps the settle wait with a warning naming the role, through the masker', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.resolve({ DBClusters: [{ Status: 'available', AssociatedRoles: [] }] })
          : answer(command)
      );
      await update({ AssociatedRoles: [{ RoleArn: ROLE_B }] }, {}, CLUSTER, {
        maskSecrets: (text: string) => text.replace('role/b', 'role/***'),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('role/***');
      expect(warn.mock.calls[0]![0]).not.toContain('role/b');
    });

    it('--no-wait skips the settle poll', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const wire = armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.resolve({ DBClusters: [{ Status: 'available', AssociatedRoles: [] }] })
          : answer(command)
      );
      await update({ AssociatedRoles: [{ RoleArn: ROLE_B }] }, {});
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('refusals before any call', () => {
    it.each([
      ['AssociatedRoles', 'not-a-list', /AssociatedRoles must be/],
      ['AssociatedRoles', [{ FeatureName: 'f' }], /AssociatedRoles must be/],
      ['AssociatedRoles', [{ RoleArn: ROLE_A, FeatureName: 1 }], /AssociatedRoles must be/],
      ['EnableCloudwatchLogsExports', 'audit', /EnableCloudwatchLogsExports must be/],
      ['EnableCloudwatchLogsExports', [1], /EnableCloudwatchLogsExports must be/],
      ['ServerlessScalingConfiguration', 'big', /ServerlessScalingConfiguration must be/],
      [
        'ServerlessScalingConfiguration',
        { MinCapacity: 'x', MaxCapacity: 8 },
        /ServerlessScalingConfiguration must be/,
      ],
    ])('%s: %j', async (key, value, message) => {
      armCluster();
      await expect(provider.create('L', CLUSTER, { [key]: value })).rejects.toThrow(message);
      await expect(update({ [key]: value }, {})).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(['replayingState', 'desiredFromAwsReadback'])(
      'a state-borne malformed scaling block is left out with a warning (%s)',
      async (flag) => {
        const wire = armCluster();
        await update({ ServerlessScalingConfiguration: 'big' }, {}, CLUSTER, { [flag]: true });
        expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty(
          'ServerlessV2ScalingConfiguration'
        );
        expect(warn.mock.calls[0]![0]).toContain('ServerlessScalingConfiguration');
      }
    );

    it('a malformed role list stays refused on a state-borne update', async () => {
      armCluster();
      await expect(
        update({ AssociatedRoles: 'junk' }, {}, CLUSTER, { replayingState: true })
      ).rejects.toThrow(/AssociatedRoles must be/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('ModifyDBCluster', () => {
    it('sends the log-export delta, not the list', async () => {
      const wire = armCluster();
      await update(
        { EnableCloudwatchLogsExports: ['slowquery'] },
        { EnableCloudwatchLogsExports: ['audit'] }
      );
      expect(wire.sent('ModifyDBClusterCommand')[0]).toMatchObject({
        CloudwatchLogsExportConfiguration: {
          EnableLogTypes: ['slowquery'],
          DisableLogTypes: ['audit'],
        },
      });
    });

    it('sends no log configuration for an unchanged list, in any order', async () => {
      const wire = armCluster();
      await update(
        { EnableCloudwatchLogsExports: ['slowquery', 'audit'] },
        { EnableCloudwatchLogsExports: ['audit', 'slowquery'] }
      );
      expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty(
        'CloudwatchLogsExportConfiguration'
      );
    });

    it('disables the recorded types when the whole list is removed', async () => {
      const wire = armCluster();
      await update({}, { EnableCloudwatchLogsExports: ['audit'] });
      expect(wire.sent('ModifyDBClusterCommand')[0]).toMatchObject({
        CloudwatchLogsExportConfiguration: { DisableLogTypes: ['audit'] },
      });
    });

    it('names an unmeasured removal without claiming CloudFormation parity', async () => {
      armCluster();
      await update({}, { CopyTagsToSnapshot: true, NetworkType: 'DUAL' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('properties CopyTagsToSnapshot, NetworkType were');
      expect(warn.mock.calls[0]![0]).not.toContain('CloudFormation');
    });

    it('sends NetworkType only on a change', async () => {
      const wire = armCluster();
      await update({ NetworkType: 'DUAL' }, { NetworkType: 'DUAL' });
      await update({ NetworkType: 'DUAL' }, { NetworkType: 'IPV4' });
      expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty('NetworkType');
      expect(wire.sent('ModifyDBClusterCommand')[1]).toMatchObject({ NetworkType: 'DUAL' });
    });

    it('coerces string capacities, as a CFn number may arrive', async () => {
      const wire = armCluster();
      await update({ ServerlessScalingConfiguration: { MinCapacity: '1', MaxCapacity: '8.5' } }, {});
      expect(wire.sent('ModifyDBClusterCommand')[0]).toMatchObject({
        ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8.5 },
      });
    });

    it('sends DBInstanceParameterGroupName with AllowMajorVersionUpgrade on a major change', async () => {
      const wire = armCluster();
      await update(
        { EngineVersion: '1.4.1.0', DBInstanceParameterGroupName: 'group' },
        { EngineVersion: '1.3.2.0' }
      );
      expect(wire.sent('ModifyDBClusterCommand')[0]).toMatchObject({
        AllowMajorVersionUpgrade: true,
        DBInstanceParameterGroupName: 'group',
      });
    });

    it.each([
      ['a minor change', { EngineVersion: '1.4.2.0' }, { EngineVersion: '1.4.1.0' }, 'group'],
      ['an unchanged version', { EngineVersion: '1.4.1.0' }, { EngineVersion: '1.4.1.0' }, 'group'],
      ['no recorded version', { EngineVersion: '1.4.1.0' }, {}, 'group'],
      ['no declared group', { EngineVersion: '1.4.1.0' }, { EngineVersion: '1.3.2.0' }, undefined],
    ])('sends neither on %s', async (_label, next, previous, group) => {
      const wire = armCluster();
      await update({ ...next, DBInstanceParameterGroupName: group }, previous);
      expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty(
        'DBInstanceParameterGroupName'
      );
      expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty('AllowMajorVersionUpgrade');
    });
  });

  describe('drift', () => {
    it('reads the cluster in the shape the template declares', async () => {
      mockSend.mockResolvedValue({
        DBClusters: [
          {
            CopyTagsToSnapshot: true,
            NetworkType: 'IPV4',
            EnabledCloudwatchLogsExports: ['audit'],
            ServerlessV2ScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8 },
            AssociatedRoles: [
              { RoleArn: ROLE_A, FeatureName: '', Status: 'ACTIVE' },
              { RoleArn: ROLE_B, FeatureName: 'f', Status: 'ACTIVE' },
            ],
          },
        ],
      });
      expect(await provider.readCurrentState('cluster-1', 'L', CLUSTER)).toMatchObject({
        CopyTagsToSnapshot: true,
        NetworkType: 'IPV4',
        EnableCloudwatchLogsExports: ['audit'],
        ServerlessScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8 },
        AssociatedRoles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_B, FeatureName: 'f' }],
      });
    });

    it('reports both lists empty on a cluster with neither, so a lost entry reads as drift', async () => {
      mockSend.mockResolvedValue({ DBClusters: [{}] });
      const read = await provider.readCurrentState('cluster-1', 'L', CLUSTER);
      expect(read).toMatchObject({ AssociatedRoles: [], EnableCloudwatchLogsExports: [] });
      expect(read).not.toHaveProperty('ServerlessScalingConfiguration');
    });

    it('reads the instance PubliclyAccessible', async () => {
      mockSend.mockResolvedValue({ DBInstances: [{ PubliclyAccessible: false }] });
      expect(await provider.readCurrentState('instance-1', 'L', INSTANCE)).toMatchObject({
        PubliclyAccessible: false,
      });
    });

    it('declares what no read answers', () => {
      expect(provider.getDriftUnknownPaths(CLUSTER)).toEqual([
        'AvailabilityZones',
        'DBInstanceParameterGroupName',
      ]);
      expect(provider.getDriftUnknownPaths(INSTANCE)).toEqual(['AllowMajorVersionUpgrade']);
      expect(provider.getDriftUnknownPaths('AWS::Neptune::DBSubnetGroup')).toEqual([]);
    });

    it('compares both lists as sets, and leaves a malformed side alone', () => {
      const a = provider.canonicalizeDriftProperties(CLUSTER, {
        AssociatedRoles: [{ RoleArn: ROLE_B }, { RoleArn: ROLE_A, FeatureName: 'f' }],
        EnableCloudwatchLogsExports: ['slowquery', 'audit'],
      });
      expect(a).toEqual({
        AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 'f' }, { RoleArn: ROLE_B }],
        EnableCloudwatchLogsExports: ['audit', 'slowquery'],
      });
      const junk = { AssociatedRoles: 'junk', EnableCloudwatchLogsExports: [1] };
      expect(provider.canonicalizeDriftProperties(CLUSTER, junk)).toEqual(junk);
      expect(provider.canonicalizeDriftProperties(INSTANCE, junk)).toBe(junk);
    });
  });

  it('sends PubliclyAccessible on create and update, AllowMajorVersionUpgrade on update', async () => {
    mockSend.mockResolvedValue({
      DBInstance: {},
      DBInstances: [{ DBInstanceStatus: 'available' }],
    });
    const sentAs = (name: string) =>
      mockSend.mock.calls
        .map(([call]) => call as { constructor: { name: string }; input: object })
        .find((call) => call.constructor.name === name)?.input;
    await provider.create('L', INSTANCE, {
      DBInstanceClass: 'db.r5.large',
      PubliclyAccessible: false,
      AllowMajorVersionUpgrade: true,
    });
    await update({ PubliclyAccessible: true, AllowMajorVersionUpgrade: false }, {}, INSTANCE);
    expect(sentAs('CreateDBInstanceCommand')).toMatchObject({ PubliclyAccessible: false });
    expect(sentAs('CreateDBInstanceCommand')).not.toHaveProperty('AllowMajorVersionUpgrade');
    expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({
      PubliclyAccessible: true,
      AllowMajorVersionUpgrade: false,
    });
  });

  it('classifies the two exclusions, with their reasons, outside handledProperties', () => {
    expect(provider.handledProperties.get(CLUSTER)!.has('GlobalClusterIdentifier')).toBe(false);
    expect(provider.handledProperties.get(INSTANCE)!.has('DBSnapshotIdentifier')).toBe(false);
    expect(provider.unhandledByDesign.get(CLUSTER)!.get('GlobalClusterIdentifier')).toContain(
      'no detach'
    );
    expect(provider.unhandledByDesign.get(INSTANCE)!.get('DBSnapshotIdentifier')).toContain(
      'not supported'
    );
  });
});
