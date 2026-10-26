// issue #1160: absent-field removal, matched to CloudFormation per property.
// ModifyDBCluster / ModifyDBInstance use merge semantics, so a field DROPPED
// from the template is sent as its reset value only where a real CFn A/B
// showed CloudFormation resets it (#5004, #1160 comment 6401151077); every
// other removal sends nothing, which keeps the live value as CFn does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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
    // The port-apply wait has its own cases below; the rest skip it.
    beforeEach(() => {
      process.env['CDKD_NO_WAIT'] = 'true';
    });
    afterEach(() => {
      delete process.env['CDKD_NO_WAIT'];
    });

    const mockClusterUpdate = () => {
      // updateDBCluster does 2 sends: ModifyDBCluster + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBClusters: [{}] });
    };

    it('resets BackupRetentionPeriod and keeps DeletionProtection / EnableIAMDatabaseAuthentication / MonitoringInterval on removal (#5004, #1160 A/B)', async () => {
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
          // Every one of these is removed; see the assertions for which reset.
          EngineVersion: '15.4',
          ManageMasterUserPassword: true,
          MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/k1' },
          MonitoringRoleArn: 'arn:aws:iam::123:role/monitoring',
          ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
          // A removed VpcSecurityGroupIds IS reset (to the VPC's default
          // security group): db-cluster-sg-removal-1160.test.ts.
          Port: 5433,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
      // #5004 A/B: CFn RESETS BackupRetentionPeriod (to 1).
      expect(modifyCall.input.BackupRetentionPeriod).toBe(1);
      // #1160 A/B: CFn resets a removed Aurora Port to the engine default and
      // sends ManageMasterUserPassword false.
      expect(modifyCall.input.Port).toBe(5432);
      expect(modifyCall.input.ManageMasterUserPassword).toBe(false);
      // CFn KEEPS these on removal -> no value sent (unchanged).
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
      expect(modifyCall.input.MonitoringInterval).toBeUndefined();
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.MonitoringRoleArn).toBeUndefined();
      expect(modifyCall.input.ServerlessV2ScalingConfiguration).toBeUndefined();
      // Unmeasured alone: a removed KMS key sends nothing.
      expect(modifyCall.input.MasterUserSecretKmsKeyId).toBeUndefined();
    });

    it.each([
      ['aurora-postgresql', 5432],
      ['aurora-mysql', 3306],
      ['Aurora-MySQL', 3306],
    ])('resets a removed Port on %s to %i, as CFn does (#1160 A/B)', async (engine, port) => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: engine },
        { Engine: engine, Port: '3307' }
      );

      expect(mockSend.mock.calls[0][0].input.Port).toBe(port);
    });

    it('sends no Port when the removed value already is the engine default', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql', Port: '5432' }
      );

      expect(mockSend.mock.calls[0][0].input.Port).toBeUndefined();
    });

    it('waits for a changed Port to apply before reading the attributes', async () => {
      delete process.env['CDKD_NO_WAIT'];
      const sleep = vi
        .spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
        .mockResolvedValue(undefined);
      mockSend.mockResolvedValueOnce({}); // ModifyDBCluster
      mockSend.mockResolvedValueOnce({ DBClusters: [{ Status: 'modifying', Port: 5433 }] });
      mockSend.mockResolvedValueOnce({ DBClusters: [{ Status: 'available', Port: 5432 }] });
      mockSend.mockResolvedValueOnce({
        DBClusters: [{ Status: 'available', Port: 5432, Endpoint: 'c.example' }],
      });

      const result = await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql', Port: 5433 }
      );

      expect(mockSend.mock.calls[0][0].input.Port).toBe(5432);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(result.attributes?.['Endpoint.Port']).toBe('5432');
    });

    it('adds no wait when the declared Port is unchanged', async () => {
      delete process.env['CDKD_NO_WAIT'];
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql', Port: 5433 },
        { Engine: 'aurora-postgresql', Port: '5433' }
      );

      expect(mockSend.mock.calls[0][0].input.Port).toBe(5433);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('sends no Port when a Multi-AZ DB cluster engine drops it (unmeasured)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'postgres' },
        { Engine: 'postgres', Port: 5433 }
      );

      expect(mockSend.mock.calls[0][0].input.Port).toBeUndefined();
    });

    it('keeps a declared Port and sends none when Port was never declared', async () => {
      mockClusterUpdate();
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql', Port: '5433' },
        { Engine: 'aurora-postgresql', Port: 5434 }
      );
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql' }
      );

      expect(mockSend.mock.calls[0][0].input.Port).toBe(5433);
      expect(mockSend.mock.calls[2][0].input.Port).toBeUndefined();
    });

    it('turns the managed password off when ManageMasterUserPassword is removed with a new MasterUserPassword (#1160 A/B)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql', MasterUserPassword: 'new-password-1' },
        {
          Engine: 'aurora-postgresql',
          ManageMasterUserPassword: 'true',
          MasterUserSecret: { KmsKeyId: 'alias/aws/secretsmanager' },
        }
      );

      const input = mockSend.mock.calls[0][0].input;
      expect(input.ManageMasterUserPassword).toBe(false);
      expect(input.MasterUserPassword).toBe('new-password-1');
      expect(input.MasterUserSecretKmsKeyId).toBeUndefined();
    });

    it('sends no ManageMasterUserPassword when a declared false is removed (unmeasured)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        { Engine: 'aurora-postgresql' },
        { Engine: 'aurora-postgresql', ManageMasterUserPassword: false }
      );

      expect(mockSend.mock.calls[0][0].input.ManageMasterUserPassword).toBeUndefined();
    });

    it('keeps the live interval when the role is kept but the interval is removed (#1160 A/B)', async () => {
      mockClusterUpdate();

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::RDS::DBCluster',
        {
          Engine: 'aurora-postgresql',
          MonitoringRoleArn: 'arn:aws:iam::123:role/monitoring',
        },
        {
          Engine: 'aurora-postgresql',
          MonitoringRoleArn: 'arn:aws:iam::123:role/monitoring',
          MonitoringInterval: 60,
        }
      );

      // CFn keeps the live interval, so only the kept role goes out.
      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.MonitoringRoleArn).toBe('arn:aws:iam::123:role/monitoring');
      expect(modifyCall.input.MonitoringInterval).toBeUndefined();
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
      expect(modifyCall.input.Port).toBeUndefined();
      expect(modifyCall.input.ManageMasterUserPassword).toBeUndefined();
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
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });
  });

  describe('DBInstance update (ModifyDBInstance)', () => {
    const mockInstanceUpdate = () => {
      // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBInstances: [{}] });
    };

    it('keeps every removed value except ManageMasterUserPassword, as CFn does (#5004, #1160 A/B)', async () => {
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
          // Every one of these is removed; see the assertions for which reset.
          EngineVersion: '17.6',
          AllocatedStorage: '20',
          Port: 5433,
          ManageMasterUserPassword: true,
          MasterUserSecret: { KmsKeyId: 'arn:aws:kms:us-east-1:123:key/k1' },
          MonitoringRoleArn: 'arn:aws:iam::123:role/monitoring',
          PubliclyAccessible: true,
          VPCSecurityGroups: ['sg-1'],
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBInstanceCommand');
      // #1160 A/B: CFn sends ManageMasterUserPassword false on removal.
      expect(modifyCall.input.ManageMasterUserPassword).toBe(false);
      // CFn KEEPS these on removal -> no value sent (unchanged).
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.MonitoringInterval).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.AllocatedStorage).toBeUndefined();
      expect(modifyCall.input.DBPortNumber).toBeUndefined();
      // Unmeasured alone / UNCERTAIN in the audit: nothing sent.
      expect(modifyCall.input.MasterUserSecretKmsKeyId).toBeUndefined();
      expect(modifyCall.input.MonitoringRoleArn).toBeUndefined();
      expect(modifyCall.input.PubliclyAccessible).toBeUndefined();
      expect(modifyCall.input.VpcSecurityGroupIds).toBeUndefined();
    });

    it('sends no interval when the role is kept but the interval is removed (#5004)', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::RDS::DBInstance',
        {
          Engine: 'postgres',
          MonitoringRoleArn: 'arn:aws:iam::123:role/monitoring',
        },
        {
          Engine: 'postgres',
          MonitoringRoleArn: 'arn:aws:iam::123:role/monitoring',
          MonitoringInterval: 60,
        }
      );

      // #5004 A/B: CFn keeps the live interval, so only the kept role goes out.
      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.MonitoringRoleArn).toBe('arn:aws:iam::123:role/monitoring');
      expect(modifyCall.input.MonitoringInterval).toBeUndefined();
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
      expect(modifyCall.input.ManageMasterUserPassword).toBeUndefined();
    });

    it('turns the managed password off when ManageMasterUserPassword is removed with a new MasterUserPassword (#1160 A/B)', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::RDS::DBInstance',
        { Engine: 'mysql', MasterUserPassword: 'new-password-1' },
        { Engine: 'mysql', ManageMasterUserPassword: true }
      );

      const input = mockSend.mock.calls[0][0].input;
      expect(input.ManageMasterUserPassword).toBe(false);
      expect(input.MasterUserPassword).toBe('new-password-1');
    });

    it('sends false for a removed string "true" on the deploy path, where changedProperties decides the password', async () => {
      mockInstanceUpdate();

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::RDS::DBInstance',
        { Engine: 'mysql', MasterUserPassword: 'new-password-1' },
        { Engine: 'mysql', ManageMasterUserPassword: 'true' },
        {
          changedProperties: new Set(['ManageMasterUserPassword', 'MasterUserPassword']),
          removedProperties: new Set(['ManageMasterUserPassword']),
        }
      );

      const input = mockSend.mock.calls[0][0].input;
      expect(input.ManageMasterUserPassword).toBe(false);
      expect(input.MasterUserPassword).toBe('new-password-1');
    });

    it('passes kept/changed fields through unchanged while removed ones are left unchanged', async () => {
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
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });
  });
});
