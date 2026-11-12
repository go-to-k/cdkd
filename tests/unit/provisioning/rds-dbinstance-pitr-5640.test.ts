// go-to-k/cdkd#5640: `RestoreTime`, `UseLatestRestorableTime`,
// `SourceDBInstanceAutomatedBackupsArn` and `SourceDbiResourceId` on the SDK
// route for AWS::RDS::DBInstance, following CloudFormation's RDS handler:
// RestoreDBInstanceToPointInTime with the members
// `Translator.restoreDbInstanceToPointInTimeRequest` sends, tested before a
// read replica and a snapshot restore, the engine read `fetchEngine` makes
// first, then the after-create ModifyDBInstance (`shouldUpdateAfterCreate`);
// an added or changed key is refused on update ("Resource is immutable"), a
// removed one changes nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation((config?: { region?: string }) => ({
      send: (command: unknown) => mockSend(command, config?.region ?? 'us-east-1'),
      destroy: vi.fn(),
      config: { region: () => Promise.resolve(config?.region ?? 'us-east-1') },
    })),
  };
});

// What the engine's per-resource deadline leaves; Infinity outside a deploy.
const remainingMs = vi.hoisted(() => ({ value: Number.POSITIVE_INFINITY }));
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => remainingMs.value,
}));

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
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { hasCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { declaresPointInTimeRestore } from '../../../src/provisioning/providers/rds/instance-pitr.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const SOURCE = 'source-db';
const DBI = 'db-SOURCEID1';
const BACKUPS = 'arn:aws:rds:us-east-1:123456789012:auto-backup:ab-sourceid1';

interface Live {
  /** The source instance's engine; `null` lists none. */
  sourceEngine?: string | null;
  /** What DescribeDBInstances throws for the source instead of answering. */
  sourceError?: Error;
  /** The automated backup's engine; `null` lists none, `undefined` names none. */
  backupEngine?: string | null | undefined;
  /** The backup lists no engine at all. */
  backupEngineMissing?: boolean;
  /** The instance the backup belongs to (`DbiResourceId`). */
  backupOwner?: string;
  backupError?: Error;
  /** What the follow-up ModifyDBInstance throws. */
  modifyError?: Error;
  /** What the restore call throws. */
  restoreError?: Error;
  /** The restored instance, as the restore call answers it. */
  restored?: Input;
}

function arm(live: Live = {}): void {
  mockSend.mockImplementation(
    (command: { constructor: { name: string }; input: Input }, region: string) => {
      switch (command.constructor.name) {
        case 'DescribeDBInstancesCommand': {
          const input = command.input;
          const bySource =
            input['Filters'] !== undefined ||
            (input['DBInstanceIdentifier'] as string | undefined)?.endsWith(SOURCE) === true;
          if (bySource) {
            if (live.sourceError !== undefined) return Promise.reject(live.sourceError);
            return Promise.resolve({
              DBInstances:
                live.sourceEngine === null
                  ? []
                  : [{ DBInstanceIdentifier: SOURCE, Engine: live.sourceEngine ?? 'postgres', region }],
            });
          }
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
        }
        case 'DescribeDBInstanceAutomatedBackupsCommand':
          if (live.backupError !== undefined) return Promise.reject(live.backupError);
          return Promise.resolve({
            DBInstanceAutomatedBackups:
              live.backupEngine === null
                ? []
                : [
                    {
                      ...(live.backupEngineMissing !== true && {
                        Engine: live.backupEngine ?? 'mysql',
                      }),
                      ...(live.backupOwner !== undefined && { DbiResourceId: live.backupOwner }),
                    },
                  ],
          });
        case 'RestoreDBInstanceToPointInTimeCommand':
          if (live.restoreError !== undefined) return Promise.reject(live.restoreError);
          return Promise.resolve({
            DBInstance: {
              DBInstanceIdentifier: 'db-1',
              DbiResourceId: 'db-NEW1',
              Engine: 'postgres',
              MasterUsername: 'postgres',
              StorageEncrypted: false,
              ...live.restored,
            },
          });
        case 'ModifyDBInstanceCommand':
          if (live.modifyError !== undefined) return Promise.reject(live.modifyError);
          return Promise.resolve({});
        case 'CreateDBInstanceReadReplicaCommand':
        case 'CreateDBInstanceCommand':
        case 'RestoreDBInstanceFromDBSnapshotCommand':
          return Promise.resolve({ DBInstance: { DBInstanceIdentifier: 'db-1', Engine: 'postgres' } });
        default:
          return Promise.resolve({});
      }
    }
  );
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

/** What a CDK `DatabaseInstance` restored to the latest restorable time emits. */
const FROM_LATEST: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t3.micro',
  Engine: 'postgres',
  SourceDBInstanceIdentifier: SOURCE,
  UseLatestRestorableTime: true,
  DBSubnetGroupName: 'subnets-1',
  VPCSecurityGroups: ['sg-1'],
  StorageType: 'gp3',
  AllocatedStorage: '100',
  Port: '5433',
  PubliclyAccessible: false,
  CopyTagsToSnapshot: true,
  Tags: [{ Key: 'team', Value: 'db' }],
};

describe('RDS DBInstance point-in-time restore (go-to-k/cdkd#5640)', () => {
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
    it('restores with RestoreDBInstanceToPointInTime, carrying the declared members', async () => {
      const result = await provider.create('L', INSTANCE, { ...FROM_LATEST });

      expect(sent('CreateDBInstanceCommand')).toEqual([]);
      // The handler tests the point-in-time keys first: a source is then the restore's.
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toEqual([
        {
          TargetDBInstanceIdentifier: 'db-1',
          SourceDBInstanceIdentifier: SOURCE,
          UseLatestRestorableTime: true,
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          DBSubnetGroupName: 'subnets-1',
          VpcSecurityGroupIds: ['sg-1'],
          StorageType: 'gp3',
          AllocatedStorage: 100,
          Port: 5433,
          PubliclyAccessible: false,
          CopyTagsToSnapshot: true,
          Tags: [{ Key: 'team', Value: 'db' }],
        },
      ]);
      // A declared engine reads nothing; MultiAZ is not defaulted.
      expect(names().filter((n) => n.startsWith('Describe') && n !== 'DescribeDBInstancesCommand')).toEqual([]);
      expect(sent('DescribeDBInstancesCommand').every((i) => i['DBInstanceIdentifier'] === 'db-1')).toBe(true);
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(result.physicalId).toBe('db-1');
      expect(warn).not.toHaveBeenCalled();
    });

    it('carries every declared member CloudFormation sends on the restore call', async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        AutoMinorVersionUpgrade: false,
        AvailabilityZone: 'us-east-1a',
        DBName: 'appdb',
        DBParameterGroupName: 'pg-1',
        DedicatedLogVolume: false,
        DeletionProtection: false,
        EnableCloudwatchLogsExports: ['postgresql'],
        EnableIAMDatabaseAuthentication: true,
        LicenseModel: 'postgresql-license',
        MaxAllocatedStorage: 200,
        MultiAZ: false,
        NetworkType: 'IPV4',
        OptionGroupName: 'og-1',
        ProcessorFeatures: [{ Name: 'coreCount', Value: '2' }],
        UseDefaultProcessorFeatures: false,
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        Iops: 3000,
        StorageThroughput: 125,
      });
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore).toMatchObject({
        AutoMinorVersionUpgrade: false,
        AvailabilityZone: 'us-east-1a',
        DBName: 'appdb',
        DBParameterGroupName: 'pg-1',
        DedicatedLogVolume: false,
        DeletionProtection: false,
        EnableCloudwatchLogsExports: ['postgresql'],
        EnableIAMDatabaseAuthentication: true,
        LicenseModel: 'postgresql-license',
        MaxAllocatedStorage: 200,
        MultiAZ: false,
        NetworkType: 'IPV4',
        OptionGroupName: 'og-1',
        ProcessorFeatures: [{ Name: 'coreCount', Value: '2' }],
        UseDefaultProcessorFeatures: false,
        EngineLifecycleSupport: 'open-source-rds-extended-support-disabled',
        Iops: 3000,
        StorageThroughput: 125,
      });
      // The parameter group asks for the follow-up and its reboot check.
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        expect.objectContaining({ DBParameterGroupName: 'pg-1', ApplyImmediately: true }),
      ]);
    });

    it('sends a RestoreTime as the instant it names, beside UseLatestRestorableTime as the handler does', async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        RestoreTime: '2026-11-01T09:30:00+09:00',
      });
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore!['RestoreTime']).toEqual(new Date('2026-11-01T00:30:00Z'));
      expect(restore!['UseLatestRestorableTime']).toBe(true);
    });

    it.each([
      ['a RestoreTime', { RestoreTime: '2026-11-01T00:00:00Z', UseLatestRestorableTime: undefined }],
      ['a SourceDbiResourceId', { SourceDbiResourceId: DBI, UseLatestRestorableTime: undefined }],
      [
        'a SourceDBInstanceAutomatedBackupsArn',
        { SourceDBInstanceAutomatedBackupsArn: BACKUPS, UseLatestRestorableTime: undefined },
      ],
      ["a 'true' UseLatestRestorableTime", { UseLatestRestorableTime: 'true' }],
    ])('restores to a point in time for %s alone', async (_name, extra) => {
      await provider.create('L', INSTANCE, { ...FROM_LATEST, ...extra });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toHaveLength(1);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
    });

    it.each([
      ['false', false],
      ["'false'", 'false'],
      ['undeclared', undefined],
    ])('makes a read replica for UseLatestRestorableTime %s with no other key (empty ones)', async (_n, latest) => {
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        UseLatestRestorableTime: latest,
        RestoreTime: '',
        SourceDbiResourceId: '',
      });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toEqual([]);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
    });

    it('restores to a point in time, with no time, for a blank RestoreTime, as the handler does', async () => {
      // `hasValue` makes it a point-in-time restore; `isNotBlank` keeps the
      // time off the call and out of the timestamp validation.
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        UseLatestRestorableTime: undefined,
        RestoreTime: '  ',
      });
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore).toMatchObject({ SourceDBInstanceIdentifier: SOURCE });
      expect(restore).not.toHaveProperty('RestoreTime');
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
    });

    it('makes a plain instance for UseLatestRestorableTime: false and no source', async () => {
      const { SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      await provider.create('L', INSTANCE, { ...rest, UseLatestRestorableTime: false });
      expect(sent('CreateDBInstanceCommand')).toHaveLength(1);
      expect(sent('CreateDBInstanceCommand')[0]).not.toHaveProperty('UseLatestRestorableTime');
    });

    it.each([
      ['a RestoreTime with no zone', { RestoreTime: '2026-11-01T00:00:00' }, /RestoreTime must be an ISO 8601 timestamp/],
      ['a RestoreTime that is no date', { RestoreTime: '2026-02-30T00:00:00Z' }, /RestoreTime must be/],
      ['a RestoreTime that is no string', { RestoreTime: { Ref: 'T' } }, /RestoreTime must be/],
      ['a malformed UseLatestRestorableTime', { UseLatestRestorableTime: 'yes' }, /UseLatestRestorableTime must be true or false/],
      ['a malformed SourceDbiResourceId', { SourceDbiResourceId: ['db-1'] }, /SourceDbiResourceId must be a string/],
      [
        'a malformed SourceDBInstanceAutomatedBackupsArn',
        { SourceDBInstanceAutomatedBackupsArn: 1 },
        /SourceDBInstanceAutomatedBackupsArn must be a string/,
      ],
    ])('refuses %s before any call, on a replay too', async (_name, extra, message) => {
      for (const context of [undefined, { replayingState: true }]) {
        mockSend.mockClear();
        const error = await provider
          .create('L', INSTANCE, { ...FROM_LATEST, ...extra }, context)
          .catch((e: unknown) => e);
        expect(String(error)).toMatch(message);
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
      }
    });

    it("reads the source instance's engine when the template declares none", async () => {
      arm({ sourceEngine: 'mysql' });
      const { Engine: _e, ...noEngine } = FROM_LATEST;
      await provider.create('L', INSTANCE, noEngine);
      expect(sent('DescribeDBInstancesCommand')[0]).toEqual({ DBInstanceIdentifier: SOURCE });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).toMatchObject({ Engine: 'mysql' });
    });

    it("reads a cross-region source ARN's engine in its own region", async () => {
      arm({ sourceEngine: 'mysql' });
      const { Engine: _e, ...noEngine } = FROM_LATEST;
      const source = `arn:aws:rds:eu-west-1:123456789012:db:${SOURCE}`;
      await provider.create('L', INSTANCE, { ...noEngine, SourceDBInstanceIdentifier: source });
      const read = mockSend.mock.calls.find(
        ([command]) =>
          (command as { input: Input }).input['DBInstanceIdentifier'] === source
      );
      expect(read?.[1]).toBe('eu-west-1');
      expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).toMatchObject({
        SourceDBInstanceIdentifier: source,
        Engine: 'mysql',
      });
    });

    it("reads the engine of the instance a SourceDbiResourceId names", async () => {
      arm({ sourceEngine: 'mariadb' });
      const { Engine: _e, SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      await provider.create('L', INSTANCE, { ...rest, SourceDbiResourceId: DBI });
      expect(sent('DescribeDBInstancesCommand')[0]).toEqual({
        Filters: [{ Name: 'dbi-resource-id', Values: [DBI] }],
      });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).toMatchObject({
        SourceDbiResourceId: DBI,
        Engine: 'mariadb',
      });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).not.toHaveProperty(
        'SourceDBInstanceIdentifier'
      );
    });

    it("reads the automated backup's engine for a SourceDBInstanceAutomatedBackupsArn", async () => {
      const { Engine: _e, SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      await provider.create('L', INSTANCE, { ...rest, SourceDBInstanceAutomatedBackupsArn: BACKUPS });
      expect(sent('DescribeDBInstanceAutomatedBackupsCommand')).toEqual([
        { DBInstanceAutomatedBackupsArn: BACKUPS },
      ]);
      expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).toMatchObject({
        SourceDBInstanceAutomatedBackupsArn: BACKUPS,
        Engine: 'mysql',
      });
    });

    it('prefers the source instance, then the resource id, as the handler reads them', async () => {
      const { Engine: _e, ...noEngine } = FROM_LATEST;
      await provider.create('L', INSTANCE, {
        ...noEngine,
        SourceDbiResourceId: DBI,
        SourceDBInstanceAutomatedBackupsArn: BACKUPS,
      });
      expect(sent('DescribeDBInstancesCommand')[0]).toEqual({ DBInstanceIdentifier: SOURCE });
      expect(sent('DescribeDBInstanceAutomatedBackupsCommand')).toEqual([]);
    });

    it.each([
      [
        'a source instance',
        { sourceEngine: null },
        {},
        /SourceDBInstanceIdentifier source-db does not name a DB instance this account can read/,
      ],
      [
        'a source instance (not-found fault)',
        { sourceError: Object.assign(new Error('gone'), { name: 'DBInstanceNotFoundFault' }) },
        {},
        /SourceDBInstanceIdentifier source-db does not name a DB instance/,
      ],
      [
        'a resource id',
        { sourceEngine: null },
        { SourceDBInstanceIdentifier: undefined, SourceDbiResourceId: DBI },
        /SourceDbiResourceId db-SOURCEID1 names no live DB instance this account can read, so cdkd cannot read the engine to restore; declare Engine/,
      ],
      [
        'an automated backup',
        { backupError: Object.assign(new Error('gone'), { name: 'DBInstanceAutomatedBackupNotFoundFault' }) },
        { SourceDBInstanceIdentifier: undefined, SourceDBInstanceAutomatedBackupsArn: BACKUPS },
        /SourceDBInstanceAutomatedBackupsArn .* does not name an automated backup/,
      ],
      [
        'an automated backup (empty list)',
        { backupEngine: null },
        { SourceDBInstanceIdentifier: undefined, SourceDBInstanceAutomatedBackupsArn: BACKUPS },
        /does not name an automated backup/,
      ],
    ] as const)('refuses %s the read does not find, before anything is made', async (_n, live, extra, message) => {
      arm(live);
      const { Engine: _e, ...noEngine } = FROM_LATEST;
      const error = await provider
        .create('L', INSTANCE, { ...noEngine, ...extra })
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(message);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toEqual([]);
      expect(hasCreatedBeforeFailure(error)).toBe(false);
    });

    it('fails the create, retryably, on any other read failure, before anything is made', async () => {
      arm({ sourceError: Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }) });
      const { Engine: _e, ...noEngine } = FROM_LATEST;
      const error = await provider.create('L', INSTANCE, noEngine).catch((e: unknown) => e);
      expect(String(error)).toMatch(/reading the restore source failed, so nothing was changed/);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toEqual([]);
      expect(hasCreatedBeforeFailure(error)).toBe(false);
    });

    it("masks a secret in AWS's text when the read fails, and a secret-derived source in the refusal", async () => {
      const mask = (t: string) => t.replaceAll('secret-1', '***');
      arm({ backupError: Object.assign(new Error('denied for secret-1'), { name: 'AccessDenied' }) });
      const { Engine: _e, SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      const failed = await provider
        .create('L', INSTANCE, { ...rest, SourceDBInstanceAutomatedBackupsArn: BACKUPS }, { maskSecrets: mask })
        .catch((e: unknown) => e);
      expect(String(failed)).toMatch(/reading the restore automated backup failed/);
      expect(String(failed)).not.toContain('secret-1');
      arm({ sourceEngine: null });
      const refused = await provider
        .create('L', INSTANCE, { ...rest, SourceDbiResourceId: 'secret-1' }, { maskSecrets: mask })
        .catch((e: unknown) => e);
      expect(String(refused)).toMatch(/SourceDbiResourceId \*\*\* names no live DB instance/);
      expect(String(refused)).not.toContain('secret-1');
    });

    it('refuses a create naming neither an engine nor a source, before any call', async () => {
      const { Engine: _e, SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      const error = await provider.create('L', INSTANCE, rest).catch((e: unknown) => e);
      expect(String(error)).toMatch(/cannot read its engine; declare Engine or a source/);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(names().filter((n) => n !== 'DescribeDBInstancesCommand')).toEqual([]);
    });

    it('sends a declared engine with no source as declared, leaving the refusal to RDS', async () => {
      const { SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      await provider.create('L', INSTANCE, rest);
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore).toMatchObject({ Engine: 'postgres', UseLatestRestorableTime: true });
      expect(restore).not.toHaveProperty('SourceDBInstanceIdentifier');
    });

    it('leaves an Oracle CDB engine to the follow-up, and SQL Server storage too', async () => {
      for (const engine of ['oracle-se2-cdb', 'oracle-ee-cdb']) {
        mockSend.mockClear();
        await provider.create('L', INSTANCE, { ...FROM_LATEST, Engine: engine });
        expect(sent('RestoreDBInstanceToPointInTimeCommand')[0], engine).not.toHaveProperty('Engine');
      }
      mockSend.mockClear();
      arm({ sourceEngine: 'sqlserver-ex' });
      const { Engine: _e, ...noEngine } = FROM_LATEST;
      await provider.create('L', INSTANCE, noEngine);
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore).toMatchObject({ Engine: 'sqlserver-ex' });
      for (const key of ['AllocatedStorage', 'StorageType']) expect(restore).not.toHaveProperty(key);
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        expect.objectContaining({ AllocatedStorage: 100, StorageType: 'gp3', ApplyImmediately: true }),
      ]);
    });

    it('treats a source that lists no engine as SQL Server for the storage members, as the handler does', async () => {
      arm({ backupEngineMissing: true });
      const { Engine: _e, SourceDBInstanceIdentifier: _s, ...rest } = FROM_LATEST;
      await provider.create('L', INSTANCE, { ...rest, SourceDBInstanceAutomatedBackupsArn: BACKUPS });
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore).not.toHaveProperty('Engine');
      for (const key of ['AllocatedStorage', 'StorageType']) expect(restore).not.toHaveProperty(key);
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        expect.objectContaining({ AllocatedStorage: 100, StorageType: 'gp3' }),
      ]);
    });

    it('sends the members the restore cannot carry in one ModifyDBInstance once available, under --no-wait too', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      const wait = vi.spyOn(provider, 'waitForInstanceAvailable');
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        BackupRetentionPeriod: '3',
        PreferredBackupWindow: '03:00-04:00',
        MaxAllocatedStorage: 200,
      });
      const [modify] = sent('ModifyDBInstanceCommand');
      expect(modify).toMatchObject({
        DBInstanceIdentifier: 'db-1',
        ApplyImmediately: true,
        BackupRetentionPeriod: 3,
        PreferredBackupWindow: '03:00-04:00',
      });
      for (const key of ['BackupRetentionPeriod', 'PreferredBackupWindow']) {
        expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).not.toHaveProperty(key);
      }
      // The wait runs before the follow-up, with the restore's budget.
      expect(wait).toHaveBeenCalledWith('L', 'db-1', 1_800_000, 'being restored');
      const order = names();
      expect(order.indexOf('ModifyDBInstanceCommand')).toBeGreaterThan(
        order.indexOf('RestoreDBInstanceToPointInTimeCommand')
      );
    });

    it.each([
      ['a restore', FROM_LATEST, 3 * 3_600_000 - 30_000, 'being restored'],
      ['a plain create', { ...FROM_LATEST, SourceDBInstanceIdentifier: undefined, UseLatestRestorableTime: undefined }, undefined, undefined],
    ] as const)(
      'waits, for %s, to the resource deadline the --resource-timeout allows',
      async (_n, props, budget, doing) => {
        remainingMs.value = 3 * 3_600_000;
        try {
          const wait = vi.spyOn(provider, 'waitForInstanceAvailable');
          await provider.create('L', INSTANCE, { ...props });
          expect(wait).toHaveBeenCalledWith('L', 'db-1', budget, doing);
        } finally {
          remainingMs.value = Number.POSITIVE_INFINITY;
        }
      }
    );

    it('names the follow-up-only members it does not apply, MaxAllocatedStorage aside', async () => {
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        MaxAllocatedStorage: 1000,
        DatabaseInsightsMode: 'standard',
      });
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).toMatchObject({ MaxAllocatedStorage: 1000 });
      expect(warned()).toMatch(/DBInstance L: DatabaseInsightsMode not applied: only CloudFormation's after-create ModifyDBInstance/);
      expect(warned()).not.toMatch(/MaxAllocatedStorage/);
    });

    it('warns about the declared keys the source decides instead', async () => {
      arm({ restored: { MasterUsername: 'postgres', StorageEncrypted: true } });
      await provider.create('L', INSTANCE, {
        ...FROM_LATEST,
        KmsKeyId: 'alias/k',
        Timezone: 'UTC',
        MasterUsername: 'admin',
        StorageEncrypted: false,
      });
      expect(warned()).toMatch(
        /DBInstance L: KmsKeyId, Timezone, MasterUsername, StorageEncrypted not applied: a restore to a point in time takes them from its source/
      );
      for (const key of ['KmsKeyId', 'Timezone', 'MasterUsername', 'StorageEncrypted']) {
        expect(sent('RestoreDBInstanceToPointInTimeCommand')[0]).not.toHaveProperty(key);
      }
    });

    it('restores to a point in time over a declared snapshot, naming it and reading none', async () => {
      await provider.create('L', INSTANCE, { ...FROM_LATEST, DBSnapshotIdentifier: 'snap-1' });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toHaveLength(1);
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
      expect(sent('DescribeDBSnapshotsCommand')).toEqual([]);
      expect(warned()).toMatch(
        /DBSnapshotIdentifier not applied: a point-in-time key makes the create a restore to a point in time/
      );
      expect(warned()).not.toMatch(/read replica/);
    });

    it('marks the restored instance created when the follow-up fails, never when the restore call does', async () => {
      arm({ modifyError: Object.assign(new Error('bad'), { name: 'InvalidParameterCombination' }) });
      const failedFollowUp = await provider
        .create('L', INSTANCE, { ...FROM_LATEST, BackupRetentionPeriod: '3' })
        .catch((e: unknown) => e);
      expect(hasCreatedBeforeFailure(failedFollowUp)).toBe(true);
      arm({ restoreError: Object.assign(new Error('no'), { name: 'InvalidRestoreFault' }) });
      const failedRestore = await provider
        .create('L', INSTANCE, { ...FROM_LATEST })
        .catch((e: unknown) => e);
      expect(String(failedRestore)).toMatch(/Failed to create DBInstance L/);
      expect(hasCreatedBeforeFailure(failedRestore)).toBe(false);
    });

    it('refuses its own name as the source on a create, before any call', async () => {
      const error = await provider
        .create('L', INSTANCE, { ...FROM_LATEST, SourceDBInstanceIdentifier: 'DB-1' })
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/SourceDBInstanceIdentifier names the DB instance this creates or replaces/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('restores the same way on a rollback replay', async () => {
      await provider.create('L', INSTANCE, { ...FROM_LATEST }, { replayingState: true });
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toHaveLength(1);
    });
  });

  describe('restore-source guard', () => {
    const scope = { region: 'us-east-1', account: '123456789012' };
    const pitr = (extra: Input) => ({ UseLatestRestorableTime: true, ...extra });

    it('refuses its own SourceDBInstanceIdentifier, by name or same-scope ARN', () => {
      for (const source of ['db-1', 'DB-1', 'arn:aws:rds:us-east-1:123456789012:db:db-1']) {
        expect(() =>
          refuseRestoreFromItself(INSTANCE, pitr({ SourceDBInstanceIdentifier: source }), 'db-1', 'L', scope)
        ).toThrow(/SourceDBInstanceIdentifier names the DB instance this creates or replaces/);
      }
    });

    it.each([
      ['another instance', 'db-2'],
      ['a same-named instance in another region', 'arn:aws:rds:eu-west-1:123456789012:db:db-1'],
      ['a same-named instance in another account', 'arn:aws:rds:us-east-1:999999999999:db:db-1'],
    ])('lets %s through', (_n, source) => {
      expect(() =>
        refuseRestoreFromItself(INSTANCE, pitr({ SourceDBInstanceIdentifier: source }), 'db-1', 'L', scope)
      ).not.toThrow();
    });

    it("reads a 'true' UseLatestRestorableTime string as a point-in-time restore", () => {
      expect(() =>
        refuseRestoreFromItself(
          INSTANCE,
          { UseLatestRestorableTime: 'TRUE', SourceDBInstanceIdentifier: 'db-1' },
          'db-1',
          'L',
          scope
        )
      ).toThrow(/SourceDBInstanceIdentifier names the DB instance/);
    });

    it('lets a read replica of itself through, which no point-in-time key makes a restore', () => {
      // A read replica of itself RDS refuses on its own; nothing here is a restore.
      expect(() =>
        refuseRestoreFromItself(INSTANCE, { SourceDBInstanceIdentifier: 'db-1' }, 'db-1', 'L', scope)
      ).not.toThrow();
    });

    it('refuses its own recorded DbiResourceId, leaving a backups ARN to the live read', () => {
      const own = { ...scope, attributes: { DbiResourceId: 'db-OWN1' } };
      expect(() =>
        refuseRestoreFromItself(INSTANCE, { SourceDbiResourceId: 'DB-own1' }, 'db-1', 'L', own)
      ).toThrow(/SourceDbiResourceId names the DB instance/);
      for (const props of [
        { SourceDbiResourceId: 'db-OTHER' },
        // The ARN's id is not the instance's resource id: only RDS can say whose it is.
        { SourceDBInstanceAutomatedBackupsArn: 'arn:aws:rds:us-east-1:123456789012:auto-backup:ab-own1' },
      ]) {
        expect(() => refuseRestoreFromItself(INSTANCE, props, 'db-1', 'L', own), JSON.stringify(props)).not.toThrow();
      }
      // No recorded id: left to the live read before the delete.
      expect(() =>
        refuseRestoreFromItself(INSTANCE, { SourceDbiResourceId: 'db-OWN1' }, 'db-1', 'L', scope)
      ).not.toThrow();
    });

    it('does not read the snapshot under a point-in-time key, as the handler restores to a point in time', () => {
      expect(() =>
        refuseRestoreFromItself(
          INSTANCE,
          // No source key: the snapshot check would otherwise read it (a
          // declared source skips it as a read replica's).
          { RestoreTime: '2026-11-01T00:00:00Z', DBSnapshotIdentifier: 'rds:db-1-2026-11-01-03-04' },
          'db-1',
          'L',
          scope
        )
      ).not.toThrow();
    });

    it("answers an automated backups ARN's identity with the instance it backs up", async () => {
      // AWS's own reference pair: the ARN's id differs from the resource id.
      const arn = 'arn:aws:rds:us-east-1:123456789012:auto-backup:ab-jkib2gfq5rv7replzadausbrktni2bn4example';
      arm({ backupOwner: 'db-JKIB2GFQ5RV7REPLZA4EXAMPLE' });
      const ctx = { expectedRegion: 'us-east-1' };
      expect(await provider.resourceIdentity(arn, INSTANCE, ctx)).toBe('db-JKIB2GFQ5RV7REPLZA4EXAMPLE');
      expect(sent('DescribeDBInstanceAutomatedBackupsCommand')).toEqual([
        { DBInstanceAutomatedBackupsArn: arn },
      ]);
      arm({ backupEngine: null });
      expect(await provider.resourceIdentity(arn, INSTANCE, ctx)).toBe(RESOURCE_NOT_FOUND);
      arm({ backupError: Object.assign(new Error('gone'), { name: 'DBInstanceAutomatedBackupNotFoundFault' }) });
      expect(await provider.resourceIdentity(arn, INSTANCE, ctx)).toBe(RESOURCE_NOT_FOUND);
      arm({});
      expect(await provider.resourceIdentity(arn, INSTANCE, ctx)).toBeUndefined();
      arm({ backupError: Object.assign(new Error('denied'), { name: 'AccessDenied' }) });
      await expect(provider.resourceIdentity(arn, INSTANCE, ctx)).rejects.toThrow('denied');
      // A not-found-sounding message under another name is no not-found.
      arm({
        backupError: Object.assign(new Error('it does not exist or you are not authorized'), {
          name: 'AccessDenied',
        }),
      });
      await expect(provider.resourceIdentity(arn, INSTANCE, ctx)).rejects.toThrow('not authorized');
      // Another region, by the ARN or by the client: no read, no answer.
      arm({ backupOwner: 'db-JKIB2GFQ5RV7REPLZA4EXAMPLE' });
      mockSend.mockClear();
      expect(
        await provider.resourceIdentity(arn.replace('us-east-1', 'eu-west-1'), INSTANCE, ctx)
      ).toBeUndefined();
      expect(
        await provider.resourceIdentity(arn, INSTANCE, { expectedRegion: 'eu-west-1' })
      ).toBeUndefined();
      expect(sent('DescribeDBInstanceAutomatedBackupsCommand')).toEqual([]);
    });
  });

  describe('update', () => {
    const update = (next: Input, prev: Input, context?: Parameters<RDSProvider['update']>[5]) =>
      provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);
    const { SourceDBInstanceIdentifier: _s, UseLatestRestorableTime: _u, ...PLAIN } = FROM_LATEST;

    it.each([
      ['RestoreTime added', PLAIN, { ...PLAIN, RestoreTime: '2026-11-01T00:00:00Z' }, 'RestoreTime'],
      [
        'RestoreTime changed',
        { ...PLAIN, RestoreTime: '2026-11-01T00:00:00Z' },
        { ...PLAIN, RestoreTime: '2026-11-02T00:00:00Z' },
        'RestoreTime',
      ],
      ['UseLatestRestorableTime turned true', { ...FROM_LATEST, UseLatestRestorableTime: false }, FROM_LATEST, 'UseLatestRestorableTime'],
      ['SourceDbiResourceId added', PLAIN, { ...PLAIN, SourceDbiResourceId: DBI }, 'SourceDbiResourceId'],
      [
        'SourceDBInstanceAutomatedBackupsArn changed',
        { ...PLAIN, SourceDBInstanceAutomatedBackupsArn: BACKUPS },
        { ...PLAIN, SourceDBInstanceAutomatedBackupsArn: `${BACKUPS}x` },
        'SourceDBInstanceAutomatedBackupsArn',
      ],
      [
        "a restored instance's source changed",
        FROM_LATEST,
        { ...FROM_LATEST, SourceDBInstanceIdentifier: 'other-db' },
        'SourceDBInstanceIdentifier',
      ],
    ])('refuses %s before any call', async (_name, prev, next, key) => {
      const error = await update(next, prev).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(String((error as Error).message)).toMatch(
        new RegExp(`${key} cannot be added or changed on an existing DB instance — an instance is restored to a point in time only when it is created`)
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names both kinds when a snapshot and a point-in-time key are added together', async () => {
      const error = await update({ ...PLAIN, DBSnapshotIdentifier: 'snap-1', RestoreTime: '2026-11-01T00:00:00Z' }, PLAIN).catch(
        (e: unknown) => e
      );
      expect(String((error as Error).message)).toMatch(
        /DBSnapshotIdentifier and RestoreTime cannot be added or changed .* restored from a snapshot or to a point in time only when it is created/
      );
    });

    it.each([
      ['UseLatestRestorableTime turned false', { ...FROM_LATEST, UseLatestRestorableTime: false }],
      ["UseLatestRestorableTime re-spelled 'true'", { ...FROM_LATEST, UseLatestRestorableTime: 'true' }],
      ['UseLatestRestorableTime removed', { ...FROM_LATEST, UseLatestRestorableTime: undefined }],
      ['the source removed', { ...FROM_LATEST, SourceDBInstanceIdentifier: undefined }],
    ])('changes nothing for %s and sends no point-in-time key on the modify', async (_n, next) => {
      await update({ ...next, BackupRetentionPeriod: '5' }, FROM_LATEST);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      const [modify] = sent('ModifyDBInstanceCommand');
      for (const key of ['UseLatestRestorableTime', 'RestoreTime', 'SourceDBInstanceIdentifier']) {
        expect(modify).not.toHaveProperty(key);
      }
      // Not a read replica: nothing to promote.
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
    });

    it("does not treat a restored instance's source as a replica's on a rollback replay", async () => {
      await update(
        { ...FROM_LATEST, SourceDBInstanceIdentifier: 'older-db', BackupRetentionPeriod: '5' },
        FROM_LATEST,
        { replayingState: true }
      );
      expect(warned()).not.toMatch(/read replica/);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it.each(['{{resolve:ssm:/cdkd/src}}', '***'])(
      "takes the deploy's own change set over a recorded stand-in (%s)",
      async (recorded) => {
        await update(
          { ...PLAIN, SourceDbiResourceId: DBI, BackupRetentionPeriod: '5' },
          { ...PLAIN, SourceDbiResourceId: recorded },
          { changedProperties: new Set(['BackupRetentionPeriod']) }
        );
        expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      }
    );

    it('lets a key named only for an unconfirmed NoEcho value through, warning without its value', async () => {
      await update(
        { ...PLAIN, SourceDbiResourceId: DBI, BackupRetentionPeriod: '5' },
        { ...PLAIN, SourceDbiResourceId: '***' },
        {
          changedProperties: new Set(['SourceDbiResourceId', 'BackupRetentionPeriod']),
          noEchoOnlyChangedProperties: new Set(['SourceDbiResourceId']),
        }
      );
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      expect(warned()).toMatch(/DBInstance L: SourceDbiResourceId may have changed \(a NoEcho value/);
      expect(warned()).not.toContain(DBI);
    });

    it('masks the physical id and names the deletion-protection step in the refusal', async () => {
      const error = await update(
        { ...PLAIN, RestoreTime: '2026-11-01T00:00:00Z' },
        { ...PLAIN, DeletionProtection: true },
        { maskSecrets: (t: string) => t.replaceAll('db-1', '***') }
      ).catch((e: unknown) => e);
      const message = String((error as Error).message);
      expect(message).toMatch(/Nothing was applied to DB instance \*\*\*/);
      expect(message).not.toContain('db-1');
      const protectedError = await update(
        { ...PLAIN, RestoreTime: '2026-11-01T00:00:00Z' },
        { ...PLAIN, DeletionProtection: true }
      ).catch((e: unknown) => e);
      expect(String((protectedError as Error).message)).toMatch(/--no-deletion-protection/);
    });

    it.each([
      ['a rollback replay', { replayingState: true }],
      ['a drift --revert', { desiredFromAwsReadback: true }],
    ] as const)('lets %s restore the record it was created from', async (_name, context) => {
      const result = await update(FROM_LATEST, { ...FROM_LATEST, UseLatestRestorableTime: undefined }, context);
      expect(result.effectiveProperties).toBeUndefined();
      expect(sent('RestoreDBInstanceToPointInTimeCommand')).toEqual([]);
    });
  });

  it('routes a point-in-time restore through the SDK provider and never reads its keys back', () => {
    expect(
      findSdkUnwiredProperties(INSTANCE, {
        ...FROM_LATEST,
        RestoreTime: '2026-11-01T00:00:00Z',
        SourceDbiResourceId: DBI,
        SourceDBInstanceAutomatedBackupsArn: BACKUPS,
      })
    ).toEqual([]);
    const rds = new RDSProvider();
    expect(rds.getDriftUnknownPaths(INSTANCE, { ...FROM_LATEST })).toEqual(
      expect.arrayContaining([
        'RestoreTime',
        'UseLatestRestorableTime',
        'SourceDBInstanceAutomatedBackupsArn',
        'SourceDbiResourceId',
        // A restored instance is no replica: RDS keeps no record of the source.
        'SourceDBInstanceIdentifier',
      ])
    );
    // A read replica's source is still compared.
    const { UseLatestRestorableTime: _u, ...replica } = FROM_LATEST;
    expect(rds.getDriftUnknownPaths(INSTANCE, replica)).not.toContain('SourceDBInstanceIdentifier');
    expect(declaresPointInTimeRestore({ UseLatestRestorableTime: 'false' })).toBe(false);
  });
});
