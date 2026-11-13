// go-to-k/cdkd#5640: `SourceDBClusterIdentifier` on the SDK route for
// AWS::RDS::DBInstance, a read replica of a Multi-AZ DB cluster, following
// CloudFormation's RDS handler (`ResourceModelHelper.isDBClusterReadReplica`):
// CreateDBInstanceReadReplica with the cluster as its source, the engine read
// from DescribeDBClusters (`fetchEngine`), the same after-create
// ModifyDBInstance as an instance replica; a removed source promotes the
// replica, an added or changed one is refused
// (`isSourceDBClusterIdentifierMutable`); the replica is deleted without a
// final snapshot only while RDS reports it a replica.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warn, info, clientRegions } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  clientRegions: [] as (string | undefined)[],
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
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  findActionableSdkUnwired,
  findSdkUnwiredProperties,
} from '../../../src/provisioning/property-coverage.js';

type Input = Record<string, unknown>;

const INSTANCE = 'AWS::RDS::DBInstance';
const ACCOUNT = '123456789012';
const CLUSTER_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:maz-1`;
const SOURCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db:source-1`;

interface Live {
  /** The replica's own DescribeDBInstances fields. */
  replica?: Input;
  /** The cluster's engine, as DescribeDBClusters reports it. */
  clusterEngine?: string;
  /** DescribeDBClusters lists no cluster. */
  noCluster?: boolean;
}

/** The cluster the instance reads back as replicating (`undefined`: standalone). */
let liveClusterSource: string | undefined;

/**
 * DescribeDBClusters answers `maz-1`, available; DescribeDBInstances answers
 * the instance `db-1`, replicating `maz-1` until PromoteReadReplica, and the
 * instance `source-1` (a point-in-time source).
 */
function arm(live: Live = {}): void {
  liveClusterSource = 'maz-1';
  mockSend.mockImplementation((command: { constructor: { name: string }; input: Input }) => {
    switch (command.constructor.name) {
      case 'DescribeDBClustersCommand':
        return Promise.resolve({
          DBClusters: live.noCluster
            ? []
            : [
                {
                  DBClusterIdentifier: 'maz-1',
                  Engine: live.clusterEngine ?? 'postgres',
                  Status: 'available',
                },
              ],
        });
      case 'DescribeDBInstancesCommand':
        if (command.input['DBInstanceIdentifier'] === 'source-1') {
          return Promise.resolve({
            DBInstances: [
              { DBInstanceIdentifier: 'source-1', Engine: 'postgres', DBInstanceStatus: 'available' },
            ],
          });
        }
        return Promise.resolve({
          DBInstances: [
            {
              DBInstanceIdentifier: 'db-1',
              DBInstanceArn: `arn:aws:rds:us-east-1:${ACCOUNT}:db:db-1`,
              DBInstanceStatus: 'available',
              Engine: live.clusterEngine ?? 'postgres',
              ...(liveClusterSource !== undefined && {
                ReadReplicaSourceDBClusterIdentifier: liveClusterSource,
              }),
              ...live.replica,
            },
          ],
        });
      case 'CreateDBInstanceReadReplicaCommand':
      case 'CreateDBInstanceCommand':
      case 'RestoreDBInstanceToPointInTimeCommand':
        return Promise.resolve({
          DBInstance: { DBInstanceIdentifier: 'db-1', Engine: live.clusterEngine ?? 'postgres' },
        });
      case 'PromoteReadReplicaCommand':
        liveClusterSource = undefined;
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

/** Pins the cluster the instance reads back as replicating (`undefined`: standalone). */
function pinLiveSource(value: string | undefined): void {
  liveClusterSource = value;
  const inner = mockSend.getMockImplementation()!;
  mockSend.mockImplementation((command: unknown, region: unknown) => {
    liveClusterSource = value;
    return inner(command, region);
  });
}

/** A DB instance replica of a Multi-AZ DB cluster (no Engine, no credentials). */
const REPLICA: Input = {
  DBInstanceIdentifier: 'db-1',
  DBInstanceClass: 'db.t3.micro',
  SourceDBClusterIdentifier: 'maz-1',
  DBSubnetGroupName: 'subnets-1',
  VPCSecurityGroups: ['sg-1'],
  StorageType: 'gp3',
  AllocatedStorage: '100',
  PubliclyAccessible: false,
  Tags: [{ Key: 'team', Value: 'db' }],
};

const withoutSource = (bag: Input): Input => {
  const { SourceDBClusterIdentifier: _source, ...rest } = bag;
  return rest;
};

describe('RDS DBInstance read replica of a Multi-AZ DB cluster (go-to-k/cdkd#5640)', () => {
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
  });

  const update = (next: Input, prev: Input, context?: UpdateContext) =>
    provider.update('L', 'db-1', INSTANCE, { ...next }, { ...prev }, context);

  describe('create', () => {
    it('creates the replica with CreateDBInstanceReadReplica from the cluster, carrying the declared members', async () => {
      const result = await provider.create('L', INSTANCE, { ...REPLICA });

      expect(sent('CreateDBInstanceCommand')).toEqual([]);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          SourceDBClusterIdentifier: 'maz-1',
          DBInstanceClass: 'db.t3.micro',
          DBSubnetGroupName: 'subnets-1',
          VpcSecurityGroupIds: ['sg-1'],
          StorageType: 'gp3',
          AllocatedStorage: 100,
          PubliclyAccessible: false,
          Tags: [{ Key: 'team', Value: 'db' }],
        },
      ]);
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(result.physicalId).toBe('db-1');
    });

    it("reads the cluster's engine (by the declared ARN, account included) when the template declares none", async () => {
      await provider.create('L', INSTANCE, { ...REPLICA, SourceDBClusterIdentifier: CLUSTER_ARN });
      expect(sent('DescribeDBClustersCommand')[0]).toEqual({ DBClusterIdentifier: CLUSTER_ARN });
      expect(sent('CreateDBInstanceReadReplicaCommand')[0]).toMatchObject({
        SourceDBClusterIdentifier: CLUSTER_ARN,
      });
      // The cluster is no DB instance: nothing reads it as one.
      expect(sent('DescribeDBInstancesCommand')).not.toContainEqual({
        DBInstanceIdentifier: CLUSTER_ARN,
      });
    });

    it('reads no engine when the template declares one', async () => {
      await provider.create('L', INSTANCE, { ...REPLICA, Engine: 'postgres' });
      expect(sent('DescribeDBClustersCommand')).toEqual([]);
      expect(sent('CreateDBInstanceReadReplicaCommand')[0]).not.toHaveProperty('Engine');
    });

    it("the cluster's engine decides the storage members: SQL Server (unknown too) moves them to the follow-up", async () => {
      arm({ clusterEngine: 'sqlserver-ee' });
      await provider.create('L', INSTANCE, { ...REPLICA });
      const [create] = sent('CreateDBInstanceReadReplicaCommand');
      expect(create).not.toHaveProperty('AllocatedStorage');
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({
        AllocatedStorage: 100,
        StorageType: 'gp3',
      });
    });

    it("a cross-region cluster ARN is read in its own region, and a MySQL one carries no parameter group (the handler's cross-region rule reads the instance key only)", async () => {
      arm({ clusterEngine: 'mysql' });
      const cross = `arn:aws:rds:us-west-2:${ACCOUNT}:cluster:maz-1`;
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        SourceDBClusterIdentifier: cross,
        DBParameterGroupName: 'pg-1',
      });
      expect(calls().find((c) => c.name === 'DescribeDBClustersCommand')?.region).toBe('us-west-2');
      expect(sent('CreateDBInstanceReadReplicaCommand')[0]).not.toHaveProperty('DBParameterGroupName');
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({ DBParameterGroupName: 'pg-1' });
    });

    it('sends the members the create cannot carry in one ModifyDBInstance once it is available', async () => {
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        BackupRetentionPeriod: '7',
        PreferredBackupWindow: '03:00-04:00',
        DeletionProtection: true,
      });
      expect(sent('ModifyDBInstanceCommand')).toEqual([
        {
          DBInstanceIdentifier: 'db-1',
          ApplyImmediately: true,
          BackupRetentionPeriod: 7,
          PreferredBackupWindow: '03:00-04:00',
          DeletionProtection: true,
        },
      ]);
      const names = calls().map((c) => c.name);
      expect(names.indexOf('CreateDBInstanceReadReplicaCommand')).toBeLessThan(
        names.indexOf('ModifyDBInstanceCommand')
      );
    });

    it('names a follow-up-only member when no follow-up runs', async () => {
      await provider.create('L', INSTANCE, { ...REPLICA, MaxAllocatedStorage: 200 });
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/MaxAllocatedStorage not applied: only CloudFormation's after-create/)
      );
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

    it('a refused create is not marked created', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) =>
        command.constructor.name === 'CreateDBInstanceReadReplicaCommand'
          ? Promise.reject(Object.assign(new Error('not a Multi-AZ DB cluster'), { name: 'InvalidParameterCombination' }))
          : inner(command, region)
      );
      const error = await provider.create('L', INSTANCE, { ...REPLICA }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(hasCreatedBeforeFailure(error)).toBe(false);
    });

    it('fails before the create when the cluster cannot be found, as the handler does', async () => {
      arm({ noCluster: true });
      const error = await provider.create('L', INSTANCE, { ...REPLICA }).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/DescribeDBClusters reported no source DB cluster maz-1/);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
    });

    it('fails before the create when a cross-region cluster cannot be found in its region', async () => {
      arm({ noCluster: true });
      const cross = `arn:aws:rds:us-west-2:${ACCOUNT}:cluster:maz-1`;
      const error = await provider
        .create('L', INSTANCE, { ...REPLICA, SourceDBClusterIdentifier: cross })
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/reported no source DB cluster/);
      expect(calls().find((c) => c.name === 'DescribeDBClustersCommand')).toMatchObject({
        region: 'us-west-2',
        input: { DBClusterIdentifier: cross },
      });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
    });

    it('resends a create refused while the cluster is busy, reading the cluster status', async () => {
      let refused = false;
      const statuses = ['modifying', 'available'];
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) => {
        if (command.constructor.name === 'CreateDBInstanceReadReplicaCommand' && !refused) {
          refused = true;
          return Promise.reject(
            Object.assign(new Error('DB instance is not in the available state'), {
              name: 'InvalidDBInstanceStateFault',
            })
          );
        }
        if (command.constructor.name === 'DescribeDBClustersCommand' && statuses.length > 0) {
          return Promise.resolve({
            DBClusters: [{ DBClusterIdentifier: 'maz-1', Engine: 'postgres', Status: statuses.shift() }],
          });
        }
        return inner(command, region);
      });
      await provider.create('L', INSTANCE, { ...REPLICA, Engine: 'postgres' });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(2);
      expect(sent('DescribeDBClustersCommand').length).toBeGreaterThanOrEqual(1);
    });

    it('names the source DB cluster when it reads a status that does not end on its own', async () => {
      // Bounded: should the status be read from anywhere but the cluster (which
      // reads `failed`), the fourth create succeeds and the message assertion fails.
      let creates = 0;
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) => {
        if (command.constructor.name === 'CreateDBInstanceReadReplicaCommand' && ++creates <= 3) {
          return Promise.reject(
            Object.assign(new Error('DB instance is not in the available state'), {
              name: 'InvalidDBInstanceStateFault',
            })
          );
        }
        if (command.constructor.name === 'DescribeDBClustersCommand') {
          return Promise.resolve({
            DBClusters: [{ DBClusterIdentifier: 'maz-1', Engine: 'postgres', Status: 'failed' }],
          });
        }
        return inner(command, region);
      });
      const error = await provider
        .create('L', INSTANCE, { ...REPLICA, Engine: 'postgres' })
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(
        /refused the create of the read replica because the source DB cluster is not in the 'available' state, and it reads status 'failed'/
      );
      expect(creates).toBe(1);
    });

    it('fails before the create when the cluster read fails, propagating AWS\'s fault', async () => {
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((command: { constructor: { name: string } }, region: unknown) =>
        command.constructor.name === 'DescribeDBClustersCommand'
          ? Promise.reject(
              Object.assign(new Error('DBCluster maz-1 not found.'), { name: 'DBClusterNotFoundFault' })
            )
          : inner(command, region)
      );
      const error = await provider.create('L', INSTANCE, { ...REPLICA }).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/DBCluster maz-1 not found/);
      expect(sent('DescribeDBClustersCommand')).toEqual([{ DBClusterIdentifier: 'maz-1' }]);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
      expect(hasCreatedBeforeFailure(error)).toBe(false);
    });

    it.each([false, true])(
      'refuses both source keys before any call (replaying: %s), as RDS refuses the pair',
      async (replaying) => {
        const error = await provider
          .create(
            'L',
            INSTANCE,
            { ...REPLICA, SourceDBInstanceIdentifier: SOURCE_ARN },
            replaying ? { replayingState: true } : undefined
          )
          .catch((e: unknown) => e);
        expect((error as Error).message).toMatch(
          /set either SourceDBInstanceIdentifier or SourceDBClusterIdentifier, not both/
        );
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('refuses a cluster source that is not a string before any call', async () => {
      const error = await provider
        .create('L', INSTANCE, { ...REPLICA, SourceDBClusterIdentifier: { Ref: 'Cluster' } })
        .catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/SourceDBClusterIdentifier must be a string/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('an empty cluster source is a standalone instance, as the handler reads it', async () => {
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        SourceDBClusterIdentifier: '',
        Engine: 'postgres',
        MasterUsername: 'admin',
        MasterUserPassword: 'not-a-secret',
      });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
      expect(sent('CreateDBInstanceCommand')).toHaveLength(1);
    });

    it('a snapshot key beside it is not read, and the warning names the cluster source', async () => {
      await provider.create('L', INSTANCE, { ...REPLICA, DBSnapshotIdentifier: 'snap-1' });
      expect(sent('RestoreDBInstanceFromDBSnapshotCommand')).toEqual([]);
      expect(sent('CreateDBInstanceReadReplicaCommand')).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /DBSnapshotIdentifier not applied: SourceDBClusterIdentifier makes the instance a read replica/
        )
      );
    });

    it('a point-in-time key makes a restore instead, which names the cluster source as not applied', async () => {
      await provider.create('L', INSTANCE, {
        ...REPLICA,
        Engine: 'postgres',
        SourceDBInstanceIdentifier: 'source-1',
        UseLatestRestorableTime: true,
      });
      expect(sent('CreateDBInstanceReadReplicaCommand')).toEqual([]);
      const [restore] = sent('RestoreDBInstanceToPointInTimeCommand');
      expect(restore).toMatchObject({ SourceDBInstanceIdentifier: 'source-1' });
      expect(restore).not.toHaveProperty('SourceDBClusterIdentifier');
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/SourceDBClusterIdentifier not applied: a restore to a point in time/)
      );
    });
  });

  describe('update', () => {
    it('promotes the replica when the template removes the cluster source, before the ModifyDBInstance', async () => {
      await update({ ...withoutSource(REPLICA), BackupRetentionPeriod: 7 }, REPLICA);
      expect(sent('PromoteReadReplicaCommand')).toEqual([
        { DBInstanceIdentifier: 'db-1', BackupRetentionPeriod: 7 },
      ]);
      const names = calls().map((c) => c.name);
      expect(names.indexOf('PromoteReadReplicaCommand')).toBeLessThan(
        names.indexOf('ModifyDBInstanceCommand')
      );
      expect(info).toHaveBeenCalledWith(
        expect.stringMatching(/standalone instance \(SourceDBClusterIdentifier was removed\)/)
      );
    });

    it('does not promote an instance already standalone', async () => {
      pinLiveSource(undefined);
      await update(withoutSource(REPLICA), REPLICA);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
    });

    it('leaves an unchanged cluster source alone, reading nothing for it', async () => {
      await update({ ...REPLICA, DBInstanceClass: 'db.t3.small' }, REPLICA);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      // Neither the cluster nor a source instance is read.
      expect(sent('DescribeDBClustersCommand')).toEqual([]);
      expect(sent('DescribeDBInstancesCommand')).not.toContainEqual({ DBInstanceIdentifier: 'maz-1' });
      expect(sent('ModifyDBInstanceCommand')[0]).toMatchObject({ DBInstanceClass: 'db.t3.small' });
    });

    it.each([
      ['added', withoutSource(REPLICA), undefined],
      ['changed', { ...REPLICA, SourceDBClusterIdentifier: 'maz-0' }, 'maz-0'],
      ['switched from an instance source', { ...withoutSource(REPLICA), SourceDBInstanceIdentifier: SOURCE_ARN }, undefined],
    ])('refuses a cluster source %s on an existing instance before any change', async (_, prev, live) => {
      // Set once, not pinned: a wrong PromoteReadReplica clears it and completes.
      liveClusterSource = live;
      const error = await update(REPLICA, prev).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toMatch(
        /^.*SourceDBClusterIdentifier cannot be added or changed on an existing DB instance/
      );
      expect((error as Error).message).not.toMatch(/SourceDBInstanceIdentifier cannot/);
      expect((error as Error).message).toMatch(/"Resource is immutable"/);
      expect((error as Error).message.includes('here it replaces SourceDBInstanceIdentifier')).toBe(
        _ === 'switched from an instance source'
      );
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
    });

    it('refuses an instance source replacing a cluster source, naming both keys', async () => {
      // The live instance replicates `maz-1` until a PromoteReadReplica (`arm`),
      // so a wrong promotion completes and fails the assertion below.
      const next = { ...withoutSource(REPLICA), SourceDBInstanceIdentifier: SOURCE_ARN };
      const error = await update(next, REPLICA).catch((e: unknown) => e);
      expect((error as Error).message).toMatch(
        /SourceDBInstanceIdentifier cannot be added or changed on an existing DB instance/
      );
      expect((error as Error).message).toMatch(
        /Removing it promotes the replica instead \(here it replaces SourceDBClusterIdentifier, so nothing is promoted\)\./
      );
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
    });

    it('refuses both keys added at once unless the live instance replicates both, naming both', async () => {
      // The live instance replicates the cluster only: the added instance key fails the match.
      const next = { ...REPLICA, SourceDBInstanceIdentifier: SOURCE_ARN };
      const error = await update(next, withoutSource(REPLICA)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((error as Error).message).toMatch(
        /SourceDBInstanceIdentifier and SourceDBClusterIdentifier cannot be added or changed/
      );
      expect(sent('ModifyDBInstanceCommand')).toEqual([]);
    });

    it('accepts an added cluster source the live instance already replicates (a record that lacks it)', async () => {
      const result = await update(REPLICA, withoutSource(REPLICA));
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      expect(result.effectiveProperties).toBeUndefined();
    });

    it('accepts the cluster ARN against a live bare identifier in the own region', async () => {
      const result = await update(
        { ...REPLICA, SourceDBClusterIdentifier: CLUSTER_ARN },
        REPLICA
      );
      expect(result.effectiveProperties).toBeUndefined();
      expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
    });

    it('refuses a same-named cluster ARN in another region', async () => {
      const error = await update(
        { ...REPLICA, SourceDBClusterIdentifier: `arn:aws:rds:us-west-2:${ACCOUNT}:cluster:maz-1` },
        REPLICA
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('an instance source the live instance does not hold is no match for a live cluster source', async () => {
      // Live replicates `maz-1` as a CLUSTER; a declared instance `maz-1` is another source.
      const next = { ...withoutSource(REPLICA), SourceDBInstanceIdentifier: 'maz-1' };
      const error = await update(next, withoutSource(REPLICA)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('a rollback replay of an added cluster source warns and records the source the instance kept', async () => {
      pinLiveSource(undefined);
      const result = await update(REPLICA, withoutSource(REPLICA), { replayingState: true });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/SourceDBClusterIdentifier cannot be added or changed in place/)
      );
      expect(result.effectiveProperties).not.toHaveProperty('SourceDBClusterIdentifier');
    });

    it('a rollback replay does not promote, and records the cluster source the instance keeps', async () => {
      const result = await update(withoutSource(REPLICA), REPLICA, { replayingState: true });
      expect(sent('PromoteReadReplicaCommand')).toEqual([]);
      expect(result.effectiveProperties).toMatchObject({ SourceDBClusterIdentifier: 'maz-1' });
    });

    describe('on an instance restored to a point in time', () => {
      const PITR: Input = {
        DBInstanceIdentifier: 'db-1',
        DBInstanceClass: 'db.t3.micro',
        Engine: 'postgres',
        SourceDBInstanceIdentifier: 'source-1',
        UseLatestRestorableTime: true,
      };

      it.each([
        ['added', PITR, { ...PITR, SourceDBClusterIdentifier: 'maz-1' }],
        ['changed', { ...PITR, SourceDBClusterIdentifier: 'maz-0' }, { ...PITR, SourceDBClusterIdentifier: 'maz-1' }],
      ])('refuses a cluster source %s, as the handler fails it as immutable', async (_, prev, next) => {
        pinLiveSource(undefined);
        const error = await update(next, prev).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
        expect((error as Error).message).toMatch(
          /SourceDBClusterIdentifier cannot be added or changed on an existing DB instance — an instance is restored to a point in time/
        );
        expect(sent('ModifyDBInstanceCommand')).toEqual([]);
      });

      it('a removed one changes nothing and promotes nothing', async () => {
        pinLiveSource(undefined);
        await update(PITR, { ...PITR, SourceDBClusterIdentifier: 'maz-1' });
        expect(sent('PromoteReadReplicaCommand')).toEqual([]);
        expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      });

      it('a key the deploy did not change (a recorded stand-in) is not refused', async () => {
        pinLiveSource(undefined);
        await update(
          { ...PITR, SourceDBClusterIdentifier: 'maz-1', DBInstanceClass: 'db.t3.small' },
          { ...PITR, SourceDBClusterIdentifier: '{{resolve:ssm:/cluster}}' },
          { changedProperties: new Set(['DBInstanceClass']) }
        );
        expect(sent('ModifyDBInstanceCommand')).toHaveLength(1);
      });
    });
  });

  // The delete path fails CLOSED: only a live read reporting a replica skips
  // the final snapshot; a promoted or unreadable instance keeps it.
  describe('delete', () => {
    const del = (properties: Input) =>
      provider.delete('L', 'db-1', INSTANCE, { ...properties }, {
        finalSnapshotIdentifier: 'db-1-final-20261113',
        expectedRegion: 'us-east-1',
      });

    const deleteInput = (): Input => sent('DeleteDBInstanceCommand')[0]!;

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

    it('deletes a live cluster replica without a final snapshot, as CloudFormation does', async () => {
      goneAfterDelete();
      await del(REPLICA);
      expect(deleteInput()).toMatchObject({ DBInstanceIdentifier: 'db-1', SkipFinalSnapshot: true });
      expect(deleteInput()).not.toHaveProperty('FinalDBSnapshotIdentifier');
    });

    it('keeps the final snapshot of a cluster replica promoted outside cdkd', async () => {
      pinLiveSource(undefined);
      goneAfterDelete();
      await del(REPLICA);
      expect(deleteInput()).toMatchObject({
        SkipFinalSnapshot: false,
        FinalDBSnapshotIdentifier: 'db-1-final-20261113',
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
      expect(deleteInput()).toMatchObject({ FinalDBSnapshotIdentifier: 'db-1-final-20261113' });
    });
  });

  describe('readback', () => {
    it("reports the cluster source as a cluster ARN in the replica's own region and account, and none once promoted", async () => {
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).toMatchObject({
        SourceDBClusterIdentifier: CLUSTER_ARN,
      });
      pinLiveSource(undefined);
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).not.toHaveProperty(
        'SourceDBClusterIdentifier'
      );
    });

    it('keeps a reported ARN as it is', async () => {
      const other = `arn:aws:rds:us-east-1:999999999999:cluster:maz-1`;
      pinLiveSource(other);
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).toMatchObject({
        SourceDBClusterIdentifier: other,
      });
    });

    it('keeps a bare source when the instance reports no ARN to scope it by', async () => {
      arm({ replica: { DBInstanceArn: undefined } });
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).toMatchObject({
        SourceDBClusterIdentifier: 'maz-1',
      });
    });

    it('reports none for a cluster member', async () => {
      arm({ replica: { DBClusterIdentifier: 'aurora-1' } });
      expect(await provider.readCurrentState('db-1', 'L', INSTANCE)).not.toHaveProperty(
        'SourceDBClusterIdentifier'
      );
    });

    it.each([
      ['the readback of a bare record', 'maz-1', CLUSTER_ARN, true],
      ['the same ARN re-cased', CLUSTER_ARN, CLUSTER_ARN.replace('maz-1', 'Maz-1'), true],
      ['another cluster', CLUSTER_ARN, `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:maz-0`, false],
      ['a same-named cluster in another region', CLUSTER_ARN, `arn:aws:rds:us-west-2:${ACCOUNT}:cluster:maz-1`, false],
      ['a same-named cluster in another account', CLUSTER_ARN, 'arn:aws:rds:us-east-1:999999999999:cluster:maz-1', false],
    ])('drift pairs %s', async (_, recorded, live, same) => {
      const baseline = { SourceDBClusterIdentifier: recorded };
      const out = await provider.canonicalizeDriftPair(INSTANCE, baseline, {
        SourceDBClusterIdentifier: live,
      });
      expect(out.aws['SourceDBClusterIdentifier'] === recorded).toBe(same);
    });

    it('drift does not compare it on a point-in-time restore, and compares it on a replica', () => {
      expect(
        provider.getDriftUnknownPaths(INSTANCE, {
          SourceDBInstanceIdentifier: 'source-1',
          SourceDBClusterIdentifier: 'maz-1',
          UseLatestRestorableTime: true,
        })
      ).toContain('SourceDBClusterIdentifier');
      expect(provider.getDriftUnknownPaths(INSTANCE, REPLICA)).not.toContain(
        'SourceDBClusterIdentifier'
      );
    });
  });

  describe('routing', () => {
    it('keeps the SDK route: the key is handled', () => {
      expect(findSdkUnwiredProperties(INSTANCE, REPLICA)).toEqual([]);
    });

    it('routes nothing by value: RDS takes no cross-region cluster source, and none in China', () => {
      const saved = process.env['AWS_REGION'];
      process.env['AWS_REGION'] = 'cn-north-1';
      try {
        expect(
          findActionableSdkUnwired(
            INSTANCE,
            { ...REPLICA, SourceDBClusterIdentifier: `arn:aws-cn:rds:cn-northwest-1:${ACCOUNT}:cluster:maz-1` },
            new Set()
          )
        ).toEqual([]);
      } finally {
        if (saved === undefined) delete process.env['AWS_REGION'];
        else process.env['AWS_REGION'] = saved;
      }
    });
  });
});
