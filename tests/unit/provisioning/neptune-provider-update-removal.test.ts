// issue #1160 (neptune batch): absent-field removal reset to CFn defaults.
// ModifyDBCluster / ModifyDBInstance use merge semantics, so a field DROPPED
// from the template must be sent as its explicit CFn-default reset value
// (doc basis: ModifyDBClusterMessage / ModifyDBInstanceMessage /
// CreateDBInstanceMessage in @aws-sdk/client-neptune), else the old live
// value silently persists. Direct pattern twin of
// rds-provider-update-removal.test.ts (PR #1222).
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

describe('NeptuneProvider removal reset to CFn defaults (issue #1160)', () => {
  let provider: NeptuneProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new NeptuneProvider();
  });

  describe('DBCluster update (ModifyDBCluster)', () => {
    const mockClusterUpdate = () => {
      // updateDBCluster does 2 sends: ModifyDBCluster + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBClusters: [{}] });
    };

    it('resets removed fields to their CFn defaults on update', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        {},
        {
          DeletionProtection: true,
          BackupRetentionPeriod: 7,
          IamAuthEnabled: true,
          // Deliberately NOT reset on removal — must stay absent.
          EngineVersion: '1.3.2.0',
          DBClusterParameterGroupName: 'my-cluster-params',
          PreferredBackupWindow: '03:00-04:00',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          VpcSecurityGroupIds: ['sg-1'],
          DBPort: 8182,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
      expect(modifyCall.input.DeletionProtection).toBe(false);
      expect(modifyCall.input.BackupRetentionPeriod).toBe(1);
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(false);
      // Deliberate non-resets: removal of these must NOT synthesize any
      // value — each stays absent (no change). Pins the per-field rationale
      // comment in updateDBCluster.
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.DBClusterParameterGroupName).toBeUndefined();
      expect(modifyCall.input.PreferredBackupWindow).toBeUndefined();
      expect(modifyCall.input.PreferredMaintenanceWindow).toBeUndefined();
      expect(modifyCall.input.VpcSecurityGroupIds).toBeUndefined();
      expect(modifyCall.input.Port).toBeUndefined();
    });

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockClusterUpdate();

      await provider.update('MyCluster', 'my-cluster', 'AWS::Neptune::DBCluster', {}, {});

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.BackupRetentionPeriod).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });

    it('passes kept/changed fields through unchanged while removed ones reset', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        {
          DeletionProtection: true,
          // CFn number props may arrive as strings — coercion preserved.
          BackupRetentionPeriod: '14',
        },
        {
          DeletionProtection: true,
          BackupRetentionPeriod: 7,
          IamAuthEnabled: true,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBe(true);
      expect(modifyCall.input.BackupRetentionPeriod).toBe(14);
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(false);
    });
  });

  describe('DBInstance update (ModifyDBInstance)', () => {
    const mockInstanceUpdate = () => {
      // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBInstances: [{}] });
    };

    it('resets removed fields to their CFn defaults on update', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::Neptune::DBInstance',
        {
          DBInstanceClass: 'db.t3.medium',
        },
        {
          DBInstanceClass: 'db.t3.medium',
          DeletionProtection: true,
          AutoMinorVersionUpgrade: false,
          // Deliberately NOT reset on removal — must stay absent.
          DBParameterGroupName: 'my-instance-params',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
      expect(modifyCall.input.DeletionProtection).toBe(false);
      // CreateDBInstance documents `Default: true` for
      // AutoMinorVersionUpgrade — the removal reset is TRUE, not false.
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBe(true);
      // Deliberate non-resets: removal of these must NOT synthesize any
      // value — each stays absent (no change). Pins the per-field rationale
      // comment in updateDBInstance.
      expect(modifyCall.input.DBParameterGroupName).toBeUndefined();
      expect(modifyCall.input.PreferredMaintenanceWindow).toBeUndefined();
    });

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::Neptune::DBInstance',
        { DBInstanceClass: 'db.t3.medium' },
        { DBInstanceClass: 'db.t3.medium' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBeUndefined();
    });

    it('passes kept/changed fields through unchanged while removed ones reset', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::Neptune::DBInstance',
        {
          DBInstanceClass: 'db.t3.medium',
          AutoMinorVersionUpgrade: false,
        },
        {
          DBInstanceClass: 'db.t3.medium',
          AutoMinorVersionUpgrade: true,
          DeletionProtection: true,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBe(false);
      expect(modifyCall.input.DeletionProtection).toBe(false);
    });
  });

  describe('DBSubnetGroup update (ModifyDBSubnetGroup)', () => {
    const mockSubnetGroupUpdate = () => {
      // updateDBSubnetGroup does 2 sends: ModifyDBSubnetGroup + describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBSubnetGroups: [{}] });
    };

    it('resets a removed description to the create-time fallback', async () => {
      mockSubnetGroupUpdate();

      await provider.update(
        'MySG',
        'my-subnet-group',
        'AWS::Neptune::DBSubnetGroup',
        { SubnetIds: ['subnet-1', 'subnet-2'] },
        { SubnetIds: ['subnet-1', 'subnet-2'], DBSubnetGroupDescription: 'custom description' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBSubnetGroupCommand');
      // Same fallback createDBSubnetGroup synthesizes for an absent
      // description — create/update parity.
      expect(modifyCall.input.DBSubnetGroupDescription).toBe('Subnet group for MySG');
    });

    it('leaves a never-present description absent and passes a kept one through', async () => {
      mockSubnetGroupUpdate();

      await provider.update(
        'MySG',
        'my-subnet-group',
        'AWS::Neptune::DBSubnetGroup',
        { SubnetIds: ['subnet-1', 'subnet-2'] },
        { SubnetIds: ['subnet-1', 'subnet-2'] }
      );

      let modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DBSubnetGroupDescription).toBeUndefined();

      vi.clearAllMocks();
      mockSubnetGroupUpdate();

      await provider.update(
        'MySG',
        'my-subnet-group',
        'AWS::Neptune::DBSubnetGroup',
        { SubnetIds: ['subnet-1', 'subnet-2'], DBSubnetGroupDescription: 'kept' },
        { SubnetIds: ['subnet-1', 'subnet-2'], DBSubnetGroupDescription: 'old' }
      );

      modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DBSubnetGroupDescription).toBe('kept');
    });
  });
});
