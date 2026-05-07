import { describe, it, expect, vi, beforeEach } from 'vitest';
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
