// go-to-k/cdkd#5639: DBCluster `SnapshotIdentifier` and `SourceDbClusterResourceId`.
// A snapshot makes the create a RestoreDBClusterFromSnapshot, a source resource id
// a RestoreDBClusterToPointInTime that names it; either is followed by the
// ModifyDBCluster CloudFormation's handler sends once the cluster is available
// (`modifyDbClusterAfterCreateRequest`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

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
    warn: mockWarn,
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
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';
import { isRestoredRecord } from '../../../src/provisioning/providers/rds/cluster-restore.js';
import { refuseRestoreFromItself } from '../../../src/provisioning/restore-source-guard.js';

type Input = Record<string, unknown>;
type Command = { constructor: { name: string }; input: Input };

const ACCOUNT = '123456789012';
const SNAPSHOT = 'manual-snap-1';
const RESOURCE_ID = 'cluster-SOURCEID123';
const CLUSTER = 'cluster-1';
const CLUSTER_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${CLUSTER}`;
const KEYS = ['SnapshotIdentifier', 'SourceDbClusterResourceId'] as const;

const named = (name: string, message = name): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

interface Live {
  /** The snapshot DescribeDBClusterSnapshots answers (`undefined`: an empty list). */
  snapshot?: Input | undefined;
  snapshotError?: Error;
  /** The automated backup DescribeDBClusterAutomatedBackups answers. */
  backup?: Input | undefined;
  backupError?: Error;
  /** The global clusters AWS lists, by identifier, with the cluster's ARN as member. */
  globalMemberOf?: string;
  members?: Input[];
}

function arm(live: Live = {}): void {
  const snapshot = 'snapshot' in live ? live.snapshot : { EngineVersion: '16.4' };
  const backup = 'backup' in live ? live.backup : { StorageEncrypted: true, Status: 'active' };
  let deleted = false;
  let detached = false;
  mockSend.mockImplementation((command: Command) => {
    const name = command.constructor.name;
    if (name === 'DescribeDBClusterSnapshotsCommand') {
      if (live.snapshotError !== undefined) return Promise.reject(live.snapshotError);
      return Promise.resolve({ DBClusterSnapshots: snapshot === undefined ? [] : [snapshot] });
    }
    if (name === 'DescribeDBClusterAutomatedBackupsCommand') {
      if (live.backupError !== undefined) return Promise.reject(live.backupError);
      return Promise.resolve({ DBClusterAutomatedBackups: backup === undefined ? [] : [backup] });
    }
    if (name === 'DescribeDBClustersCommand') {
      // Gone once deleted: a delete's wait reads it so.
      if (deleted) return Promise.reject(named('DBClusterNotFoundFault'));
      return Promise.resolve({
        DBClusters: [
          {
            DBClusterIdentifier: CLUSTER,
            DBClusterArn: CLUSTER_ARN,
            DBClusterMembers: live.members ?? [],
            Status: 'available',
            HttpEndpointEnabled: true,
          },
        ],
      });
    }
    if (
      name === 'RestoreDBClusterFromSnapshotCommand' ||
      name === 'RestoreDBClusterToPointInTimeCommand' ||
      name === 'CreateDBClusterCommand'
    ) {
      return Promise.resolve({
        DBCluster: { DBClusterIdentifier: CLUSTER, DBClusterArn: CLUSTER_ARN },
      });
    }
    if (name === 'DescribeGlobalClustersCommand') {
      return Promise.resolve({
        GlobalClusters:
          live.globalMemberOf === undefined || detached
            ? []
            : [
                {
                  GlobalClusterIdentifier: live.globalMemberOf,
                  GlobalClusterMembers: [{ DBClusterArn: CLUSTER_ARN, IsWriter: true }],
                },
              ],
      });
    }
    if (name === 'DescribeDBInstancesCommand') return Promise.reject(named('DBInstanceNotFoundFault'));
    if (name === 'DeleteDBClusterCommand') deleted = true;
    if (name === 'RemoveFromGlobalClusterCommand') detached = true;
    return Promise.resolve({});
  });
}

const commands = (): Command[] => mockSend.mock.calls.map(([command]) => command as Command);
const names = (): string[] => commands().map((command) => command.constructor.name);
const sent = (name: string): Input[] =>
  commands()
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
const only = (name: string): Input => {
  const calls = sent(name);
  expect(calls, name).toHaveLength(1);
  return calls[0]!;
};
const warnings = (): string[] => mockWarn.mock.calls.map(([text]) => String(text));

const SNAP_BASE: Input = {
  DBClusterIdentifier: CLUSTER,
  Engine: 'aurora-postgresql',
  SnapshotIdentifier: SNAPSHOT,
};
const ID_BASE: Input = {
  DBClusterIdentifier: CLUSTER,
  Engine: 'aurora-postgresql',
  SourceDbClusterResourceId: RESOURCE_ID,
  UseLatestRestorableTime: true,
};

describe('RDSProvider DBCluster snapshot and resource-id restores (go-to-k/cdkd#5639)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  const create = (base: Input, properties: Input = {}) =>
    provider.create('Cluster', 'AWS::RDS::DBCluster', { ...base, ...properties });

  it('handles both keys, so a template declaring them keeps the SDK route', () => {
    for (const key of KEYS) {
      expect(provider.handledProperties.get('AWS::RDS::DBCluster')?.has(key), key).toBe(true);
      expect(getPropertyCoverage('AWS::RDS::DBCluster')?.sdkUnwired.has(key), key).toBe(false);
    }
  });

  describe('SnapshotIdentifier', () => {
    it('restores from the snapshot, sending the members the handler puts on the restore call', async () => {
      await create(SNAP_BASE, {
        EngineVersion: '16.4',
        EngineMode: 'provisioned',
        DatabaseName: 'app',
        Port: 5433,
        DBSubnetGroupName: 'subnets',
        VpcSecurityGroupIds: ['sg-1'],
        KmsKeyId: 'alias/aws/rds',
        DBClusterParameterGroupName: 'params-1',
        DeletionProtection: false,
        EnableIAMDatabaseAuthentication: true,
        BacktrackWindow: 3600,
        AvailabilityZones: ['us-east-1a', 'us-east-1b'],
        CopyTagsToSnapshot: true,
        StorageType: 'aurora-iopt1',
        NetworkType: 'IPV4',
        EnableCloudwatchLogsExports: ['postgresql'],
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        PubliclyAccessible: false,
        Tags: [{ Key: 'k', Value: 'v' }],
        // Not on the restore call: the follow-up, or nothing.
        MasterUsername: 'postgres',
        MasterUserPassword: 'password-1',
        StorageEncrypted: true,
        PreferredBackupWindow: '03:00-03:30',
        MonitoringInterval: 60,
      });
      expect(sent('CreateDBClusterCommand')).toHaveLength(0);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
      expect(only('RestoreDBClusterFromSnapshotCommand')).toEqual({
        DBClusterIdentifier: CLUSTER,
        SnapshotIdentifier: SNAPSHOT,
        Engine: 'aurora-postgresql',
        EngineVersion: '16.4',
        EngineMode: 'provisioned',
        DatabaseName: 'app',
        Port: 5433,
        DBSubnetGroupName: 'subnets',
        VpcSecurityGroupIds: ['sg-1'],
        KmsKeyId: 'alias/aws/rds',
        DBClusterParameterGroupName: 'params-1',
        DeletionProtection: false,
        EnableIAMDatabaseAuthentication: true,
        BacktrackWindow: 3600,
        AvailabilityZones: ['us-east-1a', 'us-east-1b'],
        CopyTagsToSnapshot: true,
        StorageType: 'aurora-iopt1',
        NetworkType: 'IPV4',
        EnableCloudwatchLogsExports: ['postgresql'],
        ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        PubliclyAccessible: false,
        Tags: [{ Key: 'k', Value: 'v' }],
      });
      // The snapshot is read first, as the handler reads it for its scalability type.
      expect(names().indexOf('DescribeDBClusterSnapshotsCommand')).toBeLessThan(
        names().indexOf('RestoreDBClusterFromSnapshotCommand')
      );
      expect(sent('DescribeDBClusterSnapshotsCommand')[0]).toEqual({
        DBClusterSnapshotIdentifier: SNAPSHOT,
        IncludeShared: true,
        IncludePublic: true,
      });
    });

    it('follows the restore with the ModifyDBCluster the handler sends once the cluster is available', async () => {
      await create(SNAP_BASE, {
        MasterUserPassword: 'password-1',
        PreferredBackupWindow: '03:00-03:30',
        DeletionProtection: true,
        DBClusterParameterGroupName: 'params-1',
      });
      expect(only('ModifyDBClusterCommand')).toEqual({
        DBClusterIdentifier: CLUSTER,
        ApplyImmediately: true,
        // Absent: 1, as `ModelAdapter.setDefaults` fills it.
        BackupRetentionPeriod: 1,
        MasterUserPassword: 'password-1',
        PreferredBackupWindow: '03:00-03:30',
        DeletionProtection: true,
        DBClusterParameterGroupName: 'params-1',
      });
      expect(names().indexOf('RestoreDBClusterFromSnapshotCommand')).toBeLessThan(
        names().indexOf('ModifyDBClusterCommand')
      );
    });

    it('waits for available before the follow-up even under --no-wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      await create(SNAP_BASE);
      const order = names();
      const restored = order.indexOf('RestoreDBClusterFromSnapshotCommand');
      const modified = order.indexOf('ModifyDBClusterCommand');
      expect(order.slice(restored, modified)).toContain('DescribeDBClustersCommand');
    });

    it('names the keys a snapshot restore does not apply, and creates no express writer', async () => {
      await create(SNAP_BASE, {
        GlobalClusterIdentifier: 'global-1',
        WithExpressConfiguration: true,
        ClusterScalabilityType: 'standard',
        MasterUserAuthenticationType: 'password',
        RestoreType: 'copy-on-write',
      });
      const restore = only('RestoreDBClusterFromSnapshotCommand');
      for (const key of ['GlobalClusterIdentifier', 'WithExpressConfiguration', 'ClusterScalabilityType']) {
        expect(restore, key).not.toHaveProperty(key);
      }
      const warned = warnings().find((w) => /this snapshot restore does not apply/.test(w)) ?? '';
      for (const key of [
        'GlobalClusterIdentifier',
        'WithExpressConfiguration',
        'ClusterScalabilityType',
        'MasterUserAuthenticationType',
        'RestoreType',
      ]) {
        expect(warned, key).toContain(key);
      }
      // AvailabilityZones is one this restore takes.
      expect(warned).not.toContain('AvailabilityZones');
      expect(sent('DescribeDBInstancesCommand')).toHaveLength(0);
    });

    it.each([
      ['an unencrypted snapshot, no key', { StorageEncrypted: false }, {}, true],
      ['an unencrypted snapshot with a key', { StorageEncrypted: false }, { KmsKeyId: 'alias/aws/rds' }, false],
      ['an encrypted snapshot', { StorageEncrypted: true }, {}, false],
      ['an unread snapshot (denied)', undefined, {}, false],
    ] as const)(
      'names a cluster StorageEncrypted: true leaves unencrypted only when it does: %s',
      async (_n, snapshot, extra, warns) => {
        arm(
          snapshot === undefined
            ? { snapshotError: named('AccessDenied', 'not authorized') }
            : { snapshot: { EngineVersion: '16.4', ...snapshot } }
        );
        await create(SNAP_BASE, { StorageEncrypted: true, ...extra });
        expect(only('RestoreDBClusterFromSnapshotCommand')).not.toHaveProperty('StorageEncrypted');
        expect(warnings().some((w) => /the restored cluster is not encrypted/.test(w))).toBe(warns);
        expect(warnings().some((w) => /does not apply StorageEncrypted/.test(w))).toBe(false);
      }
    );

    it('names only a differing MasterUsername as kept: the engine, version, mode and name are sent', async () => {
      const base = (arm(), mockSend.getMockImplementation()!);
      mockSend.mockImplementation((command: Command) =>
        command.constructor.name === 'RestoreDBClusterFromSnapshotCommand'
          ? Promise.resolve({
              DBCluster: {
                DBClusterIdentifier: CLUSTER,
                DBClusterArn: CLUSTER_ARN,
                MasterUsername: 'cdkdadmin',
                EngineVersion: '16.4',
                DatabaseName: 'other',
              },
            })
          : base(command)
      );
      await create(SNAP_BASE, { MasterUsername: 'otheradmin', EngineVersion: '17.9', DatabaseName: 'app' });
      const kept = warnings().find((w) => /the restored cluster keeps its source's/.test(w)) ?? '';
      expect(kept).toContain('MasterUsername');
      expect(kept).not.toContain('EngineVersion');
      expect(kept).not.toContain('DatabaseName');
    });

    it('restores the same way on a rollback replay of the record', async () => {
      await provider.create('Cluster', 'AWS::RDS::DBCluster', { ...SNAP_BASE }, { replayingState: true });
      expect(only('RestoreDBClusterFromSnapshotCommand')['SnapshotIdentifier']).toBe(SNAPSHOT);
      expect(only('ModifyDBClusterCommand')['BackupRetentionPeriod']).toBe(1);
    });

    it('checks no encryption, as the handler checks none for a snapshot', async () => {
      arm({ snapshot: { EngineVersion: '16.4', StorageEncrypted: true } });
      await create(SNAP_BASE, { StorageEncrypted: false, KmsKeyId: 'alias/aws/rds' });
      expect(only('RestoreDBClusterFromSnapshotCommand')['KmsKeyId']).toBe('alias/aws/rds');
    });

    it('takes the limitless request shape from a limitless snapshot', async () => {
      arm({ snapshot: { EngineVersion: '16.4-limitless' } });
      await create(SNAP_BASE, {
        MonitoringInterval: 60,
        MonitoringRoleArn: 'role-m',
        PerformanceInsightsEnabled: true,
        PerformanceInsightsRetentionPeriod: 31,
        PerformanceInsightsKmsKeyId: 'key-pi',
        StorageType: 'aurora-iopt1',
      });
      expect(only('RestoreDBClusterFromSnapshotCommand')).toMatchObject({
        MonitoringInterval: 60,
        MonitoringRoleArn: 'role-m',
        EnablePerformanceInsights: true,
        PerformanceInsightsRetentionPeriod: 31,
        PerformanceInsightsKMSKeyId: 'key-pi',
      });
      const followUp = only('ModifyDBClusterCommand');
      for (const key of ['StorageType', 'EnablePerformanceInsights', 'PerformanceInsightsKMSKeyId']) {
        expect(followUp, key).not.toHaveProperty(key);
      }
    });

    it('a standard snapshot keeps monitoring and Performance Insights off the restore call', async () => {
      await create(SNAP_BASE, { MonitoringInterval: 60, PerformanceInsightsEnabled: true });
      const restore = only('RestoreDBClusterFromSnapshotCommand');
      expect(restore).not.toHaveProperty('MonitoringInterval');
      expect(restore).not.toHaveProperty('EnablePerformanceInsights');
    });

    it.each([
      `arn:aws:rds:us-east-1:${ACCOUNT}:snapshot:db-snap-1`,
      `arn:aws:rds:us-east-1:${ACCOUNT}:snapshot/db-snap-1`,
    ])('reads no DB instance snapshot (%s), which the handler restores as standard', async (instanceSnapshot) => {
      await create(SNAP_BASE, { SnapshotIdentifier: instanceSnapshot });
      expect(sent('DescribeDBClusterSnapshotsCommand')).toHaveLength(0);
      expect(only('RestoreDBClusterFromSnapshotCommand')['SnapshotIdentifier']).toBe(instanceSnapshot);
    });

    it('reads a cluster snapshot ARN, and one whose type is not spelled exactly', async () => {
      for (const arn of [
        `arn:aws:rds:us-east-1:${ACCOUNT}:cluster-snapshot:snap-1`,
        `arn:aws:rds:us-east-1:${ACCOUNT}:SNAPSHOT:snap-1`,
      ]) {
        mockSend.mockClear();
        await create(SNAP_BASE, { SnapshotIdentifier: arn });
        expect(sent('DescribeDBClusterSnapshotsCommand'), arn).toHaveLength(1);
      }
    });

    it.each([
      ['an empty answer', { snapshot: undefined }],
      ['a not-found fault', { snapshotError: named('DBClusterSnapshotNotFoundFault') }],
    ] as const)('refuses a snapshot the read does not find (%s), before anything is made', async (_n, live) => {
      arm(live);
      await expect(create(SNAP_BASE)).rejects.toThrow(
        /SnapshotIdentifier manual-snap-1 does not name a DB cluster snapshot this account can read/
      );
      expect(names()).toEqual(['DescribeDBClusterSnapshotsCommand']);
    });

    it('restores as standard when the snapshot read is denied, as the handler does', async () => {
      arm({ snapshotError: named('AccessDenied', 'not authorized') });
      await create(SNAP_BASE, { MonitoringInterval: 60 });
      expect(only('RestoreDBClusterFromSnapshotCommand')).not.toHaveProperty('MonitoringInterval');
      expect(warnings().some((w) => /could not read the restore snapshot \(AccessDenied\)/.test(w))).toBe(true);
    });

    it('fails the create when the snapshot read fails otherwise, before anything is made', async () => {
      arm({ snapshotError: named('Throttling', 'slow down') });
      await expect(create(SNAP_BASE)).rejects.toThrow(/reading the restore snapshot failed, so nothing was changed/);
      expect(sent('RestoreDBClusterFromSnapshotCommand')).toHaveLength(0);
    });

    it.each([[['snap']], [{ id: 'snap' }], [5]])('refuses a SnapshotIdentifier of %j before any call', async (value) => {
      await expect(create(SNAP_BASE, { SnapshotIdentifier: value })).rejects.toThrow(
        /SnapshotIdentifier must be a string/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('creates as before with an empty SnapshotIdentifier', async () => {
      await create(SNAP_BASE, { SnapshotIdentifier: '' });
      expect(sent('CreateDBClusterCommand')).toHaveLength(1);
      expect(sent('RestoreDBClusterFromSnapshotCommand')).toHaveLength(0);
    });

    it("refuses restoring from the cluster's own automated snapshot before any call", async () => {
      await expect(
        create(SNAP_BASE, { SnapshotIdentifier: `rds:${CLUSTER}-2026-11-11-03-00` })
      ).rejects.toThrow(/SnapshotIdentifier names an automated snapshot of the cluster/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('fails a point-in-time restore whose declared snapshot does not exist, as CloudFormation reads it first', async () => {
      arm({ snapshot: undefined });
      await expect(create(ID_BASE, { SnapshotIdentifier: SNAPSHOT })).rejects.toThrow(
        /SnapshotIdentifier manual-snap-1 does not name a DB cluster snapshot/
      );
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
      expect(sent('DescribeDBClusterAutomatedBackupsCommand')).toHaveLength(0);
    });

    it('lets a point-in-time source win, as the handler tests it first, naming the snapshot as unused', async () => {
      await create(ID_BASE, { SnapshotIdentifier: SNAPSHOT });
      expect(sent('RestoreDBClusterFromSnapshotCommand')).toHaveLength(0);
      // Read, as the handler reads it, then not used.
      expect(sent('DescribeDBClusterSnapshotsCommand')).toHaveLength(1);
      expect(only('RestoreDBClusterToPointInTimeCommand')).not.toHaveProperty('SnapshotIdentifier');
      expect(warnings().some((w) => /point-in-time restore does not apply SnapshotIdentifier/.test(w))).toBe(
        true
      );
    });

    it('deletes the restored cluster when the follow-up fails, and rethrows', async () => {
      const base = (arm(), mockSend.getMockImplementation()!);
      mockSend.mockImplementation((command: Command) =>
        command.constructor.name === 'ModifyDBClusterCommand'
          ? Promise.reject(named('DBClusterParameterGroupNotFound', 'bad parameter group'))
          : base(command)
      );
      await expect(create(SNAP_BASE, { DBClusterParameterGroupName: 'missing' })).rejects.toThrow(
        /bad parameter group/
      );
      expect(only('DeleteDBClusterCommand')).toEqual({ DBClusterIdentifier: CLUSTER, SkipFinalSnapshot: true });
    });
  });

  describe('SourceDbClusterResourceId', () => {
    it('restores the same way on a rollback replay of the record', async () => {
      await provider.create('Cluster', 'AWS::RDS::DBCluster', { ...ID_BASE }, { replayingState: true });
      expect(only('RestoreDBClusterToPointInTimeCommand')['SourceDbClusterResourceId']).toBe(RESOURCE_ID);
    });

    it('restores to a point in time from the source resource id, reading its automated backups first', async () => {
      await create(ID_BASE, { Port: 5433, KmsKeyId: 'alias/aws/rds', StorageEncrypted: true });
      expect(only('DescribeDBClusterAutomatedBackupsCommand')).toEqual({
        DbClusterResourceId: RESOURCE_ID,
      });
      // No cluster is read by the resource id (DescribeDBClusters takes none),
      // and no snapshot is read.
      expect(sent('DescribeDBClustersCommand').length).toBeGreaterThan(0);
      expect(
        sent('DescribeDBClustersCommand').filter((i) => i['DBClusterIdentifier'] === RESOURCE_ID)
      ).toHaveLength(0);
      expect(names()).not.toContain('DescribeDBClusterSnapshotsCommand');
      expect(only('RestoreDBClusterToPointInTimeCommand')).toEqual({
        DBClusterIdentifier: CLUSTER,
        SourceDbClusterResourceId: RESOURCE_ID,
        UseLatestRestorableTime: true,
        Port: 5433,
        KmsKeyId: 'alias/aws/rds',
      });
      // The backups are read before the restore.
      expect(names().indexOf('DescribeDBClusterAutomatedBackupsCommand')).toBeLessThan(
        names().indexOf('RestoreDBClusterToPointInTimeCommand')
      );
      expect(only('ModifyDBClusterCommand')['BackupRetentionPeriod']).toBe(1);
    });

    it('refuses both point-in-time sources at once before any call, as the handler does', async () => {
      await expect(create(ID_BASE, { SourceDBClusterIdentifier: 'source-1' })).rejects.toThrow(
        /set either SourceDBClusterIdentifier or SourceDbClusterResourceId, not both/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a non-string SourceDbClusterResourceId before any call', async () => {
      await expect(create(ID_BASE, { SourceDbClusterResourceId: ['x'] })).rejects.toThrow(
        /SourceDbClusterResourceId must be a string/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty answer', { backup: undefined }],
      ['a not-found fault', { backupError: named('DBClusterAutomatedBackupNotFoundFault') }],
    ] as const)('refuses an id with no automated backup (%s), before anything is made', async (_n, live) => {
      arm(live);
      await expect(create(ID_BASE)).rejects.toThrow(
        /does not name a DB cluster or retained automated backup this account can read/
      );
      expect(names()).toEqual(['DescribeDBClusterAutomatedBackupsCommand']);
    });

    it('fails the create when the backup read fails otherwise, before anything is made', async () => {
      arm({ backupError: named('AccessDenied', 'not authorized') });
      await expect(create(ID_BASE)).rejects.toThrow(
        /reading the restore source's automated backups failed, so nothing was changed/
      );
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });

    it('refuses a retained limitless backup with the handler\'s reason', async () => {
      arm({ backup: { EngineVersion: '16.4-limitless', Status: 'retained', StorageEncrypted: true } });
      await expect(create(ID_BASE)).rejects.toThrow(/retained automated backup of an Aurora Limitless/);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });

    it('takes the limitless request shape from an active limitless backup', async () => {
      arm({ backup: { EngineVersion: '16.4-limitless', Status: 'active', StorageEncrypted: true } });
      await create(ID_BASE, { MonitoringInterval: 60 });
      expect(only('RestoreDBClusterToPointInTimeCommand')['MonitoringInterval']).toBe(60);
    });

    it.each([
      [{ StorageEncrypted: false }, { StorageEncrypted: true }, /restore source is not encrypted/],
      [{ StorageEncrypted: true }, { StorageEncrypted: false }, /the restore source is encrypted/],
    ])('refuses what CloudFormation refuses: backup %j, template %j', async (backup, template, says) => {
      arm({ backup: { ...backup, Status: 'active' } });
      await expect(create(ID_BASE, template)).rejects.toThrow(says);
      expect(sent('RestoreDBClusterToPointInTimeCommand')).toHaveLength(0);
    });
  });

  describe('a restored record', () => {
    it.each([
      ['a snapshot', SNAP_BASE],
      ['a source resource id', ID_BASE],
    ])('from %s deletes no writer by name and detaches from no global cluster', async (_n, base) => {
      arm({ members: [{ DBInstanceIdentifier: `${CLUSTER}-instance-1`, IsClusterWriter: true }] });
      await provider.delete('Cluster', CLUSTER, 'AWS::RDS::DBCluster', {
        ...base,
        WithExpressConfiguration: true,
        GlobalClusterIdentifier: 'global-1',
      });
      expect(sent('DeleteDBInstanceCommand')).toHaveLength(0);
      expect(sent('DescribeGlobalClustersCommand').length).toBeGreaterThan(0);
      expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(0);
      expect(only('DeleteDBClusterCommand')['DBClusterIdentifier']).toBe(CLUSTER);
    });

    it('from a snapshot is still detached when a global cluster lists it', async () => {
      arm({ globalMemberOf: 'global-1' });
      await provider.delete('Cluster', CLUSTER, 'AWS::RDS::DBCluster', {
        ...SNAP_BASE,
        GlobalClusterIdentifier: 'global-1',
      });
      expect(sent('RemoveFromGlobalClusterCommand')).toHaveLength(1);
    });

    it('is a restore for every source key, and for no empty or missing one', () => {
      expect(isRestoredRecord({ SnapshotIdentifier: SNAPSHOT })).toBe(true);
      expect(isRestoredRecord({ SourceDbClusterResourceId: RESOURCE_ID })).toBe(true);
      expect(isRestoredRecord({ SourceDBClusterIdentifier: 'source-1' })).toBe(true);
      expect(isRestoredRecord({ SnapshotIdentifier: '', SourceDbClusterResourceId: '' })).toBe(false);
      expect(isRestoredRecord({ SnapshotIdentifier: ['x'] })).toBe(false);
      expect(isRestoredRecord(undefined)).toBe(false);
    });
  });

  describe('restore-source guard by resource id', () => {
    const guard = (type: string, attributes: Input | undefined, id: unknown) => () =>
      refuseRestoreFromItself(type, { SourceDbClusterResourceId: id }, CLUSTER, 'Cluster', {
        attributes,
      });

    it('refuses the replaced cluster\'s own recorded id, in any case', () => {
      expect(guard('AWS::RDS::DBCluster', { DBClusterResourceId: RESOURCE_ID }, RESOURCE_ID.toLowerCase())).toThrow(
        /SourceDbClusterResourceId must be another cluster's/
      );
    });

    it('leaves another id, a record without one, and another type alone', () => {
      expect(guard('AWS::RDS::DBCluster', { DBClusterResourceId: RESOURCE_ID }, 'cluster-OTHER')).not.toThrow();
      expect(guard('AWS::RDS::DBCluster', undefined, RESOURCE_ID)).not.toThrow();
      expect(guard('AWS::RDS::DBCluster', { DBClusterResourceId: '' }, '')).not.toThrow();
      expect(guard('AWS::RDS::DBCluster', { DBClusterResourceId: 5 }, '5')).not.toThrow();
      expect(guard('AWS::DocDB::DBCluster', { DBClusterResourceId: RESOURCE_ID }, RESOURCE_ID)).not.toThrow();
      expect(guard('AWS::Neptune::DBCluster', { DBClusterResourceId: RESOURCE_ID }, RESOURCE_ID)).not.toThrow();
    });
  });

  it('never reads either key back for drift', () => {
    const unknown = provider.getDriftUnknownPaths('AWS::RDS::DBCluster', { ...SNAP_BASE, ...ID_BASE });
    for (const key of KEYS) expect(unknown, key).toContain(key);
  });
});
