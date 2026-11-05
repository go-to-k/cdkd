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
  createdResourceIdentityBeforeFailure,
  isAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const CLUSTER = 'AWS::Neptune::DBCluster';
const INSTANCE = 'AWS::Neptune::DBInstance';
const ROLE_A = 'arn:aws:iam::123456789012:role/a';
const ROLE_B = 'arn:aws:iam::123456789012:role/b';
// The real refusal, from the integ run that found it.
const ROLE_CALL_BUSY = () =>
  Object.assign(
    new Error(
      'DB Cluster cluster-1 is not available for IAM role association, disassociation, or updates. Current DB cluster status: modifying'
    ),
    { name: 'InvalidDBClusterStateFault' }
  );

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
    if (name.startsWith('RestoreDBCluster')) {
      return Promise.resolve({
        DBCluster: { DbClusterResourceId: 'cluster-res', EngineVersion: options.engineVersion },
      });
    }
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
      // The wait's two reads, then the role plan's read of the live list.
      expect(order.indexOf('AddRoleToDBClusterCommand')).toBe(4);
      expect(order.slice(1, 4)).toEqual([
        'DescribeDBClustersCommand',
        'DescribeDBClustersCommand',
        'DescribeDBClustersCommand',
      ]);
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

    it('does not attach again a declared role detached outside cdkd, as CloudFormation does not', async () => {
      const wire = armCluster({ roles: [] });
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
    });

    it('a role detached outside cdkd beside an added one is neither attached again nor kept unsettled', async () => {
      const ROLE_C = 'arn:aws:iam::123456789012:role/c';
      const wire = armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      const recorded = { AssociatedRoles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_B }] };
      const desired = {
        AssociatedRoles: [{ RoleArn: ROLE_A }, { RoleArn: ROLE_B }, { RoleArn: ROLE_C }],
      };
      await update(desired, recorded);
      expect(wire.sent('AddRoleToDBClusterCommand').map((input) => input['RoleArn'])).toEqual([
        ROLE_C,
      ]);
      const identity = {
        provider,
        logicalId: 'L',
        physicalId: 'cluster-1',
        resourceType: CLUSTER,
        recordedProperties: recorded,
      };
      const names = new Set(['AssociatedRoles']);
      expect(await unsettledAfterUpdate({ ...identity, names, desired })).toEqual([]);
      const previous = await settleUnsettledPrevious({
        ...identity,
        names,
        previous: recorded,
        desired,
      });
      mockSend.mockClear();
      await update(desired, previous);
      expect(wire.sent('AddRoleToDBClusterCommand')).toEqual([]);
    });

    it('changes nothing when the Describe after the wait answers no cluster', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      let planning = false;
      const target = provider as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
      const wait = target['waitForClusterAvailable']!.bind(provider);
      target['waitForClusterAvailable'] = async (...args: unknown[]) => {
        await wait(...args);
        planning = true;
      };
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        planning && command.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.resolve({ DBClusters: [] })
          : answer(command)
      );
      await expect(
        update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, { AssociatedRoles: [{ RoleArn: ROLE_B }] })
      ).rejects.toThrow(/returned no cluster while planning its role changes/);
      const order = mockSend.mock.calls.map(([call]) => (call as object).constructor.name);
      expect(order.filter((name) => name.includes('Role'))).toEqual([]);
    });

    it('a detach AWS applied but that still threw is attached again by the convergence', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_B, Status: 'ACTIVE' }] });
      const answer = mockSend.getMockImplementation()!;
      // AWS removed B, then the call failed (a replayed request reads not found).
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        const result = await answer(command);
        if (command.constructor.name === 'RemoveRoleFromDBClusterCommand') {
          throw Object.assign(new Error('Role not found'), { name: 'DBClusterRoleNotFoundFault' });
        }
        return result;
      });
      const before = { AssociatedRoles: [{ RoleArn: ROLE_B }] };
      const markAttempted = vi.fn();
      await expect(
        update({}, before, CLUSTER, { markUnsettled: vi.fn(), markAttempted })
      ).rejects.toThrow(/Role not found/);
      const attempted = new Map([
        ['AssociatedRoles', new Set(markAttempted.mock.calls.flatMap(([, items]) => items))],
      ]);
      const previous = await settleUnsettledPrevious({
        provider,
        logicalId: 'L',
        physicalId: 'cluster-1',
        resourceType: CLUSTER,
        recordedProperties: before,
        names: new Set(['AssociatedRoles']),
        previous: {},
        desired: before,
        attemptedItems: attempted,
      });
      mockSend.mockImplementation(answer);
      mockSend.mockClear();
      await update(before, previous);
      expect(wire.sent('AddRoleToDBClusterCommand').map((input) => input['RoleArn'])).toEqual([
        ROLE_B,
      ]);
    });

    it('marks the detach as attempted beside the attach', async () => {
      armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      const markAttempted = vi.fn();
      await update(
        { AssociatedRoles: [{ RoleArn: ROLE_B }] },
        { AssociatedRoles: [{ RoleArn: ROLE_A }] },
        CLUSTER,
        { markAttempted }
      );
      expect(markAttempted.mock.calls).toEqual([
        ['AssociatedRoles', [`${ROLE_A}\n`]],
        ['AssociatedRoles', [`${ROLE_B}\n`]],
      ]);
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

    const refuseOnce = (command: string, error: Error): (() => boolean) => {
      const answer = mockSend.getMockImplementation()!;
      let refused = false;
      mockSend.mockImplementation((call: { constructor: { name: string } }) => {
        if (call.constructor.name === command && !refused) {
          refused = true;
          return Promise.reject(error);
        }
        return answer(call);
      });
      return () => refused;
    };

    it('resends an attach refused because a Modify started after the wait', async () => {
      const wire = armCluster();
      const refused = refuseOnce('AddRoleToDBClusterCommand', ROLE_CALL_BUSY());
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {});
      expect(refused()).toBe(true);
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(2);
    });

    it('resends a detach refused the same way', async () => {
      const wire = armCluster({ roles: [{ RoleArn: ROLE_A, Status: 'ACTIVE' }] });
      refuseOnce('RemoveRoleFromDBClusterCommand', ROLE_CALL_BUSY());
      await update({}, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      expect(wire.sent('RemoveRoleFromDBClusterCommand')).toHaveLength(2);
    });

    it.each([
      ['InvalidDBClusterStateFault', 'DB cluster is not in available state.'],
      ['InvalidDBInstanceStateFault', 'Database instance is not in available state.'],
    ])('resends through the Modify wording too: %s', async (name, message) => {
      const wire = armCluster();
      refuseOnce('AddRoleToDBClusterCommand', Object.assign(new Error(message), { name }));
      await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {});
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(2);
    });

    it('resends an attach refused the same way on a create', async () => {
      const wire = armCluster();
      refuseOnce('AddRoleToDBClusterCommand', ROLE_CALL_BUSY());
      await provider.create('L', CLUSTER, { AssociatedRoles: [{ RoleArn: ROLE_A }] });
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(2);
    });

    it.each([
      [
        'another refusal of the same class',
        Object.assign(new Error('The role is already associated elsewhere.'), {
          name: 'InvalidDBClusterStateFault',
        }),
      ],
      ['the wording under another class', Object.assign(ROLE_CALL_BUSY(), { name: 'OtherFault' })],
    ])('does not resend %s', async (_label, error) => {
      const wire = armCluster();
      refuseOnce('AddRoleToDBClusterCommand', error);
      await expect(update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {})).rejects.toThrow();
      expect(wire.sent('AddRoleToDBClusterCommand')).toHaveLength(1);
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
          ? Promise.reject(ROLE_CALL_BUSY())
          : answer(command)
      );
      const failure = await update({ AssociatedRoles: [{ RoleArn: ROLE_A }] }, {}).catch(
        (error: unknown) => error
      );
      const message = String((failure as Error).cause ?? failure);
      expect(message).toContain('AWS kept refusing the update as the cluster being busy');
      expect(message).toContain("it last read status 'available'");
      expect(message).not.toContain('instance');
      expect(message).not.toContain("not in the 'available' state");
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
      expect(warn.mock.calls[0]![0]).toContain('Once it applies, run cdkd drift --accept.');
      expect(warn.mock.calls[0]![0]).not.toContain('until it applies');
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

  // Each expectation is the shape measured against CloudFormation's own
  // handler (CloudTrail request parameters, #5638) unless it says otherwise.
  describe('restore (go-to-k/cdkd#5638)', () => {
    const restoreCreate = (properties: Record<string, unknown>) =>
      provider.create('L', CLUSTER, { DBClusterIdentifier: 'cluster-1', ...properties });
    const SNAPSHOT = 'RestoreDBClusterFromSnapshotCommand';
    const POINT_IN_TIME = 'RestoreDBClusterToPointInTimeCommand';
    const CREATE = 'CreateDBClusterCommand';
    const MODIFY = 'ModifyDBClusterCommand';
    const LATEST = { SourceDBClusterIdentifier: 'source', UseLatestRestorableTime: true };

    it('restores a snapshot with the type defaults, whatever the snapshot held', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(sent(CREATE)).toEqual([]);
      expect(sent(SNAPSHOT)[0]).toMatchObject({
        DBClusterIdentifier: 'cluster-1',
        SnapshotIdentifier: 'snap',
        Engine: 'neptune',
        Port: 8182,
      });
      expect(sent(MODIFY)).toEqual([
        { DBClusterIdentifier: 'cluster-1', BackupRetentionPeriod: 1, ApplyImmediately: true },
      ]);
    });

    it('sends what a snapshot restore has no member for through ModifyDBCluster', async () => {
      const { sent } = armCluster();
      await restoreCreate({
        SnapshotIdentifier: 'snap',
        BackupRetentionPeriod: '5',
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        CopyTagsToSnapshot: true,
        EngineVersion: '1.4.8.1',
        DBPort: 8183,
      });
      expect(sent(SNAPSHOT)[0]).toMatchObject({
        Port: 8183,
        CopyTagsToSnapshot: true,
        EngineVersion: '1.4.8.1',
      });
      expect(sent(SNAPSHOT)[0]).not.toHaveProperty('BackupRetentionPeriod');
      expect(sent(MODIFY)).toEqual([
        {
          DBClusterIdentifier: 'cluster-1',
          BackupRetentionPeriod: 5,
          ApplyImmediately: true,
        },
        {
          DBClusterIdentifier: 'cluster-1',
          PreferredBackupWindow: '03:00-04:00',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          ApplyImmediately: true,
        },
      ]);
    });

    it('sends a restore the default key for StorageEncrypted, or the declared one', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap', StorageEncrypted: true });
      await restoreCreate({ ...LATEST, StorageEncrypted: true, KmsKeyId: 'key-1' });
      await restoreCreate({ SnapshotIdentifier: 'snap', StorageEncrypted: false });
      // A String-typed parameter's `Ref` resolves to the string.
      await restoreCreate({ SnapshotIdentifier: 'snap', StorageEncrypted: 'true' });
      await restoreCreate({ SnapshotIdentifier: 'snap', StorageEncrypted: 'True' });
      expect(sent(SNAPSHOT)[0]?.['KmsKeyId']).toBe('alias/aws/rds');
      expect(sent(POINT_IN_TIME)[0]?.['KmsKeyId']).toBe('key-1');
      expect(sent(SNAPSHOT)[1]?.['KmsKeyId']).toBeUndefined();
      expect(sent(SNAPSHOT)[2]?.['KmsKeyId']).toBe('alias/aws/rds');
      expect(sent(SNAPSHOT)[3]?.['KmsKeyId']).toBe('alias/aws/rds');
    });

    it('sends a point-in-time restore no ModifyDBCluster when nothing needs one', async () => {
      const { sent } = armCluster();
      await restoreCreate({ ...LATEST, RestoreType: 'copy-on-write' });
      expect(sent(POINT_IN_TIME)[0]).toMatchObject({
        SourceDBClusterIdentifier: 'source',
        UseLatestRestorableTime: true,
        RestoreType: 'copy-on-write',
        Port: 8182,
      });
      expect(sent(MODIFY)).toEqual([]);
    });

    it.each([
      ['2026-11-02T07:50:50Z', '2026-11-02T07:50:50.000Z'],
      ['2026-11-02T07:50:50.380000+00:00', '2026-11-02T07:50:50.380Z'],
      ['2026-11-02T16:50:50+09:00', '2026-11-02T07:50:50.000Z'],
      ['2026-11-02T16:50:50+0900', '2026-11-02T07:50:50.000Z'],
      ['2026-11-02T07:50:50z', '2026-11-02T07:50:50.000Z'],
      // No offset reads as UTC, never as this host's zone.
      ['2026-11-02T07:50:50', '2026-11-02T07:50:50.000Z'],
    ])('sends RestoreToTime %s as that instant', async (declared, instant) => {
      // A host zone off UTC, or a test of the no-offset read proves nothing.
      const zone = process.env['TZ'];
      process.env['TZ'] = 'Asia/Tokyo';
      try {
        const { sent } = armCluster();
        await restoreCreate({ SourceDBClusterIdentifier: 'source', RestoreToTime: declared });
        expect(sent(POINT_IN_TIME)[0]?.['RestoreToTime']).toEqual(new Date(instant));
      } finally {
        if (zone === undefined) delete process.env['TZ'];
        else process.env['TZ'] = zone;
      }
    });

    it('reads a legacy Port on a restore', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap', Port: '8184' });
      expect(sent(SNAPSHOT)[0]?.['Port']).toBe(8184);
    });

    it('sends the declared values CloudFormation drops from a point-in-time restore', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.0' });
      await restoreCreate({
        ...LATEST,
        BackupRetentionPeriod: 5,
        PreferredBackupWindow: '03:00-04:00',
        CopyTagsToSnapshot: false,
        EngineVersion: '1.4.8.1',
      });
      expect(sent(POINT_IN_TIME)[0]).not.toHaveProperty('EngineVersion');
      expect(sent(MODIFY)).toEqual([
        {
          DBClusterIdentifier: 'cluster-1',
          BackupRetentionPeriod: 5,
          PreferredBackupWindow: '03:00-04:00',
          CopyTagsToSnapshot: false,
          EngineVersion: '1.4.8.1',
          ApplyImmediately: true,
        },
      ]);
    });

    it('sends a declared EngineVersion when the answer names none', async () => {
      const { sent } = armCluster();
      await restoreCreate({ ...LATEST, EngineVersion: '1.4.8.1' });
      expect(sent(MODIFY)[0]?.['EngineVersion']).toBe('1.4.8.1');
    });

    it('sends no EngineVersion on a point-in-time restore declaring none', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.0' });
      await restoreCreate({ ...LATEST, BackupRetentionPeriod: 5 });
      expect(sent(MODIFY)[0]).not.toHaveProperty('EngineVersion');
    });

    it('sends the instance parameter group only beside a major upgrade', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.0' });
      await restoreCreate({
        ...LATEST,
        EngineVersion: '1.4.8.1',
        DBInstanceParameterGroupName: 'instance-params',
      });
      expect(sent(MODIFY)[0]).not.toHaveProperty('DBInstanceParameterGroupName');
      expect(sent(MODIFY)[0]).not.toHaveProperty('AllowMajorVersionUpgrade');
    });

    it('leaves an EngineVersion the restore already holds out of the follow-up', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.0' });
      await restoreCreate({ ...LATEST, EngineVersion: '1.4.8.0' });
      expect(sent(MODIFY)).toEqual([]);
    });

    it('allows the major upgrade a point-in-time restore declares', async () => {
      const { sent } = armCluster({ engineVersion: '1.3.2.0' });
      await restoreCreate({
        ...LATEST,
        EngineVersion: '1.4.8.0',
        DBInstanceParameterGroupName: 'instance-params',
      });
      expect(sent(MODIFY)[0]).toMatchObject({
        EngineVersion: '1.4.8.0',
        AllowMajorVersionUpgrade: true,
        DBInstanceParameterGroupName: 'instance-params',
      });
    });

    it('takes the point-in-time restore over a SnapshotIdentifier beside it', async () => {
      const { sent } = armCluster();
      await restoreCreate({ ...LATEST, SnapshotIdentifier: 'snap' });
      expect(sent(SNAPSHOT)).toEqual([]);
      expect(sent(POINT_IN_TIME)[0]).not.toHaveProperty('SnapshotIdentifier');
      // The declared snapshot still draws CloudFormation's retention.
      expect(sent(MODIFY)[0]?.['BackupRetentionPeriod']).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        'L (AWS::Neptune::DBCluster): this point-in-time restore does not use SnapshotIdentifier, as in CloudFormation. A declared SnapshotIdentifier still sets BackupRetentionPeriod, 1 when none is declared.'
      );
    });

    it('warns about the AvailabilityZones a point-in-time restore cannot send', async () => {
      const { sent } = armCluster();
      await restoreCreate({ ...LATEST, AvailabilityZones: ['us-east-1a'] });
      expect(sent(POINT_IN_TIME)[0]).not.toHaveProperty('AvailabilityZones');
      expect(warn).toHaveBeenCalledWith(
        'L (AWS::Neptune::DBCluster): this point-in-time restore does not use AvailabilityZones, as in CloudFormation.'
      );
    });

    it.each([
      ['RestoreType', 'copy-on-write'],
      ['RestoreToTime', '2026-11-02T07:50:50Z'],
      ['UseLatestRestorableTime', true],
    ])('creates a plain cluster for a lone %s, and says so', async (key, value) => {
      const { sent } = armCluster();
      await restoreCreate({ [key]: value });
      expect(sent(CREATE)).toHaveLength(1);
      expect(sent(CREATE)[0]).not.toHaveProperty(key);
      expect(sent(MODIFY)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `L (AWS::Neptune::DBCluster): this create does not use ${key}, as in CloudFormation.`
      );
    });

    it('warns about the point-in-time keys a snapshot restore does not read', async () => {
      armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap', RestoreType: 'copy-on-write' });
      expect(warn).toHaveBeenCalledWith(
        'L (AWS::Neptune::DBCluster): this snapshot restore does not use RestoreType, as in CloudFormation.'
      );
    });

    it('warns nothing about a point-in-time restore naming only what it reads', async () => {
      armCluster();
      await restoreCreate({
        ...LATEST,
        RestoreType: 'copy-on-write',
      });
      await restoreCreate({ SourceDBClusterIdentifier: 'source', RestoreToTime: '2026-11-02' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('asks nothing of a false UseLatestRestorableTime', async () => {
      const { sent } = armCluster();
      await restoreCreate({ UseLatestRestorableTime: false });
      expect(sent(CREATE)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('creates a plain cluster for an empty SnapshotIdentifier, and says so', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: '' });
      expect(sent(CREATE)).toHaveLength(1);
      expect(sent(SNAPSHOT)).toEqual([]);
      expect(sent(MODIFY)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'L (AWS::Neptune::DBCluster): this create does not use SnapshotIdentifier, as in CloudFormation.'
      );
    });

    it('takes an empty source as none, with or without a snapshot', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SourceDBClusterIdentifier: '', UseLatestRestorableTime: true });
      expect(sent(CREATE)).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        'L (AWS::Neptune::DBCluster): this create does not use SourceDBClusterIdentifier, UseLatestRestorableTime, as in CloudFormation.'
      );
      await restoreCreate({ SourceDBClusterIdentifier: '', SnapshotIdentifier: 'snap' });
      expect(sent(SNAPSHOT)).toHaveLength(1);
      expect(sent(POINT_IN_TIME)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'L (AWS::Neptune::DBCluster): this snapshot restore does not use SourceDBClusterIdentifier, as in CloudFormation.'
      );
    });

    it('treats an empty source in the record as no restore', async () => {
      const { sent } = armCluster();
      const declared = { PreferredBackupWindow: '05:10-05:40', SourceDBClusterIdentifier: '' };
      await update({ ...declared, IamAuthEnabled: true }, declared);
      expect(sent(MODIFY)[0]?.['PreferredBackupWindow']).toBe('05:10-05:40');
    });

    it('treats a null key as absent', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: null, SourceDBClusterIdentifier: null });
      expect(sent(CREATE)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['cluster-1', 'CLUSTER-1'])(
      'refuses %s as its own source: a replacement deletes it first',
      async (source) => {
        armCluster();
        const failure: unknown = await restoreCreate({
          SourceDBClusterIdentifier: source,
          UseLatestRestorableTime: true,
        }).catch((error: unknown) => error);
        expect((failure as Error).message).toContain(
          'SourceDBClusterIdentifier must be another cluster than the one this creates or replaces'
        );
        expect(isMarkedNonRetryable(failure)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('lets an ARN source through at create: another account may hold the name', async () => {
      const { sent } = armCluster();
      const source = 'arn:aws:rds:us-east-1:999999999999:cluster:cluster-1';
      await restoreCreate({ SourceDBClusterIdentifier: source, UseLatestRestorableTime: true });
      expect(sent(POINT_IN_TIME)[0]?.['SourceDBClusterIdentifier']).toBe(source);
    });

    it('refuses a source that is the generated name of this very cluster', async () => {
      armCluster();
      const generated = await provider
        .create('L', CLUSTER, {})
        .then((result) => result.physicalId);
      mockSend.mockClear();
      await expect(
        provider.create('L', CLUSTER, {
          SourceDBClusterIdentifier: generated,
          UseLatestRestorableTime: true,
        })
      ).rejects.toThrow(/must be another cluster/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends a point-in-time parameter group after the restore, a refusal only warning', async () => {
      const { sent } = armCluster();
      refuseModifyOf('DBClusterParameterGroupName', 'InvalidParameterCombination');
      await restoreCreate({ ...LATEST, DBClusterParameterGroupName: 'other-family' });
      expect(sent(POINT_IN_TIME)[0]?.['DBClusterParameterGroupName']).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('AWS refused DBClusterParameterGroupName after the restore')
      );
    });

    it('keeps a snapshot parameter group on the restore call', async () => {
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap', DBClusterParameterGroupName: 'group' });
      expect(sent(SNAPSHOT)[0]?.['DBClusterParameterGroupName']).toBe('group');
      expect(sent(MODIFY)).toHaveLength(1);
      expect(sent(MODIFY)[0]?.['DBClusterParameterGroupName']).toBeUndefined();
    });

    it('sends the follow-up on the plain client, never the create client', async () => {
      armCluster();
      const creates: string[] = [];
      const answer = mockSend.getMockImplementation()!;
      vi.spyOn(provider as unknown as { getCreateClient(): unknown }, 'getCreateClient')
        .mockImplementation(() => ({
          send: (command: { constructor: { name: string } }) => {
            creates.push(command.constructor.name);
            return answer(command);
          },
        }));
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(creates).toEqual([SNAPSHOT]);
    });

    it('bounds the resend of a refused follow-up by the resource deadline', async () => {
      deadline.remainingMs = 60_000;
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name !== MODIFY) return answer(command);
        const refusal = new Error("DB cluster isn't available for modification with status creating.");
        refusal.name = 'InvalidDBClusterStateFault';
        return Promise.reject(refusal);
      });
      await expect(restoreCreate({ SnapshotIdentifier: 'snap' })).rejects.toThrow();
      const sleeps = vi.mocked(
        (provider as unknown as { sleep(ms: number): Promise<void> }).sleep
      ).mock.calls.reduce((total, [ms]) => total + ms, 0);
      expect(sleeps).toBeLessThan(120_000);
    });

    it('keeps the create wait under a short resource deadline', async () => {
      deadline.remainingMs = 60_000;
      const { sent } = armCluster({ statuses: Array<string>(150).fill('creating') });
      await restoreCreate(LATEST);
      expect(sent('DescribeDBClustersCommand').length).toBeGreaterThan(150);
    });

    it('keeps the deadline margin on a long restore wait', async () => {
      deadline.remainingMs = 3_600_000;
      armCluster({ statuses: Array<string>(5_000).fill('creating') });
      await expect(restoreCreate(LATEST)).rejects.toThrow(/Timed out waiting/);
      const sleeps = vi.mocked(
        (provider as unknown as { sleep(ms: number): Promise<void> }).sleep
      ).mock.calls.reduce((total, [ms]) => total + ms, 0);
      expect(sleeps).toBeLessThan(3_590_000);
    });

    const RESTORED = { SnapshotIdentifier: 'snap', PreferredBackupWindow: '05:10-05:40' };

    it('updates a restored cluster without its unchanged refused values', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.1' });
      refuseModifyOf('PreferredBackupWindow');
      const declared = {
        ...RESTORED,
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        EngineVersion: '1.4.8.0',
        DBClusterParameterGroupName: 'group',
        BackupRetentionPeriod: 5,
        CopyTagsToSnapshot: true,
      };
      await update({ ...declared, IamAuthEnabled: true }, declared);
      const input = sent(MODIFY)[0]!;
      for (const key of [
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'EngineVersion',
      ]) {
        expect(input[key]).toBeUndefined();
      }
      // CloudFormation's update sends these, changed or not.
      expect(input).toMatchObject({
        BackupRetentionPeriod: 5,
        CopyTagsToSnapshot: true,
        DBClusterParameterGroupName: 'group',
      });
    });

    it('applies a changed value on a restored cluster', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.1' });
      await update(
        { ...RESTORED, PreferredBackupWindow: '02:00-02:30' },
        RESTORED
      );
      expect(sent(MODIFY)[0]?.['PreferredBackupWindow']).toBe('02:00-02:30');
    });

    it('treats a point-in-time record as restored too', async () => {
      const { sent } = armCluster();
      const declared = { ...LATEST, PreferredBackupWindow: '05:10-05:40' };
      await update({ ...declared, IamAuthEnabled: true }, declared);
      expect(sent(MODIFY)[0]?.['PreferredBackupWindow']).toBeUndefined();
    });

    it('keeps sending an unchanged window on a cluster not restored', async () => {
      const { sent } = armCluster();
      const declared = { PreferredBackupWindow: '05:10-05:40', SnapshotIdentifier: '' };
      await update({ ...declared, IamAuthEnabled: true }, declared);
      expect(sent(MODIFY)[0]?.['PreferredBackupWindow']).toBe('05:10-05:40');
    });

    it('warns about nothing but what the template declares', async () => {
      armCluster({ engineVersion: '1.3.2.0' });
      refuseModifyOf('EngineVersion', 'InvalidParameterCombination');
      await restoreCreate({ ...LATEST, EngineVersion: '1.4.8.0' });
      expect(warn).toHaveBeenCalledWith(
        "L (AWS::Neptune::DBCluster): AWS refused EngineVersion after the restore, so the cluster keeps its restored values. The record holds the declared ones, so drift does not report the difference. An update leaves an unchanged window or EngineVersion out, as CloudFormation does; a refused BackupRetentionPeriod, CopyTagsToSnapshot or DBClusterParameterGroupName is sent again, so every update of this cluster fails until the template changes it."
      );
    });

    it('keeps the masked refusal reason behind debug', async () => {
      armCluster();
      refuseModifyOf('PreferredBackupWindow');
      const debug = vi.spyOn(
        (provider as unknown as { logger: { debug(line: string): void } }).logger,
        'debug'
      );
      await provider.create(
        'L',
        CLUSTER,
        { DBClusterIdentifier: 'cluster-1', ...LATEST, PreferredBackupWindow: '05:10-05:40' },
        { maskSecrets: (text) => text.replaceAll('secret-window', '***') }
      );
      const lines = debug.mock.calls.map(([line]) => line).join('\n');
      expect(lines).toContain('InvalidParameterValue after restoring L: the value *** overlaps');
      expect(lines).not.toContain('secret-window');
    });

    it('warns nothing about a snapshot restore naming only what it reads', async () => {
      armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap', AvailabilityZones: ['us-east-1a'] });
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['RestoreToTime', { SourceDBClusterIdentifier: 'source', RestoreToTime: 'yesterday' }],
      ['RestoreToTime', { SourceDBClusterIdentifier: 'source', RestoreToTime: 5 }],
      ['SnapshotIdentifier', { SnapshotIdentifier: { Ref: 'Snapshot' } }],
      ['SourceDBClusterIdentifier', { SourceDBClusterIdentifier: ['source'] }],
      ['SnapshotIdentifier', { SourceDBClusterIdentifier: 'source', SnapshotIdentifier: 5 }],
    ])('refuses a malformed %s before any call', async (key, bag) => {
      armCluster();
      const failure: unknown = await restoreCreate(bag).catch((error: unknown) => error);
      expect((failure as Error).message).toContain(key);
      expect(isMarkedNonRetryable(failure)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a malformed key on a replay too', async () => {
      armCluster();
      await expect(
        provider.create(
          'L',
          CLUSTER,
          { SnapshotIdentifier: 5 },
          { replayingState: true }
        )
      ).rejects.toThrow(/SnapshotIdentifier must be a string/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('waits out the cluster after the follow-up', async () => {
      const { sent } = armCluster({ statuses: ['available', 'modifying'] });
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(sent(MODIFY)).toHaveLength(1);
      // The first wait, the one that read `modifying`, its re-read, the final read.
      expect(sent('DescribeDBClustersCommand')).toHaveLength(4);
    });

    it('skips the wait after the follow-up under --no-wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const { sent } = armCluster();
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      // The wait before the follow-up, then the final read.
      expect(sent('DescribeDBClustersCommand')).toHaveLength(2);
    });

    it('follows a --resource-timeout past the create wait', async () => {
      deadline.remainingMs = 3_600_000;
      const { sent } = armCluster({ statuses: Array<string>(200).fill('creating') });
      await restoreCreate({ ...LATEST });
      // Thirty minutes of 10s polls is 180 reads: a longer budget outlasts them.
      expect(sent('DescribeDBClustersCommand').length).toBeGreaterThan(200);
    });

    /** Modify refuses, as AWS does (measured), any call carrying `refusedKey`. */
    const refuseModifyOf = (refusedKey: string, name = 'InvalidParameterValue'): void => {
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (command.constructor.name !== MODIFY || command.input[refusedKey] === undefined) {
            return answer(command);
          }
          const refusal = new Error('the value secret-window overlaps');
          refusal.name = name;
          return Promise.reject(refusal);
        }
      );
    };

    const forever = (): string[] => Array<string>(5_000).fill('creating');

    it('caps a restore wait outside any resource deadline', async () => {
      armCluster({ statuses: forever() });
      await expect(restoreCreate(LATEST)).rejects.toThrow(/Timed out waiting/);
    });

    it('holds a plain create to its wait, whatever the resource timeout', async () => {
      deadline.remainingMs = 3_600_000;
      const { sent } = armCluster({ statuses: forever() });
      await expect(restoreCreate({})).rejects.toThrow(/Timed out waiting/);
      expect(sent('DescribeDBClustersCommand').length).toBeLessThan(200);
    });

    it('follows a --resource-timeout after the follow-up too', async () => {
      deadline.remainingMs = 3_600_000;
      const { sent } = armCluster({
        statuses: ['available', ...Array<string>(200).fill('modifying')],
      });
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(sent('DescribeDBClustersCommand').length).toBeGreaterThan(200);
    });

    it('still waits out the cluster after a refused value', async () => {
      const { sent } = armCluster({ statuses: ['available', 'modifying'] });
      refuseModifyOf('PreferredBackupWindow');
      await restoreCreate({ SnapshotIdentifier: 'snap', PreferredBackupWindow: '03:00-04:00' });
      // The first wait, the one that read `modifying`, its re-read, the final read.
      expect(sent('DescribeDBClustersCommand')).toHaveLength(4);
    });

    it('sends a declared retention beside a SnapshotIdentifier a source overrides', async () => {
      const { sent } = armCluster();
      await restoreCreate({ ...LATEST, SnapshotIdentifier: 'snap', BackupRetentionPeriod: 5 });
      expect(sent(MODIFY)).toEqual([
        { DBClusterIdentifier: 'cluster-1', BackupRetentionPeriod: 5, ApplyImmediately: true },
      ]);
    });

    /** The Modify answers `refusal` once, then accepts. */
    const refuseFirstModify = (name: string, message: string): void => {
      const answer = mockSend.getMockImplementation()!;
      let refusals = 1;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === MODIFY && refusals-- > 0) {
          const refusal = new Error(message);
          refusal.name = name;
          return Promise.reject(refusal);
        }
        return answer(command);
      });
    };

    it.each([
      "DB cluster isn't available for modification with status creating.",
      'DB cluster isn’t available for modification with status creating.',
      'DB cluster is not available for modification with status creating.',
      "DB CLUSTER ISN'T AVAILABLE FOR MODIFICATION WITH STATUS CREATING.",
      'Database instance is not in available state.',
    ])('resends a follow-up refused as %s', async (message) => {
      const { sent } = armCluster();
      refuseFirstModify('InvalidDBClusterStateFault', message);
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(sent(MODIFY)).toHaveLength(2);
    });

    it.each([
      ['InvalidDBClusterStateFault', 'Cannot modify engine version without a healthy primary instance'],
      ['InvalidParameterValue', "DB cluster isn't available for modification with status creating."],
    ])('does not resend a %s saying "%s"', async (name, message) => {
      const { sent } = armCluster();
      refuseFirstModify(name, message);
      await expect(restoreCreate({ SnapshotIdentifier: 'snap' })).rejects.toThrow();
      expect(sent(MODIFY)).toHaveLength(1);
    });

    it('keeps a parameter group beside the EngineVersion it may belong to', async () => {
      const { sent } = armCluster({ engineVersion: '1.3.2.0' });
      refuseModifyOf('PreferredBackupWindow');
      await restoreCreate({
        ...LATEST,
        EngineVersion: '1.4.8.0',
        DBClusterParameterGroupName: 'group',
        PreferredBackupWindow: '05:10-05:40',
      });
      const beside = sent(MODIFY).filter((input) => input['EngineVersion'] !== undefined);
      expect(beside.at(-1)?.['DBClusterParameterGroupName']).toBe('group');
      const message = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(message).toContain('AWS refused PreferredBackupWindow after');
      expect(message).not.toContain('AWS refused DBClusterParameterGroupName');
    });

    it('warns about a declared value AWS refuses, and keeps the create', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.0' });
      refuseModifyOf('PreferredBackupWindow');
      const result = await restoreCreate({ ...LATEST, PreferredBackupWindow: '03:00-04:00' });
      expect(result.physicalId).toBe('cluster-1');
      expect(sent(MODIFY)).toHaveLength(1);
      const message = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(message).toContain('AWS refused PreferredBackupWindow after the restore');
      expect(message).not.toContain('secret-window');
    });

    it('applies every group but the one AWS refuses', async () => {
      const { sent } = armCluster({ engineVersion: '1.4.8.1' });
      refuseModifyOf('EngineVersion', 'InvalidParameterCombination');
      await restoreCreate({
        ...LATEST,
        BackupRetentionPeriod: 35,
        CopyTagsToSnapshot: true,
        EngineVersion: '1.4.8.0',
      });
      const applied = sent(MODIFY).slice(1);
      expect(applied.map((input) => input['BackupRetentionPeriod'])).toContain(35);
      expect(applied.map((input) => input['CopyTagsToSnapshot'])).toContain(true);
      const message = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(message).toContain('AWS refused EngineVersion after');
      expect(message).not.toContain('AWS refused BackupRetentionPeriod');
    });

    it('warns about nothing when each group passes alone', async () => {
      const { sent } = armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const { input } = command;
          if (
            command.constructor.name === MODIFY &&
            'BackupRetentionPeriod' in input &&
            'CopyTagsToSnapshot' in input
          ) {
            const refusal = new Error('refused');
            refusal.name = 'InvalidParameterCombination';
            return Promise.reject(refusal);
          }
          return answer(command);
        }
      );
      await restoreCreate({ ...LATEST, BackupRetentionPeriod: 5, CopyTagsToSnapshot: true });
      expect(sent(MODIFY)).toHaveLength(3);
      expect(warn).not.toHaveBeenCalled();
    });

    it('fails on an Invalid* answer that is not about the value', async () => {
      armCluster();
      refuseModifyOf('PreferredBackupWindow', 'InvalidClientTokenId');
      await expect(
        restoreCreate({ ...LATEST, PreferredBackupWindow: '03:00-04:00' })
      ).rejects.toThrow();
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns about the other refusal AWS answers for a value', async () => {
      armCluster({ engineVersion: '1.4.8.1' });
      refuseModifyOf('EngineVersion', 'InvalidParameterCombination');
      await restoreCreate({ ...LATEST, EngineVersion: '1.4.8.0' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('AWS refused EngineVersion'));
    });

    it('still fails on a declared value AWS does not refuse as invalid', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name !== MODIFY) return answer(command);
        const denied = new Error('denied');
        denied.name = 'AccessDenied';
        return Promise.reject(denied);
      });
      await expect(
        restoreCreate({ ...LATEST, PreferredBackupWindow: '03:00-04:00' })
      ).rejects.toThrow();
    });

    it('fails on a refused follow-up CloudFormation sends too', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name !== MODIFY) return answer(command);
        const refusal = new Error('bad retention');
        refusal.name = 'InvalidParameterValue';
        return Promise.reject(refusal);
      });
      await expect(restoreCreate({ SnapshotIdentifier: 'snap' })).rejects.toThrow();
    });

    it('waits for the cluster before the follow-up, whatever --no-wait says', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const { sent } = armCluster({ statuses: ['creating', 'backing-up'] });
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(sent(MODIFY)).toHaveLength(1);
      const calls = mockSend.mock.calls.map(
        ([call]) => (call as { constructor: { name: string } }).constructor.name
      );
      expect(calls.slice(0, 5)).toEqual([
        SNAPSHOT,
        'DescribeDBClustersCommand',
        'DescribeDBClustersCommand',
        'DescribeDBClustersCommand',
        MODIFY,
      ]);
    });

    it('skips the wait under --no-wait when no follow-up needs it', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const { sent } = armCluster();
      await restoreCreate(LATEST);
      // Only the read of the final attributes.
      expect(sent('DescribeDBClustersCommand')).toHaveLength(1);
    });

    it('resends a follow-up refused while the restored cluster settles', async () => {
      const { sent } = armCluster();
      const answer = mockSend.getMockImplementation()!;
      let refusals = 1;
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === MODIFY && refusals-- > 0) {
          const refusal = new Error(
            "DB cluster isn't available for modification with status creating."
          );
          refusal.name = 'InvalidDBClusterStateFault';
          return Promise.reject(refusal);
        }
        return answer(command);
      });
      await restoreCreate({ SnapshotIdentifier: 'snap' });
      expect(sent(MODIFY)).toHaveLength(2);
    });

    it('marks a failed follow-up as auxiliary to the cluster it restored', async () => {
      armCluster();
      const answer = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === MODIFY
          ? Promise.reject(new Error('InvalidParameterValue'))
          : answer(command)
      );
      const failure: unknown = await restoreCreate({ SnapshotIdentifier: 'snap' }).catch(
        (error: unknown) => error
      );
      expect(createdBeforeFailure(failure, 'L', CLUSTER)).toBe('cluster-1');
      expect(isAuxiliaryFailure(failure)).toBe(true);
      // #4606: the resource id the restore returned is the orphan's identity.
      expect(createdResourceIdentityBeforeFailure(failure, 'L', CLUSTER)).toBe('cluster-res');
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
        'RestoreToTime',
        'RestoreType',
        'SnapshotIdentifier',
        'SourceDBClusterIdentifier',
        'UseLatestRestorableTime',
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
      [
        'an empty nested pending block',
        {
          Status: 'available',
          PendingModifiedValues: { PendingCloudwatchLogsExports: { LogTypesToEnable: [] } },
        },
        [],
      ],
      ['a null pending block', { Status: 'available', PendingModifiedValues: null }, []],
      ['a pending log type', {
        Status: 'available',
        PendingModifiedValues: { PendingCloudwatchLogsExports: { LogTypesToEnable: ['audit'] } },
      }, [...names]],
      ['backing-up', { Status: 'backing-up' }, []],
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
      ['an empty pending block', { DBInstanceStatus: 'available', PendingModifiedValues: {} }, []],
      ['backing-up', { DBInstanceStatus: 'backing-up' }, []],
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

    it('lets a value matching the template beat a moving cluster, after an update', async () => {
      liveCluster({
        Status: 'modifying',
        CopyTagsToSnapshot: true,
        NetworkType: 'IPV4',
        PendingModifiedValues: { NetworkType: 'DUAL' },
      });
      const desired = { CopyTagsToSnapshot: true, NetworkType: 'DUAL' };
      expect(
        await unsettledAfterUpdate({
          ...identity({}),
          names: new Set(Object.keys(desired)),
          desired,
        })
      ).toEqual(['NetworkType']);
    });

    it('still refuses to converge a moving cluster before an update', async () => {
      liveCluster({ Status: 'modifying' });
      await expect(
        settleUnsettledPrevious({
          ...identity({}),
          names: new Set(['CopyTagsToSnapshot']),
          previous: {},
        })
      ).rejects.toThrow('nothing was updated');
    });

    it('proves a repeated role or log type and an empty FeatureName settled', async () => {
      liveCluster({
        AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: '' }],
        EnabledCloudwatchLogsExports: ['audit', 'audit'],
      });
      const desired = {
        AssociatedRoles: [
          { RoleArn: ROLE_A, FeatureName: '' },
          { RoleArn: ROLE_A },
        ],
        EnableCloudwatchLogsExports: ['audit'],
      };
      expect(
        await unsettledAfterUpdate({
          ...identity({}),
          names: new Set(Object.keys(desired)),
          desired,
        })
      ).toEqual([]);
    });

    it('never applies a drift canonicalizer in the proof: only the unsettled hook', async () => {
      const stripWarm = vi.fn((_type: string, bag: Record<string, unknown>) => {
        const { Warm: _stripped, ...rest } = bag;
        return rest;
      });
      const prove = (hooks: Record<string, unknown>) =>
        unsettledAfterUpdate({
          ...identity({}),
          provider: {
            ...hooks,
            canonicalizeDriftProperties: stripWarm,
            readCurrentState: () => Promise.resolve({ Warm: 1 }),
          } as unknown as NeptuneProvider,
          names: new Set(['Warm']),
          desired: { Warm: 2 },
        });
      expect(await prove({})).toEqual(['Warm']);
      expect(stripWarm).not.toHaveBeenCalled();
      expect(await prove({ canonicalizeUnsettledProperties: stripWarm })).toEqual([]);
    });

    it('normalizes both lists for drift, and leaves a malformed side alone', () => {
      expect(
        provider.canonicalizeDriftProperties(CLUSTER, {
          AssociatedRoles: [{ RoleArn: ROLE_A, FeatureName: '' }, { RoleArn: ROLE_A }],
          EnableCloudwatchLogsExports: ['audit', 'audit'],
        })
      ).toEqual({
        AssociatedRoles: [{ RoleArn: ROLE_A }],
        EnableCloudwatchLogsExports: ['audit'],
      });
      const junk = { AssociatedRoles: [{ FeatureName: 'f' }], EnableCloudwatchLogsExports: [1] };
      expect(provider.canonicalizeDriftProperties(CLUSTER, junk)).toEqual(junk);
      expect(provider.canonicalizeDriftProperties(INSTANCE, junk)).toBe(junk);
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
