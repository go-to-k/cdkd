// issue #1160: absent-field removal reset to CFn defaults.
// ModifyDBCluster / ModifyDBInstance use merge semantics, so a field DROPPED
// from the template must be sent as its explicit CFn-default reset value
// (doc basis: ModifyDBClusterMessage / ModifyDBInstanceMessage in
// @aws-sdk/client-rds), else the old live value silently persists.
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

describe('RDSProvider removal reset to CFn defaults (issue #1160)', () => {
  let provider: RDSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new RDSProvider();
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
        'AWS::RDS::DBCluster',
        {
          Engine: 'aurora-postgresql',
        },
        {
          Engine: 'aurora-postgresql',
          DeletionProtection: true,
          BackupRetentionPeriod: 7,
          MonitoringInterval: 30,
          EnableIAMDatabaseAuthentication: true,
          // Deliberately NOT reset on removal — must stay absent.
          EngineVersion: '15.4',
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
      expect(modifyCall.input.DeletionProtection).toBe(false);
      expect(modifyCall.input.BackupRetentionPeriod).toBe(1);
      expect(modifyCall.input.MonitoringInterval).toBe(0);
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(false);
      // EngineVersion removal must NOT synthesize an engine-default version
      // change — the field stays absent (no change).
      expect(modifyCall.input.EngineVersion).toBeUndefined();
    });

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.BackupRetentionPeriod).toBeUndefined();
      expect(modifyCall.input.MonitoringInterval).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });

    it('passes kept/changed fields through unchanged while removed ones reset', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        {
          Engine: 'aurora-postgresql',
          DeletionProtection: true,
          // CFn number props may arrive as strings — coercion preserved.
          MonitoringInterval: '60',
        },
        {
          Engine: 'aurora-postgresql',
          DeletionProtection: true,
          MonitoringInterval: 30,
          BackupRetentionPeriod: '14',
          EnableIAMDatabaseAuthentication: true,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBe(true);
      expect(modifyCall.input.MonitoringInterval).toBe(60);
      expect(modifyCall.input.BackupRetentionPeriod).toBe(1);
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
        'AWS::RDS::DBInstance',
        {
          Engine: 'postgres',
        },
        {
          Engine: 'postgres',
          DeletionProtection: true,
          MonitoringInterval: 60,
          EnableIAMDatabaseAuthentication: true,
          // Deliberately NOT reset on removal — must stay absent.
          EngineVersion: '17.6',
          AllocatedStorage: '20',
          Port: 5433,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
      expect(modifyCall.input.DeletionProtection).toBe(false);
      expect(modifyCall.input.MonitoringInterval).toBe(0);
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(false);
      // Deliberately-not-reset fields stay absent on removal.
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.AllocatedStorage).toBeUndefined();
      expect(modifyCall.input.DBPortNumber).toBeUndefined();
    });

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::RDS::DBInstance',
        { Engine: 'postgres', DBInstanceClass: 'db.t3.micro' },
        { Engine: 'postgres', DBInstanceClass: 'db.t3.micro' }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.MonitoringInterval).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });

    it('passes kept/changed fields through unchanged while removed ones reset', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::RDS::DBInstance',
        {
          Engine: 'postgres',
          DeletionProtection: true,
          // CFn number props may arrive as strings — coercion preserved.
          MonitoringInterval: '30',
        },
        {
          Engine: 'postgres',
          DeletionProtection: true,
          MonitoringInterval: 60,
          EnableIAMDatabaseAuthentication: true,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBe(true);
      expect(modifyCall.input.MonitoringInterval).toBe(30);
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBe(false);
    });
  });
});
