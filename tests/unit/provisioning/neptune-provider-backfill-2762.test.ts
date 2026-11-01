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
import {
  createdBeforeFailure,
  isAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const CLUSTER = 'AWS::Neptune::DBCluster';
const INSTANCE = 'AWS::Neptune::DBInstance';
const ROLE_A = 'arn:aws:iam::123456789012:role/a';
const ROLE_B = 'arn:aws:iam::123456789012:role/b';

interface LiveRole {
  RoleArn: string;
  FeatureName?: string;
  Status?: string;
}

interface LogConfig {
  EnableLogTypes?: string[];
  DisableLogTypes?: string[];
}

/** Answers the fake cluster; each Describe consumes one entry of `statuses`. */
function armCluster(
  options: {
    roles?: LiveRole[];
    statuses?: string[];
    /** The live log types; a Modify's EnableLogTypes land after `logsAfter` reads. */
    logs?: string[];
    logsAfter?: number;
    engineVersion?: string;
  } = {}
): {
  sent: (command: string) => Record<string, unknown>[];
} {
  const roles = [...(options.roles ?? [])];
  const statuses = [...(options.statuses ?? [])];
  let logs = [...(options.logs ?? [])];
  let logsPending: string[] = [];
  let logReads = 0;
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
    if (name === 'ModifyDBClusterCommand') {
      const config = (command.input as { CloudwatchLogsExportConfiguration?: LogConfig })
        .CloudwatchLogsExportConfiguration;
      logs = logs.filter((type) => !config?.DisableLogTypes?.includes(type));
      logsPending = config?.EnableLogTypes ?? [];
      if ((options.logsAfter ?? 0) === 0) logs.push(...logsPending);
    }
    if (name === 'DescribeDBClustersCommand') {
      logReads += 1;
      if (logReads === options.logsAfter) logs.push(...logsPending);
      return Promise.resolve({
        DBClusters: [
          {
            Status: statuses.shift() ?? 'available',
            AssociatedRoles: roles.map((r) => ({ ...r })),
            EnabledCloudwatchLogsExports: logs,
            EngineVersion: options.engineVersion,
          },
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
      // A role's "already exists" must not read as this cluster's name collision.
      expect(isAuxiliaryFailure(failure)).toBe(true);
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

    it('attaches a repeated entry once', async () => {
      const wire = armCluster();
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_A }] }, {});
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(1);
    });

    it('resends a role call refused because a Modify started after the wait', async () => {
      const wire = armCluster();
      const answer = mockSend.getMockImplementation()!;
      let refused = false;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'AddRoleToDBClusterCommand' && !refused) {
          refused = true;
          return Promise.reject(
            Object.assign(new Error('DB cluster is not in available state.'), {
              name: 'InvalidDBClusterStateFault',
            })
          );
        }
        return answer(command);
      });
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {});
      expect(refused).toBe(true);
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(2);
    });

    it('keeps polling while a detached role lingers, its attach already settled', async () => {
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
                  { RoleArn: ROLE_B, Status: 'ACTIVE' },
                  ...(reads < 3 ? [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] : []),
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
    });

    it('masks the role in a create-path warning too', async () => {
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
      await provider.create(
        'L',
        CLUSTER,
        { AssociatedRoles: [{ RoleArn: ROLE_B }] },
        { maskSecrets: (text: string) => text.replace('role/b', 'role/***') }
      );
      expect(warn.mock.calls[0]![0]).toContain('role/***');
      expect(warn.mock.calls[0]![0]).not.toContain('role/b');
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

    it('names what it was doing when the cluster reaches a terminal status', async () => {
      armCluster({ statuses: ['available', 'incompatible-parameters'] });
      await expect(update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {})).rejects.toThrow(
        'entered status incompatible-parameters while changing its roles'
      );
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
      ['AssociatedRoles', [{ RoleArn: '' }], /AssociatedRoles must be/],
      ['AssociatedRoles', [{ RoleArn: ROLE_A, FeatureName: 1 }], /AssociatedRoles must be/],
      ['EnableCloudwatchLogsExports', 'audit', /EnableCloudwatchLogsExports must be/],
      ['EnableCloudwatchLogsExports', [1], /EnableCloudwatchLogsExports must be/],
      ['ServerlessScalingConfiguration', 'big', /ServerlessScalingConfiguration must be/],
      [
        'ServerlessScalingConfiguration',
        { MinCapacity: 'x', MaxCapacity: 8 },
        /ServerlessScalingConfiguration must be/,
      ],
      [
        'ServerlessScalingConfiguration',
        { MinCapacity: 1, MaxCapacity: 'x' },
        /ServerlessScalingConfiguration must be/,
      ],
    ])('%s: %j', async (key, value, message) => {
      armCluster();
      const refusal = await provider
        .create('L', CLUSTER, { [key]: value })
        .catch((error: unknown) => error);
      expect(isMarkedNonRetryable(refusal)).toBe(true);
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

    it('a replayed create leaves a malformed list out with a warning', async () => {
      const wire = armCluster();
      await provider.create(
        'L',
        CLUSTER,
        { AssociatedRoles: 'junk', EnableCloudwatchLogsExports: 'junk' },
        { replayingState: true }
      );
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    });

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
      expect(
        wire.sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']
      ).toEqual({ EnableLogTypes: ['slowquery'], DisableLogTypes: ['audit'] });
    });

    it('a malformed log record only misses disables', async () => {
      const wire = armCluster({ logs: ['audit'] });
      await update(
        { EnableCloudwatchLogsExports: ['audit'] },
        { EnableCloudwatchLogsExports: 'junk' }
      );
      expect(
        wire.sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']
      ).toEqual({ EnableLogTypes: ['audit'] });
    });

    it('waits for a changed log list to read back', async () => {
      const wire = armCluster({ logs: [], logsAfter: 4 });
      await update({ EnableCloudwatchLogsExports: ['audit'] }, {});
      expect(wire.sent('DescribeDBClustersCommand')).toHaveLength(4);
      expect(warn).not.toHaveBeenCalled();
    });

    it('caps that wait with a warning rather than failing an accepted change', async () => {
      armCluster({ logs: [], logsAfter: Number.POSITIVE_INFINITY });
      await update({ EnableCloudwatchLogsExports: ['audit'] }, {});
      expect(warn.mock.calls[0]![0]).toContain('did not read back');
    });

    it('sends no empty log list on create', async () => {
      const wire = armCluster();
      await provider.create('L', CLUSTER, { EnableCloudwatchLogsExports: [] });
      expect(wire.sent('CreateDBClusterCommand')[0]).not.toHaveProperty(
        'EnableCloudwatchLogsExports'
      );
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
      expect(
        wire.sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']
      ).toEqual({ DisableLogTypes: ['audit'] });
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

    it('sends the flag alone on a major change with no declared group', async () => {
      const wire = armCluster();
      await update({ EngineVersion: '1.4.1.0' }, { EngineVersion: '1.3.2.0' });
      expect(wire.sent('ModifyDBClusterCommand')[0]).toMatchObject({
        AllowMajorVersionUpgrade: true,
      });
      expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty(
        'DBInstanceParameterGroupName'
      );
    });

    it('compares a newly declared EngineVersion with the live one', async () => {
      const wire = armCluster({ engineVersion: '1.3.2.0' });
      await update({ EngineVersion: '1.4.1.0', DBInstanceParameterGroupName: 'group' }, {});
      expect(wire.sent('ModifyDBClusterCommand')[0]).toMatchObject({
        AllowMajorVersionUpgrade: true,
        DBInstanceParameterGroupName: 'group',
      });
    });

    it.each([
      ['a minor change', { EngineVersion: '1.4.2.0' }, { EngineVersion: '1.4.1.0' }],
      ['an unchanged version', { EngineVersion: '1.4.1.0' }, { EngineVersion: '1.4.1.0' }],
      ['no declared version', {}, { EngineVersion: '1.3.2.0' }],
    ])('sends neither on %s', async (_label, next, previous) => {
      const wire = armCluster();
      await update({ ...next, DBInstanceParameterGroupName: 'group' }, previous);
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
      const read = (await provider.readCurrentState('cluster-1', 'L', CLUSTER)) as Record<
        string,
        unknown
      >;
      expect(read).toMatchObject({
        CopyTagsToSnapshot: true,
        NetworkType: 'IPV4',
        EnableCloudwatchLogsExports: ['audit'],
        ServerlessScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8 },
      });
      expect(read['AssociatedRoles']).toEqual([
        { RoleArn: ROLE_A },
        { RoleArn: ROLE_B, FeatureName: 'f' },
      ]);
    });

    it('reports both lists empty on a cluster with neither, so a lost entry reads as drift', async () => {
      mockSend.mockResolvedValue({ DBClusters: [{}] });
      const read = await provider.readCurrentState('cluster-1', 'L', CLUSTER);
      expect(read).toMatchObject({ AssociatedRoles: [], EnableCloudwatchLogsExports: [] });
      expect(read).not.toHaveProperty('ServerlessScalingConfiguration');
    });

    it('reads a one-sided scaling block as it is', async () => {
      mockSend.mockResolvedValue({
        DBClusters: [{ ServerlessV2ScalingConfiguration: { MaxCapacity: 8 } }],
      });
      const read = await provider.readCurrentState('cluster-1', 'L', CLUSTER);
      expect(read).toMatchObject({ ServerlessScalingConfiguration: { MaxCapacity: 8 } });
      expect(
        (read as Record<string, Record<string, unknown>>)['ServerlessScalingConfiguration']
      ).not.toHaveProperty('MinCapacity');
    });

    it('adds neither list to a bag that has none', () => {
      expect(provider.canonicalizeDriftProperties(CLUSTER, { CopyTagsToSnapshot: true })).toEqual({
        CopyTagsToSnapshot: true,
      });
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

  describe('DBInstance', () => {
    let live: boolean | undefined;
    const sentAs = (name: string) =>
      mockSend.mock.calls
        .map(([call]) => call as { constructor: { name: string }; input: object })
        .find((call) => call.constructor.name === name)?.input;

    beforeEach(() => {
      live = undefined;
      mockSend.mockImplementation((command: { constructor: { name: string }; input: object }) => {
        if (command.constructor.name === 'ModifyDBInstanceCommand') {
          live = (command.input as { PubliclyAccessible?: boolean }).PubliclyAccessible;
        }
        return Promise.resolve({
          DBInstance: {},
          DBInstances: [{ DBInstanceStatus: 'available', PubliclyAccessible: live }],
        });
      });
    });

    it('sends PubliclyAccessible on create and update, AllowMajorVersionUpgrade on update', async () => {
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

    it.each([
      ['a template removal', undefined],
      ['a rollback to a record without it', { replayingState: true }],
    ])('turns a removed PubliclyAccessible: true off, with a warning (%s)', async (_label, context) => {
      await update({}, { PubliclyAccessible: true }, INSTANCE, context);
      expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({ PubliclyAccessible: false });
      expect(warn.mock.calls[0]![0]).toContain('turned public access off');
    });

    it.each([
      ['a readback', { PubliclyAccessible: true }, { desiredFromAwsReadback: true }],
      ['a false record', { PubliclyAccessible: false }, undefined],
      ['no record', {}, undefined],
    ])('sends no reset for %s', async (_label, previous, context) => {
      await update({}, previous, INSTANCE, context);
      expect(sentAs('ModifyDBInstanceCommand')).not.toHaveProperty('PubliclyAccessible', false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('waits for a changed value to read back, and only then', async () => {
      const reads = () =>
        mockSend.mock.calls.filter(
          ([call]) => (call as object).constructor.name === 'DescribeDBInstancesCommand'
        ).length;
      await update({ PubliclyAccessible: true }, { PubliclyAccessible: true }, INSTANCE);
      const unchanged = reads();
      mockSend.mockClear();
      await update({ PubliclyAccessible: false }, { PubliclyAccessible: true }, INSTANCE);
      expect(reads()).toBe(unchanged + 1);
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
