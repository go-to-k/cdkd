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
} from '@aws-sdk/client-neptune';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-neptune', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    NeptuneClient: vi.fn().mockImplementation(() => ({
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

import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env['CDKD_NO_WAIT'] = 'true';
});

describe('NeptuneProvider', () => {
  // ─── DBSubnetGroup ────────────────────────────────────────────────

  describe('DBSubnetGroup', () => {
    it('create returns the DBSubnetGroupName as physicalId', async () => {
      mockSend.mockResolvedValueOnce({});
      const provider = new NeptuneProvider();
      const result = await provider.create('MySG', 'AWS::Neptune::DBSubnetGroup', {
        DBSubnetGroupName: 'my-sg',
        DBSubnetGroupDescription: 'desc',
        SubnetIds: ['subnet-a', 'subnet-b'],
      });
      expect(result.physicalId).toBe('my-sg');
      const cmd = mockSend.mock.calls[0]![0];
      expect(cmd).toBeInstanceOf(CreateDBSubnetGroupCommand);
    });

    it('update issues ModifyDBSubnetGroup; empty SubnetIds is dropped', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          DBSubnetGroups: [{ DBSubnetGroupArn: 'arn:aws:rds:us-east-1:123:subgrp:my-sg' }],
        });
      const provider = new NeptuneProvider();
      await provider.update(
        'MySG',
        'my-sg',
        'AWS::Neptune::DBSubnetGroup',
        { DBSubnetGroupDescription: 'new', SubnetIds: [] },
        { DBSubnetGroupDescription: 'old' }
      );
      const modifyCmd = mockSend.mock.calls[0]![0];
      expect(modifyCmd).toBeInstanceOf(ModifyDBSubnetGroupCommand);
      expect(modifyCmd.input.SubnetIds).toBeUndefined();
    });

    it('delete issues DeleteDBSubnetGroup', async () => {
      mockSend.mockResolvedValueOnce({});
      const provider = new NeptuneProvider();
      await provider.delete('MySG', 'my-sg', 'AWS::Neptune::DBSubnetGroup');
      const cmd = mockSend.mock.calls[0]![0];
      expect(cmd).toBeInstanceOf(DeleteDBSubnetGroupCommand);
    });

    it('delete is idempotent on DBSubnetGroupNotFoundFault', async () => {
      const err = new Error('not found') as Error & { name: string };
      err.name = 'DBSubnetGroupNotFoundFault';
      mockSend.mockRejectedValueOnce(err);
      const provider = new NeptuneProvider();
      await expect(
        provider.delete('MySG', 'my-sg', 'AWS::Neptune::DBSubnetGroup')
      ).resolves.toBeUndefined();
    });
  });

  // ─── DBCluster ────────────────────────────────────────────────────

  describe('DBCluster', () => {
    it('create issues CreateDBCluster with Engine=neptune and returns endpoint attrs', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBCluster: { DBClusterIdentifier: 'my-cluster' },
        })
        .mockResolvedValueOnce({
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              Endpoint: 'cluster.neptune.amazonaws.com',
              Port: 8182,
              ReaderEndpoint: 'cluster-ro.neptune.amazonaws.com',
              DbClusterResourceId: 'cluster-XYZ',
            },
          ],
        });
      const provider = new NeptuneProvider();
      const result = await provider.create('MyCluster', 'AWS::Neptune::DBCluster', {
        DBClusterIdentifier: 'my-cluster',
        DeletionProtection: true,
      });
      expect(result.physicalId).toBe('my-cluster');
      expect(result.attributes).toMatchObject({
        'Endpoint.Address': 'cluster.neptune.amazonaws.com',
        'Endpoint.Port': '8182',
        'ReadEndpoint.Address': 'cluster-ro.neptune.amazonaws.com',
        ClusterResourceId: 'cluster-XYZ',
      });
      const createCmd = mockSend.mock.calls[0]![0];
      expect(createCmd).toBeInstanceOf(CreateDBClusterCommand);
      expect(createCmd.input.Engine).toBe('neptune');
      expect(createCmd.input.DeletionProtection).toBe(true);
    });

    it('update issues ModifyDBCluster with ApplyImmediately=true; empty VpcSecurityGroupIds dropped', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ DBClusters: [{}] });
      const provider = new NeptuneProvider();
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        {
          BackupRetentionPeriod: 14,
          DeletionProtection: false,
          VpcSecurityGroupIds: [],
        },
        {}
      );
      const modCmd = mockSend.mock.calls[0]![0];
      expect(modCmd).toBeInstanceOf(ModifyDBClusterCommand);
      expect(modCmd.input.ApplyImmediately).toBe(true);
      expect(modCmd.input.BackupRetentionPeriod).toBe(14);
      expect(modCmd.input.DeletionProtection).toBe(false);
      expect(modCmd.input.VpcSecurityGroupIds).toBeUndefined();
    });

    it('delete with removeProtection=true issues ModifyDBCluster(DeletionProtection=false) before DeleteDBCluster', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof ModifyDBClusterCommand) return Promise.resolve({});
        if (command instanceof DeleteDBClusterCommand) return Promise.resolve({});
        const err = new Error('not found') as Error & { name: string };
        err.name = 'DBClusterNotFoundFault';
        return Promise.reject(err);
      });
      const provider = new NeptuneProvider();
      await provider.delete('CL', 'my-cluster', 'AWS::Neptune::DBCluster', undefined, {
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
      const provider = new NeptuneProvider();
      await provider.delete('CL', 'my-cluster', 'AWS::Neptune::DBCluster');
      const cmds = mockSend.mock.calls.map((c) => c[0]);
      expect(cmds.some((c) => c instanceof ModifyDBClusterCommand)).toBe(false);
      expect(cmds.some((c) => c instanceof DeleteDBClusterCommand)).toBe(true);
    });
  });

  // ─── DBInstance ───────────────────────────────────────────────────

  describe('DBInstance', () => {
    it('create issues CreateDBInstance with Engine=neptune and DeletionProtection wired', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBInstance: { DBInstanceIdentifier: 'my-instance' },
        })
        .mockResolvedValueOnce({
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              Endpoint: { Address: 'instance.neptune.amazonaws.com', Port: 8182 },
            },
          ],
        });
      const provider = new NeptuneProvider();
      const result = await provider.create('MyInst', 'AWS::Neptune::DBInstance', {
        DBInstanceIdentifier: 'my-instance',
        DBInstanceClass: 'db.r5.large',
        DBClusterIdentifier: 'my-cluster',
        DeletionProtection: true,
      });
      expect(result.physicalId).toBe('my-instance');
      const createCmd = mockSend.mock.calls[0]![0];
      expect(createCmd).toBeInstanceOf(CreateDBInstanceCommand);
      expect(createCmd.input.Engine).toBe('neptune');
      // Neptune supports DBInstance-level DeletionProtection (unlike DocDB).
      expect(createCmd.input.DeletionProtection).toBe(true);
    });

    it('update issues ModifyDBInstance with DeletionProtection round-trip', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          DBInstances: [{ DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance' }],
        });
      const provider = new NeptuneProvider();
      await provider.update(
        'MyInst',
        'my-instance',
        'AWS::Neptune::DBInstance',
        { DBInstanceClass: 'db.r5.xlarge', DeletionProtection: false },
        {}
      );
      const modCmd = mockSend.mock.calls[0]![0];
      expect(modCmd).toBeInstanceOf(ModifyDBInstanceCommand);
      expect(modCmd.input.ApplyImmediately).toBe(true);
      expect(modCmd.input.DeletionProtection).toBe(false);
    });

    it('delete with removeProtection=true issues ModifyDBInstance(DeletionProtection=false) before DeleteDBInstance', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof ModifyDBInstanceCommand) return Promise.resolve({});
        if (command instanceof DeleteDBInstanceCommand) return Promise.resolve({});
        const err = new Error('not found') as Error & { name: string };
        err.name = 'DBInstanceNotFoundFault';
        return Promise.reject(err);
      });
      const provider = new NeptuneProvider();
      await provider.delete('I', 'my-instance', 'AWS::Neptune::DBInstance', undefined, {
        removeProtection: true,
      });
      const cmds = mockSend.mock.calls.map((c) => c[0]);
      const flipIdx = cmds.findIndex((c) => c instanceof ModifyDBInstanceCommand);
      const delIdx = cmds.findIndex((c) => c instanceof DeleteDBInstanceCommand);
      expect(flipIdx).toBeGreaterThanOrEqual(0);
      expect(delIdx).toBeGreaterThan(flipIdx);
      expect(cmds[flipIdx]!.input.DeletionProtection).toBe(false);
      expect(cmds[flipIdx]!.input.ApplyImmediately).toBe(true);
    });

    it('delete without removeProtection does NOT issue ModifyDBInstance', async () => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof DeleteDBInstanceCommand) return Promise.resolve({});
        const err = new Error('not found') as Error & { name: string };
        err.name = 'DBInstanceNotFoundFault';
        return Promise.reject(err);
      });
      const provider = new NeptuneProvider();
      await provider.delete('I', 'my-instance', 'AWS::Neptune::DBInstance');
      const cmds = mockSend.mock.calls.map((c) => c[0]);
      expect(cmds.some((c) => c instanceof ModifyDBInstanceCommand)).toBe(false);
      expect(cmds.some((c) => c instanceof DeleteDBInstanceCommand)).toBe(true);
    });
  });

  // ─── readCurrentState ─────────────────────────────────────────────

  describe('readCurrentState', () => {
    it('DBCluster surfaces DeletionProtection + IamAuthEnabled', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBClusters: [
            {
              DBClusterIdentifier: 'my-cluster',
              EngineVersion: '1.2.0.0',
              Port: 8182,
              VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-aaa' }],
              StorageEncrypted: true,
              IAMDatabaseAuthenticationEnabled: true,
              DeletionProtection: true,
              DBClusterArn: 'arn:aws:rds:us-east-1:123:cluster:my-cluster',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });
      const provider = new NeptuneProvider();
      const state = await provider.readCurrentState!(
        'my-cluster',
        'C',
        'AWS::Neptune::DBCluster'
      );
      expect(state).toMatchObject({
        DBClusterIdentifier: 'my-cluster',
        EngineVersion: '1.2.0.0',
        Port: 8182,
        VpcSecurityGroupIds: ['sg-aaa'],
        StorageEncrypted: true,
        IamAuthEnabled: true,
        DeletionProtection: true,
      });
    });

    it('DBInstance surfaces DeletionProtection (Neptune supports it)', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBInstances: [
            {
              DBInstanceIdentifier: 'my-instance',
              DBInstanceClass: 'db.r5.large',
              DBClusterIdentifier: 'my-cluster',
              DBSubnetGroup: { DBSubnetGroupName: 'my-sg' },
              AutoMinorVersionUpgrade: true,
              DeletionProtection: true,
              DBParameterGroups: [{ DBParameterGroupName: 'default.neptune1' }],
              DBInstanceArn: 'arn:aws:rds:us-east-1:123:db:my-instance',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });
      const provider = new NeptuneProvider();
      const state = await provider.readCurrentState!(
        'my-instance',
        'I',
        'AWS::Neptune::DBInstance'
      );
      expect(state).toMatchObject({
        DBInstanceIdentifier: 'my-instance',
        DBInstanceClass: 'db.r5.large',
        DBClusterIdentifier: 'my-cluster',
        DBSubnetGroupName: 'my-sg',
        AutoMinorVersionUpgrade: true,
        DeletionProtection: true,
        DBParameterGroupName: 'default.neptune1',
      });
    });

    it('returns undefined when DBInstance is gone (DBInstanceNotFoundFault)', async () => {
      const err = new Error('not found') as Error & { name: string };
      err.name = 'DBInstanceNotFoundFault';
      mockSend.mockRejectedValueOnce(err);
      const provider = new NeptuneProvider();
      const state = await provider.readCurrentState!(
        'my-instance',
        'I',
        'AWS::Neptune::DBInstance'
      );
      expect(state).toBeUndefined();
    });
  });
});
