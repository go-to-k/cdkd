import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  ListTagsForResourceCommand,
} from '@aws-sdk/client-rds';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
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
    warn: vi.fn(),
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

describe('RDSProvider.readCurrentState', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new RDSProvider();
  });

  it('returns CFn-shaped DBInstance fields from DescribeDBInstances', async () => {
    mockSend.mockResolvedValueOnce({
      DBInstances: [
        {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'aurora-postgresql',
          DBClusterIdentifier: 'my-cluster',
          DBSubnetGroup: { DBSubnetGroupName: 'my-sg' },
          PubliclyAccessible: false,
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDBInstancesCommand);
    expect(result).toEqual({
      DBInstanceIdentifier: 'my-instance',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'aurora-postgresql',
      DBClusterIdentifier: 'my-cluster',
      DBSubnetGroupName: 'my-sg',
      PubliclyAccessible: false,
    });
  });

  it('surfaces #609 backfilled DBInstance siblings (7 readable) in CFn shape', async () => {
    mockSend.mockResolvedValueOnce({
      DBInstances: [
        {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          // #609 backfill — verify readback for each prop:
          AllocatedStorage: 20,
          MasterUsername: 'postgres',
          DeletionProtection: true,
          EngineVersion: '15.4',
          // Port is read from Endpoint.Port (the active listener), not a
          // top-level field — there is no top-level Port on DescribeDBInstance.
          Endpoint: { Port: 5432, Address: 'my-instance.abc.us-east-1.rds.amazonaws.com' },
          StorageEncrypted: true,
          // CFn `VPCSecurityGroups` ↔ AWS `VpcSecurityGroups[].VpcSecurityGroupId`
          VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-1' }, { VpcSecurityGroupId: 'sg-2' }],
          // NOT readable: MasterUserPassword (AWS never returns the password —
          // would be phantom drift on every read).
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    expect(result).toEqual({
      DBInstanceIdentifier: 'my-instance',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'postgres',
      AllocatedStorage: 20,
      MasterUsername: 'postgres',
      DeletionProtection: true,
      EngineVersion: '15.4',
      Port: 5432,
      StorageEncrypted: true,
      VPCSecurityGroups: ['sg-1', 'sg-2'],
    });
    // MasterUserPassword is never in the readback — RDS never returns it.
    expect(result).not.toHaveProperty('MasterUserPassword');
  });

  it('omits VPCSecurityGroups when AWS returns no security groups', async () => {
    mockSend.mockResolvedValueOnce({
      DBInstances: [
        {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          // No VpcSecurityGroups field.
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    // Match DBInstance's overall "emit-when-present" pattern: no
    // VPCSecurityGroups key at all when AWS returned nothing — drift
    // calculator descends from state's branch if state has the prop,
    // so omitting here does not mask a state-vs-AWS divergence.
    expect(result).not.toHaveProperty('VPCSecurityGroups');
  });

  it('omits Port when DBInstance Endpoint is absent (mid-create / mid-modify)', async () => {
    mockSend.mockResolvedValueOnce({
      DBInstances: [
        {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          // No Endpoint — AWS leaves it undefined while the instance is
          // transitioning (creating / modifying). Don't fabricate a Port.
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    expect(result).not.toHaveProperty('Port');
  });

  it('returns CFn-shaped DBCluster fields from DescribeDBClusters', async () => {
    mockSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          EngineVersion: '15.3',
          MasterUsername: 'admin',
          DatabaseName: 'mydb',
          Port: 5432,
          VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-1' }, { VpcSecurityGroupId: 'sg-2' }],
          DBSubnetGroup: 'my-sg',
          StorageEncrypted: true,
          KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abcd',
          BackupRetentionPeriod: 7,
          DeletionProtection: true,
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::RDS::DBCluster'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDBClustersCommand);
    expect(result).toEqual({
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      EngineVersion: '15.3',
      MasterUsername: 'admin',
      DatabaseName: 'mydb',
      Port: 5432,
      VpcSecurityGroupIds: ['sg-1', 'sg-2'],
      DBSubnetGroupName: 'my-sg',
      StorageEncrypted: true,
      KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abcd',
      BackupRetentionPeriod: 7,
      DeletionProtection: true,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
    });
  });

  // ─── #609 security-cluster backfill readbacks ─────────────────────
  it('surfaces #609 security DBInstance props (KmsKeyId / Monitoring / IAM-auth / MasterUserSecret) in CFn shape', async () => {
    mockSend.mockResolvedValueOnce({
      DBInstances: [
        {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          KmsKeyId: 'arn:aws:kms:us-east-1:123:key/storage',
          MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
          MonitoringInterval: 60,
          // AWS Describe field name → CFn `EnableIAMDatabaseAuthentication`.
          IAMDatabaseAuthenticationEnabled: true,
          // Read-side object carries SecretArn / SecretStatus; only KmsKeyId
          // round-trips into the CFn-shape state.
          MasterUserSecret: {
            SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:abc',
            SecretStatus: 'active',
            KmsKeyId: 'arn:aws:kms:us-east-1:123:key/secret',
          },
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    expect(result).toEqual({
      DBInstanceIdentifier: 'my-instance',
      DBInstanceClass: 'db.t3.micro',
      Engine: 'postgres',
      KmsKeyId: 'arn:aws:kms:us-east-1:123:key/storage',
      MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
      MonitoringInterval: 60,
      EnableIAMDatabaseAuthentication: true,
      // Only KmsKeyId — SecretArn / SecretStatus are AWS-managed read-only
      // fields cdkd never sets, so they are NOT round-tripped (would be
      // phantom drift on every read).
      MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/secret' },
    });
    // ManageMasterUserPassword is not a Describe field — never read back.
    expect(result).not.toHaveProperty('ManageMasterUserPassword');
  });

  it('surfaces #609 security DBCluster props (Monitoring / IAM-auth / PubliclyAccessible / MasterUserSecret) in CFn shape', async () => {
    mockSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
          MonitoringInterval: 30,
          IAMDatabaseAuthenticationEnabled: true,
          PubliclyAccessible: false,
          MasterUserSecret: {
            SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:abc',
            KmsKeyId: 'arn:aws:kms:us-east-1:123:key/secret',
          },
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::RDS::DBCluster'
    );

    expect(result).toMatchObject({
      DBClusterIdentifier: 'my-cluster',
      Engine: 'aurora-postgresql',
      MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
      MonitoringInterval: 30,
      EnableIAMDatabaseAuthentication: true,
      PubliclyAccessible: false,
      MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/secret' },
    });
    expect(result).not.toHaveProperty('ManageMasterUserPassword');
  });

  it('omits #609 security props when AWS does not return them (no phantom drift)', async () => {
    mockSend.mockResolvedValueOnce({
      DBClusters: [
        {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          // No Monitoring / IAM-auth / PubliclyAccessible / MasterUserSecret.
        },
      ],
    });

    const result = await provider.readCurrentState(
      'my-cluster',
      'ClusterLogical',
      'AWS::RDS::DBCluster'
    );

    expect(result).not.toHaveProperty('MonitoringRoleArn');
    expect(result).not.toHaveProperty('MonitoringInterval');
    expect(result).not.toHaveProperty('EnableIAMDatabaseAuthentication');
    expect(result).not.toHaveProperty('PubliclyAccessible');
    expect(result).not.toHaveProperty('MasterUserSecret');
  });

  it('returns CFn-shaped DBSubnetGroup fields from DescribeDBSubnetGroups', async () => {
    mockSend.mockResolvedValueOnce({
      DBSubnetGroups: [
        {
          DBSubnetGroupName: 'my-sg',
          DBSubnetGroupDescription: 'my subnet group',
          Subnets: [{ SubnetIdentifier: 'subnet-1' }, { SubnetIdentifier: 'subnet-2' }],
        },
      ],
    });

    const result = await provider.readCurrentState('my-sg', 'SGLogical', 'AWS::RDS::DBSubnetGroup');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeDBSubnetGroupsCommand);
    expect(result).toEqual({
      DBSubnetGroupName: 'my-sg',
      DBSubnetGroupDescription: 'my subnet group',
      SubnetIds: ['subnet-1', 'subnet-2'],
    });
  });

  it('returns undefined for not-found instance', async () => {
    const err = new Error('DBInstance not found');
    (err as { name?: string }).name = 'DBInstanceNotFoundFault';
    mockSend.mockRejectedValueOnce(err);

    const result = await provider.readCurrentState('gone', 'InstanceLogical', 'AWS::RDS::DBInstance');
    expect(result).toBeUndefined();
  });

  it('surfaces DBInstance Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'my-instance',
            DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance',
          },
        ],
      })
      .mockResolvedValueOnce({
        TagList: [
          { Key: 'Foo', Value: 'Bar' },
          { Key: 'aws:cdk:path', Value: 'MyStack/MyDB/Resource' },
        ],
      });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend
      .mockResolvedValueOnce({
        DBInstances: [
          {
            DBInstanceIdentifier: 'my-instance',
            DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance',
          },
        ],
      })
      .mockResolvedValueOnce({
        TagList: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyDB/Resource' }],
      });

    const result = await provider.readCurrentState(
      'my-instance',
      'InstanceLogical',
      'AWS::RDS::DBInstance'
    );

    expect(result?.Tags).toEqual([]);
  });
});
