// go-to-k/cdkd#5640: `DBSnapshotIdentifier` / `DBClusterSnapshotIdentifier` on
// the SDK route for AWS::RDS::DBInstance (CDK's DatabaseInstanceFromSnapshot),
// following CloudFormation's RDS handler: RestoreDBInstanceFromDBSnapshot with
// the members `Translator.restoreDbInstanceFromSnapshotRequest` sends, the
// snapshot reads `CreateHandler` makes first, then the after-create
// ModifyDBInstance (`shouldUpdateAfterCreate`); an added or changed key is
// refused on update ("Resource is immutable"), a removed one changes nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation((config?: { region?: string }) => ({
      send: (command: unknown) => mockSend(command),
      destroy: vi.fn(),
      config: { region: () => Promise.resolve(config?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { findSdkUnwiredProperties } from '../../../src/provisioning/property-coverage.js';
import { refuseRestoreFromItself } from '../../../src/provisioning/restore-source-guard.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const SNAPSHOT = 'manual-snap-1';
const CLUSTER_SNAPSHOT = 'maz-cluster-snap-1';

interface Live {
  /** The DB snapshot's engine; `null` lists none. */
  snapshotEngine?: string | null;
  /** The cluster snapshot's engine; `null` lists none. */
  clusterSnapshotEngine?: string | null;
  /** What DescribeDBSnapshots throws instead of answering. */
  snapshotError?: Error;
  /** What DescribeDBClusterSnapshots throws instead of answering. */
  clusterSnapshotError?: Error;
  /** The DB snapshot lists no engine. */
  snapshotEngineMissing?: boolean;
  /** The restored instance, as the restore call answers it. */
  restored?: Input;
}

function arm(live: Live = {}): void {
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    switch (command.constructor.name) {
      case 'DescribeDBSnapshotsCommand':
        if (live.snapshotError !== undefined) return Promise.reject(live.snapshotError);
        return Promise.resolve({
          DBSnapshots:
            live.snapshotEngine === null
              ? []
              : [
                  {
                    DBSnapshotIdentifier: SNAPSHOT,
                    ...(live.snapshotEngineMissing !== true && {
                      Engine: live.snapshotEngine ?? 'postgres',
                    }),
                  },
                ],
        });
      case 'DescribeDBClusterSnapshotsCommand':
        if (live.clusterSnapshotError !== undefined) {
          return Promise.reject(live.clusterSnapshotError);
        }
        return Promise.resolve({
          DBClusterSnapshots:
            live.clusterSnapshotEngine === null
              ? []
              : [
                  {
                    DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
                    Engine: live.clusterSnapshotEngine ?? 'postgres',
                  },
                ],
        });
      case 'DescribeDBInstancesCommand':
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:db-1',
              DBInstanceStatus: 'available',
              Engine: 'postgres',
            },
          ],
        });
      case 'RestoreDBInstanceFromDBSnapshotCommand':
        return Promise.resolve({
          DBInstance: {
            DBInstanceIdentifier: 'db-1',
            Engine: live.snapshotEngine ?? live.clusterSnapshotEngine ?? 'postgres',
            MasterUsername: 'postgres',
            StorageEncrypted: false,
            ...live.restored,
          },
        });
      case 'CreateDBInstanceReadReplicaCommand':
      case 'CreateDBInstanceCommand':
        return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'db-1', Engine: 'postgres' } });
      default:
        return Promise.resolve({});
    }
  });
}

function sent(name: string): Input[] {
  return mockSend.mock.calls
    .map(([command]) => command as { constructor: { name: string }; input: Input })
    .filter((command) => command.constructor.name === name)
    .map((command) => command.input);
}

function names(): string[] {
  return mockSend.mock.calls.map(
    ([command]) => (command as { constructor: { name: string } }).constructor.name
  );
}

function warned(): string {
  return warn.mock.calls.map((call) => String(call[0])).join('\n');
}

/** What a CDK DatabaseInstanceFromSnapshot emits (no credentials). */
const FROM_SNAPSHOT: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t3.micro',
  Engine: 'postgres',
  DBSnapshotIdentifier: SNAPSHOT,
  DBSubnetGroupName: 'subnets-1',
  VPCSecurityGroups: ['sg-1'],
  StorageType: 'gp3',
  AllocatedStorage: '100',
  Port: '5433',
  PubliclyAccessible: false,
  CopyTagsToSnapshot: true,
  Tags: [{ Key: 'team', Value: 'db' }],
};

describe('RDS DBInstance snapshot restore (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  describe('create', () => {
    it('restores with RestoreDBInstanceFromDBSnapshot, carrying the declared members', async () => {
      const result = await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT });

      expect(sent('CreateDBInstanceCommand')).toEqual([]);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          DBSnapshotIdentifier: SNAPSHOT,
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          DBSubnetGroupName: 'subnets-1',
          VpcSecurityGroupIds: ['sg-1'],
          StorageType: 'gp3',
          AllocatedStorage: 100,
          // The handler's default for an undeclared MultiAZ (not SQL Server mirroring).
          MultiAZ: false,
          Port: 5433,
          PubliclyAccessible: false,
          CopyTagsToSnapshot: true,
          Tags: [{ Key: 'team', Value: 'db' }],
        },
      ]);
      // The handler reads the DB snapshot for the MultiAZ default.
      expect(sent('DescribeDBSnapshotsCommand')).toEqual([{ DBSnapshotIdentifier: SNAPSHOT }]);
      // Nothing the restore could not carry is declared: no follow-up.
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(result.physicalId).toBe('db-1');
      expect(warn).not.toHaveBeenCalled();
    });

    it("sends the snapshot's engine when the template declares none", async () => {
      arm({ snapshotEngine: 'mysql' });
      const { Engine: _engine, ...noEngine } = FROM_SNAPSHOT;
      await provider.create('L', INSTANCE, noEngine);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')[0]).toMatchObject({ Engine: 'mysql' });
    });

    it('reads no snapshot when the engine is declared and MultiAZ is true, and sends MultiAZ as declared', async () => {
      await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT, MultiAZ: true });
      expect(sent('DescribeDBSnapshotsCommand')).toEqual([]);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')[0]).toMatchObject({ MultiAZ: true });
    });

    it('sends a declared MultiAZ: false as declared (the snapshot is still read)', async () => {
      await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT, MultiAZ: false });
      expect(sent('DescribeDBSnapshotsCommand')).toHaveLength(1);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')[0]).toMatchObject({ MultiAZ: false });
    });

    it('leaves MultiAZ to RDS for a SQL Server mirroring snapshot, and sends its storage on the follow-up', async () => {
      arm({ snapshotEngine: 'sqlserver-se' });
      const { Engine: _engine, ...noEngine } = FROM_SNAPSHOT;
      await provider.create('L', INSTANCE, noEngine);
      const [restore] = sent('RestoreDBInstanceFromDBSnapshotCommand');
      expect(restore).not.toHaveProperty('MultiAZ');
      expect(restore).toMatchObject({ Engine: 'sqlserver-se' });
      for (const key of ['AllocatedStorage', 'StorageType']) {
        expect(restore).not.toHaveProperty(key);
      }
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        expect.objectContaining({
          DBInstanceIdentifier: 'db-1',
          ApplyImmediately: true,
          AllocatedStorage: 100,
          StorageType: 'gp3',
        }),
      ]);
    });

    it('leaves an Oracle CDB engine off the restore call', async () => {
      await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT, Engine: 'oracle-se2-cdb' });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')[0]).not.toHaveProperty('Engine');
    });

    it('restores from a Multi-AZ DB cluster snapshot, reading its engine when none is declared', async () => {
      arm({ clusterSnapshotEngine: 'mysql' });
      const { Engine: _engine, DBSnapshotIdentifier: _snap, ...rest } = FROM_SNAPSHOT;
      await provider.create('L', INSTANCE, {
        ...rest,
        DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
      });
      expect(sent('DescribeDBClusterSnapshotsCommand')).toEqual([
        { DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT },
      ]);
      expect(sent('DescribeDBSnapshotsCommand')).toEqual([]);
      const [restore] = sent('RestoreDBInstanceFromDBSnapshotCommand');
      expect(restore).toMatchObject({
        DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
        Engine: 'mysql',
      });
      expect(restore).not.toHaveProperty('DBSnapshotIdentifier');
      // The handler defaults MultiAZ from a DB snapshot only.
      expect(restore).not.toHaveProperty('MultiAZ');
    });

    it('reads no cluster snapshot when the engine is declared', async () => {
      const { DBSnapshotIdentifier: _snap, ...rest } = FROM_SNAPSHOT;
      await provider.create('L', INSTANCE, {
        ...rest,
        DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
      });
      expect(sent('DescribeDBClusterSnapshotsCommand')).toEqual([]);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toHaveLength(1);
    });

    it('sends both keys when both are declared, reading the DB snapshot first', async () => {
      const { Engine: _engine, ...noEngine } = FROM_SNAPSHOT;
      await provider.create('L', INSTANCE, {
        ...noEngine,
        DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
      });
      expect(sent('DescribeDBClusterSnapshotsCommand')).toEqual([]);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')[0]).toMatchObject({
        DBSnapshotIdentifier: SNAPSHOT,
        DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
      });
    });

    it.each([
      ['a DB snapshot it does not list', { snapshotEngine: null }, FROM_SNAPSHOT, /DBSnapshotIdentifier manual-snap-1 does not name a DB snapshot/],
      [
        'a DB snapshot RDS reports not found',
        {
          snapshotError: Object.assign(new Error('DBSnapshot not found'), {
            name: 'DBSnapshotNotFoundFault',
          }),
        },
        FROM_SNAPSHOT,
        /does not name a DB snapshot this account can read/,
      ],
      [
        'a cluster snapshot it does not list',
        { clusterSnapshotEngine: null },
        (() => {
          const { Engine: _e, DBSnapshotIdentifier: _s, ...rest } = FROM_SNAPSHOT;
          return { ...rest, DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT };
        })(),
        /DBClusterSnapshotIdentifier maz-cluster-snap-1 does not name a Multi-AZ DB cluster snapshot/,
      ],
    ] as const)('refuses %s before anything is made', async (_name, live, bag, says) => {
      arm(live as Live);
      const error = await provider.create('L', INSTANCE, { ...bag }).catch((e: unknown) => e);
      expect(String(error)).toMatch(says);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
    });

    it('fails the create on any other snapshot read failure, before anything is made', async () => {
      arm({
        snapshotError: Object.assign(new Error('not authorized'), { name: 'AccessDenied' }),
      });
      await expect(provider.create('L', INSTANCE, { ...FROM_SNAPSHOT })).rejects.toThrow(
        /reading the restore snapshot failed, so nothing was changed/
      );
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
    });

    it('sends the members the restore cannot carry in one ModifyDBInstance once available, under --no-wait too', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        MasterUserPassword: 'password-1',
        BackupRetentionPeriod: '3',
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        DeletionProtection: true,
      });
      const [restore] = sent('RestoreDBInstanceFromDBSnapshotCommand');
      for (const key of ['MasterUserPassword', 'BackupRetentionPeriod', 'PreferredBackupWindow']) {
        expect(restore).not.toHaveProperty(key);
      }
      expect(restore).toMatchObject({ DeletionProtection: true });
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          ApplyImmediately: true,
          MasterUserPassword: 'password-1',
          BackupRetentionPeriod: 3,
          PreferredBackupWindow: '03:00-04:00',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          DeletionProtection: true,
        },
      ]);
      // The follow-up waited for `available` first.
      const order = names();
      expect(order.indexOf('DescribeDBInstancesCommand')).toBeLessThan(
        order.indexOf('ModifyDBInstanceCommand')
      );
    });

    it('warns about the declared keys the snapshot decides instead', async () => {
      arm({ restored: { MasterUsername: 'postgres', StorageEncrypted: false } });
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        KmsKeyId: 'alias/aws/rds',
        Timezone: 'UTC',
        MasterUsername: 'admin',
        StorageEncrypted: true,
      });
      const [restore] = sent('RestoreDBInstanceFromDBSnapshotCommand');
      for (const key of ['KmsKeyId', 'Timezone', 'MasterUsername', 'StorageEncrypted']) {
        expect(restore).not.toHaveProperty(key);
      }
      expect(warned()).toMatch(
        /KmsKeyId, Timezone, MasterUsername, StorageEncrypted not applied: a restore from a snapshot takes them from the snapshot/
      );
    });

    it('does not warn about a master user or encryption the restored instance holds', async () => {
      arm({ restored: { MasterUsername: 'admin', StorageEncrypted: true } });
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        MasterUsername: 'admin',
        StorageEncrypted: 'true',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('makes a read replica when a source is declared too, warning that the snapshot is not applied', async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        SourceDBInstanceIdentifier: 'source-1',
      });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
      expect(warned()).toMatch(
        /DBSnapshotIdentifier not applied: SourceDBInstanceIdentifier makes the instance a read replica/
      );
    });

    it('creates a plain instance for an empty snapshot key', async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        DBSnapshotIdentifier: '',
        MasterUsername: 'admin',
      });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
      expect(sent('CreateDBInstanceCommand')).toHaveLength(1);
    });

    it.each(['DBSnapshotIdentifier', 'DBClusterSnapshotIdentifier'])(
      'refuses a %s that is not a string before any call',
      async (key) => {
        const error = await provider
          .create('L', INSTANCE, { ...FROM_SNAPSHOT, [key]: { Ref: 'Snap' } })
          .catch((e: unknown) => e);
        expect(String(error)).toMatch(new RegExp(`${key} must be a string`));
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it.each([
      'rds:db-1-2026-11-01-03-04',
      'arn:aws:rds:us-east-1:123456789012:snapshot:rds:DB-1-2026-11-01-03-04',
    ])('refuses its own automated snapshot %s before any call', async (snapshot) => {
      const error = await provider
        .create('L', INSTANCE, { ...FROM_SNAPSHOT, DBSnapshotIdentifier: snapshot })
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(
        /DBSnapshotIdentifier names an automated snapshot of the DB instance this creates or replaces/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("restores from another instance's automated snapshot", async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        DBSnapshotIdentifier: 'rds:db-2-2026-11-01-03-04',
      });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toHaveLength(1);
    });

    it('carries every declared member CloudFormation sends on the restore call, and the rest on the follow-up', async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_SNAPSHOT,
        StorageType: 'io1',
        Iops: 3000,
        StorageThroughput: 125,
        AutoMinorVersionUpgrade: false,
        AvailabilityZone: 'us-east-1a',
        DBName: 'ORCL',
        DBParameterGroupName: 'params-1',
        DedicatedLogVolume: false,
        EnableCloudwatchLogsExports: ['postgresql'],
        EnableIAMDatabaseAuthentication: true,
        LicenseModel: 'postgresql-license',
        NetworkType: 'IPV4',
        OptionGroupName: 'options-1',
        ProcessorFeatures: [{ Name: 'coreCount', Value: '2' }],
        UseDefaultProcessorFeatures: false,
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        DeletionProtection: false,
        MultiAZ: false,
      });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          DBSnapshotIdentifier: SNAPSHOT,
          AutoMinorVersionUpgrade: false,
          AvailabilityZone: 'us-east-1a',
          CopyTagsToSnapshot: true,
          DBInstanceClass: 'db.t3.micro',
          DBName: 'ORCL',
          DBParameterGroupName: 'params-1',
          DBSubnetGroupName: 'subnets-1',
          DeletionProtection: false,
          DedicatedLogVolume: false,
          EnableCloudwatchLogsExports: ['postgresql'],
          EnableIAMDatabaseAuthentication: true,
          Engine: 'postgres',
          LicenseModel: 'postgresql-license',
          MultiAZ: false,
          NetworkType: 'IPV4',
          OptionGroupName: 'options-1',
          Port: 5433,
          ProcessorFeatures: [{ Name: 'coreCount', Value: '2' }],
          UseDefaultProcessorFeatures: false,
          PubliclyAccessible: false,
          VpcSecurityGroupIds: ['sg-1'],
          EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
          AllocatedStorage: 100,
          Iops: 3000,
          StorageThroughput: 125,
          StorageType: 'io1',
          Tags: [{ Key: 'team', Value: 'db' }],
        },
      ]);
      // The declared parameter group rides the follow-up too, as the handler sends it.
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        expect.objectContaining({ DBParameterGroupName: 'params-1', ApplyImmediately: true }),
      ]);
    });

    it('treats a snapshot that lists no engine as SQL Server for the storage members, as the handler does', async () => {
      arm({ snapshotEngineMissing: true });
      const { Engine: _engine, ...noEngine } = FROM_SNAPSHOT;
      await provider.create('L', INSTANCE, noEngine);
      const [restore] = sent('RestoreDBInstanceFromDBSnapshotCommand');
      expect(restore).not.toHaveProperty('Engine');
      expect(restore).not.toHaveProperty('AllocatedStorage');
      expect(restore).not.toHaveProperty('StorageType');
    });

    it('refuses a cluster snapshot RDS reports not found', async () => {
      arm({
        clusterSnapshotError: Object.assign(new Error('not found'), {
          name: 'DBClusterSnapshotNotFoundFault',
        }),
      });
      const { Engine: _e, DBSnapshotIdentifier: _s, ...rest } = FROM_SNAPSHOT;
      const error = await provider
        .create('L', INSTANCE, { ...rest, DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT })
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/does not name a Multi-AZ DB cluster snapshot/);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
    });

    it('fails the create, retryably, on any other cluster snapshot read failure', async () => {
      arm({
        clusterSnapshotError: Object.assign(new Error('not authorized'), { name: 'AccessDenied' }),
      });
      const { Engine: _e, DBSnapshotIdentifier: _s, ...rest } = FROM_SNAPSHOT;
      const error = await provider
        .create('L', INSTANCE, { ...rest, DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT })
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/reading the restore cluster snapshot failed/);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
    });

    it("masks a secret in AWS's text when a snapshot read fails", async () => {
      arm({
        snapshotError: Object.assign(new Error('denied for secret-name-1'), {
          name: 'AccessDenied',
        }),
      });
      const error = await provider
        .create(
          'L',
          INSTANCE,
          { ...FROM_SNAPSHOT },
          { maskSecrets: (t: string) => t.replaceAll('secret-name-1', '***') }
        )
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/reading the restore snapshot failed/);
      expect(String(error)).not.toContain('secret-name-1');
    });

    it('does not warn about a master user the restore answer does not name', async () => {
      arm({ restored: { MasterUsername: undefined } });
      await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT, MasterUsername: 'admin' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn about an empty AdditionalStorageVolumes list', async () => {
      await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT, AdditionalStorageVolumes: [] });
      expect(warn).not.toHaveBeenCalled();
    });

    it('makes a read replica over its own automated snapshot or a malformed key, only warning', async () => {
      for (const snapshot of ['rds:db-1-2026-11-01-03-04', { Ref: 'Snap' }]) {
        mockSend.mockClear();
        warn.mockReset();
        await provider.create('L', INSTANCE, {
          ...FROM_SNAPSHOT,
          DBSnapshotIdentifier: snapshot,
          SourceDBInstanceIdentifier: 'source-1',
        });
        expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
        expect(warned()).toMatch(/DBSnapshotIdentifier not applied/);
      }
    });

    it('restores the same way on a rollback replay', async () => {
      await provider.create('L', INSTANCE, { ...FROM_SNAPSHOT }, { replayingState: true });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toHaveLength(1);
      expect(sent('CreateDBInstanceCommand')).toEqual([]);
    });
  });

  describe('restore-source guard (the delete-first replacement paths)', () => {
    it('refuses the replaced instance\'s own automated snapshot, by name or same-scope ARN', () => {
      for (const snapshot of [
        'rds:db-1-2026-11-01-03-04',
        'arn:aws:rds:us-east-1:123456789012:snapshot:rds:db-1-2026-11-01-03-04',
      ]) {
        expect(() =>
          refuseRestoreFromItself(INSTANCE, { DBSnapshotIdentifier: snapshot }, 'db-1', 'L', {
            region: 'us-east-1',
            account: '123456789012',
          })
        ).toThrow(/automated snapshot of the DB instance/);
      }
    });

    it.each([
      ['a manual snapshot', 'manual-snap-1'],
      ["another instance's automated snapshot", 'rds:db-2-2026-11-01-03-04'],
      [
        'a same-named automated snapshot in another region',
        'arn:aws:rds:us-west-2:123456789012:snapshot:rds:db-1-2026-11-01-03-04',
      ],
    ])('lets %s through', (_name, snapshot) => {
      expect(() =>
        refuseRestoreFromItself(INSTANCE, { DBSnapshotIdentifier: snapshot }, 'db-1', 'L', {
          region: 'us-east-1',
          account: '123456789012',
        })
      ).not.toThrow();
    });

    it('lets a read replica name its own automated snapshot, which it never reads', () => {
      expect(() =>
        refuseRestoreFromItself(
          INSTANCE,
          { DBSnapshotIdentifier: 'rds:db-1-2026-11-01-03-04', SourceDBInstanceIdentifier: 'src-1' },
          'db-1',
          'L',
          {}
        )
      ).not.toThrow();
    });

    it('reads no cluster key for a DB instance', () => {
      expect(() =>
        refuseRestoreFromItself(
          INSTANCE,
          { SnapshotIdentifier: 'rds:db-1-2026-11-01-03-04', SourceDBClusterIdentifier: 'db-1' },
          'db-1',
          'L',
          {}
        )
      ).not.toThrow();
    });
  });

  describe('update', () => {
    const update = (next: Input, prev: Input, context?: Parameters<RDSProvider['update']>[5]) =>
      provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

    it.each([
      ['added', { DBSnapshotIdentifier: undefined }, { DBSnapshotIdentifier: SNAPSHOT }],
      ['changed', { DBSnapshotIdentifier: 'snap-0' }, { DBSnapshotIdentifier: SNAPSHOT }],
      [
        'a cluster snapshot added',
        {},
        { DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT },
      ],
    ])('refuses a snapshot %s before any call', async (_name, prev, next) => {
      const base = { ...FROM_SNAPSHOT, DBSnapshotIdentifier: undefined };
      const error = await update({ ...base, ...next }, { ...base, ...prev }).catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(String((error as Error).message)).toMatch(
        /cannot be added or changed on an existing DB instance/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['removed', undefined],
      ['emptied', ''],
    ])('changes nothing for a %s snapshot and sends none on the modify', async (_name, value) => {
      await update(
        { ...FROM_SNAPSHOT, DBSnapshotIdentifier: value, BackupRetentionPeriod: '5' },
        { ...FROM_SNAPSHOT }
      );
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      for (const modify of sent('ModifyDBInstanceCommand')) {
        expect(modify).not.toHaveProperty('DBSnapshotIdentifier');
        expect(modify).not.toHaveProperty('DBClusterSnapshotIdentifier');
      }
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
    });

    it.each(["{{resolve:ssm-secure:snap}}", '***'])(
      "takes the deploy's own change set over a recorded stand-in (%s)",
      async (recorded) => {
        const changedProperties = new Set(['BackupRetentionPeriod']);
        await update(
          { ...FROM_SNAPSHOT, BackupRetentionPeriod: '5' },
          { ...FROM_SNAPSHOT, DBSnapshotIdentifier: recorded },
          { changedProperties }
        );
        expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      }
    );

    it('refuses a snapshot the change set names', async () => {
      const error = await update(FROM_SNAPSHOT, { ...FROM_SNAPSHOT, DBSnapshotIdentifier: 'snap-0' }, {
        changedProperties: new Set(['DBSnapshotIdentifier']),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('masks the physical id in the refusal', async () => {
      const error = await update(
        FROM_SNAPSHOT,
        { ...FROM_SNAPSHOT, DBSnapshotIdentifier: 'snap-0' },
        { maskSecrets: (t: string) => t.replaceAll('db-1', '***') }
      ).catch((e: unknown) => e);
      const message = String((error as Error).message);
      expect(message).toMatch(/Nothing was applied to DB instance \*\*\*/);
      expect(message).not.toContain('db-1');
    });

    it('names the deletion-protection step for a protected instance', async () => {
      const error = await update(FROM_SNAPSHOT, {
        ...FROM_SNAPSHOT,
        DBSnapshotIdentifier: 'snap-0',
        DeletionProtection: true,
      }).catch((e: unknown) => e);
      expect(String((error as Error).message)).toMatch(/--no-deletion-protection/);
    });

    it('updates in place under an unchanged snapshot', async () => {
      const result = await update({ ...FROM_SNAPSHOT, BackupRetentionPeriod: '5' }, FROM_SNAPSHOT);
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        expect.objectContaining({ BackupRetentionPeriod: 5 }),
      ]);
      expect(result.effectiveProperties).toBeUndefined();
    });

    it.each([
      ['a rollback replay', { replayingState: true }],
      ['a drift --revert', { desiredFromAwsReadback: true }],
    ] as const)('lets %s restore the record it was created from', async (_name, context) => {
      const result = await update(
        { ...FROM_SNAPSHOT },
        { ...FROM_SNAPSHOT, DBSnapshotIdentifier: undefined },
        context
      );
      expect(result.effectiveProperties).toBeUndefined();
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
    });
  });

  it('routes a snapshot restore through the SDK provider and never reads either key back', () => {
    expect(
      findSdkUnwiredProperties(INSTANCE, {
        ...FROM_SNAPSHOT,
        DBClusterSnapshotIdentifier: CLUSTER_SNAPSHOT,
      })
    ).toEqual([]);
    const unknown = new RDSProvider().getDriftUnknownPaths(INSTANCE, { ...FROM_SNAPSHOT });
    expect(unknown).toEqual(
      expect.arrayContaining(['DBSnapshotIdentifier', 'DBClusterSnapshotIdentifier'])
    );
  });
});
