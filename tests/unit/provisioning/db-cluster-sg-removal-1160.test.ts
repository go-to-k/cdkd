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
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

/** Routes each DB-client command by name; the cluster sits in SUBNET_GROUP. */
function routeDbSends(overrides: Record<string, () => unknown> = {}) {
  dbSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (overrides[name]) return overrides[name]();
    if (name === 'DescribeDBClustersCommand') {
      return {
        DBClusters: [
          { DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:c', DBSubnetGroup: SUBNET_GROUP },
        ],
      };
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

const RESETTING = [
  { label: 'RDS', type: 'AWS::RDS::DBCluster', make: () => new RDSProvider() },
  { label: 'Neptune', type: 'AWS::Neptune::DBCluster', make: () => new NeptuneProvider() },
] as const;

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
