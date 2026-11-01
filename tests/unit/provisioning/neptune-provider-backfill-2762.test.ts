// go-to-k/cdkd#2762: the DBCluster / DBInstance properties backfilled into
// `handledProperties`. sdk-wire-coverage-15 proves each reaches the wire; this
// suite holds the arms a generic probe cannot spell: the role plan against the
// live list, its waits, the refusals, the major-upgrade pair and drift.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());
const deadline = vi.hoisted(() => ({ remainingMs: Number.POSITIVE_INFINITY }));

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => deadline.remainingMs,
}));

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
  settleUnsettledPrevious,
  unsettledAfterUpdate,
} from '../../../src/deployment/unsettled-convergence.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
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
    /** The live log types; a Modify's delta lands at read `logsAfter` (default: at once). */
    logs?: string[];
    logsAfter?: number;
    engineVersion?: string;
    networkType?: string;
    /** The Modify's NetworkType lands at this read (default: at once). */
    networkAfter?: number;
  } = {}
): {
  sent: (command: string) => Record<string, unknown>[];
} {
  const roles = [...(options.roles ?? [])];
  const statuses = [...(options.statuses ?? [])];
  let logs = [...(options.logs ?? [])];
  let pendingLogs: LogConfig = {};
  let networkType = options.networkType;
  let pendingNetwork: string | undefined;
  let reads = 0;
  const applyLogs = (): void => {
    logs = [
      ...logs.filter((type) => !pendingLogs.DisableLogTypes?.includes(type)),
      ...(pendingLogs.EnableLogTypes ?? []),
    ];
    pendingLogs = {};
  };
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
      const input = command.input as {
        CloudwatchLogsExportConfiguration?: LogConfig;
        NetworkType?: string;
      };
      pendingLogs = input.CloudwatchLogsExportConfiguration ?? {};
      if (options.logsAfter === undefined) applyLogs();
      pendingNetwork = input.NetworkType;
      if (options.networkAfter === undefined) networkType = pendingNetwork ?? networkType;
    }
    if (name === 'DescribeDBClustersCommand') {
      reads += 1;
      if (reads === options.logsAfter) applyLogs();
      if (reads === options.networkAfter) networkType = pendingNetwork ?? networkType;
      return Promise.resolve({
        DBClusters: [
          {
            Status: statuses.shift() ?? 'available',
            AssociatedRoles: roles.map((r) => ({ ...r })),
            EnabledCloudwatchLogsExports: logs,
            EngineVersion: options.engineVersion,
            NetworkType: networkType,
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
    deadline.remainingMs = Number.POSITIVE_INFINITY;
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

    it('resends a detach refused the same way', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      const answer = mockSend.getMockImplementation()!;
      let refused = false;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'RemoveRoleFromDBClusterCommand' && !refused) {
          refused = true;
          return Promise.reject(
            Object.assign(new Error('DB cluster is not in available state.'), {
              name: 'InvalidDBClusterStateFault',
            })
          );
        }
        return answer(command);
      });
      await update({}, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toHaveLength(2);
    });

    it('writes nothing when the resource deadline leaves no room to wait', async () => {
      const wire = armCluster();
      deadline.remainingMs = 30_000;
      await expect(update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {})).rejects.toThrow(
        'no more time to change the roles'
      );
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
    });

    it('bounds the available wait by the resource deadline, before any write', async () => {
      const wire = armCluster({ statuses: Array<string>(50).fill('modifying') });
      deadline.remainingMs = 60_000;
      await expect(update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {})).rejects.toThrow(
        'Timed out waiting'
      );
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
    });

    it('marks AssociatedRoles unsettled only once a write is about to go out', async () => {
      armCluster();
      const marks: string[] = [];
      deadline.remainingMs = 30_000;
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}, CLUSTER, {
        markUnsettled: (key: string) => marks.push(key),
      }).catch(() => undefined);
      expect(marks).not.toContain('AssociatedRoles');
      deadline.remainingMs = Number.POSITIVE_INFINITY;
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}, CLUSTER, {
        markUnsettled: (key: string) => marks.push(key),
      });
      expect(marks).toContain('AssociatedRoles');
    });

    it('marks nothing when a terminal status fails the wait before the write', async () => {
      const wire = armCluster({ statuses: ['available', 'incompatible-parameters'] });
      const marks: string[] = [];
      await expect(
        update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}, CLUSTER, {
          markUnsettled: (key: string) => marks.push(key),
        })
      ).rejects.toThrow('incompatible-parameters');
      expect(marks).not.toContain('AssociatedRoles');
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
    });

    it('marks what each attach added as attempted, after the call', async () => {
      armCluster();
      const attempted: [string, readonly string[]][] = [];
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: 'f' }] }, {}, CLUSTER, {
        markAttempted: (path: string, items: readonly string[]) => attempted.push([path, items]),
      });
      expect(attempted).toEqual([['AssociatedRoles', [`${ROLE_A}\nf`]]]);
    });

    it('stops a settle wait at the resource deadline, as a warning', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      let added = false;
      let reads = 0;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'AddRoleToDBClusterCommand') added = true;
        if (added && command.constructor.name === 'DescribeDBClustersCommand') {
          reads += 1;
          return Promise.resolve({ DBClusters: [{ Status: 'available', AssociatedRoles: [] }] });
        }
        return answer(command);
      });
      deadline.remainingMs = 31_000;
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {});
      expect(reads).toBe(1);
      expect(warn.mock.calls[0]![0]).toContain('had not settled');
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

    it('calls the resource a cluster when a role call runs out of budget', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'AddRoleToDBClusterCommand'
          ? Promise.reject(
              Object.assign(new Error('DB cluster is not in available state.'), {
                name: 'InvalidDBClusterStateFault',
              })
            )
          : answer(command)
      );
      const failure = await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}).catch(
        (error: unknown) => error
      );
      expect(String((failure as Error).cause ?? failure)).toContain('the cluster is');
      expect(String((failure as Error).cause ?? failure)).not.toContain('instance');
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
      ['ServerlessScalingConfiguration', {}, /ServerlessScalingConfiguration must be/],
      ...[
        { MinCapacity: 1 },
        { MaxCapacity: 8 },
        { MinCapacity: '', MaxCapacity: 8 },
        { MinCapacity: 1, MaxCapacity: true },
        { MinCapacity: 1, MaxCapacity: Number.POSITIVE_INFINITY },
      ].map(
        (block) =>
          ['ServerlessScalingConfiguration', block, /ServerlessScalingConfiguration must be/] as [
            string,
            unknown,
            RegExp,
          ]
      ),
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

    it('marks only the log types AWS did not hold as attempted', async () => {
      armCluster({ logs: ['slowquery'] });
      const attempted: [string, readonly string[]][] = [];
      await update({ EnableCloudwatchLogsExports: ['audit', 'slowquery'] }, {}, CLUSTER, {
        markAttempted: (path: string, items: readonly string[]) => attempted.push([path, items]),
      });
      expect(attempted).toEqual([['EnableCloudwatchLogsExports', ['audit']]]);
    });

    it('waits for a changed log list to read back', async () => {
      const wire = armCluster({ logs: [], logsAfter: 5 });
      await update({ EnableCloudwatchLogsExports: ['audit'] }, {});
      expect(wire.sent('DescribeDBClustersCommand')).toHaveLength(5);
      expect(warn).not.toHaveBeenCalled();
    });

    it('waits out a delayed disable, and reads the delta landing', async () => {
      const wire = armCluster({ logs: ['audit'], logsAfter: 3 });
      await update({}, { EnableCloudwatchLogsExports: ['audit'] });
      expect(wire.sent('DescribeDBClustersCommand')).toHaveLength(3);
      expect(warn).not.toHaveBeenCalled();
    });

    it('--no-wait skips the log wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const wire = armCluster({ logs: [], logsAfter: Number.POSITIVE_INFINITY });
      await update({ EnableCloudwatchLogsExports: ['audit'] }, {});
      expect(wire.sent('DescribeDBClustersCommand')).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('settles on the delta: a type enabled out of band does not hold the wait', async () => {
      armCluster({ logs: ['slowquery'] });
      await update({ EnableCloudwatchLogsExports: ['audit'] }, {});
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
      await update({}, {
        NetworkType: 'DUAL',
        ServerlessScalingConfiguration: { MinCapacity: 1, MaxCapacity: 8 },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(
        'properties NetworkType, ServerlessScalingConfiguration were'
      );
      expect(warn.mock.calls[0]![0]).not.toContain('CloudFormation');
    });

    it('claims parity for CopyTagsToSnapshot, which the A/B measured kept', async () => {
      const wire = armCluster();
      await update({}, { CopyTagsToSnapshot: true });
      expect(wire.sent('ModifyDBClusterCommand')[0]!['CopyTagsToSnapshot']).toBeUndefined();
      expect(warn.mock.calls[0]![0]).toContain('property CopyTagsToSnapshot was');
      expect(warn.mock.calls[0]![0]).toContain('as CloudFormation does');
    });

    it('compares a newly declared NetworkType with the live one', async () => {
      const wire = armCluster({ networkType: 'IPV4' });
      await update({ NetworkType: 'IPV4' }, {});
      await update({ NetworkType: 'DUAL' }, {});
      expect(wire.sent('ModifyDBClusterCommand')[0]).not.toHaveProperty('NetworkType');
      expect(wire.sent('ModifyDBClusterCommand')[1]).toMatchObject({ NetworkType: 'DUAL' });
    });

    it('waits for a changed NetworkType to read back, unless --no-wait', async () => {
      const wire = armCluster({ networkType: 'IPV4', networkAfter: 4 });
      await update({ NetworkType: 'DUAL' }, { NetworkType: 'IPV4' });
      expect(wire.sent('DescribeDBClustersCommand')).toHaveLength(4);
      mockSend.mockClear();
      process.env['CDKD_NO_WAIT'] = 'true';
      armCluster({ networkType: 'IPV4', networkAfter: Number.POSITIVE_INFINITY });
      await update({ NetworkType: 'DUAL' }, { NetworkType: 'IPV4' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('marks changed Tags unsettled before their write', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.resolve({ DBClusters: [{ Status: 'available', DBClusterArn: 'arn' }] })
          : answer(command)
      );
      const marks: string[] = [];
      await update({ Tags: [{ Key: 'k', Value: 'v' }] }, {}, CLUSTER, {
        markUnsettled: (key: string) => marks.push(key),
      });
      expect(marks).toEqual(['Tags']);
    });

    it('marks what the Modify changes unsettled, before it is sent', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      const marks: string[] = [];
      let marksAtModify: string[] = [];
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ModifyDBClusterCommand') marksAtModify = [...marks];
        return answer(command);
      });
      await update(
        { CopyTagsToSnapshot: true, BackupRetentionPeriod: 7 },
        { BackupRetentionPeriod: 7 },
        CLUSTER,
        { markUnsettled: (key: string) => marks.push(key) }
      );
      expect(marksAtModify).toEqual(['CopyTagsToSnapshot']);
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

    it('declares the three sets unordered, on the cluster only', () => {
      expect(provider.getDriftUnorderedPaths(CLUSTER)).toEqual([
        'AssociatedRoles',
        'EnableCloudwatchLogsExports',
        'VpcSecurityGroupIds',
      ]);
      expect(provider.getDriftUnorderedPaths(INSTANCE)).toEqual([]);
    });
  });

  describe('unsettled convergence', () => {
    const identity = (recordedProperties: Record<string, unknown>) => ({
      provider,
      logicalId: 'L',
      physicalId: 'cluster-1',
      resourceType: CLUSTER,
      recordedProperties,
    });
    const liveCluster = (fields: Record<string, unknown>): void => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        Promise.resolve(
          command.constructor.name === 'DescribeDBClustersCommand'
            ? { DBClusters: [{ Status: 'available', ...fields }] }
            : {}
        )
      );
    };

    // A deploy hands the record and the template; a rollback hands the failed
    // update's bag as the record and the earlier record as the desired side.
    it.each([
      ['a deploy', { AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}],
      ['a rollback', {}, { AssociatedRoles: [{ RoleArn: ROLE_A }] }],
    ])('keeps an out-of-band role and log type off the previous side (%s)', async (_l, own, want) => {
      const recorded = { ...own, EnableCloudwatchLogsExports: ['audit'] };
      const desired = { ...want, EnableCloudwatchLogsExports: [] };
      const live = {
        AssociatedRoles: [
          { RoleArn: ROLE_A, Status: 'ACTIVE' },
          { RoleArn: ROLE_B, Status: 'ACTIVE' },
        ],
        EnabledCloudwatchLogsExports: ['audit', 'slowquery'],
      };
      liveCluster(live);
      const previous = await settleUnsettledPrevious({
        ...identity(recorded),
        names: new Set(['AssociatedRoles', 'EnableCloudwatchLogsExports']),
        previous: recorded,
        desired,
      });
      expect(previous['AssociatedRoles']).toEqual([{ RoleArn: ROLE_A }]);
      expect(previous['EnableCloudwatchLogsExports']).toEqual(['audit']);

      const wire = armCluster({
        roles: live.AssociatedRoles,
        logs: live.EnabledCloudwatchLogsExports,
      });
      await update({ EnableCloudwatchLogsExports: [] }, previous);
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toEqual([
        { DBClusterIdentifier: 'cluster-1', RoleArn: ROLE_A },
      ]);
      expect(
        wire.sent('ModifyDBClusterCommand')[0]!['CloudwatchLogsExportConfiguration']
      ).toEqual({ DisableLogTypes: ['audit'] });
    });

    it('puts what an earlier attempt added on the previous side, and no redaction', async () => {
      liveCluster({
        AssociatedRoles: [{ RoleArn: ROLE_A }, { RoleArn: `${ROLE_B}***` }],
        EnabledCloudwatchLogsExports: ['audit', 'slowquery', '{{resolve:x}}'],
      });
      const read = await provider.readUnsettled(
        'cluster-1',
        'L',
        CLUSTER,
        new Set(['AssociatedRoles', 'EnableCloudwatchLogsExports']),
        {},
        {},
        new Map([
          ['AssociatedRoles', new Set([`${ROLE_A}\n`, `${ROLE_B}***`])],
          ['EnableCloudwatchLogsExports', new Set(['audit', '{{resolve:x}}'])],
        ])
      );
      expect(read).toMatchObject({
        AssociatedRoles: [{ RoleArn: ROLE_A }],
        EnableCloudwatchLogsExports: ['audit'],
      });
    });

    it('keeps the log types only the desired side names', async () => {
      liveCluster({ EnabledCloudwatchLogsExports: ['audit', 'slowquery'] });
      const read = await provider.readUnsettled(
        'cluster-1',
        'L',
        CLUSTER,
        new Set(['EnableCloudwatchLogsExports']),
        {},
        { EnableCloudwatchLogsExports: ['audit'] }
      );
      expect(read).toMatchObject({ EnableCloudwatchLogsExports: ['audit'] });
    });

    it('leaves a name it was not asked for as read', async () => {
      liveCluster({ AssociatedRoles: [{ RoleArn: ROLE_A }] });
      const read = await provider.readUnsettled('cluster-1', 'L', CLUSTER, new Set(['Tags']));
      expect(read).toMatchObject({ AssociatedRoles: [{ RoleArn: ROLE_A }] });
    });

    it('reports a gone cluster as gone', async () => {
      mockSend.mockRejectedValue(
        Object.assign(new Error('gone'), { name: 'DBClusterNotFoundFault' })
      );
      expect(
        await provider.readUnsettled('cluster-1', 'L', CLUSTER, new Set(['AssociatedRoles']))
      ).toBe(RESOURCE_NOT_FOUND);
    });

    it('settles a template ordering the three lists differently from AWS', async () => {
      liveCluster({
        AssociatedRoles: [{ RoleArn: ROLE_B }, { RoleArn: ROLE_A }],
        EnabledCloudwatchLogsExports: ['slowquery', 'audit'],
        VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-2' }, { VpcSecurityGroupId: 'sg-1' }],
      });
      const desired = {
        AssociatedRoles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_B }],
        EnableCloudwatchLogsExports: ['audit', 'slowquery'],
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
      };
      expect(
        await unsettledAfterUpdate({
          ...identity(desired),
          names: new Set(Object.keys(desired)),
          desired,
        })
      ).toEqual([]);
    });

    const names = new Set(['AssociatedRoles', 'CopyTagsToSnapshot']);

    it.each([
      ['available, nothing pending', { Status: 'available' }, []],
      ['an empty pending block', { Status: 'available', PendingModifiedValues: {} }, []],
      ['upgrading', { Status: 'upgrading' }, [...names]],
      [
        'a pending change',
        { Status: 'available', PendingModifiedValues: { EngineVersion: '1.4.1.0' } },
        [...names],
      ],
    ])('cluster: %s', async (_label, fields, moving) => {
      mockSend.mockResolvedValue({ DBClusters: [fields] });
      expect([
        ...(await provider.unsettledInTransition('cluster-1', 'L', CLUSTER, names)),
      ]).toEqual(moving);
    });

    it.each([
      ['available', { DBInstanceStatus: 'available' }, []],
      ['modifying', { DBInstanceStatus: 'modifying' }, ['PubliclyAccessible']],
      [
        'a pending change',
        { DBInstanceStatus: 'available', PendingModifiedValues: { DBInstanceClass: 'db.r5.large' } },
        ['PubliclyAccessible'],
      ],
    ])('instance: %s', async (_label, fields, moving) => {
      mockSend.mockResolvedValue({ DBInstances: [fields] });
      const asked = new Set(['PubliclyAccessible']);
      expect([
        ...(await provider.unsettledInTransition('instance-1', 'L', INSTANCE, asked)),
      ]).toEqual(moving);
    });

    it('keeps every name when the read fails or finds nothing', async () => {
      mockSend.mockRejectedValue(new Error('throttled'));
      expect(await provider.unsettledInTransition('cluster-1', 'L', CLUSTER, names)).toBe(names);
      mockSend.mockReset();
      mockSend.mockResolvedValue({ DBClusters: [] });
      expect(await provider.unsettledInTransition('cluster-1', 'L', CLUSTER, names)).toBe(names);
    });

    it('has nothing to report for a subnet group', async () => {
      const moving = await provider.unsettledInTransition(
        'sg',
        'L',
        'AWS::Neptune::DBSubnetGroup',
        names
      );
      expect(moving.size).toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
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
      ['true', true],
      ['True', true],
      ['false', false],
      ['False', false],
    ])('reads %s as the boolean it means, on the wire and in the wait', async (raw, value) => {
      await update(
        { PubliclyAccessible: raw },
        { PubliclyAccessible: value ? 'false' : 'true' },
        INSTANCE
      );
      expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({ PubliclyAccessible: value });
      expect(warn).not.toHaveBeenCalled();
      mockSend.mockClear();
      await provider.create('L', INSTANCE, { PubliclyAccessible: raw });
      expect(sentAs('CreateDBInstanceCommand')).toMatchObject({ PubliclyAccessible: value });
    });

    it.each(['no', 'yes', 1, null])('refuses PubliclyAccessible %j before any call', async (raw) => {
      for (const attempt of [
        () => provider.create('L', INSTANCE, { PubliclyAccessible: raw }),
        () => update({ PubliclyAccessible: raw }, {}, INSTANCE),
      ]) {
        const refusal = await attempt().catch((error: unknown) => error);
        expect(String(refusal)).toContain('PubliclyAccessible must be a boolean');
        expect(isMarkedNonRetryable(refusal)).toBe(true);
      }
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback', { replayingState: true }],
      ['a readback', { desiredFromAwsReadback: true }],
    ])('leaves an unusable value out with a warning on %s', async (_label, context) => {
      await update({ PubliclyAccessible: 'no' }, {}, INSTANCE, context);
      expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({ PubliclyAccessible: undefined });
      expect(warn.mock.calls[0]![0]).toContain('recorded PubliclyAccessible is unusable');
    });

    it('leaves an unusable value out of a replayed create, with a warning', async () => {
      await provider.create('L', INSTANCE, { PubliclyAccessible: 'no' }, { replayingState: true });
      expect(sentAs('CreateDBInstanceCommand')).toMatchObject({ PubliclyAccessible: undefined });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('waits for a delayed readback of a changed value, and not for an unchanged one', async () => {
      let reads = 0;
      mockSend.mockImplementation((command: { constructor: { name: string }; input: object }) => {
        if (command.constructor.name === 'ModifyDBInstanceCommand') {
          live = (command.input as { PubliclyAccessible?: boolean }).PubliclyAccessible;
        }
        if (command.constructor.name === 'DescribeDBInstancesCommand') reads += 1;
        return Promise.resolve({
          DBInstances: [
            { DBInstanceStatus: 'available', PubliclyAccessible: reads < 3 ? undefined : live },
          ],
        });
      });
      await update({ PubliclyAccessible: true }, { PubliclyAccessible: false }, INSTANCE);
      // Two stale reads, the matching third, then update()'s attribute read.
      expect(reads).toBe(4);
      expect(warn).not.toHaveBeenCalled();
      reads = 10;
      await update({ PubliclyAccessible: true }, { PubliclyAccessible: true }, INSTANCE);
      expect(reads).toBe(11);
    });

    it('reads a string record as unchanged, so a same value does not wait', async () => {
      const reads = () =>
        mockSend.mock.calls.filter(
          ([call]) => (call as object).constructor.name === 'DescribeDBInstancesCommand'
        ).length;
      await update({ PubliclyAccessible: true }, { PubliclyAccessible: 'True' }, INSTANCE);
      expect(reads()).toBe(1);
    });

    it('--no-wait skips the public-access wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockResolvedValue({ DBInstances: [{ DBInstanceStatus: 'available' }] });
      await update({ PubliclyAccessible: true }, { PubliclyAccessible: false }, INSTANCE);
      expect(warn).not.toHaveBeenCalled();
    });

    it('marks a changed property unsettled before the Modify, and Tags before their write', async () => {
      const marks: string[] = [];
      let marksAtModify: string[] = [];
      mockSend.mockImplementation((command: { constructor: { name: string }; input: object }) => {
        const name = command.constructor.name;
        if (name === 'ModifyDBInstanceCommand') marksAtModify = [...marks];
        if (name === 'ListTagsForResourceCommand' || name === 'AddTagsToResourceCommand') {
          return Promise.reject(new Error('tag write refused'));
        }
        return Promise.resolve({
          TagList: [],
          DBInstances: [
            { DBInstanceStatus: 'available', DBInstanceArn: 'arn', PubliclyAccessible: true },
          ],
        });
      });
      await update(
        { PubliclyAccessible: true, Tags: [{ Key: 'k', Value: 'v' }] },
        { PubliclyAccessible: false },
        INSTANCE,
        { markUnsettled: (key: string) => marks.push(key) }
      ).catch(() => undefined);
      expect(marksAtModify).toEqual(['PubliclyAccessible']);
      expect(marks).toEqual(['PubliclyAccessible', 'Tags']);
    });

    it.each([
      ['true', true],
      ['the string true', 'true'],
      ['the string True', 'True'],
    ])('keeps a removed %s, sends no reset and says the instance stays public', async (_l, was) => {
      await update({}, { PubliclyAccessible: was }, INSTANCE);
      expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({ PubliclyAccessible: undefined });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(
        'the instance stays publicly accessible, as CloudFormation leaves it'
      );
    });

    it('says the same on a rollback, where the A/B measured it too', async () => {
      await update({}, { PubliclyAccessible: true }, INSTANCE, { replayingState: true });
      expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({ PubliclyAccessible: undefined });
      expect(warn.mock.calls[0]![0]).toContain(
        'stays publicly accessible after this rollback, as CloudFormation leaves it'
      );
    });

    it.each([
      ['a readback', { PubliclyAccessible: true }, { desiredFromAwsReadback: true }],
      ['a false record', { PubliclyAccessible: false }, undefined],
      ['no record', {}, undefined],
    ])('stays silent for %s', async (_label, previous, context) => {
      await update({}, previous, INSTANCE, context);
      expect(sentAs('ModifyDBInstanceCommand')).toMatchObject({ PubliclyAccessible: undefined });
      expect(warn).not.toHaveBeenCalled();
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
