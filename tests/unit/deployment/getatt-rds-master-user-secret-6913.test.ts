import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';
import { dbInstanceAttributes } from '../../../src/provisioning/providers/rds/instance-attributes.js';
import { dbClusterAttributes } from '../../../src/provisioning/providers/rds/cluster-attributes.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

/**
 * go-to-k/cdkd#6913: `Fn::GetAtt [<DBCluster | DBInstance>, MasterUserSecret.SecretArn]`
 * (CDK's `attrMasterUserSecretSecretArn`, read by the L2's `secret` under
 * `manageMasterUserPassword`) and the DB cluster's `StorageThroughput` are
 * recorded from the describe, so CloudFormation's attribute resolves.
 */
const SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!cluster-0a1b2c3d-AbCdEf';
const MASTER_USER_SECRET = {
  SecretArn: SECRET_ARN,
  SecretStatus: 'active',
  KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/k',
};
const CLUSTER = {
  Endpoint: 'db.cluster-x.us-east-1.rds.amazonaws.com',
  Port: 5432,
  DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:db',
};
const INSTANCE = {
  DBInstanceIdentifier: 'mydb',
  DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
};

const resolveAttr = (
  type: string,
  attributes: Record<string, unknown>,
  attribute: string,
  healer?: ResolverContext['attributeHealer']
): Promise<unknown> => {
  const context: ResolverContext = {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: {
      X: { physicalId: 'db', resourceType: type, properties: {}, attributes, dependencies: [] },
    },
    ...(healer && { attributeHealer: healer }),
  };
  return new IntrinsicFunctionResolver('us-east-1').resolve(
    { 'Fn::GetAtt': ['X', attribute] },
    context
  );
};

const healerReading = (attributes: Record<string, unknown>) =>
  vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes }));

describe('the attribute maps record MasterUserSecret.SecretArn (#6913)', () => {
  it('DBCluster: recorded, with StorageThroughput, when RDS reports them', () => {
    const attrs = dbClusterAttributes({
      ...CLUSTER,
      MasterUserSecret: MASTER_USER_SECRET,
      StorageThroughput: 125,
    });
    expect(attrs['MasterUserSecret.SecretArn']).toBe(SECRET_ARN);
    expect(attrs['StorageThroughput']).toBe(125);
    // Only the ARN: the secret's status and key are not CloudFormation attributes.
    expect(Object.keys(attrs).filter((k) => k.startsWith('MasterUserSecret'))).toStrictEqual([
      'MasterUserSecret.SecretArn',
    ]);
  });

  it('DBCluster: absent when RDS manages no master secret and reports no throughput', () => {
    const attrs = dbClusterAttributes(CLUSTER);
    expect(Object.hasOwn(attrs, 'MasterUserSecret.SecretArn')).toBe(false);
    expect(Object.hasOwn(attrs, 'StorageThroughput')).toBe(false);
    expect(Object.hasOwn(dbClusterAttributes({ ...CLUSTER, MasterUserSecret: {} }), 'MasterUserSecret.SecretArn')).toBe(false);
  });

  it('DBInstance: recorded when RDS reports it, absent otherwise', () => {
    expect(
      dbInstanceAttributes({ ...INSTANCE, MasterUserSecret: MASTER_USER_SECRET }, { settled: true })[
        'MasterUserSecret.SecretArn'
      ]
    ).toBe(SECRET_ARN);
    expect(
      Object.hasOwn(dbInstanceAttributes(INSTANCE, { settled: true }), 'MasterUserSecret.SecretArn')
    ).toBe(false);
  });
});

describe('Fn::GetAtt MasterUserSecret.SecretArn resolves (#6913)', () => {
  for (const [type, build] of [
    ['AWS::RDS::DBCluster', () => dbClusterAttributes({ ...CLUSTER, MasterUserSecret: MASTER_USER_SECRET })],
    [
      'AWS::RDS::DBInstance',
      () => dbInstanceAttributes({ ...INSTANCE, MasterUserSecret: MASTER_USER_SECRET }, { settled: true }),
    ],
  ] as const) {
    it(`${type}: served from the record`, async () => {
      await expect(resolveAttr(type, build(), 'MasterUserSecret.SecretArn')).resolves.toBe(SECRET_ARN);
    });

    it(`${type}: a record written before the fix heals from the describe`, async () => {
      const healer = healerReading(build());
      await expect(
        resolveAttr(type, { Arn: 'arn:aws:rds:us-east-1:123456789012:x:db' }, 'MasterUserSecret.SecretArn', healer)
      ).resolves.toBe(SECRET_ARN);
      expect(healer).toHaveBeenCalledTimes(1);
    });
  }

  for (const [type, attributes] of [
    ['AWS::RDS::DBCluster', dbClusterAttributes(CLUSTER)],
    ['AWS::RDS::DBInstance', dbInstanceAttributes(INSTANCE, { settled: true })],
  ] as const) {
    it(`${type} with no managed master secret is refused with the remedy, never served its identifier`, async () => {
      const healer = healerReading(attributes);
      const err = await resolveAttr(type, attributes, 'MasterUserSecret.SecretArn', healer).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(String(err)).toContain(
        'RDS manages no master user secret for it: declare ManageMasterUserPassword: true, or remove the reference.'
      );
      // Not the stale-record wording, which asks for a cdkd issue.
      expect(String(err)).not.toMatch(/file an issue/i);
      expect(healer).toHaveBeenCalledTimes(1);
    });
  }

  it('DBCluster StorageThroughput is served from the record as a number', async () => {
    await expect(
      resolveAttr(
        'AWS::RDS::DBCluster',
        dbClusterAttributes({ ...CLUSTER, StorageThroughput: 125 }),
        'StorageThroughput'
      )
    ).resolves.toBe(125);
  });
});
