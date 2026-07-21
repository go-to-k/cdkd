import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateDBClusterCommand,
  CreateDBInstanceCommand,
  CreateDBSubnetGroupCommand,
  DeleteDBClusterCommand,
  DeleteDBInstanceCommand,
  DeleteDBSubnetGroupCommand,
  ModifyDBClusterCommand,
  ModifyDBInstanceCommand,
  ModifyDBSubnetGroupCommand,
} from '@aws-sdk/client-docdb';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-docdb', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    DocDBClient: vi.fn().mockImplementation(() => ({
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

import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Skip waiter polling in tests.
  process.env['CDKD_NO_WAIT'] = 'true';
});

describe('DocDBProvider', () => {
  // ─── DBSubnetGroup ────────────────────────────────────────────────

  describe('DBSubnetGroup', () => {
    it('create returns the DBSubnetGroupName as physicalId', async () => {
      mockSend.mockResolvedValueOnce({});
      const provider = new DocDBProvider();
      const result = await provider.create('MySG', 'AWS::DocDB::DBSubnetGroup', {
        DBSubnetGroupName: 'my-sg',
        DBSubnetGroupDescription: 'desc',
        SubnetIds: ['subnet-a', 'subnet-b'],
      });
      expect(result.physicalId).toBe('my-sg');
      const cmd = mockSend.mock.calls[0]![0];
      expect(cmd).toBeInstanceOf(CreateDBSubnetGroupCommand);
      expect(cmd.input.DBSubnetGroupName).toBe('my-sg');
      expect(cmd.input.SubnetIds).toEqual(['subnet-a', 'subnet-b']);
    });

    it('update issues ModifyDBSubnetGroup; empty SubnetIds is dropped (Class 2 placeholder)', async () => {
      // ModifyDBSubnetGroup -> Describe (for ARN)
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:aws:rds:us-east-1:123:subgrp:my-sg' }],
        });
      const provider = new DocDBProvider();
      await provider.update(
        'MySG',
        'my-sg',
        'AWS::DocDB::DBSubnetGroup',
        { DBSubnetGroupDescription: 'new', SubnetIds: [] },
        { DBSubnetGroupDescription: 'old' }
      );
      const modifyCmd = mockSend.mock.calls[0]![0];
      expect(modifyCmd).toBeInstanceOf(ModifyDBSubnetGroupCommand);
      // Empty array MUST be dropped — AWS rejects DBSubnetGroup with < 2 subnets.
      expect(modifyCmd.input.SubnetIds).toBeUndefined();
      expect(modifyCmd.input.DBSubnetGroupDescription).toBe('new');
    });

    it('delete issues DeleteDBSubnetGroup', async () => {
      mockSend.mockResolvedValueOnce({});
      const provider = new DocDBProvider();
      await provider.delete('MySG', 'my-sg', 'AWS::DocDB::DBSubnetGroup');
      const cmd = mockSend.mock.calls[0]![0];
      expect(cmd).toBeInstanceOf(DeleteDBSubnetGroupCommand);
      expect(cmd.input.DBSubnetGroupName).toBe('my-sg');
    });

    it('delete is idempotent on DBSubnetGroupNotFoundFault', async () => {
      const err = new Error('not found') as Error & { name: string };
      err.name = 'DBSubnetGroupNotFoundFault';
      mockSend.mockRejectedValueOnce(err);
      const provider = new DocDBProvider();
      await expect(
        provider.delete('MySG', 'my-sg', 'AWS::DocDB::DBSubnetGroup')
      ).resolves.toBeUndefined();
    });
  });

  // ─── DBCluster ────────────────────────────────────────────────────

  describe('DBCluster', () => {
    it('create issues CreateDBCluster with Engine=docdb and returns endpoint attrs', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBCluster: { DBClusterIdentifier: 'my-cluster' },
        })
        // Final DescribeDBCluster (waiter is skipped via CDKD_NO_WAIT).
        .mockResolvedValueOnce({
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              Endpoint: 'cluster.cluster-xxx.docdb.amazonaws.com',
              Port: 27017,
              ReaderEndpoint: 'cluster-ro.docdb.amazonaws.com',
              DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster',
              DbClusterResourceId: 'cluster-ABC',
            },
          ],
        });
      const provider = new DocDBProvider();
      const result = await provider.create('MyCluster', 'AWS::DocDB::DBCluster', {
        DBClusterIdentifier: 'my-cluster',
        MasterUsername: 'admin',
        MasterUserPassword: 'secret123',
      });
      expect(result.physicalId).toBe('my-cluster');
      expect(result.attributes).toMatchObject({
        'Endpoint.Address': 'cluster.cluster-xxx.docdb.amazonaws.com',
        'Endpoint.Port': '27017',
        'ReadEndpoint.Address': 'cluster-ro.docdb.amazonaws.com',
        Arn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster',
        ClusterResourceId: 'cluster-ABC',
      });
      const createCmd = mockSend.mock.calls[0]![0];
      expect(createCmd).toBeInstanceOf(CreateDBClusterCommand);
      expect(createCmd.input.Engine).toBe('docdb');
      expect(createCmd.input.MasterUsername).toBe('admin');
    });

    it('update issues ModifyDBCluster with ApplyImmediately=true', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          DBClusters: [{ DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster' }],
        });
      const provider = new DocDBProvider();
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::DocDB::DBCluster',
        { BackupRetentionPeriod: 7 },
        {}
      );
      const modCmd = mockSend.mock.calls[0]![0];
      expect(modCmd).toBeInstanceOf(ModifyDBClusterCommand);
      expect(modCmd.input.ApplyImmediately).toBe(true);
      expect(modCmd.input.BackupRetentionPeriod).toBe(7);
    });

    it('update drops empty VpcSecurityGroupIds (Class 2 — would CLEAR all SGs)', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ DBClusters: [{}] });
      const provider = new DocDBProvider();
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::DocDB::DBCluster',
        { VpcSecurityGroupIds: [] },
        {}
      );
      const modCmd = mockSend.mock.calls[0]![0];
      expect(modCmd.input.VpcSecurityGroupIds).toBeUndefined();
    });

    it('delete with removeProtection=true issues ModifyDBCluster(DeletionProtection=false) before DeleteDBCluster', async () => {
      mockSend.mockResolvedValue({});
      // Force the waiter loop to exit immediately by making subsequent
      // describes throw NotFound.
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof ModifyDBClusterCommand) return Promise.resolve({});
        if (command instanceof DeleteDBClusterCommand) return Promise.resolve({});
        const err = new Error('not found') as Error & { name: string };
        err.name = 'DBClusterNotFoundFault';
        return Promise.reject(err);
      });
      const provider = new DocDBProvider();
      await provider.delete('CL', 'my-cluster', 'AWS::DocDB::DBCluster', undefined, {
        removeProtection: true,
      });
      const cmds = mockSend.mock.calls.map((c) => c[0]);
      const flipIdx = cmds.findIndex((c) => c instanceof ModifyDBClusterCommand);
      const delIdx = cmds.findIndex((c) => c instanceof DeleteDBClusterCommand);
      expect(flipIdx).toBeGreaterThanOrEqual(0);
      expect(delIdx).toBeGreaterThan(flipIdx);
      expect(cmds[flipIdx]!.input.DeletionProtection).toBe(false);
      expect(cmds[flipIdx]!.input.ApplyImmediately).toBe(true);
    });

    it('delete without removeProtection does NOT issue ModifyDBCluster', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DeleteDBClusterCommand) return Promise.resolve({});
        const err = new Error('not found') as Error & { name: string };
        err.name = 'DBClusterNotFoundFault';
        return Promise.reject(err);
      });
      const provider = new DocDBProvider();
      await provider.delete('CL', 'my-cluster', 'AWS::DocDB::DBCluster');
      const cmds = mockSend.mock.calls.map((c) => c[0]);
      expect(cmds.some((c) => c instanceof ModifyDBClusterCommand)).toBe(false);
      expect(cmds.some((c) => c instanceof DeleteDBClusterCommand)).toBe(true);
    });
  });

  // ─── DBInstance ───────────────────────────────────────────────────

  describe('DBInstance', () => {
    it('create issues CreateDBInstance with Engine=docdb (no DeletionProtection — DocDB instance lacks the field)', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'my-instance' },
        })
        .mockResolvedValueOnce({
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              Endpoint: { Address: 'instance.docdb.amazonaws.com', Port: 27017 },
              DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance',
            },
          ],
        });
      const provider = new DocDBProvider();
      const result = await provider.create('MyInst', 'AWS::DocDB::DBInstance', {
        DBInstanceIdentifier: 'my-instance',
        DBInstanceClass: 'db.r5.large',
        DBClusterIdentifier: 'my-cluster',
      });
      expect(result.physicalId).toBe('my-instance');
      const createCmd = mockSend.mock.calls[0]![0];
      expect(createCmd).toBeInstanceOf(CreateDBInstanceCommand);
      expect(createCmd.input.Engine).toBe('docdb');
      // DocDB DBInstance does NOT support DeletionProtection.
      expect(createCmd.input.DeletionProtection).toBeUndefined();
    });

    it('update issues ModifyDBInstance with ApplyImmediately=true', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          DBInstances: [{ DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance' }],
        });
      const provider = new DocDBProvider();
      await provider.update(
        'MyInst',
        'my-instance',
        'AWS::DocDB::DBInstance',
        { DBInstanceClass: 'db.r5.xlarge' },
        {}
      );
      const modCmd = mockSend.mock.calls[0]![0];
      expect(modCmd).toBeInstanceOf(ModifyDBInstanceCommand);
      expect(modCmd.input.DBInstanceClass).toBe('db.r5.xlarge');
      expect(modCmd.input.ApplyImmediately).toBe(true);
      // No DeletionProtection round-trip — the field is absent on DocDB instances.
      expect(modCmd.input.DeletionProtection).toBeUndefined();
    });

    it('delete with removeProtection=true does NOT issue ModifyDBInstance (DocDB instance has no protection field)', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DeleteDBInstanceCommand) return Promise.resolve({});
        const err = new Error('not found') as Error & { name: string };
        err.name = 'DBInstanceNotFoundFault';
        return Promise.reject(err);
      });
      const provider = new DocDBProvider();
      await provider.delete('I', 'my-instance', 'AWS::DocDB::DBInstance', undefined, {
        removeProtection: true,
      });
      const cmds = mockSend.mock.calls.map((c) => c[0]);
      // Architectural — DocDB DBInstance does not expose DeletionProtection.
      expect(cmds.some((c) => c instanceof ModifyDBInstanceCommand)).toBe(false);
      expect(cmds.some((c) => c instanceof DeleteDBInstanceCommand)).toBe(true);
    });
  });

  // ─── readCurrentState ─────────────────────────────────────────────

  describe('readCurrentState', () => {
    it('DBCluster surfaces DeletionProtection from DescribeDBClusters', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              EngineVersion: '5.0.0',
              Port: 27017,
              VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-aaa' }],
              StorageEncrypted: true,
              DeletionProtection: true,
              DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster',
            },
          ],
        })
        // ListTagsForResource
        .mockResolvedValueOnce({ TagList: [{ Key: 'Env', Value: 'prod' }] });
      const provider = new DocDBProvider();
      const state = await provider.readCurrentState!('my-cluster', 'C', 'AWS::DocDB::DBCluster');
      expect(state).toMatchObject({
        DBClusterIdentifier: 'my-cluster',
        EngineVersion: '5.0.0',
        Port: 27017,
        VpcSecurityGroupIds: ['sg-aaa'],
        StorageEncrypted: true,
        DeletionProtection: true,
        Tags: [{ Key: 'Env', Value: 'prod' }],
      });
    });

    it('DBInstance surfaces fields cdkd manages (no DeletionProtection key)', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              DBInstanceClass: 'db.r5.large',
              DBClusterIdentifier: 'my-cluster',
              AvailabilityZone: 'us-east-1a',
              AutoMinorVersionUpgrade: false,
              DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });
      const provider = new DocDBProvider();
      const state = await provider.readCurrentState!(
        'my-instance',
        'I',
        'AWS::DocDB::DBInstance'
      );
      expect(state).toMatchObject({
        DBInstanceIdentifier: 'my-instance',
        DBInstanceClass: 'db.r5.large',
        DBClusterIdentifier: 'my-cluster',
        AvailabilityZone: 'us-east-1a',
        AutoMinorVersionUpgrade: false,
      });
      // Cluster-level only — instance shape never carries DeletionProtection.
      expect(state).not.toHaveProperty('DeletionProtection');
    });

    it('DBSubnetGroup surfaces SubnetIds from DescribeDBSubnetGroups', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBSubnetGroups: [
            {
              DBSubnetGroupName: 'my-sg',
              DBSubnetGroupDescription: 'desc',
              Subnets: [
                { SubnetIdentifier: 'subnet-a' },
                { SubnetIdentifier: 'subnet-b' },
              ],
              DBSubnetGroupArn: 'arn:aws:rds:us-east-1:123:subgrp:my-sg',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });
      const provider = new DocDBProvider();
      const state = await provider.readCurrentState!(
        'my-sg',
        'SG',
        'AWS::DocDB::DBSubnetGroup'
      );
      expect(state).toMatchObject({
        DBSubnetGroupName: 'my-sg',
        DBSubnetGroupDescription: 'desc',
        SubnetIds: ['subnet-a', 'subnet-b'],
      });
    });

    it('returns undefined when DBCluster is gone (DBClusterNotFoundFault)', async () => {
      const err = new Error('not found') as Error & { name: string };
      err.name = 'DBClusterNotFoundFault';
      mockSend.mockRejectedValueOnce(err);
      const provider = new DocDBProvider();
      const state = await provider.readCurrentState!(
        'my-cluster',
        'C',
        'AWS::DocDB::DBCluster'
      );
      expect(state).toBeUndefined();
    });
  });

  // ─── import ───────────────────────────────────────────────────────

  describe('import', () => {
    const CDK_PATH = 'MyStack/MyDb/Resource';

    const importInput = (
      resourceType: string,
      overrides: Record<string, unknown> = {}
    ): Parameters<NonNullable<DocDBProvider['import']>>[0] =>
      ({
        logicalId: 'MyDb',
        resourceType,
        cdkPath: CDK_PATH,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      }) as Parameters<NonNullable<DocDBProvider['import']>>[0];

    it('DBInstance verifies an explicit id override via DescribeDBInstances', async () => {
      mockSend.mockResolvedValueOnce({ DBInstances: [{ DBInstanceIdentifier: 'mine' }] });
      const result = await new DocDBProvider().import!(
        importInput('AWS::DocDB::DBInstance', { knownPhysicalId: 'mine' })
      );
      expect(result).toEqual({ physicalId: 'mine', attributes: {} });
    });

    // The aws:cdk:path tag walk is gone (issue #1134): AWS rejects
    // aws:-prefixed tag writes, so the tag never exists on a real resource.
    // With no explicit id / name property each sub-type resolves nothing and
    // returns null immediately, issuing NO list / tag AWS call.
    it('DBInstance returns null without any AWS call when no override / name is supplied', async () => {
      const result = await new DocDBProvider().import!(importInput('AWS::DocDB::DBInstance'));
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('DBCluster returns null without any AWS call when no override / name is supplied', async () => {
      const result = await new DocDBProvider().import!(importInput('AWS::DocDB::DBCluster'));
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('DBSubnetGroup returns null without any AWS call when no override / name is supplied', async () => {
      const result = await new DocDBProvider().import!(importInput('AWS::DocDB::DBSubnetGroup'));
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
