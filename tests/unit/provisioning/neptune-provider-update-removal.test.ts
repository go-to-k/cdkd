// issues #1160 / #5004 (neptune): absent-field removal semantics.
// ModifyDBCluster / ModifyDBInstance use merge semantics (an omitted field is
// "no change"). A real CloudFormation A/B (#5004) showed CloudFormation KEEPS
// the live value of a removed DeletionProtection / IamAuthEnabled /
// BackupRetentionPeriod (DBCluster) and AutoMinorVersionUpgrade (DBInstance),
// so cdkd sends NO reset for them. DBSubnetGroupDescription is required in
// CloudFormation (not measurable), so its create-time-fallback reset stays.
// #5544: a further A/B showed CloudFormation also KEEPS a removed DBCluster
// EngineVersion / PreferredBackupWindow / PreferredMaintenanceWindow /
// DBClusterParameterGroupName and DBInstance DBParameterGroupName /
// PreferredMaintenanceWindow; cdkd keeps them and names them in a warning.
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

import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';

describe('NeptuneProvider removal semantics (issues #1160 / #5004)', () => {
  let provider: NeptuneProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new NeptuneProvider();
  });

  describe('removal declaration (what deploy / rollback inject)', () => {
    it.each([
      [
        'AWS::Neptune::DBCluster',
        { DeletionProtection: true, BackupRetentionPeriod: 7, IamAuthEnabled: true },
      ],
      [
        'AWS::Neptune::DBInstance',
        { DeletionProtection: true, AutoMinorVersionUpgrade: false },
      ],
    ])('declares no removalDefaults for %s, so nothing is injected (#5004)', (type, previous) => {
      expect((provider as ResourceProvider).removalDefaults?.get(type)).toBeUndefined();
      const prep = prepareRemovalForUpdate(provider, type, {}, previous);
      expect(prep.injected).toEqual([]);
      for (const key of Object.keys(previous)) {
        expect(prep.properties).not.toHaveProperty(key);
      }
    });
  });

  describe('DBCluster update (ModifyDBCluster)', () => {
    const mockClusterUpdate = () => {
      // updateDBCluster does 2 sends: ModifyDBCluster + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBClusters: [{}] });
    };

    it('sends NO reset for removed fields CloudFormation keeps (#5004)', async () => {
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
          // Also not reset on removal — must stay absent.
          EngineVersion: '1.3.2.0',
          DBClusterParameterGroupName: 'my-cluster-params',
          PreferredBackupWindow: '03:00-04:00',
          PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
          // A removed VpcSecurityGroupIds IS reset (to the VPC's default
          // security group): db-cluster-sg-removal-1160.test.ts.
          DBPort: 8182,
        }
      );

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
      // #5004: CloudFormation keeps the live value, so each stays absent
      // (no change) rather than being reset to false / 1 / false.
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.BackupRetentionPeriod).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
      // Other deliberate non-resets: removal must NOT synthesize any value.
      expect(modifyCall.input.EngineVersion).toBeUndefined();
      expect(modifyCall.input.DBClusterParameterGroupName).toBeUndefined();
      expect(modifyCall.input.PreferredBackupWindow).toBeUndefined();
      expect(modifyCall.input.PreferredMaintenanceWindow).toBeUndefined();
      expect(modifyCall.input.Port).toBeUndefined();
    });

    it.each([
      ['DBPort', { DBPort: 8183 }],
      ['the legacy Port', { Port: 8183 }],
      ['both spellings (as a string)', { DBPort: '8183', Port: '8183' }],
    ])(
      'sends NO reset for a removed non-default %s: CloudFormation keeps the live port (#1160)',
      async (_label, previous) => {
        mockClusterUpdate();

        await provider.update('MyCluster', 'my-cluster', 'AWS::Neptune::DBCluster', {}, previous);

        // A Port reset would be the documented 8182 default; CloudFormation
        // keeps 8183, so the field must stay absent (no change).
        const modifyCall = mockSend.mock.calls[0][0];
        expect(modifyCall.constructor.name).toBe('ModifyDBClusterCommand');
        expect(modifyCall.input.Port).toBeUndefined();
        expect(mockSend).toHaveBeenCalledTimes(2);
      }
    );

    it('leaves a never-present field absent (no spurious reset value)', async () => {
      mockClusterUpdate();

      await provider.update('MyCluster', 'my-cluster', 'AWS::Neptune::DBCluster', {}, {});

      const modifyCall = mockSend.mock.calls[0][0];
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.BackupRetentionPeriod).toBeUndefined();
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });

    it('passes changed fields through while removed ones stay absent', async () => {
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
      expect(modifyCall.input.EnableIAMDatabaseAuthentication).toBeUndefined();
    });
  });

  describe('DBInstance update (ModifyDBInstance)', () => {
    const mockInstanceUpdate = () => {
      // updateDBInstance does 2 sends: ModifyDBInstance + final describe.
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ DBInstances: [{}] });
    };

    it('sends NO reset for a removed AutoMinorVersionUpgrade or DeletionProtection (#5004)', async () => {
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
      // #5004: CloudFormation keeps a removed AutoMinorVersionUpgrade;
      // DeletionProtection is not a CloudFormation DBInstance property.
      // Neither is reset.
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
      expect(modifyCall.input.AutoMinorVersionUpgrade).toBeUndefined();
      // Other deliberate non-resets: removal must NOT synthesize any value.
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

    it('passes changed fields through while removed ones stay absent', async () => {
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
      expect(modifyCall.input.DeletionProtection).toBeUndefined();
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

  describe('kept removals are warned about, never reset (#5544)', () => {
    const warn = (): ReturnType<typeof vi.fn> =>
      (provider as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn;
    const warnings = (): string[] => warn().mock.calls.map((call) => String(call[0]));
    const mockModify = (describeKey: 'DBClusters' | 'DBInstances') => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ [describeKey]: [{}] });
    };
    const CLUSTER_PREVIOUS = {
      EngineVersion: '1.4.7.0',
      PreferredBackupWindow: '03:00-03:30',
      PreferredMaintenanceWindow: 'sun:05:00-sun:05:30',
      DBClusterParameterGroupName: 'my-cluster-params',
      BackupRetentionPeriod: 7,
    };
    const INSTANCE_PREVIOUS = {
      DBInstanceClass: 'db.t3.medium',
      DBParameterGroupName: 'my-instance-params',
      PreferredMaintenanceWindow: 'mon:06:00-mon:06:30',
    };

    it.each(['AWS::Neptune::DBCluster', 'AWS::Neptune::DBInstance'])(
      'registers every handled %s property, so the shared caller warns about none',
      (type) => {
        const handled = provider.handledProperties.get(type)!;
        expect(provider.removalHandledInUpdate.get(type)).toEqual(handled);
        const previous = Object.fromEntries([...handled].map((key) => [key, 'x']));
        expect(prepareRemovalForUpdate(provider, type, {}, previous).unhandled).toEqual([]);
      }
    );

    it('names every removed cluster property in ONE warning and sends none of them', async () => {
      mockModify('DBClusters');

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        // Beside a changed property, as the A/B measured.
        { BackupRetentionPeriod: 8 },
        CLUSTER_PREVIOUS
      );

      const input = mockSend.mock.calls[0][0].input;
      expect(input.BackupRetentionPeriod).toBe(8);
      for (const key of [
        'EngineVersion',
        'PreferredBackupWindow',
        'PreferredMaintenanceWindow',
        'DBClusterParameterGroupName',
      ]) {
        expect(input[key]).toBeUndefined();
      }
      expect(warnings()).toEqual([
        'MyCluster (AWS::Neptune::DBCluster): properties EngineVersion, PreferredBackupWindow, PreferredMaintenanceWindow, DBClusterParameterGroupName were removed from the template; cdkd leaves the current AWS values in place, as CloudFormation does.',
      ]);
    });

    it('names a removed instance parameter group and window, and sends neither', async () => {
      mockModify('DBInstances');

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::Neptune::DBInstance',
        { DBInstanceClass: 'db.t3.medium' },
        INSTANCE_PREVIOUS
      );

      const input = mockSend.mock.calls[0][0].input;
      expect(input.DBParameterGroupName).toBeUndefined();
      expect(input.PreferredMaintenanceWindow).toBeUndefined();
      expect(warnings()).toEqual([
        'MyInstance (AWS::Neptune::DBInstance): properties DBParameterGroupName, PreferredMaintenanceWindow were removed from the template; cdkd leaves the current AWS values in place, as CloudFormation does.',
      ]);
    });

    it('warns about nothing when no kept property was removed (kept, changed or never set)', async () => {
      mockModify('DBClusters');
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        { ...CLUSTER_PREVIOUS, EngineVersion: '1.4.8.0' },
        CLUSTER_PREVIOUS
      );
      mockModify('DBInstances');
      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::Neptune::DBInstance',
        { DBInstanceClass: 'db.t3.medium' },
        { DBInstanceClass: 'db.t3.medium' }
      );

      expect(warn()).not.toHaveBeenCalled();
    });

    it('reads the caller-computed removedProperties when set', async () => {
      mockModify('DBClusters');

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        {},
        CLUSTER_PREVIOUS,
        { removedProperties: new Set(['EngineVersion']) }
      );

      expect(warnings()).toEqual([
        'MyCluster (AWS::Neptune::DBCluster): property EngineVersion was removed from the template; cdkd leaves the current AWS value in place, as CloudFormation does.',
      ]);
    });

    it('counts DBPort and Port as one setting', async () => {
      mockModify('DBClusters');
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        { Port: 8183 },
        { DBPort: 8183, Port: 8183 }
      );
      expect(warn()).not.toHaveBeenCalled();

      mockModify('DBClusters');
      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        {},
        { DBPort: 8183 }
      );
      expect(warnings()).toEqual([
        'MyCluster (AWS::Neptune::DBCluster): property DBPort was removed from the template; cdkd leaves the current AWS value in place, as CloudFormation does.',
      ]);
    });

    it('says a rollback restore is missing the property, not that the template dropped it', async () => {
      mockModify('DBInstances');

      await provider.update(
        'MyInstance',
        'my-instance',
        'AWS::Neptune::DBInstance',
        { DBInstanceClass: 'db.t3.medium' },
        { DBInstanceClass: 'db.t3.medium', DBParameterGroupName: 'my-instance-params' },
        { replayingState: true }
      );

      expect(warnings()).toEqual([
        'MyInstance (AWS::Neptune::DBInstance): property DBParameterGroupName is absent from the configuration being restored; cdkd leaves the current AWS value in place, as CloudFormation does.',
      ]);
    });

    it('warns about nothing on a drift --revert, whose baseline is a readback', async () => {
      mockModify('DBClusters');

      await provider.update(
        'MyCluster',
        'my-cluster',
        'AWS::Neptune::DBCluster',
        {},
        CLUSTER_PREVIOUS,
        { desiredFromAwsReadback: true }
      );

      expect(warn()).not.toHaveBeenCalled();
    });
  });
});
