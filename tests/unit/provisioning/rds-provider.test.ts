import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
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

describe('RDSProvider', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new RDSProvider();
  });

  // ─── DBSubnetGroup ────────────────────────────────────────────────

  describe('DBSubnetGroup', () => {
    describe('create', () => {
      it('should create a DBSubnetGroup and return subnet group name as physicalId', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MySubnetGroup', 'AWS::RDS::DBSubnetGroup', {
          DBSubnetGroupName: 'my-subnet-group',
          DBSubnetGroupDescription: 'Test subnet group',
          SubnetIds: ['subnet-aaa', 'subnet-bbb'],
        });

        expect(result.physicalId).toBe('my-subnet-group');
        expect(result.attributes).toEqual({
          DBSubnetGroupName: 'my-subnet-group',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateDBSubnetGroupCommand');
        expect(createCall.input.DBSubnetGroupName).toBe('my-subnet-group');
        expect(createCall.input.SubnetIds).toEqual(['subnet-aaa', 'subnet-bbb']);
      });

      it('should use logicalId as name when DBSubnetGroupName is not provided', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create('MySubnetGroup', 'AWS::RDS::DBSubnetGroup', {
          DBSubnetGroupDescription: 'Test subnet group',
          SubnetIds: ['subnet-aaa'],
        });

        expect(result.physicalId).toBe('mysubnetgroup');

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.DBSubnetGroupName).toBe('mysubnetgroup');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MySubnetGroup', 'AWS::RDS::DBSubnetGroup', {
            SubnetIds: ['subnet-aaa'],
          })
        ).rejects.toThrow('Failed to create DBSubnetGroup MySubnetGroup');
      });
    });

    describe('delete', () => {
      it('should delete a DBSubnetGroup', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete('MySubnetGroup', 'my-subnet-group', 'AWS::RDS::DBSubnetGroup');

        expect(mockSend).toHaveBeenCalledTimes(1);

        const deleteCall = mockSend.mock.calls[0][0];
        expect(deleteCall.constructor.name).toBe('DeleteDBSubnetGroupCommand');
        expect(deleteCall.input.DBSubnetGroupName).toBe('my-subnet-group');
      });

      it('should handle DBSubnetGroupNotFoundFault gracefully', async () => {
        const notFoundError = new Error('DBSubnetGroup not found');
        (notFoundError as { name: string }).name = 'DBSubnetGroupNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MySubnetGroup', 'my-subnet-group', 'AWS::RDS::DBSubnetGroup');

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.delete('MySubnetGroup', 'my-subnet-group', 'AWS::RDS::DBSubnetGroup')
        ).rejects.toThrow('Failed to delete DBSubnetGroup MySubnetGroup');
      });
    });
  });

  // ─── DBCluster ────────────────────────────────────────────────────

  describe('DBCluster', () => {
    describe('create', () => {
      it('should create a DBCluster and return identifier with attributes', async () => {
        // CreateDBClusterCommand
        mockSend.mockResolvedValueOnce({
          DBCluster: {
            DBClusterIdentifier: 'my-cluster',
            DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
          },
        });
        // DescribeDBClusters (waitForClusterAvailable)
        mockSend.mockResolvedValueOnce({
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              Status: 'available',
              Endpoint: 'my-cluster.cluster-xxx.us-east-1.rds.amazonaws.com',
              Port: 5432,
              ReaderEndpoint: 'my-cluster.cluster-ro-xxx.us-east-1.rds.amazonaws.com',
              DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
              DbClusterResourceId: 'cluster-ABCDEF123456',
            },
          ],
        });
        // DescribeDBClusters (final describe for attributes)
        mockSend.mockResolvedValueOnce({
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              Status: 'available',
              Endpoint: 'my-cluster.cluster-xxx.us-east-1.rds.amazonaws.com',
              Port: 5432,
              ReaderEndpoint: 'my-cluster.cluster-ro-xxx.us-east-1.rds.amazonaws.com',
              DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
              DbClusterResourceId: 'cluster-ABCDEF123456',
            },
          ],
        });

        const result = await provider.create('MyCluster', 'AWS::RDS::DBCluster', {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          MasterUsername: 'admin',
          MasterUserPassword: 'secret123',
        });

        expect(result.physicalId).toBe('my-cluster');
        expect(result.attributes).toEqual({
          'Endpoint.Address': 'my-cluster.cluster-xxx.us-east-1.rds.amazonaws.com',
          'Endpoint.Port': '5432',
          'ReadEndpoint.Address': 'my-cluster.cluster-ro-xxx.us-east-1.rds.amazonaws.com',
          Arn: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
          DBClusterResourceId: 'cluster-ABCDEF123456',
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateDBClusterCommand');
        expect(createCall.input.Engine).toBe('aurora-postgresql');
      });

      it('should use lowercased logicalId when DBClusterIdentifier is not provided', async () => {
        mockSend.mockResolvedValueOnce({
          DBCluster: { DBClusterIdentifier: 'mycluster' },
        });
        // waitForClusterAvailable
        mockSend.mockResolvedValueOnce({
          DBClusters: [{ Status: 'available' }],
        });
        // final describe
        mockSend.mockResolvedValueOnce({
          DBClusters: [{}],
        });

        const result = await provider.create('MyCluster', 'AWS::RDS::DBCluster', {
          Engine: 'aurora-postgresql',
        });

        expect(result.physicalId).toBe('mycluster');

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.DBClusterIdentifier).toBe('mycluster');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyCluster', 'AWS::RDS::DBCluster', {
            Engine: 'aurora-postgresql',
          })
        ).rejects.toThrow('Failed to create DBCluster MyCluster');
      });
    });

    describe('delete', () => {
      it('should disable deletion protection and delete with SkipFinalSnapshot=true', async () => {
        // ModifyDBClusterCommand (disable deletion protection)
        mockSend.mockResolvedValueOnce({});
        // DeleteDBClusterCommand
        mockSend.mockResolvedValueOnce({});
        // DescribeDBClusters (waitForClusterDeleted) - not found
        const notFoundError = new Error('DBCluster not found');
        (notFoundError as { name: string }).name = 'DBClusterNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster');

        expect(mockSend).toHaveBeenCalledTimes(3);

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
        expect(modifyCall.input.DeletionProtection).toBe(false);

        const deleteCall = mockSend.mock.calls[1][0];
        expect(deleteCall.constructor.name).toBe('DeleteDBClusterCommand');
        expect(deleteCall.input.DBClusterIdentifier).toBe('my-cluster');
        expect(deleteCall.input.SkipFinalSnapshot).toBe(true);
      });

      it('should handle DBClusterNotFoundFault gracefully', async () => {
        // ModifyDBClusterCommand (disable deletion protection) - not found
        const notFoundError1 = new Error('DBCluster not found');
        (notFoundError1 as { name: string }).name = 'DBClusterNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError1);

        // DeleteDBClusterCommand - not found
        const notFoundError2 = new Error('DBCluster not found');
        (notFoundError2 as { name: string }).name = 'DBClusterNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError2);

        await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster');

        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        // ModifyDBClusterCommand succeeds
        mockSend.mockResolvedValueOnce({});
        // DeleteDBClusterCommand fails
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster')
        ).rejects.toThrow('Failed to delete DBCluster MyCluster');
      });
    });
  });

  // ─── DBInstance ───────────────────────────────────────────────────

  describe('DBInstance', () => {
    describe('create', () => {
      it('should create a DBInstance and return identifier with attributes', async () => {
        // CreateDBInstanceCommand
        mockSend.mockResolvedValueOnce({
          DBInstance: {
            DBInstanceIdentifier: 'my-instance',
            DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:my-instance',
          },
        });
        // DescribeDBInstances (waitForInstanceAvailable)
        mockSend.mockResolvedValueOnce({
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              DBInstanceStatus: 'available',
              Endpoint: {
                Address: 'my-instance.xxx.us-east-1.rds.amazonaws.com',
                Port: 5432,
              },
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:my-instance',
            },
          ],
        });
        // DescribeDBInstances (final describe for attributes)
        mockSend.mockResolvedValueOnce({
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              DBInstanceStatus: 'available',
              Endpoint: {
                Address: 'my-instance.xxx.us-east-1.rds.amazonaws.com',
                Port: 5432,
              },
              DBInstanceArn: 'arn:aws:rds:us-east-1:123456789012:db:my-instance',
            },
          ],
        });

        const result = await provider.create('MyInstance', 'AWS::RDS::DBInstance', {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.serverless',
          Engine: 'aurora-postgresql',
          DBClusterIdentifier: 'my-cluster',
        });

        expect(result.physicalId).toBe('my-instance');
        expect(result.attributes).toEqual({
          'Endpoint.Address': 'my-instance.xxx.us-east-1.rds.amazonaws.com',
          'Endpoint.Port': '5432',
          Arn: 'arn:aws:rds:us-east-1:123456789012:db:my-instance',
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateDBInstanceCommand');
        expect(createCall.input.DBInstanceClass).toBe('db.serverless');
        expect(createCall.input.Engine).toBe('aurora-postgresql');
        expect(createCall.input.DBClusterIdentifier).toBe('my-cluster');
      });

      it('should use lowercased logicalId when DBInstanceIdentifier is not provided', async () => {
        mockSend.mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'myinstance' },
        });
        // waitForInstanceAvailable
        mockSend.mockResolvedValueOnce({
          DBInstances: [{ DBInstanceStatus: 'available' }],
        });
        // final describe
        mockSend.mockResolvedValueOnce({
          DBInstances: [{}],
        });

        const result = await provider.create('MyInstance', 'AWS::RDS::DBInstance', {
          DBInstanceClass: 'db.serverless',
          Engine: 'aurora-postgresql',
        });

        expect(result.physicalId).toBe('myinstance');

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.DBInstanceIdentifier).toBe('myinstance');
      });

      it('should throw ProvisioningError on failure', async () => {
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.create('MyInstance', 'AWS::RDS::DBInstance', {
            DBInstanceClass: 'db.serverless',
            Engine: 'aurora-postgresql',
          })
        ).rejects.toThrow('Failed to create DBInstance MyInstance');
      });
    });

    describe('delete', () => {
      it('should disable deletion protection and delete with SkipFinalSnapshot=true', async () => {
        // ModifyDBInstanceCommand (disable deletion protection)
        mockSend.mockResolvedValueOnce({});
        // DeleteDBInstanceCommand
        mockSend.mockResolvedValueOnce({});
        // DescribeDBInstances (waitForInstanceDeleted) - not found
        const notFoundError = new Error('DBInstance not found');
        (notFoundError as { name: string }).name = 'DBInstanceNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyInstance', 'my-instance', 'AWS::RDS::DBInstance');

        expect(mockSend).toHaveBeenCalledTimes(3);

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
        expect(modifyCall.input.DeletionProtection).toBe(false);
        expect(modifyCall.input.ApplyImmediately).toBe(true);

        const deleteCall = mockSend.mock.calls[1][0];
        expect(deleteCall.constructor.name).toBe('DeleteDBInstanceCommand');
        expect(deleteCall.input.DBInstanceIdentifier).toBe('my-instance');
        expect(deleteCall.input.SkipFinalSnapshot).toBe(true);
      });

      it('should handle DBInstanceNotFoundFault gracefully', async () => {
        // ModifyDBInstanceCommand (disable deletion protection) - not found
        const notFoundError1 = new Error('DBInstance not found');
        (notFoundError1 as { name: string }).name = 'DBInstanceNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError1);

        // DeleteDBInstanceCommand - not found
        const notFoundError2 = new Error('DBInstance not found');
        (notFoundError2 as { name: string }).name = 'DBInstanceNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError2);

        await provider.delete('MyInstance', 'my-instance', 'AWS::RDS::DBInstance');

        expect(mockSend).toHaveBeenCalledTimes(2);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        // ModifyDBInstanceCommand succeeds
        mockSend.mockResolvedValueOnce({});
        // DeleteDBInstanceCommand fails
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(
          provider.delete('MyInstance', 'my-instance', 'AWS::RDS::DBInstance')
        ).rejects.toThrow('Failed to delete DBInstance MyInstance');
      });
    });
  });

  // ─── Unsupported resource type ────────────────────────────────────

  describe('unsupported resource type', () => {
    it('should throw ProvisioningError for unsupported resource type on create', async () => {
      await expect(
        provider.create('MyResource', 'AWS::RDS::Unknown', {})
      ).rejects.toThrow('Unsupported resource type: AWS::RDS::Unknown');
    });

    it('should throw ProvisioningError for unsupported resource type on delete', async () => {
      await expect(
        provider.delete('MyResource', 'some-id', 'AWS::RDS::Unknown')
      ).rejects.toThrow('Unsupported resource type: AWS::RDS::Unknown');
    });
  });
});
