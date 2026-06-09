import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({ send: mockSend, config: { region: () => Promise.resolve('us-east-1') } })),
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

      // ─── #609 security-cluster backfill — 6 props ───────────────
      it('forwards all 6 #609 security props to CreateDBCluster (MasterUserSecret→MasterUserSecretKmsKeyId flip; MonitoringInterval string→number)', async () => {
        mockSend.mockResolvedValueOnce({
          DBCluster: { DBClusterIdentifier: 'my-cluster' },
        });
        mockSend.mockResolvedValueOnce({ DBClusters: [{ Status: 'available' }] });
        mockSend.mockResolvedValueOnce({ DBClusters: [{}] });

        await provider.create('MyCluster', 'AWS::RDS::DBCluster', {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          ManageMasterUserPassword: true,
          MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abcd' },
          MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
          // CFn-string-typed numeric (CDK emits "60", not 60).
          MonitoringInterval: '60',
          EnableIAMDatabaseAuthentication: true,
          PubliclyAccessible: false,
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateDBClusterCommand');
        expect(createCall.input.ManageMasterUserPassword).toBe(true);
        // CFn `MasterUserSecret { KmsKeyId }` → SDK scalar `MasterUserSecretKmsKeyId`.
        expect(createCall.input.MasterUserSecretKmsKeyId).toBe(
          'arn:aws:kms:us-east-1:123:key/abcd'
        );
        // The object form must NOT leak onto the request shape.
        expect(createCall.input.MasterUserSecret).toBeUndefined();
        expect(createCall.input.MonitoringRoleArn).toBe('arn:aws:iam::123:role/emaccess');
        // String "60" coerced to number 60 at the wire boundary.
        expect(createCall.input.MonitoringInterval).toBe(60);
        expect(createCall.input.EnableIAMDatabaseAuthentication).toBe(true);
        // PubliclyAccessible explicit false reaches AWS (not dropped by a truthy gate).
        expect(createCall.input.PubliclyAccessible).toBe(false);
      });

      it('forwards EnableIAMDatabaseAuthentication=false explicitly (not dropped by a truthy gate)', async () => {
        mockSend.mockResolvedValueOnce({
          DBCluster: { DBClusterIdentifier: 'my-cluster' },
        });
        mockSend.mockResolvedValueOnce({ DBClusters: [{ Status: 'available' }] });
        mockSend.mockResolvedValueOnce({ DBClusters: [{}] });

        await provider.create('MyCluster', 'AWS::RDS::DBCluster', {
          DBClusterIdentifier: 'my-cluster',
          Engine: 'aurora-postgresql',
          EnableIAMDatabaseAuthentication: false,
          ManageMasterUserPassword: false,
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.EnableIAMDatabaseAuthentication).toBe(false);
        expect(createCall.input.ManageMasterUserPassword).toBe(false);
      });
    });

    describe('update', () => {
      it('forwards 5 mutable #609 security props to ModifyDBCluster (MasterUserSecret→MasterUserSecretKmsKeyId flip; MonitoringInterval string→number; PubliclyAccessible NOT forwarded — create-only)', async () => {
        // updateDBCluster does 2 sends: ModifyDBCluster + final describe.
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBClusters: [{}] });

        await provider.update(
          'MyCluster',
          'my-cluster',
          'AWS::RDS::DBCluster',
          {
            Engine: 'aurora-postgresql',
            ManageMasterUserPassword: true,
            MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/new' },
            MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
            MonitoringInterval: '30',
            EnableIAMDatabaseAuthentication: true,
            // PubliclyAccessible is create-only for DBCluster (absent from
            // ModifyDBClusterMessage); must NOT appear in the modify input.
            PubliclyAccessible: true,
          },
          {
            Engine: 'aurora-postgresql',
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
        expect(modifyCall.input.ApplyImmediately).toBe(true);
        expect(modifyCall.input.ManageMasterUserPassword).toBe(true);
        expect(modifyCall.input.MasterUserSecretKmsKeyId).toBe(
          'arn:aws:kms:us-east-1:123:key/new'
        );
        expect(modifyCall.input.MasterUserSecret).toBeUndefined();
        expect(modifyCall.input.MonitoringRoleArn).toBe('arn:aws:iam::123:role/emaccess');
        expect(modifyCall.input.MonitoringInterval).toBe(30);
        expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(true);
        // Create-only — never rides ModifyDBCluster.
        expect(modifyCall.input.PubliclyAccessible).toBeUndefined();
      });
    });

    describe('delete', () => {
      it('with removeProtection=true: disables deletion protection then deletes with SkipFinalSnapshot=true', async () => {
        // ModifyDBClusterCommand (disable deletion protection)
        mockSend.mockResolvedValueOnce({});
        // DeleteDBClusterCommand
        mockSend.mockResolvedValueOnce({});
        // DescribeDBClusters (waitForClusterDeleted) - not found
        const notFoundError = new Error('DBCluster not found');
        (notFoundError as { name: string }).name = 'DBClusterNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster', undefined, {
          removeProtection: true,
        });

        expect(mockSend).toHaveBeenCalledTimes(3);

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
        expect(modifyCall.input.DeletionProtection).toBe(false);

        const deleteCall = mockSend.mock.calls[1][0];
        expect(deleteCall.constructor.name).toBe('DeleteDBClusterCommand');
        expect(deleteCall.input.DBClusterIdentifier).toBe('my-cluster');
        expect(deleteCall.input.SkipFinalSnapshot).toBe(true);
      });

      it('without removeProtection: skips the protection-flip and only issues DeleteDBClusterCommand', async () => {
        // DeleteDBClusterCommand
        mockSend.mockResolvedValueOnce({});
        // DescribeDBClusters (waitForClusterDeleted) - not found
        const notFoundError = new Error('DBCluster not found');
        (notFoundError as { name: string }).name = 'DBClusterNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster');

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('DeleteDBClusterCommand');
      });

      it('should handle DBClusterNotFoundFault gracefully', async () => {
        // DeleteDBClusterCommand - not found (no protection flip without removeProtection).
        const notFoundError = new Error('DBCluster not found');
        (notFoundError as { name: string }).name = 'DBClusterNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyCluster', 'my-cluster', 'AWS::RDS::DBCluster');

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        // DeleteDBClusterCommand fails (no protection flip without removeProtection).
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

      // ─── #609 backfill — 8 sibling props ────────────────────────
      it('forwards all 8 #609 backfilled props to CreateDBInstance (with VPCSecurityGroups→VpcSecurityGroupIds flip; CFn Port → SDK Port on create; AllocatedStorage stringly-typed→number)', async () => {
        mockSend.mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'my-instance' },
        });
        mockSend.mockResolvedValueOnce({
          DBInstances: [{ DBInstanceStatus: 'available' }],
        });
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.create('MyInstance', 'AWS::RDS::DBInstance', {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          // AllocatedStorage as CFn-typed string (CDK emits "20" not 20).
          AllocatedStorage: '20',
          MasterUsername: 'postgres',
          DeletionProtection: true,
          EngineVersion: '15.4',
          Port: 5432,
          MasterUserPassword: 'secret-password',
          StorageEncrypted: true,
          VPCSecurityGroups: ['sg-1', 'sg-2'],
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateDBInstanceCommand');
        // AllocatedStorage: coerced to number (AWS SDK requires number, not string).
        expect(createCall.input.AllocatedStorage).toBe(20);
        expect(createCall.input.MasterUsername).toBe('postgres');
        expect(createCall.input.DeletionProtection).toBe(true);
        expect(createCall.input.EngineVersion).toBe('15.4');
        // CFn `Port` → SDK `Port` (NOT DBPortNumber, which is a Modify-side
        // oddity unique to ModifyDBInstance).
        expect(createCall.input.Port).toBe(5432);
        expect(createCall.input.MasterUserPassword).toBe('secret-password');
        expect(createCall.input.StorageEncrypted).toBe(true);
        // CFn `VPCSecurityGroups` → SDK `VpcSecurityGroupIds` (name+casing flip).
        expect(createCall.input.VpcSecurityGroupIds).toEqual(['sg-1', 'sg-2']);
      });

      it('forwards DeletionProtection=false explicitly (not silently dropped by a truthy gate)', async () => {
        mockSend.mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'my-instance' },
        });
        mockSend.mockResolvedValueOnce({
          DBInstances: [{ DBInstanceStatus: 'available' }],
        });
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.create('MyInstance', 'AWS::RDS::DBInstance', {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          // Explicit opt-out: the user-set false MUST reach AWS, not be
          // silently dropped by a `properties[...]` truthy gate.
          DeletionProtection: false,
          StorageEncrypted: false,
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.DeletionProtection).toBe(false);
        expect(createCall.input.StorageEncrypted).toBe(false);
      });

      // ─── #609 security-cluster backfill — 6 props ───────────────
      it('forwards all 6 #609 security props to CreateDBInstance (KmsKeyId; MasterUserSecret→MasterUserSecretKmsKeyId flip; MonitoringInterval string→number)', async () => {
        mockSend.mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'my-instance' },
        });
        mockSend.mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.create('MyInstance', 'AWS::RDS::DBInstance', {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          KmsKeyId: 'arn:aws:kms:us-east-1:123:key/storage',
          MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/secret' },
          ManageMasterUserPassword: true,
          MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
          // CFn-string-typed numeric (CDK emits "60", not 60).
          MonitoringInterval: '60',
          EnableIAMDatabaseAuthentication: true,
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateDBInstanceCommand');
        expect(createCall.input.KmsKeyId).toBe('arn:aws:kms:us-east-1:123:key/storage');
        // CFn `MasterUserSecret { KmsKeyId }` → SDK scalar `MasterUserSecretKmsKeyId`.
        expect(createCall.input.MasterUserSecretKmsKeyId).toBe(
          'arn:aws:kms:us-east-1:123:key/secret'
        );
        expect(createCall.input.MasterUserSecret).toBeUndefined();
        expect(createCall.input.ManageMasterUserPassword).toBe(true);
        expect(createCall.input.MonitoringRoleArn).toBe('arn:aws:iam::123:role/emaccess');
        // String "60" coerced to number 60.
        expect(createCall.input.MonitoringInterval).toBe(60);
        expect(createCall.input.EnableIAMDatabaseAuthentication).toBe(true);
      });

      it('forwards EnableIAMDatabaseAuthentication=false explicitly (not dropped by a truthy gate)', async () => {
        mockSend.mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'my-instance' },
        });
        mockSend.mockResolvedValueOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.create('MyInstance', 'AWS::RDS::DBInstance', {
          DBInstanceIdentifier: 'my-instance',
          DBInstanceClass: 'db.t3.micro',
          Engine: 'postgres',
          EnableIAMDatabaseAuthentication: false,
          ManageMasterUserPassword: false,
        });

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.input.EnableIAMDatabaseAuthentication).toBe(false);
        expect(createCall.input.ManageMasterUserPassword).toBe(false);
      });
    });

    describe('update', () => {
      it('forwards 5 mutable #609 props to ModifyDBInstance (with CFn Port → SDK DBPortNumber flip)', async () => {
        // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
        // (No waitForInstanceAvailable polling on the update path.)
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.small',
            Engine: 'postgres',
            DeletionProtection: false,
            EngineVersion: '15.5',
            Port: 5433,
            MasterUserPassword: 'new-password',
            VPCSecurityGroups: ['sg-new'],
            // StorageEncrypted is create-only; should NOT appear in modify input
            // even if present in newProperties.
            StorageEncrypted: true,
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            DeletionProtection: true,
            EngineVersion: '15.4',
            Port: 5432,
            MasterUserPassword: 'old-password',
            VPCSecurityGroups: ['sg-old'],
            StorageEncrypted: true,
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
        expect(modifyCall.input.DBInstanceClass).toBe('db.t3.small');
        expect(modifyCall.input.ApplyImmediately).toBe(true);
        expect(modifyCall.input.DeletionProtection).toBe(false);
        expect(modifyCall.input.EngineVersion).toBe('15.5');
        // CFn `Port` → SDK `DBPortNumber` on Modify (different field name vs Create).
        expect(modifyCall.input.DBPortNumber).toBe(5433);
        expect(modifyCall.input.Port).toBeUndefined();
        expect(modifyCall.input.MasterUserPassword).toBe('new-password');
        expect(modifyCall.input.VpcSecurityGroupIds).toEqual(['sg-new']);
        // StorageEncrypted is create-only and MUST NOT ride ModifyDBInstance —
        // AWS rejects it and the diff layer schedules a replace separately.
        expect(modifyCall.input.StorageEncrypted).toBeUndefined();
      });

      it('forwards 5 mutable #609 security props to ModifyDBInstance (KmsKeyId create-only → NOT forwarded; MasterUserSecret flip; MonitoringInterval string→number)', async () => {
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/new' },
            ManageMasterUserPassword: true,
            MonitoringRoleArn: 'arn:aws:iam::123:role/emaccess',
            MonitoringInterval: '30',
            EnableIAMDatabaseAuthentication: true,
            // KmsKeyId is storage-encryption (create-only / immutable); must NOT
            // ride ModifyDBInstance even if present in newProperties.
            KmsKeyId: 'arn:aws:kms:us-east-1:123:key/storage',
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
        expect(modifyCall.input.MasterUserSecretKmsKeyId).toBe(
          'arn:aws:kms:us-east-1:123:key/new'
        );
        expect(modifyCall.input.MasterUserSecret).toBeUndefined();
        expect(modifyCall.input.ManageMasterUserPassword).toBe(true);
        expect(modifyCall.input.MonitoringRoleArn).toBe('arn:aws:iam::123:role/emaccess');
        expect(modifyCall.input.MonitoringInterval).toBe(30);
        expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(true);
        // Storage KMS key is create-only — never rides ModifyDBInstance.
        expect(modifyCall.input.KmsKeyId).toBeUndefined();
      });

      it('forwards AllocatedStorage scale-up to ModifyDBInstance (coerced to number)', async () => {
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            AllocatedStorage: '50',
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            AllocatedStorage: '20',
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.input.AllocatedStorage).toBe(50);
      });

      it('does NOT forward MasterUsername to ModifyDBInstance (create-only per AWS RDS)', async () => {
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            MasterUsername: 'new-user',
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            MasterUsername: 'old-user',
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        // MasterUsername is create-only on AWS RDS DBInstance (ModifyDBInstance
        // rejects it). A template change here would CFn-replace the instance,
        // which cdkd's diff layer schedules separately.
        expect(modifyCall.input.MasterUsername).toBeUndefined();
      });

      it('adds AllowMajorVersionUpgrade when EngineVersion crosses a major boundary', async () => {
        // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
        // (No waitForInstanceAvailable polling on the update path.)
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            EngineVersion: '16.1',
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            EngineVersion: '15.4',
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.input.EngineVersion).toBe('16.1');
        // 15→16 crosses a major boundary; AllowMajorVersionUpgrade must be
        // set so AWS accepts the upgrade without a separate template toggle.
        expect(modifyCall.input.AllowMajorVersionUpgrade).toBe(true);
      });

      it('does NOT add AllowMajorVersionUpgrade when previous EngineVersion is undefined (first-time set)', async () => {
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            EngineVersion: '15.4',
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            // No EngineVersion previously — first-time set.
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        // EngineVersion still rides (the user's explicit value reaches AWS),
        // but AllowMajorVersionUpgrade is NOT set: we have no previous version
        // to compare against, so we cannot infer the user's major-bump intent.
        // Setting it unconditionally would promote any first-time EngineVersion
        // set into a "I accept major upgrades" policy declaration the user did
        // not make.
        expect(modifyCall.input.EngineVersion).toBe('15.4');
        expect(modifyCall.input.AllowMajorVersionUpgrade).toBeUndefined();
      });

      it('does NOT add AllowMajorVersionUpgrade for a minor-version bump', async () => {
        // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
        // (No waitForInstanceAvailable polling on the update path.)
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            EngineVersion: '15.5',
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            EngineVersion: '15.4',
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.input.EngineVersion).toBe('15.5');
        // Same major (15→15): AllowMajorVersionUpgrade must NOT be set
        // (avoid a no-op flag, and avoid promoting to a major bump if the
        // user did NOT intend one).
        expect(modifyCall.input.AllowMajorVersionUpgrade).toBeUndefined();
      });

      it('forwards DeletionProtection=false explicitly on update (not silently dropped)', async () => {
        // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
        // (No waitForInstanceAvailable polling on the update path.)
        mockSend.mockResolvedValueOnce({});
        mockSend.mockResolvedValueOnce({ DBInstances: [{}] });

        await provider.update(
          'MyInstance',
          'my-instance',
          'AWS::RDS::DBInstance',
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            DeletionProtection: false,
          },
          {
            DBInstanceClass: 'db.t3.micro',
            Engine: 'postgres',
            DeletionProtection: true,
          }
        );

        const modifyCall = mockSend.mock.calls[0][0];
        // User wants to disable deletion protection — explicit false MUST
        // reach AWS, not be silently dropped.
        expect(modifyCall.input.DeletionProtection).toBe(false);
      });
    });

    describe('delete', () => {
      it('with removeProtection=true: disables deletion protection then deletes with SkipFinalSnapshot=true', async () => {
        // ModifyDBInstanceCommand (disable deletion protection)
        mockSend.mockResolvedValueOnce({});
        // DeleteDBInstanceCommand
        mockSend.mockResolvedValueOnce({});
        // DescribeDBInstances (waitForInstanceDeleted) - not found
        const notFoundError = new Error('DBInstance not found');
        (notFoundError as { name: string }).name = 'DBInstanceNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyInstance', 'my-instance', 'AWS::RDS::DBInstance', undefined, {
          removeProtection: true,
        });

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

      it('without removeProtection: skips the protection-flip and only issues DeleteDBInstanceCommand', async () => {
        // DeleteDBInstanceCommand
        mockSend.mockResolvedValueOnce({});
        // DescribeDBInstances (waitForInstanceDeleted) - not found
        const notFoundError = new Error('DBInstance not found');
        (notFoundError as { name: string }).name = 'DBInstanceNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyInstance', 'my-instance', 'AWS::RDS::DBInstance');

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('DeleteDBInstanceCommand');
      });

      it('should handle DBInstanceNotFoundFault gracefully', async () => {
        // DeleteDBInstanceCommand - not found (no protection flip without removeProtection)
        const notFoundError = new Error('DBInstance not found');
        (notFoundError as { name: string }).name = 'DBInstanceNotFoundFault';
        mockSend.mockRejectedValueOnce(notFoundError);

        await provider.delete('MyInstance', 'my-instance', 'AWS::RDS::DBInstance');

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      it('should throw ProvisioningError on unexpected failure', async () => {
        // DeleteDBInstanceCommand fails (no protection flip without removeProtection)
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
