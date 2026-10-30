// Issue #5542 (umbrella #1160): an AWS::RDS::DBInstance `VPCSecurityGroups`
// REMOVED from the template.
//
// A real CloudFormation A/B (us-east-1, 2026-10-30, stacks
// `cdkd-ab-5542-alone` / `cdkd-ab-5542-beside`): a non-Aurora postgres
// instance in a VPC with one custom security group, then the property removed,
// alone and beside a CopyTagsToSnapshot change. In both, CloudFormation sent
// ModifyDBInstance `vpcSecurityGroupIds: [<the VPC's default group>]`
// (CloudTrail), and the instance read back on the `default` group, `active`,
// for five minutes after. ModifyDBInstance merges (an omitted field is "no
// change"), so cdkd must look the default group up and send it, as it does for
// a DB cluster (#5152).
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const dbSend = vi.fn();
const ec2Send = vi.fn();

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: dbSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    EC2Client: vi.fn().mockImplementation(() => ({ send: ec2Send })),
  };
});

const loggerWarn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
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
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const TYPE = 'AWS::RDS::DBInstance';
const SUBNET_GROUP = 'my-subnets';
const VPC_ID = 'vpc-0abc';
const DEFAULT_SG = 'sg-0default';

/** The instance sits in SUBNET_GROUP / VPC_ID; `null` reports no subnet group. */
function routeDbSends(subnetGroup: Record<string, unknown> | null = {
  DBSubnetGroupName: SUBNET_GROUP,
  VpcId: VPC_ID,
}) {
  dbSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'DescribeDBInstancesCommand') {
      return {
        DBInstances: [
          {
            DBInstanceIdentifier: 'my-db',
            DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-db',
            DBInstanceStatus: 'available',
            ...(subnetGroup !== null && { DBSubnetGroup: subnetGroup }),
          },
        ],
      };
    }
    if (command.constructor.name === 'ListTagsForResourceCommand') return { TagList: [] };
    return {};
  });
}

function routeEc2Sends(groups: Array<{ GroupId?: string }> = [{ GroupId: DEFAULT_SG }]) {
  ec2Send.mockImplementation(async () => ({ SecurityGroups: groups }));
}

const dbCommandNames = (): string[] => dbSend.mock.calls.map((c) => c[0].constructor.name);

const modifyInput = (): Record<string, unknown> | undefined => {
  const call = dbSend.mock.calls.find((c) => c[0].constructor.name === 'ModifyDBInstanceCommand');
  return call?.[0].input as Record<string, unknown> | undefined;
};

const update = (
  properties: Record<string, unknown>,
  previous: Record<string, unknown>,
  context?: UpdateContext
) => new RDSProvider().update('Db', 'my-db', TYPE, properties, previous, context);

describe('RDS DBInstance: a removed VPCSecurityGroups moves to the VPC default group, as CloudFormation does (#5542)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeDbSends();
    routeEc2Sends();
  });

  it("looks the default group up through the instance's subnet group VPC and sends it", async () => {
    await update({ DBInstanceClass: 'db.t4g.micro' }, {
      DBInstanceClass: 'db.t4g.micro',
      VPCSecurityGroups: ['sg-custom'],
    });

    expect(modifyInput()?.['VpcSecurityGroupIds']).toEqual([DEFAULT_SG]);
    // The lookup runs BEFORE the modify; the instance reports its VPC inline.
    const names = dbCommandNames();
    expect(names.indexOf('DescribeDBInstancesCommand')).toBeLessThan(
      names.indexOf('ModifyDBInstanceCommand')
    );
    expect(names).not.toContain('DescribeDBSubnetGroupsCommand');
    expect(ec2Send).toHaveBeenCalledTimes(1);
    expect(ec2Send.mock.calls[0][0].input).toEqual({
      Filters: [
        { Name: 'vpc-id', Values: [VPC_ID] },
        { Name: 'group-name', Values: ['default'] },
      ],
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`VPCSecurityGroups was removed.*${DEFAULT_SG}`))
    );
  });

  it('also resets when another property changes in the same update (the A/B "beside" arm)', async () => {
    await update(
      { DeletionProtection: true },
      { DeletionProtection: false, VPCSecurityGroups: ['sg-a', 'sg-b'] }
    );

    expect(modifyInput()?.['VpcSecurityGroupIds']).toEqual([DEFAULT_SG]);
    expect(modifyInput()?.['DeletionProtection']).toBe(true);
  });

  it('sends a declared list as is, with no lookup', async () => {
    await update({ VPCSecurityGroups: ['sg-new'] }, { VPCSecurityGroups: ['sg-old'] });

    expect(modifyInput()?.['VpcSecurityGroupIds']).toEqual(['sg-new']);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('leaves a never-declared list absent, with no lookup', async () => {
    await update({ DeletionProtection: true }, { DeletionProtection: false });

    expect(modifyInput()).toBeDefined();
    expect(modifyInput()).not.toHaveProperty('VpcSecurityGroupIds');
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('omits a desired EMPTY list, with no lookup', async () => {
    await update({ VPCSecurityGroups: [] }, { VPCSecurityGroups: ['sg-old'] });

    expect(modifyInput()).toBeDefined();
    expect(modifyInput()).not.toHaveProperty('VpcSecurityGroupIds');
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('does not treat a previous EMPTY list as a removal', async () => {
    await update({}, { VPCSecurityGroups: [] });

    expect(modifyInput()).not.toHaveProperty('VpcSecurityGroupIds');
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('does not reset on a drift --revert bag (its baseline is a readback, not a template)', async () => {
    await update({}, { VPCSecurityGroups: ['sg-custom'] }, { desiredFromAwsReadback: true });

    expect(modifyInput()).not.toHaveProperty('VpcSecurityGroupIds');
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('refuses, before any modify, when the VPC has no default group', async () => {
    routeEc2Sends([]);

    const error = await update({}, { VPCSecurityGroups: ['sg-custom'] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain('Failed to update DBInstance Db: VPCSecurityGroups was removed');
    expect(message).toContain(`VPC ${VPC_ID} has no security group named default`);
    expect(message).toContain('Declare VPCSecurityGroups in the template');
    // Thrown outside the update's own catch, so it is not wrapped twice.
    expect(message.match(/Failed to update/g)).toHaveLength(1);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(modifyInput()).toBeUndefined();
  });

  it('refuses, before any EC2 lookup, when the instance reports no DB subnet group', async () => {
    routeDbSends(null);

    const error = await update({}, { VPCSecurityGroups: ['sg-custom'] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('the instance reports no DB subnet group');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(ec2Send).not.toHaveBeenCalled();
    expect(modifyInput()).toBeUndefined();
  });

  it('refuses, before any EC2 lookup, when the subnet group reports no VPC', async () => {
    routeDbSends({ DBSubnetGroupName: SUBNET_GROUP });

    const error = await update({}, { VPCSecurityGroups: ['sg-custom'] }).catch((e: unknown) => e);

    expect((error as Error).message).toContain(`DB subnet group ${SUBNET_GROUP} reports no VPC`);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(ec2Send).not.toHaveBeenCalled();
    expect(modifyInput()).toBeUndefined();
  });

  it('wraps an AWS failure of the lookup once, leaving it retryable', async () => {
    const awsError = Object.assign(new Error('Rate exceeded'), { name: 'RequestLimitExceeded' });
    ec2Send.mockRejectedValue(awsError);

    const error = await update({}, { VPCSecurityGroups: ['sg-custom'] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('could not find that group');
    expect((error as Error).message.match(/Failed to update/g)).toHaveLength(1);
    expect((error as Error).cause).toBe(awsError);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(modifyInput()).toBeUndefined();
  });
});
