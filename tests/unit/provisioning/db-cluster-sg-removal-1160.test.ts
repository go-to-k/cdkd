// Issue #1160: a DB cluster's `VpcSecurityGroupIds` REMOVED from the template.
//
// A real CloudFormation A/B (us-east-1, stack `Cdkd1160SgAb`) removed the
// property from an AWS::RDS::DBCluster, an AWS::Neptune::DBCluster and an
// AWS::DocDB::DBCluster that each held one custom security group:
//   - RDS and Neptune: CloudFormation moved the cluster to the VPC's `default`
//     security group.
//   - DocDB: CloudFormation kept the custom group.
// ModifyDBCluster merges (an omitted field is "no change"), so RDS / Neptune
// must look the default group up and send it, while DocDB sends nothing.
// The empty-list guard stays: `[]` would detach every group, and
// `readCurrentState` emits `[]` for a cluster with none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const dbSend = vi.fn();
const ec2Send = vi.fn();

function dbClientMock(name: string) {
  return async (importOriginal: () => Promise<unknown>) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      [name]: vi.fn().mockImplementation(() => ({
        send: dbSend,
        config: { region: () => Promise.resolve('us-east-1') },
      })),
    };
  };
}

vi.mock('@aws-sdk/client-rds', dbClientMock('RDSClient'));
vi.mock('@aws-sdk/client-neptune', dbClientMock('NeptuneClient'));
vi.mock('@aws-sdk/client-docdb', dbClientMock('DocDBClient'));
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    EC2Client: vi.fn().mockImplementation(() => ({ send: ec2Send })),
  };
});

const loggerWarn = vi.fn();
const loggerDebug = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: (...args: unknown[]) => loggerDebug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarn(...args),
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
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
} from '../../../src/deployment/retryable-errors/marks.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const SUBNET_GROUP = 'my-subnets';
const VPC_ID = 'vpc-0abc';
const DEFAULT_SG = 'sg-0default';
const MEMBER = 'member-1';

/**
 * Routes each DB-client command by name; the cluster sits in SUBNET_GROUP. The
 * cluster reads back `available` with whatever groups the last ModifyDBCluster
 * sent, all `active`, and one member instance, `available`.
 */
function routeDbSends(overrides: Record<string, () => unknown> = {}) {
  let liveGroups: string[] = [];
  dbSend.mockImplementation(async (command: { constructor: { name: string }; input?: any }) => {
    const name = command.constructor.name;
    if (name === 'ModifyDBClusterCommand' && Array.isArray(command.input?.VpcSecurityGroupIds)) {
      liveGroups = [...new Set<string>(command.input.VpcSecurityGroupIds)];
    }
    if (overrides[name]) return overrides[name]();
    if (name === 'DescribeDBClustersCommand') {
      return {
        DBClusters: [
          {
            DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:c',
            DBSubnetGroup: SUBNET_GROUP,
            Status: 'available',
            VpcSecurityGroups: liveGroups.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
            DBClusterMembers: [{ DBInstanceIdentifier: MEMBER }],
          },
        ],
      };
    }
    if (name === 'DescribeDBInstancesCommand') {
      return { DBInstances: [{ DBInstanceIdentifier: MEMBER, DBInstanceStatus: 'available' }] };
    }
    if (name === 'DescribeDBSubnetGroupsCommand') {
      return { DBSubnetGroups: [{ DBSubnetGroupName: SUBNET_GROUP, VpcId: VPC_ID }] };
    }
    if (name === 'ListTagsForResourceCommand') return { TagList: [] };
    return {};
  });
}

function routeEc2Sends(groups: Array<{ GroupId?: string }> = [{ GroupId: DEFAULT_SG }]) {
  ec2Send.mockImplementation(async () => ({ SecurityGroups: groups }));
}

const modifyInput = (): Record<string, unknown> | undefined => {
  const call = dbSend.mock.calls.find((c) => c[0].constructor.name === 'ModifyDBClusterCommand');
  return call?.[0].input as Record<string, unknown> | undefined;
};

const dbCommandNames = (): string[] => dbSend.mock.calls.map((c) => c[0].constructor.name);

const countOf = (command: string): number =>
  dbSend.mock.calls.filter((c) => c[0].constructor.name === command).length;

/** No real sleeps: the waiters poll through `sleep`. */
function withoutSleep<T extends object>(provider: T): T {
  (provider as unknown as { sleep: () => Promise<void> }).sleep = vi.fn().mockResolvedValue(undefined);
  return provider;
}

const RESETTING = [
  { label: 'RDS', type: 'AWS::RDS::DBCluster', make: () => withoutSleep(new RDSProvider()) },
  {
    label: 'Neptune',
    type: 'AWS::Neptune::DBCluster',
    make: () => withoutSleep(new NeptuneProvider()),
  },
] as const;

const ALL_THREE = [
  ...RESETTING,
  { label: 'DocDB', type: 'AWS::DocDB::DBCluster', make: () => withoutSleep(new DocDBProvider()) },
] as const;

describe.each(ALL_THREE)(
  '$label DBCluster: a changed VpcSecurityGroupIds waits for the cluster and its members to settle (#1160)',
  ({ type, make }) => {
    beforeEach(() => {
      vi.clearAllMocks();
      delete process.env['CDKD_NO_WAIT'];
      routeDbSends();
      routeEc2Sends();
      // Every wait polls against Date.now with sleep mocked out: a clock that
      // moves keeps a regressed wait FINITE (it times out and fails the case)
      // instead of spinning the event loop.
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('waits through a group swap still in progress, then for each member instance', async () => {
      let reads = 0;
      routeDbSends({
        DescribeDBClustersCommand: () => {
          reads += 1;
          // The post-update describe and the first poll see the swap in flight.
          const settled = reads > 2;
          return {
            DBClusters: [
              {
                DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:c',
                DBSubnetGroup: SUBNET_GROUP,
                Status: settled ? 'available' : 'modifying',
                VpcSecurityGroups: [
                  { VpcSecurityGroupId: 'sg-new', Status: settled ? 'active' : 'adding' },
                  ...(settled ? [] : [{ VpcSecurityGroupId: 'sg-old', Status: 'removing' }]),
                ],
                DBClusterMembers: [{ DBInstanceIdentifier: MEMBER }],
              },
            ],
          };
        },
      });

      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(reads).toBe(3);
      expect(countOf('DescribeDBInstancesCommand')).toBe(1);
    });

    it('waits on an available cluster that still reports the OLD groups', async () => {
      let reads = 0;
      routeDbSends({
        DescribeDBClustersCommand: () => {
          reads += 1;
          const ids = reads > 2 ? ['sg-new'] : ['sg-old'];
          return {
            DBClusters: [
              {
                DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:c',
                DBSubnetGroup: SUBNET_GROUP,
                Status: 'available',
                VpcSecurityGroups: ids.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
                DBClusterMembers: [],
              },
            ],
          };
        },
      });

      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(reads).toBe(3);
    });

    it('settles on a list with a duplicate entry, which AWS reads back once', async () => {
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-a', 'sg-a'] },
        { VpcSecurityGroupIds: ['sg-b'] }
      );

      expect(countOf('DescribeDBClustersCommand')).toBe(2);
    });

    it('does not hold the update for a cluster in a lasting state once the groups are active', async () => {
      routeDbSends({
        DescribeDBClustersCommand: () => ({
          DBClusters: [
            {
              DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:c',
              Status: 'backing-up',
              VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-new', Status: 'active' }],
              DBClusterMembers: [],
            },
          ],
        }),
      });

      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(countOf('DescribeDBClustersCommand')).toBe(2);
    });

    it('waits out a member that is modifying, then stops', async () => {
      let reads = 0;
      routeDbSends({
        DescribeDBInstancesCommand: () => {
          reads += 1;
          return {
            DBInstances: [{ DBInstanceIdentifier: MEMBER, DBInstanceStatus: reads > 1 ? 'available' : 'modifying' }],
          };
        },
      });

      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(reads).toBe(2);
    });

    it('does not hold the update for a member in a lasting state', async () => {
      routeDbSends({
        DescribeDBInstancesCommand: () => ({
          DBInstances: [{ DBInstanceIdentifier: MEMBER, DBInstanceStatus: 'maintenance' }],
        }),
      });

      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(countOf('DescribeDBInstancesCommand')).toBe(1);
    });

    it('skips a member deleted out of band', async () => {
      routeDbSends({
        DescribeDBInstancesCommand: () => {
          throw Object.assign(new Error('DBInstance member-1 not found.'), {
            name: 'DBInstanceNotFoundFault',
          });
        },
      });

      await expect(
        make().update(
          'Cluster',
          'my-cluster',
          type,
          { VpcSecurityGroupIds: ['sg-new'] },
          { VpcSecurityGroupIds: ['sg-old'] }
        )
      ).resolves.toBeDefined();
    });

    it('adds no call when the declared list is unchanged (only re-sent)', async () => {
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-b', 'sg-a'], DeletionProtection: true },
        { VpcSecurityGroupIds: ['sg-a', 'sg-b'] }
      );

      expect(countOf('DescribeDBClustersCommand')).toBe(1);
      expect(countOf('DescribeDBInstancesCommand')).toBe(0);
    });

    it('adds no call when no list is sent', async () => {
      await make().update('Cluster', 'my-cluster', type, { DeletionProtection: true }, {});

      expect(countOf('DescribeDBClustersCommand')).toBe(1);
      expect(countOf('DescribeDBInstancesCommand')).toBe(0);
    });

    it('skips the wait under --no-wait, as create() does', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      try {
        await make().update(
          'Cluster',
          'my-cluster',
          type,
          { VpcSecurityGroupIds: ['sg-new'] },
          { VpcSecurityGroupIds: ['sg-old'] }
        );
      } finally {
        delete process.env['CDKD_NO_WAIT'];
      }

      expect(countOf('DescribeDBClustersCommand')).toBe(1);
      expect(countOf('DescribeDBInstancesCommand')).toBe(0);
    });
  }
);

describe.each(RESETTING)(
  '$label DBCluster: a removed VpcSecurityGroupIds moves to the VPC default group (#1160)',
  ({ type, make }) => {
    beforeEach(() => {
      vi.clearAllMocks();
      routeDbSends();
      routeEc2Sends();
    });

    it('looks the default group up through the subnet group VPC and sends it', async () => {
      await make().update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] });

      expect(modifyInput()?.['VpcSecurityGroupIds']).toEqual([DEFAULT_SG]);
      // The lookup runs BEFORE the modify, from the cluster's own subnet group.
      const names = dbCommandNames();
      expect(names.indexOf('DescribeDBSubnetGroupsCommand')).toBeLessThan(
        names.indexOf('ModifyDBClusterCommand')
      );
      const subnetCall = dbSend.mock.calls.find(
        (c) => c[0].constructor.name === 'DescribeDBSubnetGroupsCommand'
      );
      expect(subnetCall?.[0].input).toEqual({ DBSubnetGroupName: SUBNET_GROUP });
      expect(ec2Send).toHaveBeenCalledTimes(1);
      expect(ec2Send.mock.calls[0][0].input).toEqual({
        Filters: [
          { Name: 'vpc-id', Values: [VPC_ID] },
          { Name: 'group-name', Values: ['default'] },
        ],
      });
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_SG));
      // The reset is a changed list, so the cluster and its member are awaited.
      expect(countOf('DescribeDBInstancesCommand')).toBe(1);
    });

    it('also resets when another property changes in the same update', async () => {
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { DeletionProtection: true },
        { DeletionProtection: false, VpcSecurityGroupIds: ['sg-a', 'sg-b'] }
      );

      expect(modifyInput()?.['VpcSecurityGroupIds']).toEqual([DEFAULT_SG]);
      expect(modifyInput()?.['DeletionProtection']).toBe(true);
    });

    it('sends a declared list as is, with no lookup', async () => {
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(modifyInput()?.['VpcSecurityGroupIds']).toEqual(['sg-new']);
      expect(ec2Send).not.toHaveBeenCalled();
      expect(dbCommandNames()).not.toContain('DescribeDBSubnetGroupsCommand');
    });

    it('leaves a never-declared list absent, with no lookup', async () => {
      await make().update('Cluster', 'my-cluster', type, { DeletionProtection: true }, {});

      expect(modifyInput()).toBeDefined();
      expect(modifyInput()?.['VpcSecurityGroupIds']).toBeUndefined();
      expect(ec2Send).not.toHaveBeenCalled();
    });

    it('still omits a desired EMPTY list (the readCurrentState placeholder), with no lookup', async () => {
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        { VpcSecurityGroupIds: [] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );

      expect(modifyInput()?.['VpcSecurityGroupIds']).toBeUndefined();
      expect(ec2Send).not.toHaveBeenCalled();
    });

    it('does not treat a previous EMPTY list as a removal', async () => {
      await make().update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: [] });

      expect(modifyInput()?.['VpcSecurityGroupIds']).toBeUndefined();
      expect(ec2Send).not.toHaveBeenCalled();
    });

    it('does not reset on a drift --revert bag (its baseline is a readback, not a template)', async () => {
      const context: UpdateContext = { desiredFromAwsReadback: true };
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        {},
        { VpcSecurityGroupIds: ['sg-custom'] },
        context
      );

      expect(modifyInput()?.['VpcSecurityGroupIds']).toBeUndefined();
      expect(ec2Send).not.toHaveBeenCalled();
    });

    it('refuses, before any modify, when the VPC has no default group', async () => {
      routeEc2Sends([]);

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain(
        `VPC ${VPC_ID} has no security group named default`
      );
      expect((error as Error).message).toContain('Declare VpcSecurityGroupIds in the template');
      // The update's own catch passes it through instead of wrapping it twice.
      expect((error as Error).message.match(/Failed to update/g)).toHaveLength(1);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(modifyInput()).toBeUndefined();
    });

    it('refuses, before any modify, when the subnet group reports no VPC', async () => {
      routeDbSends({
        DescribeDBSubnetGroupsCommand: () => ({ DBSubnetGroups: [{}] }),
      });

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] })
        .catch((e: unknown) => e);

      expect((error as Error).message).toContain(`DB subnet group ${SUBNET_GROUP} reports no VPC`);
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(ec2Send).not.toHaveBeenCalled();
      expect(modifyInput()).toBeUndefined();
    });

    it('refuses, before any lookup past the cluster, when the cluster reports no DB subnet group', async () => {
      routeDbSends({
        DescribeDBClustersCommand: () => ({ DBClusters: [{ DBClusterArn: 'arn:x' }] }),
      });

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain('the cluster reports no DB subnet group');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(dbCommandNames()).not.toContain('DescribeDBSubnetGroupsCommand');
      expect(ec2Send).not.toHaveBeenCalled();
      expect(modifyInput()).toBeUndefined();
    });

    it('never looks up when the previous bag does not carry the key', async () => {
      // go-to-k/cdkd#1160 review M2: a previous bag WITHOUT VpcSecurityGroupIds
      // (the template never declared it) is not a removal, whatever else changed.
      await make().update(
        'Cluster',
        'my-cluster',
        type,
        {},
        { DeletionProtection: true, BackupRetentionPeriod: 7 }
      );

      expect(modifyInput()).toBeDefined();
      expect(modifyInput()?.['VpcSecurityGroupIds']).toBeUndefined();
      expect(ec2Send).not.toHaveBeenCalled();
      expect(dbCommandNames()).not.toContain('DescribeDBSubnetGroupsCommand');
    });

    it('keeps an AWS-authored lookup failure (caller ARN) out of the thrown message', async () => {
      // go-to-k/cdkd#2319: the thrown message is persisted to the deployment
      // events; AWS's own text goes to debug and rides on `cause` only.
      const callerArn = 'arn:aws:sts::123456789012:assumed-role/deployer/session';
      const awsError = Object.assign(
        new Error(
          `You are not authorized to perform this operation. User: ${callerArn} is not authorized to perform: ec2:DescribeSecurityGroups`
        ),
        { name: 'UnauthorizedOperation', $fault: 'client', $metadata: { httpStatusCode: 403 } }
      );
      ec2Send.mockRejectedValue(awsError);

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).not.toContain(callerArn);
      expect((error as Error).message).toContain('UnauthorizedOperation');
      expect((error as Error).message).toContain('could not find that group');
      expect((error as Error).cause).toBe(awsError);
      expect(hasRedactedCause(error)).toBe(true);
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(loggerDebug).toHaveBeenCalledWith(expect.stringContaining(callerArn));
      expect(modifyInput()).toBeUndefined();
    });

    it('stamps a masked non-AWS failure so the classifier reads the unmasked cause', async () => {
      ec2Send.mockRejectedValue(new Error('socket hang up near s3cr3t-value'));
      const context: UpdateContext = {
        maskSecrets: (text: string) => text.split('s3cr3t-value').join('***'),
      };

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] }, context)
        .catch((e: unknown) => e);

      expect((error as Error).message).not.toContain('s3cr3t-value');
      expect((error as Error).message).toContain('socket hang up near ***');
      expect(hasRedactedCause(error)).toBe(true);
    });

    it('does not stamp an unmasked non-AWS failure', async () => {
      ec2Send.mockRejectedValue(new Error('socket hang up'));

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] })
        .catch((e: unknown) => e);

      expect((error as Error).message).toContain('socket hang up');
      expect(hasRedactedCause(error)).toBe(false);
    });

    it('wraps an AWS failure of the lookup, leaving it retryable', async () => {
      ec2Send.mockRejectedValue(
        Object.assign(new Error('Rate exceeded'), { name: 'RequestLimitExceeded' })
      );

      const error = await make()
        .update('Cluster', 'my-cluster', type, {}, { VpcSecurityGroupIds: ['sg-custom'] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toContain('could not find that group');
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(modifyInput()).toBeUndefined();
    });
  }
);

describe('DocDB DBCluster: a removed VpcSecurityGroupIds is kept, as CloudFormation keeps it (#1160)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeDbSends();
    routeEc2Sends();
  });

  it('sends no VpcSecurityGroupIds and looks nothing up', async () => {
    await new DocDBProvider().update(
      'Cluster',
      'my-cluster',
      'AWS::DocDB::DBCluster',
      {},
      { VpcSecurityGroupIds: ['sg-custom'] }
    );

    expect(modifyInput()).toBeDefined();
    expect(modifyInput()?.['VpcSecurityGroupIds']).toBeUndefined();
    expect(ec2Send).not.toHaveBeenCalled();
    expect(dbCommandNames()).not.toContain('DescribeDBSubnetGroupsCommand');
  });
});
