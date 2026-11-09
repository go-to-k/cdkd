// go-to-k/cdkd#5640: `SourceDBInstanceIdentifier` on the SDK route for
// AWS::RDS::DBInstance (a read replica, e.g. CDK's DatabaseInstanceReadReplica),
// following CloudFormation's RDS handler: CreateDBInstanceReadReplica with the
// members `Translator.createDbInstanceReadReplicaRequest` sends, then the
// after-create ModifyDBInstance (`shouldUpdateAfterCreate`); a removed source
// promotes the replica (PromoteReadReplica); an added or changed one is refused
// ("Resource is immutable"); a replica is deleted without a final snapshot.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warn, info, clientRegions } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  clientRegions: [] as (string | undefined)[],
}));

const budget = vi.hoisted(() => ({ remainingMs: Number.POSITIVE_INFINITY }));

vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enclosingDeadlineRemainingMs: () => budget.remainingMs,
}));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation((config?: { region?: string }) => {
      clientRegions.push(config?.region);
      return {
        send: (command: unknown) => mockSend(command, config?.region),
        destroy: vi.fn(),
        config: { region: () => Promise.resolve(config?.region ?? 'us-east-1') },
      };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info,
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
import { hasCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import type { UpdateContext } from '../../../src/types/resource.js';
import {
  AWS_CN_CROSS_REGION_REPLICA_RATIONALE,
  findActionableSdkUnwired,
  findSdkUnwiredProperties,
} from '../../../src/provisioning/property-coverage.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const ACCOUNT = '123456789012';
const SOURCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db:source-1`;

interface Live {
  /** The replica's own DescribeDBInstances fields. */
  replica?: Input;
  /** The source's engine, as DescribeDBInstances reports it. */
  sourceEngine?: string;
  /** Whether PromoteReadReplica turns the replica standalone. */
  promotes?: boolean;
}

let replicaSource: string | undefined;

/**
 * DescribeDBInstances answers the source (`source-1`) with its engine and
 * any other identifier as the replica, available, replicating `source-1`
 * until PromoteReadReplica.
 */
function arm(live: Live = {}): void {
  replicaSource = 'source-1';
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    switch (command.constructor.name) {
      case 'DescribeDBInstancesCommand':
        if (
          command.input['DBInstanceIdentifier'] === 'source-1' ||
          String(command.input['DBInstanceIdentifier']).endsWith(':db:source-1')
        ) {
          return Promise.resolve({
            DBInstances: [
              {
                DBInstanceIdentifier: 'source-1',
                Engine: live.sourceEngine ?? 'postgres',
                DBInstanceStatus: 'available',
              },
            ],
          });
        }
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: `arn:aws:rds:us-east-1:${ACCOUNT}:db:db-1`,
              DBInstanceStatus: 'available',
              Engine: live.sourceEngine ?? 'postgres',
              ...(replicaSource !== undefined && {
                ReadReplicaSourceDBInstanceIdentifier: replicaSource,
              }),
              ...live.replica,
            },
          ],
        });
      case 'CreateDBInstanceReadReplicaCommand':
      case 'CreateDBInstanceCommand':
        return Promise.resolve({
          DBInstance: { DBInstanceIdentifier: 'db-1', Engine: live.sourceEngine ?? 'postgres' },
        });
      case 'PromoteReadReplicaCommand':
        if (live.promotes !== false) replicaSource = undefined;
        return Promise.resolve({});
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ TagList: [] });
      default:
        return Promise.resolve({});
    }
  });
}

function calls(): { name: string; input: Input; region: string | undefined }[] {
  return mockSend.mock.calls.map(([command, region]) => ({
    name: (command as { constructor: { name: string } }).constructor.name,
    input: (command as { input: Input }).input,
    region: region as string | undefined,
  }));
}

function sent(name: string): Input[] {
  return calls()
    .filter((call) => call.name === name)
    .map((call) => call.input);
}

/** Pins the source the replica reads back as replicating (`undefined`: standalone). */
function pinLiveSource(value: string | undefined): void {
  replicaSource = value;
  const inner = mockSend.getMockImplementation()!;
  mockSend.mockImplementation((command: unknown, region: unknown) => {
    replicaSource = value;
    return inner(command, region);
  });
}

/** What a CDK DatabaseInstanceReadReplica emits (no Engine, no credentials). */
const REPLICA: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t3.micro',
  SourceDBInstanceIdentifier: SOURCE_ARN,
  DBSubnetGroupName: 'subnets-1',
  VPCSecurityGroups: ['sg-1'],
  StorageType: 'gp3',
  AllocatedStorage: '100',
  MultiAZ: false,
  PubliclyAccessible: false,
  CopyTagsToSnapshot: true,
  Tags: [{ Key: 'team', Value: 'db' }],
};

describe('RDS DBInstance read replica (go-to-k/cdkd#5640)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    info.mockReset();
    clientRegions.length = 0;
    provider = new RDSProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
    arm();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
    budget.remainingMs = Number.POSITIVE_INFINITY;
  });

  const update = (next: Input, prev: Input, context?: UpdateContext) =>
    provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

  describe('create', () => {
    it('creates the replica with CreateDBInstanceReadReplica, carrying the declared members', async () => {
      const result = await provider.create('L', INSTANCE, { ...REPLICA });

      expect(sent('CreateDBInstanceCommand')).toEqual([]);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          SourceDBInstanceIdentifier: SOURCE_ARN,
          DBInstanceClass: 'db.t3.micro',
          DBSubnetGroupName: 'subnets-1',
          VpcSecurityGroupIds: ['sg-1'],
          StorageType: 'gp3',
          AllocatedStorage: 100,
          MultiAZ: false,
          PubliclyAccessible: false,
          CopyTagsToSnapshot: true,
          Tags: [{ Key: 'team', Value: 'db' }],
        },
      ]);
      // Nothing the create could not carry is declared: no follow-up.
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(result.physicalId).toBe('db-1');
    });

    it("reads the source's engine (by the declared ARN, account included) when the template declares none", async () => {
      await provider.create('L', INSTANCE, { ...REPLICA });
      expect(sent('DescribeDBInstancesCommand')[0]).toEqual({ DBInstanceIdentifier: SOURCE_ARN });
    });

    it('sends nothing for the members a replica inherits, as CloudFormation sends none', async () => {
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        Engine: 'postgres',
        MasterUsername: 'admin',
        DBName: 'appdb',
        StorageEncrypted: true,
        LicenseModel: 'postgresql-license',
      });
      const [create] = sent('CreateDBInstanceReadReplicaCommand');
      for (const key of ['Engine', 'MasterUsername', 'DBName', 'StorageEncrypted', 'LicenseModel']) {
        expect(create).not.toHaveProperty(key);
      }
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      // A declared engine is not read from the source.
      expect(sent('DescribeDBInstancesCommand')).not.toContainEqual({
        DBInstanceIdentifier: SOURCE_ARN,
      });
    });

    it('sends the members the create cannot carry in one ModifyDBInstance once it is available', async () => {
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        BackupRetentionPeriod: '7',
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        MaxAllocatedStorage: 1000,
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
        EngineVersion: '17.6',
        DeletionProtection: true,
      });

      const [create] = sent('CreateDBInstanceReadReplicaCommand');
      for (const key of [
        'BackupRetentionPeriod',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'MaxAllocatedStorage',
        'CACertificateIdentifier',
        'EngineVersion',
      ]) {
        expect(create).not.toHaveProperty(key);
      }
      expect(create).toMatchObject({ DeletionProtection: true });
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          ApplyImmediately: true,
          BackupRetentionPeriod: 7,
          PreferredBackupWindow: '03:00-04:00',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          MaxAllocatedStorage: 1000,
          CACertificateIdentifier: 'rds-ca-rsa2048-g1',
          EngineVersion: '17.6',
          DeletionProtection: true,
        },
      ]);
      // The available wait sits between the create and the follow-up.
      const names = calls().map((call) => call.name);
      expect(names.indexOf('CreateDBInstanceReadReplicaCommand')).toBeLessThan(
        names.lastIndexOf('DescribeDBInstancesCommand', names.indexOf('ModifyDBInstanceCommand'))
      );
    });

    it('waits for available after the follow-up when no parameter group is declared', async () => {
      await provider.create('L', INSTANCE, { ...REPLICA, BackupRetentionPeriod: 7 });
      const names = calls().map((call) => call.name);
      const modify = names.indexOf('ModifyDBInstanceCommand');
      const after = names.slice(modify + 1);
      const nextOther = after.findIndex((name) => name !== 'DescribeDBInstancesCommand');
      // A replica describe sits between the follow-up and whatever comes next.
      const settle = calls()
        .slice(modify + 1, nextOther === -1 ? undefined : modify + 1 + nextOther)
        .filter(
          (call) =>
            call.name === 'DescribeDBInstancesCommand' && call.input['DBInstanceIdentifier'] === 'db-1'
        );
      expect(settle.length).toBeGreaterThanOrEqual(2);
    });

    it('a failing follow-up marks the replica as created before the failure', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) =>
        command.constructor.name === 'ModifyDBInstanceCommand'
          ? Promise.reject(Object.assign(new Error('invalid window'), { name: 'InvalidParameterValue' }))
          : inner(command, region)
      );
      const error = await provider
        .create('L', INSTANCE, { ...REPLICA, BackupRetentionPeriod: 7 })
        .catch((e: unknown) => e);
      expect(hasCreatedBeforeFailure(error)).toBe(true);
    });

    describe('a source that is not available (a second replica of it created in parallel)', () => {
      const notAvailable = (): Error =>
        Object.assign(new Error('DB instance is not in the available state'), {
          name: 'InvalidDBInstanceStateFault',
        });

      /** CreateDBInstanceReadReplica answers `refusals` (in order), then succeeds. */
      const refuseCreates = (refusals: Error[], sourceStatuses: string[] = []): void => {
        const inner = mockSend.getMockImplementation()!;
        mockSend.mockImplementation(
          (command: { constructor: { name: string }; input: Input }, region: unknown) => {
            if (command.constructor.name === 'CreateDBInstanceReadReplicaCommand') {
              const next = refusals.shift();
              if (next !== undefined) return Promise.reject(next);
            }
            if (
              command.constructor.name === 'DescribeDBInstancesCommand' &&
              command.input['DBInstanceIdentifier'] === SOURCE_ARN &&
              sourceStatuses.length > 0
            ) {
              return Promise.resolve({
                DBInstances: [
                  { DBInstanceIdentifier: 'source-1', Engine: 'postgres', DBInstanceStatus: sourceStatuses.shift() },
                ],
              });
            }
            return inner(command, region);
          }
        );
      };

      it('waits for the source to be available, then resends the create', async () => {
        refuseCreates([notAvailable()], ['postgres-engine-read', 'modifying', 'available']);
        const result = await provider.create('L', INSTANCE, { ...REPLICA });
        expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(2);
        expect(result.physicalId).toBe('db-1');
        // The wait read the SOURCE between the two creates.
        const names = calls().map((call) => `${call.name}:${String(call.input['DBInstanceIdentifier'])}`);
        const first = names.indexOf('CreateDBInstanceReadReplicaCommand:db-1');
        const second = names.lastIndexOf('CreateDBInstanceReadReplicaCommand:db-1');
        expect(names.slice(first + 1, second)).toContain(`DescribeDBInstancesCommand:${SOURCE_ARN}`);
      });

      it('never resends a create refused for any other reason', async () => {
        refuseCreates([
          Object.assign(new Error('Creating read replicas ... is not supported.'), {
            name: 'InvalidParameterValue',
          }),
        ]);
        await expect(provider.create('L', INSTANCE, { ...REPLICA })).rejects.toThrow(
          /Creating read replicas \.\.\. is not supported/
        );
        expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
      });

      it('fails at once, naming the source, when the source reads a status that does not end on its own', async () => {
        refuseCreates([notAvailable()], ['postgres-engine-read', 'deleting']);
        await expect(provider.create('L', INSTANCE, { ...REPLICA })).rejects.toThrow(
          /because the source instance is not in the 'available' state, and it reads status 'deleting'/
        );
        expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
      });

      it('gives up within a resource deadline nearer than 30 minutes', async () => {
        let now = 1_000_000;
        const start = now;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
          now += ms;
        };
        budget.remainingMs = 10 * 60_000;
        try {
          refuseCreates(
            Array.from({ length: 1000 }, notAvailable),
            Array.from({ length: 1000 }, () => 'modifying')
          );
          await expect(provider.create('L', INSTANCE, { ...REPLICA })).rejects.toThrow(
            /the resource timeout leaves no more time to wait for it; .*--resource-timeout/
          );
          expect(now - start).toBeLessThanOrEqual(10 * 60_000);
          expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
        } finally {
          clock.mockRestore();
        }
      });

      it('gives up within its budget, naming the source and keeping AWS\'s error as the cause', async () => {
        let now = 1_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
          now += ms;
        };
        try {
          refuseCreates(
            Array.from({ length: 1000 }, notAvailable),
            Array.from({ length: 1000 }, () => 'modifying')
          );
          const error = await provider.create('L', INSTANCE, { ...REPLICA }).catch((e: unknown) => e);
          expect(String((error as Error).message)).toMatch(
            /refused the create of the read replica because the source instance is not in the 'available' state/
          );
          const chain: string[] = [];
          for (let e: unknown = error; e instanceof Error; e = e.cause) chain.push(e.name);
          expect(chain).toContain('InvalidDBInstanceStateFault');
          expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
        } finally {
          clock.mockRestore();
        }
      });
    });

    it('sends no follow-up for a member that alone does not call for one (MaxAllocatedStorage)', async () => {
      await provider.create('L', INSTANCE, { ...REPLICA, MaxAllocatedStorage: 1000 });
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
    });

    it('a SQL Server replica sends the storage members on the follow-up, not the create', async () => {
      arm({ sourceEngine: 'sqlserver-ee' });
      await provider.create('L', INSTANCE, { ...REPLICA, Iops: 3000, StorageThroughput: 125 });

      const [create] = sent('CreateDBInstanceReadReplicaCommand');
      for (const key of ['AllocatedStorage', 'StorageType', 'Iops', 'StorageThroughput']) {
        expect(create).not.toHaveProperty(key);
      }
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          ApplyImmediately: true,
          AllocatedStorage: 100,
          StorageType: 'gp3',
          Iops: 3000,
          StorageThroughput: 125,
        },
      ]);
    });

    it("a cross-region source's engine is read in its own region, and a MySQL one carries the parameter group", async () => {
      arm({ sourceEngine: 'mysql' });
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        SourceDBInstanceIdentifier: `arn:aws:rds:eu-west-1:${ACCOUNT}:db:source-1`,
        DBParameterGroupName: 'pg-1',
      });

      const source = calls().find(
        (call) =>
          call.name === 'DescribeDBInstancesCommand' &&
          call.input['DBInstanceIdentifier'] === `arn:aws:rds:eu-west-1:${ACCOUNT}:db:source-1`
      );
      expect(source?.region).toBe('eu-west-1');
      expect(sent('CreateDBInstanceReadReplicaCommand')[0]).toMatchObject({
        SourceDBInstanceIdentifier: `arn:aws:rds:eu-west-1:${ACCOUNT}:db:source-1`,
        DBParameterGroupName: 'pg-1',
      });
      // ... and on the follow-up, as the handler sends it there too.
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({ DBParameterGroupName: 'pg-1' });
    });

    it('a same-region replica sends its parameter group on the follow-up only', async () => {
      arm({ sourceEngine: 'mysql' });
      await provider.create('L', INSTANCE, { ...REPLICA, DBParameterGroupName: 'pg-1' });
      expect(sent('CreateDBInstanceReadReplicaCommand')[0]).not.toHaveProperty(
        'DBParameterGroupName'
      );
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({ DBParameterGroupName: 'pg-1' });
    });

    it('reboots a replica whose follow-up leaves the parameter group pending-reboot', async () => {
      let status = 'pending-reboot';
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(
        async (command: { constructor: { name: string } }, region: unknown) => {
          if (command.constructor.name === 'RebootDBInstanceCommand') status = 'in-sync';
          const out = (await inner(command, region)) as { DBInstances?: Input[] };
          if (command.constructor.name !== 'DescribeDBInstancesCommand') return out;
          return {
            DBInstances: out.DBInstances?.map((instance) => ({
              ...instance,
              DBParameterGroups: [{ DBParameterGroupName: 'pg-1', ParameterApplyStatus: status }],
            })),
          };
        }
      );
      await provider.create('L', INSTANCE, { ...REPLICA, DBParameterGroupName: 'pg-1' });
      expect(sent('RebootDBInstanceCommand')).toEqual([{ DBInstanceIdentifier: 'db-1' }]);
    });

    it('waits for available under --no-wait only when a follow-up needs it', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      await provider.create('L', INSTANCE, { ...REPLICA });
      const waitsWithout = sent('DescribeDBInstancesCommand').filter(
        (input) => input['DBInstanceIdentifier'] === 'db-1'
      ).length;

      mockSend.mockClear();
      await provider.create('L', INSTANCE, { ...REPLICA, BackupRetentionPeriod: 7 });
      const waitsWith = sent('DescribeDBInstancesCommand').filter(
        (input) => input['DBInstanceIdentifier'] === 'db-1'
      ).length;
      expect(waitsWith).toBeGreaterThan(waitsWithout);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('refuses a source that is not a string before any call', async () => {
      await expect(
        provider.create('L', INSTANCE, { ...REPLICA, SourceDBInstanceIdentifier: { Ref: 'Db' } })
      ).rejects.toThrow(/SourceDBInstanceIdentifier must be a string/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('an empty source is a standalone instance, as the handler reads it', async () => {
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        SourceDBInstanceIdentifier: '',
        Engine: 'postgres',
      });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
      expect(sent('CreateDBInstanceCommand')).toHaveLength(1);
    });
    it('fails before the create when the source cannot be found, as the handler does', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(
        (command: { constructor: { name: string }; input: Input }, region: unknown) =>
          command.constructor.name === 'DescribeDBInstancesCommand' &&
          command.input['DBInstanceIdentifier'] === SOURCE_ARN
            ? Promise.resolve({ DBInstances: [] })
            : inner(command, region)
      );
      await expect(provider.create('L', INSTANCE, { ...REPLICA })).rejects.toThrow(
        /reported no source DB instance arn:aws:rds:us-east-1:123456789012:db:source-1/
      );
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
    });

    it("sends the source's Oracle CDB engine on the follow-up, as the handler's model carries it", async () => {
      arm({ sourceEngine: 'oracle-ee-cdb' });
      await provider.create('L', INSTANCE, { ...REPLICA, BackupRetentionPeriod: 7 });
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({ Engine: 'oracle-ee-cdb' });
    });
  });

  describe('update', () => {
    it('promotes the replica when the template removes the source, before the ModifyDBInstance', async () => {
      const { SourceDBInstanceIdentifier: _source, ...promoted } = REPLICA;
      await update(
        { ...promoted, BackupRetentionPeriod: 7, PreferredBackupWindow: '03:00-04:00' },
        REPLICA
      );

      expect(sent('PromoteReadReplicaCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          BackupRetentionPeriod: 7,
          PreferredBackupWindow: '03:00-04:00',
        },
      ]);
      const names = calls().map((call) => call.name);
      expect(names.indexOf('PromoteReadReplicaCommand')).toBeLessThan(
        names.indexOf('ModifyDBInstanceCommand')
      );
      // The promotion is waited out (a describe reading it standalone) first.
      const between = names.slice(
        names.indexOf('PromoteReadReplicaCommand'),
        names.indexOf('ModifyDBInstanceCommand')
      );
      expect(between).toContain('DescribeDBInstancesCommand');
    });

    it('keeps waiting while the instance still reads as a replica after the promotion', async () => {
      arm({ promotes: false });
      const { SourceDBInstanceIdentifier: _source, ...promoted } = REPLICA;
      let describes = 0;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) => {
        if (command.constructor.name === 'DescribeDBInstancesCommand' && ++describes === 4) {
          replicaSource = undefined;
        }
        return inner(command, region);
      });
      await update(promoted, REPLICA);
      expect(describes).toBeGreaterThanOrEqual(4);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('does not promote an instance that is already standalone', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: unknown, region: unknown) => {
        replicaSource = undefined;
        return inner(command, region);
      });
      const { SourceDBInstanceIdentifier: _source, ...promoted } = REPLICA;
      await update(promoted, REPLICA);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('leaves an unchanged source alone', async () => {
      await update({ ...REPLICA, DBInstanceClass: 'db.t3.small' }, REPLICA);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({
        DBInstanceClass: 'db.t3.small',
      });
    });

    it.each([
      ['added', { ...REPLICA, SourceDBInstanceIdentifier: undefined }, 'none'],
      [
        'changed',
        { ...REPLICA, SourceDBInstanceIdentifier: `arn:aws:rds:us-east-1:${ACCOUNT}:db:other-1` },
        'other-1',
      ],
    ])('refuses a source %s on an existing instance before any change', async (_, prev, live) => {
      replicaSource = live === 'none' ? undefined : live;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: unknown, region: unknown) => {
        replicaSource = live === 'none' ? undefined : live;
        return inner(command, region);
      });
      const error = await update(REPLICA, prev as Input).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toMatch(
        /SourceDBInstanceIdentifier cannot be added or changed on an existing DB instance/
      );
      expect((error as Error).message).toMatch(/"Resource is immutable"/);
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
    });

    it('accepts an added source the live instance already replicates (a record that lacks it)', async () => {
      const { SourceDBInstanceIdentifier: _source, ...unrecorded } = REPLICA;
      const result = await update(REPLICA, unrecorded);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('names an unreadable instance in the refusal', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) =>
        command.constructor.name === 'DescribeDBInstancesCommand'
          ? Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }))
          : inner(command, region)
      );
      const { SourceDBInstanceIdentifier: _source, ...unrecorded } = REPLICA;
      await expect(update(REPLICA, unrecorded)).rejects.toThrow(
        /could not read the instance's live replica source/
      );
    });

    it('a rollback replay warns, keeps the instance as it is and records what it kept', async () => {
      replicaSource = undefined;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: unknown, region: unknown) => {
        replicaSource = undefined;
        return inner(command, region);
      });
      const { SourceDBInstanceIdentifier: _source, ...promoted } = REPLICA;
      const result = await update(REPLICA, promoted, { replayingState: true });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/SourceDBInstanceIdentifier cannot be added or changed in place/)
      );
      expect(result.effectiveProperties).toBeDefined();
      expect(result.effectiveProperties).not.toHaveProperty('SourceDBInstanceIdentifier');
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('a drift --revert naming the source by identifier is no change against a recorded ARN', async () => {
      await update({ ...REPLICA, SourceDBInstanceIdentifier: 'source-1' }, REPLICA, {
        desiredFromAwsReadback: true,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it.each([
      ['another region', `arn:aws:rds:us-west-2:${ACCOUNT}:db:source-1`],
      ['another account', 'arn:aws:rds:us-east-1:999999999999:db:source-1'],
    ])(
      'refuses a source moved to a same-named instance in %s, which the live replica does not replicate',
      async (_, moved) => {
        const error = await update({ ...REPLICA, SourceDBInstanceIdentifier: moved }, REPLICA).catch(
          (e: unknown) => e
        );
        expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
        expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      }
    );

    it('fails closed when the live instance reports no ARN: a bare live source never matches a declared ARN', async () => {
      arm({ replica: { DBInstanceArn: undefined } });
      const { SourceDBInstanceIdentifier: _source, ...unrecorded } = REPLICA;
      await expect(update(REPLICA, unrecorded)).rejects.toBeInstanceOf(
        ResourceUpdateNotSupportedError
      );
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
    });

    it('fails closed on a replay too: it warns and keeps the previous source', async () => {
      arm({ replica: { DBInstanceArn: undefined } });
      const result = await update(REPLICA, { ...REPLICA, SourceDBInstanceIdentifier: 'source-1' }, {
        replayingState: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/SourceDBInstanceIdentifier cannot be added or changed in place/)
      );
      expect(result.effectiveProperties).toMatchObject({ SourceDBInstanceIdentifier: 'source-1' });
    });

    it('accepts the same source re-spelled from its identifier to its same-region ARN', async () => {
      await update(REPLICA, { ...REPLICA, SourceDBInstanceIdentifier: 'source-1' });
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('refuses a cross-region live source of the same name as the declared same-region ARN', async () => {
      pinLiveSource(`arn:aws:rds:us-west-2:${ACCOUNT}:db:source-1`);
      const { SourceDBInstanceIdentifier: _source, ...unrecorded } = REPLICA;
      await expect(update(REPLICA, unrecorded)).rejects.toBeInstanceOf(
        ResourceUpdateNotSupportedError
      );
    });

    it('a template naming the same source by identifier instead of ARN is refused, as CloudFormation compares it as written', async () => {
      replicaSource = 'other-1';
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: unknown, region: unknown) => {
        replicaSource = 'other-1';
        return inner(command, region);
      });
      await expect(
        update({ ...REPLICA, SourceDBInstanceIdentifier: 'source-1' }, REPLICA)
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    });
    it('refuses a source that is not a string before any call', async () => {
      await expect(
        update({ ...REPLICA, SourceDBInstanceIdentifier: { Ref: 'Db' } }, REPLICA)
      ).rejects.toThrow(/SourceDBInstanceIdentifier must be a string/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names an instance deleted outside cdkd in the refusal', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) =>
        command.constructor.name === 'DescribeDBInstancesCommand'
          ? Promise.reject(
              Object.assign(new Error('DBInstance db-1 not found.'), {
                name: 'DBInstanceNotFoundFault',
              })
            )
          : inner(command, region)
      );
      const { SourceDBInstanceIdentifier: _source, ...unrecorded } = REPLICA;
      await expect(update(REPLICA, unrecorded)).rejects.toThrow(/RDS reports no such DB instance/);
    });

    it('refuses a changed zone before it promotes, so nothing is applied', async () => {
      const { SourceDBInstanceIdentifier: _source, ...promoted } = REPLICA;
      arm({ replica: { AvailabilityZone: 'us-east-1a' } });
      await expect(
        update(
          { ...promoted, AvailabilityZone: 'us-east-1b' },
          { ...REPLICA, AvailabilityZone: 'us-east-1a' }
        )
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
    });

    it('a rollback replay does not promote, and records the source the instance keeps', async () => {
      const { SourceDBInstanceIdentifier: _source, ...unrecorded } = REPLICA;
      const result = await update(unrecorded, REPLICA, { replayingState: true });
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/the rollback does not promote the read replica/)
      );
      expect(result.effectiveProperties).toMatchObject({ SourceDBInstanceIdentifier: SOURCE_ARN });
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

  });

  describe('delete', () => {
    const del = (properties: Input) =>
      provider.delete('L', 'db-1', INSTANCE, { ...properties }, {
        finalSnapshotIdentifier: 'db-1-final-20261108',
        expectedRegion: 'us-east-1',
      });

    const deleteInput = (): Input => {
      const [input] = sent('DeleteDBInstanceCommand');
      return input!;
    };

    /** The instance reads gone after its delete. */
    const goneAfterDelete = (): void => {
      let deleted = false;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) => {
        if (command.constructor.name === 'DeleteDBInstanceCommand') deleted = true;
        if (deleted && command.constructor.name === 'DescribeDBInstancesCommand') {
          return Promise.reject(
            Object.assign(new Error('DBInstance db-1 not found.'), { name: 'DBInstanceNotFoundFault' })
          );
        }
        return inner(command, region);
      });
    };

    it('deletes a live read replica without a final snapshot, as CloudFormation does', async () => {
      goneAfterDelete();
      await del(REPLICA);
      expect(deleteInput()).toMatchObject({ DBInstanceIdentifier: 'db-1', SkipFinalSnapshot: true });
      expect(deleteInput()).not.toHaveProperty('FinalDBSnapshotIdentifier');
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/without a final snapshot: it is a read replica/));
    });

    it('keeps the final snapshot of a replica promoted outside cdkd', async () => {
      replicaSource = undefined;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: unknown, region: unknown) => {
        replicaSource = undefined;
        return inner(command, region);
      });
      goneAfterDelete();
      await del(REPLICA);
      expect(deleteInput()).toMatchObject({
        SkipFinalSnapshot: false,
        FinalDBSnapshotIdentifier: 'db-1-final-20261108',
      });
    });

    it('keeps the final snapshot when the instance cannot be read', async () => {
      let first = true;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) => {
        if (command.constructor.name === 'DescribeDBInstancesCommand' && first) {
          first = false;
          return Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }));
        }
        return inner(command, region);
      });
      goneAfterDelete();
      await del(REPLICA);
      expect(deleteInput()).toMatchObject({ FinalDBSnapshotIdentifier: 'db-1-final-20261108' });
    });

    it('reads nothing extra for a record declaring no source', async () => {
      const { SourceDBInstanceIdentifier: _source, ...standalone } = REPLICA;
      goneAfterDelete();
      await del(standalone);
      const names = calls().map((call) => call.name);
      expect(names[0]).toBe('DeleteDBInstanceCommand');
      expect(deleteInput()).toMatchObject({ FinalDBSnapshotIdentifier: 'db-1-final-20261108' });
    });

    it('a replica of a DB cluster is deleted without a final snapshot too', async () => {
      arm({ replica: { ReadReplicaSourceDBClusterIdentifier: 'cluster-1' } });
      pinLiveSource(undefined);
      goneAfterDelete();
      await del(REPLICA);
      expect(deleteInput()).toMatchObject({ SkipFinalSnapshot: true });
    });
  });

  describe('readback', () => {
    it("reports a replica's source as an ARN in its own region and account, and none once promoted", async () => {
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).toMatchObject({
        SourceDBInstanceIdentifier: SOURCE_ARN,
      });
      replicaSource = undefined;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: unknown, region: unknown) => {
        replicaSource = undefined;
        return inner(command, region);
      });
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).not.toHaveProperty(
        'SourceDBInstanceIdentifier'
      );
    });

    it.each([
      ['the reported identifier', 'source-1', true],
      ['the same ARN re-cased', SOURCE_ARN.replace('source-1', 'Source-1'), true],
      ['another instance', 'other-1', false],
      ['a same-named instance in another region', `arn:aws:rds:us-west-2:${ACCOUNT}:db:source-1`, false],
      ['a same-named instance in another account', 'arn:aws:rds:us-east-1:999999999999:db:source-1', false],
    ])('drift pairs the template ARN with %s: %s', async (_, live, same) => {
      const baseline = { SourceDBInstanceIdentifier: SOURCE_ARN };
      const aws = { SourceDBInstanceIdentifier: live };
      const out = await provider.canonicalizeDriftPair(INSTANCE, baseline, aws);
      expect(out.aws['SourceDBInstanceIdentifier'] === SOURCE_ARN).toBe(same);
      expect(out.baseline).toBe(baseline);
    });

    it('drift keeps a record naming another account against the own-account readback', async () => {
      const readback = await provider.readCurrentState('db-1', 'L', INSTANCE);
      const baseline = { SourceDBInstanceIdentifier: 'arn:aws:rds:us-east-1:999999999999:db:source-1' };
      const out = await provider.canonicalizeDriftPair(
        INSTANCE,
        baseline,
        readback as Record<string, unknown>
      );
      expect(out.aws['SourceDBInstanceIdentifier']).toBe(SOURCE_ARN);
    });
  });

  // CloudFormation's handler refuses an unknown SourceRegion
  // (`Validations.validateSourceRegion`) and otherwise only gives it to the
  // Java SDK, which presigns the cross-region URL for it and keeps it off the
  // wire. The JS SDK presigns the same URL from the source ARN by itself.
  describe('SourceRegion', () => {
    const CROSS_ARN = `arn:aws:rds:us-west-2:${ACCOUNT}:db:source-1`;
    const CROSS: Input = { ...REPLICA, SourceDBInstanceIdentifier: CROSS_ARN };

    it('sends nothing for it: the create is the one an undeclared SourceRegion sends', async () => {
      await provider.create('L', INSTANCE, { ...CROSS });
      const [without] = sent('CreateDBInstanceReadReplicaCommand');
      mockSend.mockClear();
      await provider.create('L', INSTANCE, { ...CROSS, SourceRegion: 'us-west-2' });
      const [withRegion] = sent('CreateDBInstanceReadReplicaCommand');
      expect(withRegion).toEqual(without);
      expect(withRegion).not.toHaveProperty('SourceRegion');
      expect(withRegion).toMatchObject({ SourceDBInstanceIdentifier: CROSS_ARN });
    });

    it('a standalone instance declaring it creates as before, with no SourceRegion member', async () => {
      const { SourceDBInstanceIdentifier: _source, ...standalone } = REPLICA;
      await provider.create('L', INSTANCE, {
        ...standalone,
        Engine: 'postgres',
        MasterUsername: 'postgres',
        MasterUserPassword: 'not-a-secret',
        SourceRegion: 'us-west-2',
      });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
      const [create] = sent('CreateDBInstanceCommand');
      expect(create).toBeDefined();
      expect(create).not.toHaveProperty('SourceRegion');
    });

    it.each([
      ['an upper-cased region, as the handler lower-cases it', 'US-WEST-2'],
      ['a GovCloud region', 'us-gov-west-1'],
      ['a China region', 'cn-north-1'],
      ['an empty value, as the handler skips a blank one', ''],
      ['a whitespace-only value, which the handler skips as blank too', '   '],
      ["one of the Java SDK's global pseudo regions", 'aws-global'],
    ])('accepts %s', async (_, value) => {
      await provider.create('L', INSTANCE, { ...CROSS, SourceRegion: value });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
    });

    it.each([
      ['a name no partition knows', 'mars-north-1', /Unknown source region/],
      ['a service name', 's3', /Unknown source region/],
      ['a region with surrounding space', ' us-west-2', /Unknown source region/],
      ['an unresolved intrinsic', { Ref: 'SourceRegionParam' }, /SourceRegion must be a string/],
    ])('refuses %s before any call', async (_, value, says) => {
      await expect(
        provider.create('L', INSTANCE, { ...CROSS, SourceRegion: value })
      ).rejects.toThrow(says);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('only warns on a rollback replay of a recorded state, and creates the replica', async () => {
      await provider.create(
        'L',
        INSTANCE,
        { ...CROSS, SourceRegion: 'mars-north-1' },
        { replayingState: true }
      );
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Unknown source region.*ignored/));
      expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
    });

    it('is a path drift cannot compare (DescribeDBInstances never returns it)', () => {
      expect(provider.getDriftUnknownPaths(INSTANCE, { ...CROSS, SourceRegion: 'us-west-2' })).toContain(
        'SourceRegion'
      );
    });

    // The premise the wiring rests on, against the REAL client and middleware
    // (only the HTTP handler is faked): a cross-region ARN source gets a
    // PreSignedUrl signed for the ARN's region, a same-region one none.
    describe('the JS SDK presigns from the source ARN', () => {
      async function wireBody(source: string, region = 'us-east-1'): Promise<string> {
        const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>(
          '@aws-sdk/client-rds'
        );
        let body = '';
        const client = new actual.RDSClient({
          region,
          credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' },
          requestHandler: {
            handle: async (request: { body?: unknown }) => {
              body = String(request.body);
              throw new Error('captured');
            },
          },
        });
        try {
          await client
            .send(
              new actual.CreateDBInstanceReadReplicaCommand({
                DBInstanceIdentifier: 'db-1',
                SourceDBInstanceIdentifier: source,
              })
            )
            .catch(() => undefined);
        } finally {
          client.destroy();
        }
        // Twice: the presigned URL is itself a percent-encoded form value.
        return decodeURIComponent(decodeURIComponent(body));
      }

      it('a cross-region source', async () => {
        const body = await wireBody(CROSS_ARN);
        expect(body).toMatch(/PreSignedUrl=https:\/\/rds\.us-west-2\.amazonaws\.com/);
        expect(body).toContain('DestinationRegion=us-east-1');
        expect(body).toContain('X-Amz-Credential=AKIDEXAMPLE/');
        expect(body).toMatch(/\/us-west-2\/rds\/aws4_request/);
        expect(body).not.toMatch(/(^|&)SourceRegion=/);
      });

      it('a same-region source', async () => {
        const body = await wireBody(SOURCE_ARN);
        expect(body).toContain('SourceDBInstanceIdentifier=');
        expect(body).not.toContain('PreSignedUrl');
      });

      // Why an aws-cn cross-region replica keeps the Cloud Control route: the
      // URL is signed for the commercial host, not `amazonaws.com.cn`.
      it('an aws-cn cross-region source, for the commercial host', async () => {
        const body = await wireBody(`arn:aws-cn:rds:cn-northwest-1:${ACCOUNT}:db:source-1`, 'cn-north-1');
        expect(body).toMatch(/PreSignedUrl=https:\/\/rds\.cn-northwest-1\.amazonaws\.com\/\?/);
        expect(body).not.toContain('amazonaws.com.cn');
      });
    });

    describe('routing an aws-cn cross-region replica through Cloud Control', () => {
      const CN_SOURCE = `arn:aws-cn:rds:cn-northwest-1:${ACCOUNT}:db:source-1`;
      const routeDriving = (bag: Input, allowed: ReadonlySet<string> = new Set()) =>
        findActionableSdkUnwired(INSTANCE, bag, allowed).map((d) => d.property);
      let savedRegion: string | undefined;
      beforeEach(() => {
        savedRegion = process.env['AWS_REGION'];
        process.env['AWS_REGION'] = 'cn-north-1';
      });
      afterEach(() => {
        if (savedRegion === undefined) delete process.env['AWS_REGION'];
        else process.env['AWS_REGION'] = savedRegion;
      });

      it('routes a source ARN in another aws-cn region, SourceRegion declared or not', () => {
        for (const bag of [
          { ...REPLICA, SourceDBInstanceIdentifier: CN_SOURCE },
          { ...REPLICA, SourceDBInstanceIdentifier: CN_SOURCE, SourceRegion: 'cn-northwest-1' },
        ]) {
          expect(routeDriving(bag)).toEqual(['SourceDBInstanceIdentifier']);
        }
        expect(findActionableSdkUnwired(INSTANCE, { SourceDBInstanceIdentifier: CN_SOURCE }, new Set())).toEqual([
          { property: 'SourceDBInstanceIdentifier', rationale: AWS_CN_CROSS_REGION_REPLICA_RATIONALE },
        ]);
      });

      it('routes it when the deploying region is unknown', () => {
        delete process.env['AWS_REGION'];
        expect(routeDriving({ SourceDBInstanceIdentifier: CN_SOURCE })).toEqual([
          'SourceDBInstanceIdentifier',
        ]);
      });

      it.each([
        ['a same-region aws-cn source', `arn:aws-cn:rds:cn-north-1:${ACCOUNT}:db:source-1`],
        ['a commercial cross-region source', CROSS_ARN],
        ['a bare identifier', 'source-1'],
        ['an unresolved intrinsic', { 'Fn::GetAtt': ['Source', 'DBInstanceArn'] }],
      ])('keeps the SDK route for %s', (_, source) => {
        expect(routeDriving({ ...REPLICA, SourceDBInstanceIdentifier: source })).toEqual([]);
      });

      it('keeps the SDK route when --prefer-sdk-route names the key', () => {
        expect(
          routeDriving(
            { SourceDBInstanceIdentifier: CN_SOURCE },
            new Set([`${INSTANCE}:SourceDBInstanceIdentifier`])
          )
        ).toEqual([]);
      });

      it('narrows nothing away: the key stays a handled one', () => {
        expect(findSdkUnwiredProperties(INSTANCE, { SourceDBInstanceIdentifier: CN_SOURCE })).toEqual(
          []
        );
      });
    });
  });
});
